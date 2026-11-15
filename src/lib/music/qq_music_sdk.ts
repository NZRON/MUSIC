import {
	checkQQLoginQr,
	getLyric,
	getMusicPlay,
	getQQLoginQr,
	search,
} from '@sansenjian/qq-music-api/sdk';
import { getUserAvatar } from '@sansenjian/qq-music-api/services';
import { txHeaders, txRequest, upgradeTxAudioUrl, zzcSign } from './native_tx';
import { inflateRawSync, inflateSync, unzipSync } from 'node:zlib';

type QqSdkResponse = {
	status: number;
	body?: Record<string, any>;
};

const QQ_SDK_QUALITY_MAP: Record<string, string> = {
	'4': '128',
	'8': '320',
	'10': 'flac',
	'11': 'flac',
	'14': 'flac',
	'128': '128',
	'320': '320',
	'128k': '128',
	'320k': '320',
	flac: 'flac',
	sq: 'flac',
	hires: 'flac',
};

// ─── Cookie 与鉴权相关常量 ─────────────────────────────────────────────────
const QQ_AUTH_COOKIE_KEYS = [
	'qqCookiePlaybackKey',
	'qm_keyst',
	'qqmusic_key',
	'music_key',
];
const QQ_PLAYBACK_KEY = 'qqCookiePlaybackKey';
const QQ_MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const QQ_MUSICS_URL = 'https://u.y.qq.com/cgi-bin/musics.fcg';
const QQ_COMMON_QUERY = {
	g_tk: '1124214810',
	hostUin: '0',
	inCharset: 'utf8',
	outCharset: 'utf-8',
	notice: '0',
	platform: 'yqq.json',
	needNewCode: '0',
};
const QQ_OFFICIAL_HEADERS = {
	'User-Agent':
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
	referer: 'https://y.qq.com/portal/player.html',
	host: 'u.y.qq.com',
	'content-type': 'application/x-www-form-urlencoded',
};

// ─── 音质前缀与降级链 ──────────────────────────────────────────────────────
// M500: 128k (游客可用), M800: 320k (需会员), C400: m4a, F000: flac
const QQ_PLAY_FILE_TYPE_MAP: Record<
	string,
	{ prefix: string; suffix: string }
> = {
	m4a: { prefix: 'C400', suffix: '.m4a' },
	'128': { prefix: 'M500', suffix: '.mp3' },
	'320': { prefix: 'M800', suffix: '.mp3' },
	flac: { prefix: 'F000', suffix: '.flac' },
};

// 音质等级排序（从高到低），用于构建降级链
const QUALITY_TIER: Record<string, number> = {
	flac: 4,
	hires: 4,
	'320': 3,
	'128': 2,
	m4a: 1,
};

// ─── 工具函数 ──────────────────────────────────────────────────────────────
const unwrapQqSdkResponse = (
	response: QqSdkResponse,
	fallbackMessage: string
) => {
	const status = Number(response?.status || 500);
	const body = response?.body || {};
	if (status >= 400 || body.error) {
		throw new Error(String(body.error || body.message || fallbackMessage));
	}
	return body;
};

const parseCookieObject = (cookie?: string) => {
	const result: Record<string, string> = {};
	if (!cookie) return result;
	cookie.split(';').forEach((item) => {
		const separatorIndex = item.indexOf('=');
		if (separatorIndex <= 0) return;
		const key = item.slice(0, separatorIndex).trim();
		const value = item.slice(separatorIndex + 1).trim();
		if (key && value) result[key] = value;
	});
	return result;
};

const serializeCookieObject = (cookieObject: Record<string, string>) => {
	return Object.entries(cookieObject)
		.filter(([key, value]) => key && value)
		.map(([key, value]) => `${key}=${value}`)
		.join('; ');
};

export const normalizeQqCookie = (cookie?: string) => {
	const cookieObject = parseCookieObject(cookie);
	// 保留所有原始字段，不做覆盖，避免丢失 qqCookiePlaybackKey
	return serializeCookieObject(cookieObject);
};

export const getQqCookieDiagnostic = (cookie?: string) => {
	const normalizedCookie = normalizeQqCookie(cookie);
	const cookieObject = parseCookieObject(normalizedCookie);
	const authKeys = QQ_AUTH_COOKIE_KEYS.filter((key) =>
		Boolean(cookieObject[key])
	);

	return {
		hasCookie: Boolean(normalizedCookie),
		hasUin: Boolean(cookieObject.uin || cookieObject.wxuin),
		uinType: cookieObject.wxuin
			? 'wxuin'
			: cookieObject.uin
			? 'uin'
			: 'missing',
		hasAuthKey: authKeys.length > 0,
		hasPlaybackKey: Boolean(cookieObject[QQ_PLAYBACK_KEY]),
		authKeySource: cookieObject[QQ_PLAYBACK_KEY]
			? QQ_PLAYBACK_KEY
			: cookieObject.qm_keyst
			? 'qm_keyst'
			: cookieObject.qqmusic_key
			? 'qqmusic_key'
			: cookieObject.music_key
			? 'music_key'
			: 'missing',
		authKeys,
	};
};

