export type MusicPlatform = 'netease' | 'qq' | 'bilibili' | 'custom';
export interface MusicSearchResult {
	id: string;
	title: string;
	artist: string;
	cover?: string | null;
	platform: MusicPlatform;
	duration?: number | null;
	playUrl?: string;
	lrc?: string | null;
}
export interface Song {
	id: string;
	title: string;
	artist: string;
	cover: string | null;
	musicPlatform: MusicPlatform | null;
	musicId: string | null;
	lrc: string | null;
	duration: number | null;
	playedAt?: string;
	favorited?: boolean;
	favoritedAt?: string;
}
export type ViewKey = 'find' | 'history';
