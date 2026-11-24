import { ok, fail, handleError } from '@/lib/api';
import { fetchNetEaseLyric } from '@/lib/music/netease';
import {
	resolveQqNativeLyric,
	resolveQqSdkLyric,
} from '@/lib/music/qq_music_sdk';
import { getTxSongPlayableInfo } from '@/lib/music/native_tx';
export async function GET(req: Request) {
	try {
		const url = new URL(req.url);
		const platform = url.searchParams.get('platform') ?? '';
		let musicId = url.searchParams.get('musicId') ?? '';
		let rawId = musicId;
		let detected = platform;
		if (musicId.startsWith('wy-')) {
			rawId = musicId.slice(3);
			detected = 'netease';
		} else if (musicId.startsWith('qq-')) {
			rawId = musicId.slice(3);
			detected = 'qq';
		} else if (musicId.startsWith('bili-')) {
			rawId = musicId.slice(5);
			detected = 'bilibili';
		}
		if (detected === 'bilibili') {
			return fail('B站视频暂无歌词', 404);
		}
		let lyric: string | null = null;
		if (detected === 'netease') {
			lyric = await fetchNetEaseLyric(rawId);
		} else if (detected === 'qq') {
			const playableInfo = await getTxSongPlayableInfo(rawId);
			const songId = playableInfo.songId || '';
			const songmid = playableInfo.songmid || rawId;
			if (songId) {
				try {
					const data = await resolveQqNativeLyric({ songId });
					lyric = data.lrc || data.qrc || null;
				} catch (e) {
					console.warn(
						'[lyric] 原生 QRC 接口失败，回退到 SDK 接口:',
						e
					);
				}
			}
			if (!lyric) {
				try {
					const sdkLyric = await resolveQqSdkLyric({
						songmid,
						songid: songId,
					});
					lyric = sdkLyric.lrc || null;
				} catch (sdkErr) {
					console.warn('[lyric] SDK 接口失败，回退到旧接口:', sdkErr);
				}
			}
			if (!lyric) {
				const params = new URLSearchParams({
					format: 'json',
					outCharset: 'utf-8',
					pcachetime: String(Date.now()),
					loginUin: '0',
					...(songmid ? { songmid } : {}),
					...(songId ? { songid: songId } : {}),
				});
				const response = await fetch(
					`https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?${params.toString()}`,
					{
						headers: {
							Referer: 'https://y.qq.com/portal/player.html',
							'User-Agent':
								'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
						},
						signal: AbortSignal.timeout(8000),
					}
				);
				if (!response.ok)
					throw new Error(`QQ 歌词接口返回 ${response.status}`);
				const text = await response.text();
				let legacyData: any;
				try {
					legacyData = JSON.parse(text);
				} catch {
					legacyData = JSON.parse(
						text.replace(/^\w+\(/, '').replace(/\)\s*$/, '')
					);
				}
				if (!legacyData || legacyData.code !== 0) {
					throw new Error(
						`QQ 歌词接口异常: ${legacyData?.code ?? '未知'}`
					);
				}
				const decodeBase64 = (value: unknown): string => {
					if (typeof value !== 'string' || !value) return '';
					try {
						return Buffer.from(value, 'base64').toString() || value;
					} catch {
						return value;
					}
				};
				lyric = decodeBase64(legacyData.lyric) || null;
			}
		} else {
			return fail(`不支持的平台: ${detected}`, 400);
		}
		if (!lyric) return fail('未找到歌词', 404);
		return ok({ lyric });
	} catch (err) {
		return handleError(err);
	}
}