const decodeMaybeBase64 = (value: unknown) => {
	if (typeof value !== 'string' || !value) return '';
	const normalizedValue = value.trim();
	if (
		!/^[A-Za-z0-9+/]+={0,2}$/.test(normalizedValue) ||
		normalizedValue.length % 4 !== 0
	) {
		return value;
	}
	try {
		const decoded = Buffer.from(normalizedValue, 'base64').toString();
		if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/.test(decoded)) {
			return value;
		}
		if (!/[\r\n[\]\u4e00-\u9fa5]/.test(decoded)) {
			return value;
		}
		return decoded || value;
	} catch {
		return value;
	}
};

const isHttpAudioUrl = (value: string) => /^https?:\/\//i.test(value.trim());

const findFirstUrl = (value: unknown): string => {
	if (!value) return '';
	if (typeof value === 'string') {
		return isHttpAudioUrl(value) ? value : '';
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			const url = findFirstUrl(item);
			if (url) return url;
		}
		return '';
	}
	if (typeof value === 'object') {
		const record = value as Record<string, any>;
		if (typeof record.url === 'string' && isHttpAudioUrl(record.url)) {
			return record.url;
		}
		for (const item of Object.values(record)) {
			const url = findFirstUrl(item);
			if (url) return url;
		}
	}
	return '';
};

const collectPlayUrlErrors = (value: unknown): string[] => {
	if (!value) return [];
	if (Array.isArray(value)) {
		return value.flatMap((item) => collectPlayUrlErrors(item));
	}
	if (typeof value === 'object') {
		const record = value as Record<string, any>;
		const currentError =
			typeof record.error === 'string' ? [record.error] : [];
		return [
			...currentError,
			...Object.values(record).flatMap((item) =>
				collectPlayUrlErrors(item)
			),
		];
	}
	return [];
};

const normalizeQqSdkQuality = (quality: unknown) => {
	const key = String(quality ?? '320').toLowerCase();
	return QQ_SDK_QUALITY_MAP[key] || '320';
};

const pickPlayableDomain = (sip: unknown) => {
	if (!Array.isArray(sip)) return '';
	const urls = sip.filter(
		(item) => typeof item === 'string' && item.length > 0
	);
	return (
		urls.find((url) => !url.startsWith('http://ws')) ||
		urls.find((url) => url.startsWith('https://')) ||
		urls[0] ||
		''
	);
};

const joinUrl = (domain: string, path: string) => {
	if (domain.endsWith('/') && path.startsWith('/'))
		return `${domain}${path.slice(1)}`;
	if (!domain.endsWith('/') && !path.startsWith('/'))
		return `${domain}/${path}`;
	return `${domain}${path}`;
};

const buildQqOfficialPlayUrl = (
	domain: string,
	info: Record<string, any> | undefined,
	guid: string
) => {
	if (!domain || !info) return '';
	if (info.purl) return joinUrl(domain, info.purl);
	if (info.vkey && info.filename) {
		return `${joinUrl(domain, info.filename)}?vkey=${
			info.vkey
		}&guid=${guid}&fromtag=66`;
	}
	return '';
};

const resolveQqVkeyUin = (cookieObject: Record<string, string>) => {
	return cookieObject.uin || cookieObject.wxuin || '0';
};

/**
 * 从 Cookie 中提取用于 authst 的凭证。
 * 优先级：qqCookiePlaybackKey > qm_keyst > qqmusic_key > music_key
 * 仅有网页登录态（qqmusic_key）但缺少播放票据（qqCookiePlaybackKey）时，
 * 免费歌曲也可能命中 104003。
 */
const resolveAuthst = (cookieObject: Record<string, string>) => {
	return (
		cookieObject[QQ_PLAYBACK_KEY] ||
		cookieObject.qm_keyst ||
		cookieObject.qqmusic_key ||
		cookieObject.music_key ||
		undefined
	);
};

