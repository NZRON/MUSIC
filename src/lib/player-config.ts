export interface PlayerConfig {
	proxyEnabled: boolean;
	playerName: string;
	titleText: string;
	githubUrl: string;
	copyrightText: string;
}
export const DEFAULT_PLAYER_CONFIG: PlayerConfig = {
	proxyEnabled: true,
	playerName: '共享音乐',
	titleText: '共享音乐播放器',
	githubUrl: 'https://github.com/nzron/music',
	copyrightText: '© 2026 VoiceCity',
};
const KV_KEY = 'player-config';
export async function getPlayerConfig(): Promise<PlayerConfig> {
	const { getKV } = await import('./kv');
	const kv = await getKV();
	const stored = await kv.get<Partial<PlayerConfig>>(KV_KEY);
	if (!stored) return DEFAULT_PLAYER_CONFIG;
	return { ...DEFAULT_PLAYER_CONFIG, ...stored };
}
export async function setPlayerConfig(
	config: Partial<PlayerConfig>
): Promise<PlayerConfig> {
	const { getKV } = await import('./kv');
	const kv = await getKV();
	const current = await getPlayerConfig();
	const updated = { ...current, ...config };
	await kv.put(KV_KEY, updated);
	return updated;
}
