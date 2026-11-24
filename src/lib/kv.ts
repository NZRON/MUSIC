interface KVLike {
	get<T = unknown>(key: string): Promise<T | null>;
	put<T = unknown>(key: string, value: T): Promise<void>;
	delete(key: string): Promise<void>;
}
let cached: KVLike | null = null;
const memoryStore = new Map<string, string>();
const memoryKV: KVLike = {
	async get<T>(key: string): Promise<T | null> {
		const v = memoryStore.get(key);
		if (!v) return null;
		try {
			return JSON.parse(v) as T;
		} catch {
			return null;
		}
	},
	async put<T>(key: string, value: T): Promise<void> {
		memoryStore.set(key, JSON.stringify(value));
	},
	async delete(key: string): Promise<void> {
		memoryStore.delete(key);
	},
};
async function getCfContextSafe(): Promise<{
	env?: Record<string, unknown>;
} | null> {
	try {
		const mod = await import('@opennextjs/cloudflare');
		const getCtx = (
			mod as {
				getCloudflareContext?: () =>
					| { env?: Record<string, unknown> }
					| Promise<{ env?: Record<string, unknown> }>;
			}
		).getCloudflareContext;
		if (typeof getCtx === 'function') {
			return (await getCtx()) ?? null;
		}
	} catch {}
	return null;
}
async function detectCloudflareKV(): Promise<KVLike | null> {
	const ctx = await getCfContextSafe();
	const kv = (ctx?.env as Record<string, unknown> | undefined)?.KV as
		| {
				get: (k: string) => Promise<string | null>;
				put: (k: string, v: string) => Promise<void>;
				delete?: (k: string) => Promise<void>;
		  }
		| undefined;
	if (kv && typeof kv.get === 'function' && typeof kv.put === 'function') {
		return {
			async get<T>(key: string): Promise<T | null> {
				const v = await kv.get(key);
				if (!v) return null;
				try {
					return JSON.parse(v) as T;
				} catch {
					return null;
				}
			},
			async put<T>(key: string, value: T): Promise<void> {
				await kv.put(key, JSON.stringify(value));
			},
			async delete(key: string): Promise<void> {
				await kv.delete?.(key);
			},
		};
	}
	return null;
}
export async function getKV(): Promise<KVLike> {
	if (cached) return cached;
	const cfKV = await detectCloudflareKV();
	cached = cfKV || memoryKV;
	return cached;
}
export async function isCloudflareKV(): Promise<boolean> {
	const kv = await getKV();
	return kv !== memoryKV;
}
export async function getEnvVar(key: string): Promise<string | undefined> {
	const ctx = await getCfContextSafe();
	const cfVal = ctx?.env?.[key];
	if (typeof cfVal === 'string' && cfVal.trim()) {
		return cfVal.trim();
	}
	const procVal = process.env[key];
	if (typeof procVal === 'string' && procVal.trim()) {
		return procVal.trim();
	}
	return undefined;
}
export async function syncEnvCookiesToKV(): Promise<{
	neteaseCookie: string;
	tencentCookie: string;
}> {
	const kv = await getKV();
	const envNetease = (await getEnvVar('NETEASE_COOKIE')) || '';
	const envTencent = (await getEnvVar('TENCENT_COOKIE')) || '';
	const storedNetease = (await kv.get<string>('music_cookie_netease')) || '';
	const storedTencent = (await kv.get<string>('music_cookie_tencent')) || '';
	if (envNetease && envNetease !== storedNetease) {
		await kv.put('music_cookie_netease', envNetease);
	}
	if (envTencent && envTencent !== storedTencent) {
		await kv.put('music_cookie_tencent', envTencent);
	}
	return {
		neteaseCookie: envNetease || storedNetease,
		tencentCookie: envTencent || storedTencent,
	};
}