// ─── vkey 请求封装 ─────────────────────────────────────────────────────────
const requestQqOfficialVkey = async (
	payload: Record<string, any>,
	cookie: string,
	useSignedRequest: boolean
) => {
	const headers: Record<string, string> = useSignedRequest
		? { ...txHeaders, 'Content-Type': 'application/json' }
		: { ...QQ_OFFICIAL_HEADERS };
	if (cookie) headers.Cookie = cookie;

	if (useSignedRequest) {
		const sign = await zzcSign(JSON.stringify(payload));
		const response = await fetch(`${QQ_MUSICS_URL}?sign=${sign}`, {
			method: 'POST',
			headers,
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(6000),
		});
		if (!response.ok)
			throw new Error(`QQ Signed vkey HTTP ${response.status}`);
		return await response.json();
	}

	// 普通请求：GET + query string
	const query = new URLSearchParams({
		...QQ_COMMON_QUERY,
		loginUin: payload.loginUin || '0',
		format: 'json',
		data: JSON.stringify(payload),
	});
	const response = await fetch(`${QQ_MUSICU_URL}?${query.toString()}`, {
		method: 'GET',
		headers,
		signal: AbortSignal.timeout(6000),
	});
	if (!response.ok) throw new Error(`QQ vkey HTTP ${response.status}`);
	return await response.json();
};

const parseQqOfficialPlayUrl = (
	response: Record<string, any> | undefined,
	songmid: string,
	guid: string
) => {
	const data = response?.req_0?.data;
	const domain = pickPlayableDomain(data?.sip);
	const midurlinfo = Array.isArray(data?.midurlinfo) ? data.midurlinfo : [];
	const info =
		midurlinfo.find(
			(item: Record<string, any>) => item?.songmid === songmid
		) || midurlinfo[0];
	const url = buildQqOfficialPlayUrl(domain, info, guid);
	return { url, info };
};

/**
 * 构造 vkey 请求体。
 * 注意：comm 中加入 authst 可以解决部分歌曲“能登录但拿不到链接”的问题。
 */
const createQqOfficialVkeyPayload = ({
	songmid,
	filename,
	guid,
	uin,
	authst,
}: {
	songmid: string;
	filename: string;
	guid: string;
	uin: string;
	authst?: string;
}) => {
	const comm: Record<string, any> = {
		uin,
		format: 'json',
		ct: 24,
		cv: 0,
	};
	if (authst) {
		comm.authst = authst;
	}

	return {
		req_0: {
			module: 'vkey.GetVkeyServer',
			method: 'CgiGetVkey',
			param: {
				filename: [filename],
				guid,
				songmid: [songmid],
				songtype: [0],
				uin,
				loginflag: 1,
				platform: '20',
			},
		},
		loginUin: uin,
		comm,
	};
};

/** 生成随机 GUID，避免固定值被风控标记 */
const buildRandomGuid = () =>
	String(Math.floor(1e9 + Math.random() * 9e9));

/**
 * 构建音质降级链。
 * 如果调用方指定了 quality，则从该音质开始；
 * 否则默认从 320k 开始，依次降级到 128k、m4a。
 */
const buildQualityChain = (quality?: unknown): string[] => {
	const preferred = normalizeQqSdkQuality(quality);
	const tier = QUALITY_TIER[preferred] ?? 3;
	const chain = Object.entries(QUALITY_TIER)
		.filter(([, t]) => t <= tier)
		.sort((a, b) => b[1] - a[1])
		.map(([q]) => q);
	// 确保去重且只保留 QQ_PLAY_FILE_TYPE_MAP 中存在的音质
	const result = [...new Set(chain)].filter(
		(q) => QQ_PLAY_FILE_TYPE_MAP[q]
	);
	return result.length ? result : ['320', '128', 'm4a'];
};

