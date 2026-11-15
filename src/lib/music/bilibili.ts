/**
 * Bilibili (哔哩哔哩) platform plugin.
 *
 * Port of VoiceHub's
 *   server/api/bilibili/search.get.ts +
 *   server/api/bilibili/playurl.get.ts
 *
 * Optimizations over the original verbatim port:
 *   - 统一 biliFetch：请求 / 超时 / 错误分类一处维护
 *   - view 接口：并发限制 + 60s TTL 缓存 + in-flight 去重 + FIFO 上限
 *   - 健壮的 HTML 实体解码与 duration 解析
 *   - search 支持 includePages:false 跳过 N 次 view 请求
 *   - 统一 VideoInfoRes 类型，删除不一致的 CidRes
 *   - 分类错误 BilibiliError（http / api / timeout）
 */

const BILI_UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 各接口超时（毫秒） */
const BILI_TIMEOUT = {
	search: 12_000,
	view: 8_000,
	playurl: 10_000,
} as const;

/** view 结果缓存 TTL */
const VIEW_CACHE_TTL = 60_000;
/** view 缓存最多保留多少条 bvid */
const VIEW_CACHE_MAX = 500;
/** 搜索后补全 pages 的最大并发 */
const VIEW_FETCH_CONCURRENCY = 5;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface SongInfo {
	id: number;
	bvid: string;
	title: string;
	author: string;
	pic: string;
	duration: string;
}

interface VideoPage {
	cid: number;
	page: number;
	part: string;
	duration: number;
}

interface VideoInfoRes {
	code: number;
	message: string;
	data: {
		pages: VideoPage[];
	};
}

interface SearchRes {
	code: number;
	message: string;
	data: {
		result: SongInfo[];
	};
}

interface PlayUrlRes {
	code: number;
	message: string;
	data: {
		durl: [{ url: string }];
	};
}

export interface BilibiliTrack {
	id: string;
	title: string;
	artist: string;
	source: 'bilibili';
	musicPlatform: 'bilibili';
	cover: string;
	duration: number;
	album: string;
	pages: VideoPage[];
}

