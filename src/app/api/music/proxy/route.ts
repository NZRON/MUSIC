import { fail, handleError } from '@/lib/api';
import { getPlayerConfig } from '@/lib/player-config';
export async function GET(req: Request) {
	try {
		const config = await getPlayerConfig();
		if (!config.proxyEnabled) {
			return fail('音乐代理已被管理员关闭', 403);
		}
		const url = new URL(req.url);
		const target = url.searchParams.get('url');
		if (!target || !/^https?:\/\//.test(target)) {
			return fail('Invalid url', 400);
		}
		const targetUrl = new URL(target);
		const headers: Record<string, string> = {
			'User-Agent':
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
		};
		if (
			targetUrl.hostname.includes('bilibili.com') ||
			targetUrl.hostname.includes('bilivideo.com') ||
			targetUrl.hostname.includes('hdslb.com')
		) {
			headers.Referer = 'https://www.bilibili.com/';
			headers.Origin = 'https://www.bilibili.com';
		} else if (
			targetUrl.hostname.includes('music.126.net') ||
			targetUrl.hostname.includes('163.com')
		) {
			headers.Referer = 'https://music.163.com/';
		} else if (
			targetUrl.hostname.includes('y.qq.com') ||
			targetUrl.hostname.includes('gtimg.cn')
		) {
			headers.Referer = 'https://y.qq.com/';
		}
		const range = req.headers.get('range');
		if (range) headers.Range = range;
		const upstream = await fetch(target, {
			headers,
			signal: AbortSignal.timeout(30000),
		});
		if (!upstream.ok) {
			return fail(`上游 ${upstream.status}`, upstream.status);
		}
		const contentType =
			upstream.headers.get('content-type') ?? 'audio/mpeg';
		const contentLength = upstream.headers.get('content-length');
		const acceptRanges = upstream.headers.get('accept-ranges');
		const contentRange = upstream.headers.get('content-range');
		const respHeaders: Record<string, string> = {
			'Content-Type': contentType,
			'Cache-Control': 'public, max-age=3600',
			'Access-Control-Allow-Origin': '*',
		};
		if (contentLength) respHeaders['Content-Length'] = contentLength;
		if (acceptRanges) respHeaders['Accept-Ranges'] = acceptRanges;
		if (contentRange) respHeaders['Content-Range'] = contentRange;
		return new Response(upstream.body, {
			status: upstream.status,
			headers: respHeaders,
		});
	} catch (err) {
		return handleError(err);
	}
}