// ─── 官方 vkey 解析主函数（带音质降级）─────────────────────────────────────
export const resolveQqOfficialPlayUrl = async ({
	songmid,
	quality,
	cookie,
	mediaId,
}: {
	songmid: string;
	quality?: unknown;
	cookie?: string;
	mediaId?: string;
}) => {
	const normalizedCookie = normalizeQqCookie(cookie);
	const cookieObject = parseCookieObject(normalizedCookie);
	const songmidValue = String(songmid || '').trim();

	if (!songmidValue) {
		throw new Error('QQ 官方接口缺少 songmid');
	}

	// 播放文件 ID 优先使用 songmid（传统 vkey filename 格式为 PREFIX+ID+ID.SUFFIX）
	// 如果显式提供了 mediaId，则作为备选尝试
	const fileIds = [songmidValue];
	if (mediaId && mediaId !== songmidValue) {
		fileIds.push(mediaId);
	}

	const guid = buildRandomGuid();
	const uin = resolveQqVkeyUin(cookieObject);
	const authst = resolveAuthst(cookieObject);
	const qualityChain = buildQualityChain(quality);

	let lastErrorInfo = '';

	for (const fileId of fileIds) {
		for (const q of qualityChain) {
			const fileType = QQ_PLAY_FILE_TYPE_MAP[q];
			if (!fileType) continue;

			const filename = `${fileType.prefix}${fileId}${fileType.suffix}`;
			const payload = createQqOfficialVkeyPayload({
				songmid: songmidValue,
				filename,
				guid,
				uin,
				authst,
			});

			let response: Record<string, any> | undefined;
			let parseError: string | undefined;

			// 优先签名请求（稳定性更好）
			try {
				response = await requestQqOfficialVkey(
					payload,
					normalizedCookie,
					true
				);
			} catch (signedErr) {
				console.warn(
					`[qq_music_sdk] 签名请求失败 (quality=${q}, fileId=${fileId})，尝试普通请求:`,
					signedErr
				);
				try {
					response = await requestQqOfficialVkey(
						payload,
						normalizedCookie,
						false
					);
				} catch (normalErr) {
					parseError = String(normalErr);
				}
			}

			if (!response) {
				lastErrorInfo = `network: ${parseError}`;
				continue;
			}

			const parsed = parseQqOfficialPlayUrl(
				response,
				songmidValue,
				guid
			);

			if (parsed.url) {
				return upgradeTxAudioUrl(parsed.url);
			}

			const info = parsed.info;
			const resultCode =
				info?.result === undefined ? 'missing' : String(info.result);
			const subcode =
				info?.subcode === undefined ? 'missing' : String(info.subcode);

			lastErrorInfo = `quality=${q}, fileId=${fileId}, filename=${filename}, result=${resultCode}, subcode=${subcode}, purl=${Boolean(
				info?.purl
			)}, vkey=${Boolean(info?.vkey)}`;

			// 104003 = 无权限 / 等级不够 → 继续尝试更低音质
			if (String(info?.result) === '104003') {
				console.warn(
					`[qq_music_sdk] ${q} 音质返回 104003（无权限），降级重试`
				);
				continue;
			}

			// 104004 = VKey 获取失败（可能是 fileId 不对）→ 继续尝试下一个 fileId
			if (String(info?.result) === '104004') {
				console.warn(
					`[qq_music_sdk] ${q} 音质返回 104004（VKey 失败），尝试其他 fileId`
				);
				break; // 跳出当前音质循环，进入下一个 fileId
			}

			// 其他错误码，继续降级尝试
			console.warn(
				`[qq_music_sdk] ${q} 音质失败 (result=${resultCode})，降级重试`
			);
		}
	}

	const diagnostic = getQqCookieDiagnostic(normalizedCookie);
	const authHint = diagnostic.hasCookie
		? `（Cookie: uin=${
				diagnostic.hasUin ? `present:${diagnostic.uinType}` : 'missing'
		  }, authKey=${
				diagnostic.hasAuthKey
					? `${diagnostic.authKeys.join('/')}, used=${
							diagnostic.authKeySource
					  }`
					: 'missing'
		  }, playbackKey=${
				diagnostic.hasPlaybackKey ? 'present' : 'missing'
		  }）`
		: '（未传 Cookie）';

	throw new Error(
		`QQ 官方接口所有音质/文件ID均失败。最后错误：${lastErrorInfo}。${authHint}。` +
			`提示：104003 通常是因为缺少 qqCookiePlaybackKey（播放票据），仅有 qqmusic_key 不够。`
	);
};

// ─── SDK 播放解析（保留作为兜底，但需要完整 Cookie）─────────────────────────
export const resolveQqSdkPlayUrl = async (
	songmid: string,
	quality?: unknown,
	cookie?: string,
	mediaId?: string
) => {
	const normalizedCookie = normalizeQqCookie(cookie);
	const body = unwrapQqSdkResponse(
		await getMusicPlay({
			songmid,
			quality: normalizeQqSdkQuality(quality),
			mediaId,
			cookie: normalizedCookie,
		}),
		'qq-music-api 未返回播放链接'
	);

	const data = body?.response || body?.data || body;
	const url =
		findFirstUrl(data?.url) ||
		findFirstUrl(data?.playUrl?.[songmid]) ||
		findFirstUrl(data?.playUrl);

	if (!url || typeof url !== 'string') {
		const errors = collectPlayUrlErrors(
			data?.playUrl?.[songmid] || data?.playUrl
		);
		const diagnostic = getQqCookieDiagnostic(normalizedCookie);
		const reason = errors.length
			? `：${[...new Set(errors)].join('、')}`
			: '';
		const authHint = diagnostic.hasCookie
			? `（Cookie: uin=${
					diagnostic.hasUin
						? `present:${diagnostic.uinType}`
						: 'missing'
			  }, authKey=${
					diagnostic.hasAuthKey
						? `${diagnostic.authKeys.join('/')}, used=${
								diagnostic.authKeySource
						  }`
						: 'missing'
			  }, playbackKey=${
					diagnostic.hasPlaybackKey ? 'present' : 'missing'
			  }）`
			: '（未传 Cookie）';
		throw new Error(`qq-music-api 未返回播放链接${reason}${authHint}`);
	}

	return upgradeTxAudioUrl(url);
};

