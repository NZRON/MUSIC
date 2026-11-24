import { ok, fail, handleError, readBody } from '@/lib/api';
import { getPlayerConfig, setPlayerConfig } from '@/lib/player-config';
import { requireAdmin } from '@/lib/auth';
export async function GET() {
	try {
		const config = await getPlayerConfig();
		return ok(config);
	} catch (err) {
		return handleError(err);
	}
}
export async function POST(req: Request) {
	try {
		await requireAdmin();
		const body = await readBody<
			Partial<import('@/lib/player-config').PlayerConfig>
		>(req);
		const updated = await setPlayerConfig(body);
		return ok(updated);
	} catch (err) {
		const e = err as Error & { status?: number };
		if (e.status === 401) return fail('请先登录管理员', 401);
		return handleError(err);
	}
}
