import { ok, fail, handleError } from '@/lib/api';
const WY_UA =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36';
export async function GET() {
	try {
		const unikeyRes = await fetch(
			'https://music.163.com/api/login/qrcode/unikey?type=1',
			{
				method: 'POST',
				headers: {
					'User-Agent': WY_UA,
					Referer: 'https://music.163.com',
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: 'type=1',
				signal: AbortSignal.timeout(10000),
			}
		);
		if (!unikeyRes.ok)
			return fail(
				`获取网易云 unikey 失败: HTTP ${unikeyRes.status}`,
				502
			);
		const unikeyJson = (await unikeyRes.json()) as {
			unikey?: string;
			code?: number;
		};
		if (unikeyJson.code !== 200 || !unikeyJson.unikey) {
			return fail(`获取网易云 unikey 失败: code=${unikeyJson.code}`, 502);
		}
		const unikey = unikeyJson.unikey;
		const qrUrl = `https://music.163.com/login?codekey=${unikey}`;
		return ok({
			unikey,
			qrUrl,
			qrImageUrl: `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(
				qrUrl
			)}`,
		});
	} catch (err) {
		return handleError(err);
	}
}