/** 分类错误，便于上层做差异化处理（重试 / 刷新 buvid / 提示用户） */
export class BilibiliError extends Error {
	constructor(
		message: string,
		readonly kind: 'http' | 'api' | 'timeout',
		readonly code?: number,
		readonly status?: number
	) {
		super(message);
		this.name = 'BilibiliError';
	}
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 去标签 + 解码 HTML 实体（B站搜索标题同时含 <em> 和 &amp; 等） */
function cleanHtml(value: string): string {
	return value
		.replace(/<[^>]*>/g, '')
		.replace(/&#(\d+);/g, (_, n) => safeCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n) => safeCodePoint(parseInt(n, 16)))
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'");
}

function safeCodePoint(code: number): string {
	try {
		return String.fromCodePoint(code);
	} catch {
		return '';
	}
}

/** 兼容 "ss" / "mm:ss" / "hh:mm:ss"，非法输入返回 0 而非 NaN */
function parseDuration(s: string): number {
	if (!s) return 0;
	const parts = s.split(':').map((x) => Number.parseInt(x, 10));
	if (parts.length === 0 || parts.some(Number.isNaN)) return 0;
	return parts.reduce((acc, v) => acc * 60 + v, 0);
}

function normalizeCover(url: string): string {
	return url.startsWith('//') ? `https:${url}` : url;
}

function biConvertSong(song: SongInfo, pages?: VideoPage[]): BilibiliTrack {
	return {
		id: song.bvid,
		title: cleanHtml(song.title),
		artist: cleanHtml(song.author),
		source: 'bilibili',
		musicPlatform: 'bilibili',
		cover: normalizeCover(song.pic),
		duration: parseDuration(song.duration),
		album: 'Bilibili Video',
		pages: pages ?? [],
	};
}

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

function buildBiliHeaders(clientIp?: string): Record<string, string> {
	const headers: Record<string, string> = {
		Cookie: 'buvid3=0',
		Referer: 'https://www.bilibili.com/',
		'User-Agent': BILI_UA,
	};
	if (clientIp) {
		headers['X-Forwarded-For'] = clientIp;
		headers['X-Real-IP'] = clientIp;
		headers['Client-IP'] = clientIp;
	}
	return headers;
}

async function biliFetch<T>(
	url: string,
	clientIp: string | undefined,
	timeout: number
): Promise<T> {
	let resp: Response;
	try {
		resp = await fetch(url, {
			headers: buildBiliHeaders(clientIp),
			signal: AbortSignal.timeout(timeout),
		});
	} catch (err) {
		const name = (err as { name?: string } | null)?.name;
		if (name === 'TimeoutError' || name === 'AbortError') {
			throw new BilibiliError(`B站请求超时 (${timeout}ms)`, 'timeout');
		}
		throw err;
	}

	if (!resp.ok) {
		throw new BilibiliError(
			`B站请求失败: HTTP ${resp.status}`,
			'http',
			undefined,
			resp.status
		);
	}
	return (await resp.json()) as T;
}

// ---------------------------------------------------------------------------
// 并发控制
// ---------------------------------------------------------------------------

async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const workerCount = Math.min(limit, items.length);
	const workers = Array.from({ length: workerCount }, async () => {
		while (true) {
			const i = next++;
			if (i >= items.length) return;
			out[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return out;
}

// ---------------------------------------------------------------------------
// view 缓存 + in-flight 去重
// ---------------------------------------------------------------------------

interface ViewCacheEntry {
	pages: VideoPage[];
	exp: number;
}

const viewCache = new Map<string, ViewCacheEntry>();
const viewInflight = new Map<string, Promise<VideoPage[]>>();

function cacheViewPages(bvid: string, pages: VideoPage[]): void {
	if (viewCache.size >= VIEW_CACHE_MAX) {
		const now = Date.now();
		for (const [k, v] of viewCache) {
			if (v.exp <= now) viewCache.delete(k);
		}
		// 仍超限则按插入顺序 FIFO 淘汰
		while (viewCache.size >= VIEW_CACHE_MAX) {
			const oldest = viewCache.keys().next().value;
			if (oldest === undefined) break;
			viewCache.delete(oldest);
		}
	}
	viewCache.set(bvid, { pages, exp: Date.now() + VIEW_CACHE_TTL });
}

/**
 * 按需获取视频分P信息（带 TTL 缓存 + in-flight 去重）。
 * 失败时返回 []，不抛错，方便搜索场景降级；调用方需自行判断是否可用。
 */
export async function getVideoPages(
	bvid: string,
	clientIp?: string
): Promise<VideoPage[]> {
	const hit = viewCache.get(bvid);
	if (hit && hit.exp > Date.now()) return hit.pages;

	const running = viewInflight.get(bvid);
	if (running) return running;

	const task = (async (): Promise<VideoPage[]> => {
		try {
			const json = await biliFetch<VideoInfoRes>(
				`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
				clientIp,
				BILI_TIMEOUT.view
			);
			if (json.code !== 0) {
				console.log(
					`[bilibili] view ${bvid} 业务失败: code=${json.code} ${json.message}`
				);
				return [];
			}
			const pages = json.data?.pages ?? [];
			cacheViewPages(bvid, pages);
			return pages;
		} catch (err) {
			console.log(`[bilibili] view ${bvid} 请求失败:`, err);
			return [];
		} finally {
			viewInflight.delete(bvid);
		}
	})();

	viewInflight.set(bvid, task);
	return task;
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

export interface SearchBilibiliOptions {
	/** 转发给 B站的真实客户端 IP（可选） */
	clientIp?: string;
	/**
	 * 是否附带分P信息。默认 true（保持旧行为）。
	 * 只需要播放时传 false 可完全跳过 N 次 view 请求（性能提升最大）。
	 */
	includePages?: boolean;
}

/**
 * 搜索 B站视频。
 * - 默认保持旧行为：返回的每条 track 都带 pages；
 * - 传 { includePages: false } 可跳过 pages 补全（推荐用于纯播放场景）。
 */
export async function searchBilibili(
	keyword: string,
	limit = 15,
	options: SearchBilibiliOptions = {}
): Promise<BilibiliTrack[]> {
	if (!keyword) return [];
	const { clientIp, includePages = true } = options;

	const params = new URLSearchParams({
		__refresh__: 'true',
		page: '1',
		page_size: String(limit),
		platform: 'pc',
		highlight: '1',
		single_column: '0',
		keyword,
		search_type: 'video',
		dynamic_offset: '0',
		preload: 'true',
	});

	const json = await biliFetch<SearchRes>(
		`https://api.bilibili.com/x/web-interface/search/type?${params.toString()}`,
		clientIp,
		BILI_TIMEOUT.search
	);

	if (json.code !== 0 || !json.data?.result) {
		throw new BilibiliError(
			`B站搜索接口异常: ${json.message || `code=${json.code}`}`,
			'api',
			json.code
		);
	}

	const items = json.data.result;
	if (!includePages) {
		return items.map((s) => biConvertSong(s));
	}

	// 并发受限 + 每条 view 内部还有缓存/去重，避免风控 412
	return mapLimit(items, VIEW_FETCH_CONCURRENCY, async (song) => {
		const pages = await getVideoPages(song.bvid, clientIp);
		return biConvertSong(song, pages);
	});
}

// ---------------------------------------------------------------------------
// 播放链接
// ---------------------------------------------------------------------------

export interface ResolveBilibiliResult {
	url: string;
	pay: false;
}

/**
 * 解析 B站视频的可播放音频 URL。
 * 内部复用 getVideoPages 的缓存，避免和搜索阶段重复打 view。
 *
 * @param bvid     视频 bvid
 * @param cid      可选 cid；缺省时自动取第一个分P
 * @param clientIp 客户端真实 IP（可选，用于分配最快 CDN 节点）
 */
export async function resolveBilibiliUrl(
	bvid: string,
	cid?: string | number,
	clientIp?: string
): Promise<ResolveBilibiliResult> {
	if (!bvid) throw new BilibiliError('缺少 bvid 参数', 'api');

	let finalCid = cid != null && cid !== '' ? String(cid) : '';
	if (!finalCid) {
		const pages = await getVideoPages(bvid, clientIp);
		const firstCid = pages[0]?.cid;
		if (firstCid == null) {
			throw new BilibiliError('获取 CID 失败', 'api');
		}
		finalCid = String(firstCid);
	}

	// platform=html5 绕过严格防盗链，前端可用 referrerpolicy="no-referrer" 直接播
	const playParams = new URLSearchParams({
		fnval: '1',
		platform: 'html5',
		high_quality: '1',
		bvid,
		cid: finalCid,
	});

	const json = await biliFetch<PlayUrlRes>(
		`https://api.bilibili.com/x/player/playurl?${playParams.toString()}`,
		clientIp,
		BILI_TIMEOUT.playurl
	);

	if (json.code !== 0 || !json.data?.durl?.length) {
		throw new BilibiliError(
			`获取歌曲链接失败: ${json.message || '未知错误'}`,
			'api',
			json.code
		);
	}

	return { url: json.data.durl[0].url, pay: false };
}