// ─── 歌词 ──────────────────────────────────────────────────────────────────
export const resolveQqSdkLyric = async ({
	songmid,
	songid,
	cookie,
}: {
	songmid?: string;
	songid?: string;
	cookie?: string;
}) => {
	const normalizedCookie = normalizeQqCookie(cookie);
	const body = unwrapQqSdkResponse(
		await getLyric({
			songmid,
			songid,
			isFormat: false,
			cookie: normalizedCookie,
		}),
		'qq-music-api 未返回歌词'
	);

	const data = body.response || body.data || body;
	const lrc =
		typeof data?.lyric === 'string'
			? data.lyric
			: decodeMaybeBase64(data?.lrc);
	const trans = decodeMaybeBase64(data?.trans);

	if (!lrc) {
		throw new Error('qq-music-api 未返回歌词');
	}

	return { lrc, trans };
};

// ─── 登录 / 用户信息 / 搜索（保持原样）─────────────────────────────────────
export const getQqLoginQr = async () => {
	const body = unwrapQqSdkResponse(
		await getQQLoginQr(),
		'获取 QQ 登录二维码失败'
	);
	return body.response || body.data || body;
};

export const checkQqLogin = async (
	ptqrtoken: string | number,
	qrsig: string
) => {
	const body = unwrapQqSdkResponse(
		await checkQQLoginQr({ ptqrtoken, qrsig }),
		'检查 QQ 登录状态失败'
	);
	return body.response || body.data || body;
};

export const getQqUserAvatar = async ({
	uin,
	k,
	size = 140,
}: {
	uin?: string;
	k?: string;
	size?: number;
}) => {
	return await getUserAvatar({ uin, k, size });
};

export const searchQqMusic = async ({
	key,
	limit,
	page,
	cookie,
}: {
	key: string;
	limit?: number;
	page?: number;
	cookie?: string;
}) => {
	const normalizedCookie = normalizeQqCookie(cookie);
	const body = unwrapQqSdkResponse(
		await search({
			key,
			limit,
			page,
			option: normalizedCookie
				? { headers: { Cookie: normalizedCookie } }
				: undefined,
		}),
		'qq-music-api 搜索失败'
	);

	return body.response || body.data || body;
};

// ─── QRC 解密（与原版一致，未改动）─────────────────────────────────────────
const QRC_KEY = Buffer.from('!@#)(*$%123ZXC!@!@#)(NHL', 'utf8');

const SBOX: number[][] = [
	[
		14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14,
		2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12,
		9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13,
	],
	[
		15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15,
		2, 8, 15, 12, 0, 1, 10, 6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8,
		12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14,
		9,
	],
	[
		10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4,
		6, 10, 2, 8, 5, 14, 12, 11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2,
		12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12,
	],
	[
		7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6,
		15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1,
		3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 10, 13, 8, 9, 4, 5, 11, 12, 7, 2,
		14,
	],
	[
		2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4,
		7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9,
		12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5,
		3,
	],
	[
		12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7,
		12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4,
		10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13,
	],
	[
		4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4,
		9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15,
		6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12,
	],
	[
		13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10,
		3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10,
		13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11,
	],
];

const _bn = (a: Buffer, b: number, c: number): number => {
	const bi = Math.floor(b / 32) * 4 + 3 - Math.floor((b % 32) / 8);
	return ((a[bi] >> (7 - (b % 8))) & 1) << c;
};
const _bni = (a: number, b: number, c: number): number =>
	((a >> (31 - b)) & 1) << c;
const _bnl = (a: number, b: number, c: number): number =>
	(((a << b) & 0x80000000) >>> c) >>> 0;
const _sb = (a: number): number => (a & 32) | ((a & 31) >> 1) | ((a & 1) << 4);

