import { ok, fail, handleError } from '@/lib/api';
import { resolveBilibiliUrl } from '@/lib/music/bilibili';
export async function GET(req: Request) {
	try {
		const url = new URL(req.url);
		const bvid = url.searchParams.get('id') ?? '';
		const cid = url.searchParams.get('cid') ?? undefined;
		if (!bvid) return fail('缺少 id 参数', 400);
		const forwardedFor = req.headers.get('x-forwarded-for');
		const forwardedForStr = forwardedFor
			? forwardedFor.split(',')[0].trim()
			: '';
		const clientIp = forwardedForStr || req.headers.get('x-real-ip') || '';
		const result = await resolveBilibiliUrl(bvid, cid, clientIp);
		return ok(result);
	} catch (err) {
		return handleError(err);
	}
}
