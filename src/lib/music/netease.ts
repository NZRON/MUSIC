/**
 * NetEase Cloud Music (网易云音乐) platform plugin.
 *
 * 保留原版所有 headers 与 EAPI 加密流程，无简化。
 * search / resolveUrl / lyric 均自包含，统一由 /api/music/proxy 转发流。
 */

import { createHash, createCipheriv } from 'node:crypto';
import { getMusicCookie } from '@/lib/kv';

// ============================================================================
// EAPI 加密（与原版一致）
// ============================================================================
const EAPI_KEY = 'e82ckenh8dichen8';

function aesEncrypt(
	buffer: Buffer,
	mode: string,
	key: string | Buffer,
	iv: string | Buffer
): Buffer {
	const cipher = createCipheriv(mode, key, iv);
	return Buffer.concat([cipher.update(buffer), cipher.final()]);
}

export function eapi(url: string, object: unknown): { params: string } {
	const text =
		typeof object === 'object' ? JSON.stringify(object) : String(object);
	const message = `nobody${url}use${text}md5forencrypt`;
	const digest = createHash('md5').update(message).digest('hex');
	const data = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
	return {
		params: aesEncrypt(Buffer.from(data), 'aes-128-ecb', EAPI_KEY, '')
			.toString('hex')
			.toUpperCase(),
	};
}

// ============================================================================
// Headers（原版 4 套 header 合并去重）
// ============================================================================
const WY_UA =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36';

function headers(extra?: Record<string, string>): Record<string, string> {
	return {
		'User-Agent': WY_UA,
		Referer: 'https://music.163.com',
		origin: 'https://music.163.com',
		...extra,
	};
}

// ============================================================================
// 类型
// ============================================================================
export interface NetEaseSong {
	id: number;
	name: string;
	artist: string;
	album: string;
	albumId: number;
	duration: number; // seconds
	cover: string;
}

/** cloudsearch 用 ar/al/dt，老接口用 artists/album/duration，统一兼容 */
interface RawSong {
	id: number;
	name: string;
	ar?: Array<{ name: string }>;
	al?: { id?: number; name?: string; picUrl?: string };
	dt?: number;
	artists?: Array<{ name: string }>;
	album?: { id?: number; name?: string; picUrl?: string };
	duration?: number;
}

interface UrlData {
	data?: Array<{ url?: string; code?: number }>;
}