const _ip = (inp: Buffer): [number, number] => {
	const s0 =
		(_bn(inp, 57, 31) |
			_bn(inp, 49, 30) |
			_bn(inp, 41, 29) |
			_bn(inp, 33, 28) |
			_bn(inp, 25, 27) |
			_bn(inp, 17, 26) |
			_bn(inp, 9, 25) |
			_bn(inp, 1, 24) |
			_bn(inp, 59, 23) |
			_bn(inp, 51, 22) |
			_bn(inp, 43, 21) |
			_bn(inp, 35, 20) |
			_bn(inp, 27, 19) |
			_bn(inp, 19, 18) |
			_bn(inp, 11, 17) |
			_bn(inp, 3, 16) |
			_bn(inp, 61, 15) |
			_bn(inp, 53, 14) |
			_bn(inp, 45, 13) |
			_bn(inp, 37, 12) |
			_bn(inp, 29, 11) |
			_bn(inp, 21, 10) |
			_bn(inp, 13, 9) |
			_bn(inp, 5, 8) |
			_bn(inp, 63, 7) |
			_bn(inp, 55, 6) |
			_bn(inp, 47, 5) |
			_bn(inp, 39, 4) |
			_bn(inp, 31, 3) |
			_bn(inp, 23, 2) |
			_bn(inp, 15, 1) |
			_bn(inp, 7, 0)) >>>
		0;
	const s1 =
		(_bn(inp, 56, 31) |
			_bn(inp, 48, 30) |
			_bn(inp, 40, 29) |
			_bn(inp, 32, 28) |
			_bn(inp, 24, 27) |
			_bn(inp, 16, 26) |
			_bn(inp, 8, 25) |
			_bn(inp, 0, 24) |
			_bn(inp, 58, 23) |
			_bn(inp, 50, 22) |
			_bn(inp, 42, 21) |
			_bn(inp, 34, 20) |
			_bn(inp, 26, 19) |
			_bn(inp, 18, 18) |
			_bn(inp, 10, 17) |
			_bn(inp, 2, 16) |
			_bn(inp, 60, 15) |
			_bn(inp, 52, 14) |
			_bn(inp, 44, 13) |
			_bn(inp, 36, 12) |
			_bn(inp, 28, 11) |
			_bn(inp, 20, 10) |
			_bn(inp, 12, 9) |
			_bn(inp, 4, 8) |
			_bn(inp, 62, 7) |
			_bn(inp, 54, 6) |
			_bn(inp, 46, 5) |
			_bn(inp, 38, 4) |
			_bn(inp, 30, 3) |
			_bn(inp, 22, 2) |
			_bn(inp, 14, 1) |
			_bn(inp, 6, 0)) >>>
		0;
	return [s0, s1];
};

const _fp = (s0: number, s1: number): Buffer => {
	const d = Buffer.alloc(8);
	d[3] = _bni(s1, 7, 7) | _bni(s0, 7, 6) | _bni(s1, 15, 5) | _bni(s0, 15, 4) | _bni(s1, 23, 3) | _bni(s0, 23, 2) | _bni(s1, 31, 1) | _bni(s0, 31, 0);
	d[2] = _bni(s1, 6, 7) | _bni(s0, 6, 6) | _bni(s1, 14, 5) | _bni(s0, 14, 4) | _bni(s1, 22, 3) | _bni(s0, 22, 2) | _bni(s1, 30, 1) | _bni(s0, 30, 0);
	d[1] = _bni(s1, 5, 7) | _bni(s0, 5, 6) | _bni(s1, 13, 5) | _bni(s0, 13, 4) | _bni(s1, 21, 3) | _bni(s0, 21, 2) | _bni(s1, 29, 1) | _bni(s0, 29, 0);
	d[0] = _bni(s1, 4, 7) | _bni(s0, 4, 6) | _bni(s1, 12, 5) | _bni(s0, 12, 4) | _bni(s1, 20, 3) | _bni(s0, 20, 2) | _bni(s1, 28, 1) | _bni(s0, 28, 0);
	d[7] = _bni(s1, 3, 7) | _bni(s0, 3, 6) | _bni(s1, 11, 5) | _bni(s0, 11, 4) | _bni(s1, 19, 3) | _bni(s0, 19, 2) | _bni(s1, 27, 1) | _bni(s0, 27, 0);
	d[6] = _bni(s1, 2, 7) | _bni(s0, 2, 6) | _bni(s1, 10, 5) | _bni(s0, 10, 4) | _bni(s1, 18, 3) | _bni(s0, 18, 2) | _bni(s1, 26, 1) | _bni(s0, 26, 0);
	d[5] = _bni(s1, 1, 7) | _bni(s0, 1, 6) | _bni(s1, 9, 5) | _bni(s0, 9, 4) | _bni(s1, 17, 3) | _bni(s0, 17, 2) | _bni(s1, 25, 1) | _bni(s0, 25, 0);
	d[4] = _bni(s1, 0, 7) | _bni(s0, 0, 6) | _bni(s1, 8, 5) | _bni(s0, 8, 4) | _bni(s1, 16, 3) | _bni(s0, 16, 2) | _bni(s1, 24, 1) | _bni(s0, 24, 0);
	return d;
};

