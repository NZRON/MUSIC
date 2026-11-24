import { ok, fail, handleError, readBody } from '@/lib/api';
const WY_UA =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36';
export async function POST(req: Request) {
	try {
		const body = await readBody<{ unikey?: string }>(req);
		const unikey = (body.unikey ?? '').trim();
		if (!unikey) return fail('缺少 unikey', 400);
		const loginRes = await fetch(
			`https://music.163.com/api/login/qrcode/client/login?type=1&noToken=true&unikey=${unikey}`,
			{
				method: 'POST',
				headers: {
					'User-Agent': WY_UA,
					Referer: 'https://music.163.com',
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: `type=1&noToken=true&unikey=${unikey}`,
				signal: AbortSignal.timeout(10000),
			}
		);
		if (!loginRes.ok)
			return fail(`网易云登录检查失败: HTTP ${loginRes.status}`, 502);
		const setCookie = loginRes.headers.get('set-cookie') || '';
		const json = (await loginRes.json()) as {
			code?: number;
			accountId?: number;
			profile?: {
				nickname?: string;
				avatarUrl?: string;
				userId?: number;
			};
			message?: string;
		};
		let status: 'waiting' | 'success' | 'expired' = 'waiting';
		let cookie = '';
		let user:
			| { userId?: string; nickname?: string; avatarUrl?: string }
			| undefined;
		if (json.code === 803) {
			status = 'success';
			const cookies: string[] = [];
			for (const c of setCookie.split(',')) {
				const trimmed = c.trim();
				if (
					trimmed.startsWith('MUSIC_U=') ||
					trimmed.startsWith('__csrf=') ||
					trimmed.startsWith('NMTID=') ||
					trimmed.startsWith('os=')
				) {
					cookies.push(trimmed.split(';')[0]);
				}
			}
			cookie = cookies.join('; ');
			user = {
				userId: json.profile?.userId
					? String(json.profile.userId)
					: String(json.accountId || ''),
				nickname: json.profile?.nickname || '网易云音乐账号',
				avatarUrl: json.profile?.avatarUrl || '',
			};
		} else if (json.code === 800) {
			status = 'expired';
		} else if (json.code === 801 || json.code === 802) {
			status = 'waiting';
		}
		return ok({
			status,
			cookie: cookie || undefined,
			user,
			message: json.message,
		});
	} catch (err) {
		return handleError(err);
	}
}