// ============================================================================
// 工具
// ============================================================================
function toHttps(url?: string | null): string {
	if (!url) return '';
	return url.replace(/^http:\/\//, 'https://');
}

function normalizeSong(s: RawSong): NetEaseSong {
	const artists = s.ar ?? s.artists ?? [];
	const album = s.al ?? s.album;
	const durMs = s.dt ?? s.duration ?? 0;
	return {
		id: s.id,
		name: s.name,
		artist: artists.map((a) => a.name).join('、') || '未知',
		album: album?.name ?? '',
		albumId: album?.id ?? 0,
		duration: Math.round(durMs / 1000),
		cover: toHttps(album?.picUrl),
	};
}

// ============================================================================
// EAPI 请求封装
// ============================================================================
async function eapiPost(
	path: string,
	payload: Record<string, unknown>,
	cookie?: string
): Promise<Response> {
	const { params } = eapi(path, payload);
	const body = new URLSearchParams({ params }).toString();
	return fetch(`https://music.163.com${path}`, {
		method: 'POST',
		headers: headers({
			'Content-Type': 'application/x-www-form-urlencoded',
			...(cookie ? { Cookie: cookie } : {}),
		}),
		body,
		signal: AbortSignal.timeout(10000),
	});
}

// ============================================================================
// 搜索：主路径 eapi cloudsearch，兜底老接口 + song/detail 补封面
// ============================================================================
export async function searchNetEase(
	keyword: string,
	limit = 20
): Promise<NetEaseSong[]> {
	// 1. EAPI cloudsearch —— 字段全、封面稳定
	try {
		const res = await eapiPost('/api/cloudsearch/pc', {
			s: keyword,
			type: 1,
			limit,
			offset: 0,
			total: true,
		});
		if (res.ok) {
			const json = (await res.json()) as {
				code?: number;
				result?: { songs?: RawSong[] };
			};
			if (json.code === 200) {
				return (json.result?.songs ?? []).map(normalizeSong);
			}
			console.warn(`[netease] cloudsearch code=${json.code}, fallback`);
		}
	} catch (e) {
		console.warn('[netease] cloudsearch failed, fallback:', e);
	}

	// 2. 兜底：老搜索接口（封面常缺）
	const url = `https://music.163.com/api/search/get?s=${encodeURIComponent(
		keyword
	)}&type=1&limit=${limit}`;
	const res = await fetch(url, {
		headers: headers(),
		signal: AbortSignal.timeout(10000),
	});
	if (!res.ok) throw new Error(`网易云音乐搜索失败: HTTP ${res.status}`);
	const json = (await res.json()) as {
		code?: number;
		result?: { songs?: RawSong[] };
	};
	if (json.code !== 200)
		throw new Error(`网易云音乐搜索接口异常: code=${json.code}`);

	const songs = (json.result?.songs ?? []).map(normalizeSong);
	if (songs.some((s) => !s.cover)) await fillCovers(songs);
	return songs;
}

async function fillCovers(songs: NetEaseSong[]): Promise<void> {
	try {
		const ids = songs.filter((s) => !s.cover).map((s) => s.id);
		if (!ids.length) return;
		const url = `https://music.163.com/api/song/detail?ids=${encodeURIComponent(
			`[${ids.join(',')}]`
		)}`;
		const res = await fetch(url, {
			headers: headers(),
			signal: AbortSignal.timeout(10000),
		});
		if (!res.ok) return;
		const json = (await res.json()) as {
			songs?: Array<{
				id: number;
				al?: { picUrl?: string };
				album?: { picUrl?: string };
			}>;
		};
		const coverMap = new Map<number, string>();
		for (const s of json.songs ?? []) {
			const pic = s.al?.picUrl ?? s.album?.picUrl;
			if (pic) coverMap.set(s.id, toHttps(pic));
		}
		for (const s of songs) {
			if (!s.cover) s.cover = coverMap.get(s.id) ?? '';
		}
	} catch (e) {
		console.warn('[netease] fillCovers failed:', e);
	}
}

// ============================================================================
// URL 解析：抽象三种来源，消除重复
// ============================================================================
async function tryEnhanceUrl(
	songId: number | string,
	cookie?: string
): Promise<string | null> {
	try {
		const url = `https://music.163.com/api/song/enhance/player/url/v1?ids=${encodeURIComponent(
			`[${songId}]`
		)}&level=exhigh&encodeType=mp3`;
		const res = await fetch(url, {
			headers: headers({ Cookie: cookie ? `os=pc; ${cookie}` : 'os=pc' }),
			signal: AbortSignal.timeout(8000),
		});
		if (!res.ok) return null;
		const json = (await res.json()) as UrlData;
		return json.data?.[0]?.url ?? null;
	} catch (e) {
		console.warn(
			`[netease] enhance url${cookie ? ' (cookie)' : ''} failed:`,
			e
		);
		return null;
	}
}

async function tryMeting(songId: number | string): Promise<string | null> {
	try {
		const metingUrl = `https://api.injahow.cn/meting/?type=url&server=netease&id=${encodeURIComponent(
			String(songId)
		)}`;
		const res = await fetch(metingUrl, {
			method: 'GET',
			redirect: 'manual',
			headers: { 'User-Agent': WY_UA },
			signal: AbortSignal.timeout(8000),
		});
		if (res.status === 301 || res.status === 302) {
			const loc = res.headers.get('location');
			if (loc?.startsWith('http')) return loc;
		}
		const ct = res.headers.get('content-type') ?? '';
		if (res.ok && (ct.startsWith('audio') || ct.includes('octet-stream'))) {
			return metingUrl;
		}
	} catch (e) {
		console.warn('[netease] Meting failed:', e);
	}
	return null;
}

async function tryOuterUrl(songId: number | string): Promise<string | null> {
	try {
		const outerUrl = `https://music.163.com/song/media/outer/url?id=${encodeURIComponent(
			String(songId)
		)}.mp3`;
		const res = await fetch(outerUrl, {
			method: 'GET',
			redirect: 'manual',
			headers: { 'User-Agent': WY_UA },
			signal: AbortSignal.timeout(6000),
		});
		const loc = res.headers.get('location');
		if (loc && !loc.includes('/404')) return loc;
	} catch (e) {
		console.warn('[netease] outer url failed:', e);
	}
	return null;
}

export async function resolveNetEaseUrl(
	songId: number | string,
	loginCookie?: string
): Promise<string> {
	// 优先使用传入的 cookie，如果没有则自动从 KV / 环境变量中获取
	const activeCookie = loginCookie || (await getMusicCookie('netease')) || undefined;

	// 1. 登录 Cookie → 官方 enhance（可解析 VIP）
	if (activeCookie) {
		const u = await tryEnhanceUrl(songId, activeCookie);
		if (u) return u;
	}
	// 2. Meting 镜像
	const meting = await tryMeting(songId);
	if (meting) return meting;
	// 3. 无 Cookie 官方 enhance
	const u2 = await tryEnhanceUrl(songId);
	if (u2) return u2;
	// 4. outer url 跳转
	const outer = await tryOuterUrl(songId);
	if (outer) return outer;

	throw new Error(
		`网易云音乐无法解析播放链接 (songId=${songId})，可能为 VIP 或版权受限，请扫码登录网易云后重试`
	);
}

// ============================================================================
// 歌词（保持原行为）
// ============================================================================
export async function fetchNetEaseLyric(
	songId: number | string
): Promise<string> {
	const url = `https://music.163.com/api/song/lyric?id=${encodeURIComponent(
		String(songId)
	)}&lv=1&kv=1&tv=-1`;
	const res = await fetch(url, {
		headers: headers(),
		signal: AbortSignal.timeout(8000),
	});
	if (!res.ok) throw new Error(`网易云歌词获取失败: HTTP ${res.status}`);
	const json = (await res.json()) as {
		lrc?: { lyric?: string };
		code?: number;
	};
	if (!json.lrc?.lyric)
		throw new Error(`网易云未返回歌词 (songId=${songId})`);
	return json.lrc.lyric;
}