const _f = (state: number, key: number[]): number => {
	const t1 =
		(_bnl(state, 31, 0) | ((state & 0xf0000000) >>> 1) | _bnl(state, 4, 5) | _bnl(state, 3, 6) | ((state & 0x0f000000) >>> 3) | _bnl(state, 8, 11) | _bnl(state, 7, 12) | ((state & 0x00f00000) >>> 5) | _bnl(state, 12, 17) | _bnl(state, 11, 18) | ((state & 0x000f0000) >>> 7) | _bnl(state, 16, 23)) >>> 0;
	const t2 =
		(_bnl(state, 15, 0) | ((state & 0x0000f000) << 15) | _bnl(state, 20, 5) | _bnl(state, 19, 6) | ((state & 0x00000f00) << 13) | _bnl(state, 24, 11) | _bnl(state, 23, 12) | ((state & 0x000000f0) << 11) | _bnl(state, 28, 17) | _bnl(state, 27, 18) | ((state & 0x0000000f) << 9) | _bnl(state, 0, 23)) >>> 0;
	const lg = [
		((t1 >>> 24) & 0xff) ^ key[0],
		((t1 >>> 16) & 0xff) ^ key[1],
		((t1 >>> 8) & 0xff) ^ key[2],
		((t2 >>> 24) & 0xff) ^ key[3],
		((t2 >>> 16) & 0xff) ^ key[4],
		((t2 >>> 8) & 0xff) ^ key[5],
	];
	state =
		((SBOX[0][_sb(lg[0] >>> 2)] << 28) | (SBOX[1][_sb(((lg[0] & 3) << 4) | (lg[1] >>> 4))] << 24) | (SBOX[2][_sb(((lg[1] & 15) << 2) | (lg[2] >>> 6))] << 20) | (SBOX[3][_sb(lg[2] & 63)] << 16) | (SBOX[4][_sb(lg[3] >>> 2)] << 12) | (SBOX[5][_sb(((lg[3] & 3) << 4) | (lg[4] >>> 4))] << 8) | (SBOX[6][_sb(((lg[4] & 15) << 2) | (lg[5] >>> 6))] << 4) | SBOX[7][_sb(lg[5] & 63)]) >>> 0;
	return (
		(_bnl(state, 15, 0) | _bnl(state, 6, 1) | _bnl(state, 19, 2) | _bnl(state, 20, 3) | _bnl(state, 28, 4) | _bnl(state, 11, 5) | _bnl(state, 27, 6) | _bnl(state, 16, 7) | _bnl(state, 0, 8) | _bnl(state, 14, 9) | _bnl(state, 22, 10) | _bnl(state, 25, 11) | _bnl(state, 4, 12) | _bnl(state, 17, 13) | _bnl(state, 30, 14) | _bnl(state, 9, 15) | _bnl(state, 1, 16) | _bnl(state, 7, 17) | _bnl(state, 23, 18) | _bnl(state, 13, 19) | _bnl(state, 31, 20) | _bnl(state, 26, 21) | _bnl(state, 2, 22) | _bnl(state, 8, 23) | _bnl(state, 18, 24) | _bnl(state, 12, 25) | _bnl(state, 29, 26) | _bnl(state, 5, 27) | _bnl(state, 21, 28) | _bnl(state, 10, 29) | _bnl(state, 3, 30) | _bnl(state, 24, 31)) >>> 0
	);
};

const _ks = (key: Buffer, mode: number): number[][] => {
	const sch: number[][] = Array.from({ length: 16 }, () => Array(6).fill(0));
	const sh = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
	const pC = [56, 48, 40, 32, 24, 16, 8, 0, 57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35];
	const pD = [62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 60, 52, 44, 36, 28, 20, 12, 4, 27, 19, 11, 3];
	const cp = [13, 16, 10, 23, 0, 4, 2, 27, 14, 5, 20, 9, 22, 18, 11, 3, 25, 7, 15, 6, 26, 19, 12, 1, 40, 51, 30, 36, 46, 54, 29, 39, 50, 44, 32, 47, 43, 48, 38, 55, 33, 52, 45, 41, 49, 35, 28, 31];
	let c = 0, d = 0;
	for (let i = 0; i < 28; i++) { c |= _bn(key, pC[i], 31 - i); d |= _bn(key, pD[i], 31 - i); }
	for (let i = 0; i < 16; i++) {
		c = (((c << sh[i]) | (c >>> (28 - sh[i]))) & 0xfffffff0) >>> 0;
		d = (((d << sh[i]) | (d >>> (28 - sh[i]))) & 0xfffffff0) >>> 0;
		const t = mode === 0 ? 15 - i : i;
		for (let j = 0; j < 24; j++) sch[t][Math.floor(j / 8)] |= _bni(c, cp[j], 7 - (j % 8));
		for (let j = 24; j < 48; j++) sch[t][Math.floor(j / 8)] |= _bni(d, cp[j] - 27, 7 - (j % 8));
	}
	return sch;
};

const _desBlock = (inp: Buffer, key: number[][]): Buffer => {
	let [s0, s1] = _ip(inp);
	for (let i = 0; i < 15; i++) { const p = s1; s1 = (_f(s1, key[i]) ^ s0) >>> 0; s0 = p; }
	s0 = (_f(s1, key[15]) ^ s0) >>> 0;
	return _fp(s0, s1);
};

const QRC_DES_KEYS = {
	k1: _ks(QRC_KEY.slice(16, 24), 0),
	k2: _ks(QRC_KEY.slice(8, 16), 1),
	k3: _ks(QRC_KEY.slice(0, 8), 0),
};

