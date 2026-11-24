import { ok, fail, handleError } from '@/lib/api';
const QQ_UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
export async function GET() {
	try {
		const loginPageRes = await fetch(
			'https://ssl.ptlogin2.qq.com/ptqrshow?appid=716027609&e=2&l=M&s=3&d=72&v=4&t=0.1',
			{
				headers: {
					'User-Agent': QQ_UA,
					Referer: 'https://y.qq.com/',
				},
				redirect: 'manual',
				signal: AbortSignal.timeout(10000),
			}
		);
		const setCookie = loginPageRes.headers.get('set-cookie') || '';
		const qrsigMatch = setCookie.match(/qrsig=([^;]+)/);
		const qrsig = qrsigMatch ? qrsigMatch[1] : '';

		if (!qrsig) {
			return fail('获取 QQ 登录二维码失败：未获取到 qrsig', 502);
		}
		const contentType =
			loginPageRes.headers.get('content-type') || 'image/png';
		const arrayBuffer = await loginPageRes.arrayBuffer();
		const base64 = Buffer.from(arrayBuffer).toString('base64');
		const qrImageUrl = `data:${contentType};base64,${base64}`;
		const ptqrtoken = hashQrsig(qrsig);
		return ok({
			qrImageUrl,
			ptqrtoken,
			qrsig,
		});
	} catch (err) {
		return handleError(err);
	}
}
function hashQrsig(qrsig: string): number {
	let hash = 0;
	for (let i = 0; i < qrsig.length; i++) {
		hash += (hash << 5) + qrsig.charCodeAt(i);
		hash = hash & 0x7fffffff;
	}
	return hash;
}
