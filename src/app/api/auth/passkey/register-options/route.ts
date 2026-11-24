import { requireAdmin } from '@/lib/auth';
import { ok, handleError } from '@/lib/api';
import { getKV } from '@/lib/kv';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import { getRpId } from '@/lib/passkey-config';
const RP_NAME = '共享音乐播放器';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export async function POST(req: Request) {
	try {
		const user = await requireAdmin();
		const rpId = getRpId(req);
		const kv = await getKV();
		const credentials =
			(await kv.get<
				Array<{
					credentialId: string;
					publicKey: number[];
					counter: number;
					transports?: string[];
				}>
			>('passkey-credentials')) || [];
		const options = await generateRegistrationOptions({
			rpName: RP_NAME,
			rpID: rpId,
			userID: new TextEncoder().encode(user.id),
			userName: user.username,
			userDisplayName: user.name || user.username,
			attestationType: 'none',
			excludeCredentials: credentials.map((c) => ({
				id: c.credentialId,
				type: 'public-key',
			})),
			authenticatorSelection: {
				residentKey: 'preferred',
				userVerification: 'preferred',
			},
		});
		const challenges =
			(await kv.get<
				Array<{ challenge: string; purpose: string; expiresAt: number }>
			>('passkey-challenges')) || [];
		challenges.push({
			challenge: options.challenge,
			purpose: 'register',
			expiresAt: Date.now() + CHALLENGE_TTL_MS,
		});
		const validChallenges = challenges.filter(
			(c) => c.expiresAt > Date.now()
		);
		await kv.put('passkey-challenges', validChallenges);
		return ok(options);
	} catch (err) {
		return handleError(err);
	}
}