const tripleDesDecrypt = (data: Buffer): Buffer => {
	const { k1, k2, k3 } = QRC_DES_KEYS;
	const result = Buffer.alloc(data.length);
	for (let i = 0; i < data.length; i += 8) {
		const b = data.slice(i, i + 8);
		_desBlock(_desBlock(_desBlock(b, k1), k2), k3).copy(result, i);
	}
	return result;
};

const decryptQrc = (encryptedHex: string): string => {
	if (!encryptedHex?.trim()) throw new Error('QRC 密文为空');
	const decrypted = tripleDesDecrypt(Buffer.from(encryptedHex, 'hex'));
	for (const decompress of [inflateSync, inflateRawSync, unzipSync]) {
		try { return decompress(decrypted).toString('utf8'); } catch { /* 继续 */ }
	}
	const raw = decrypted.toString('utf8');
	if (raw.includes('[') || raw.includes('<')) return raw;
	throw new Error('QRC 解压失败');
};

const tryDecryptQrc = (hex: string | undefined): string | undefined => {
	if (!hex) return undefined;
	try { return decryptQrc(hex); } catch { return undefined; }
};

// ─── QQ 音乐原生歌词接口（支持 QRC 逐字）────────────────────────────────────
export const resolveQqNativeLyric = async ({
	songId,
	name = '',
	artist = '',
	album = '',
	duration = 0,
	cookie,
}: {
	songId: string | number;
	name?: string;
	artist?: string;
	album?: string;
	duration?: number;
	cookie?: string;
}): Promise<{ lrc?: string; qrc?: string; trans?: string; roma?: string }> => {
	const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

	const baseParam = {
		albumName: b64(album),
		crypt: 1,
		ct: 19,
		cv: 2111,
		interval: duration,
		lrc_t: 0,
		qrc: 1,
		qrc_t: 0,
		roma: 1,
		roma_t: 0,
		singerName: b64(artist),
		songID: Number(songId),
		songName: b64(name),
		trans: 1,
		trans_t: 0,
		type: 0,
	};

	const buildBody = (param: Record<string, unknown>) => ({
		comm: { ct: '19', cv: '1859', uin: '0' },
		req: {
			module: 'music.musichallSong.PlayLyricInfo',
			method: 'GetPlayLyricInfo',
			param,
		},
	});

	const normalizedCookie = cookie ? normalizeQqCookie(cookie) : '';

	const doRequest = async (param: Record<string, unknown>) => {
		const body = buildBody(param);
		const headers: Record<string, string> = {
			...txHeaders,
			'Content-Type': 'application/json',
		};
		if (normalizedCookie) headers['Cookie'] = normalizedCookie;

		try {
			const sign = await zzcSign(JSON.stringify(body));
			const response = await fetch(
				`https://u.y.qq.com/cgi-bin/musics.fcg?sign=${sign}`,
				{
					method: 'POST',
					headers,
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(8000),
				}
			);
			if (!response.ok)
				throw new Error(`QQ lyric signed HTTP ${response.status}`);
			return await response.json();
		} catch (signedErr) {
			console.warn(
				'[qq_music_sdk] QRC 签名请求失败，回退到普通请求:',
				signedErr
			);
			const response = await fetch(
				'https://u.y.qq.com/cgi-bin/musicu.fcg',
				{
					method: 'POST',
					headers,
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(8000),
				}
			);
			if (!response.ok)
				throw new Error(`QQ lyric HTTP ${response.status}`);
			return await response.json();
		}
	};

	const resp = await doRequest(baseParam);
	const data = resp?.req?.data ?? resp?.request?.data ?? {};
	const result: {
		lrc?: string;
		qrc?: string;
		trans?: string;
		roma?: string;
	} = {};

	const mainDecrypted = tryDecryptQrc(data.lyric);
	if (mainDecrypted) {
		if (typeof data.qrc_t === 'number' && data.qrc_t !== 0) {
			result.qrc = mainDecrypted;
		} else {
			result.lrc = mainDecrypted;
		}
	}

	if (result.qrc && !result.lrc) {
		try {
			const lrcResp = await doRequest({ ...baseParam, qrc: 0, qrc_t: 0 });
			const lrcData = lrcResp?.req?.data ?? lrcResp?.request?.data ?? {};
			const lrcText = tryDecryptQrc(lrcData.lyric);
			if (lrcText) result.lrc = lrcText;
		} catch (lrcErr) {
			console.warn('[qq_music_sdk] 补充 LRC 请求失败:', lrcErr);
		}
	}

	result.trans = tryDecryptQrc(data.trans) || undefined;
	result.roma = tryDecryptQrc(data.roma) || undefined;

	return result;
};
