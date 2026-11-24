'use client';
import { create } from 'zustand';
import type { Song, ViewKey } from '@/types/voicehub';
import type { PlayerConfig } from '@/lib/player-config';
export type MediaType = 'audio' | 'video';
export interface AuthUser {
	id: string;
	username: string;
	name: string | null;
	role: string;
	email: string | null;
}
interface VoiceCityLiteState {
	view: ViewKey;
	setView: (v: ViewKey) => void;
	previewPlayingId: string | null;
	setPreviewPlayingId: (id: string | null) => void;
	currentSong: Song | null;
	isPlaying: boolean;
	mediaType: MediaType;
	setCurrentSong: (s: Song | null) => void;
	setIsPlaying: (p: boolean) => void;
	playSong: (s: Song) => void;
	stopPlayer: () => void;
	audioMatchOpen: boolean;
	setAudioMatchOpen: (v: boolean) => void;
	historyVersion: number;
	bumpHistory: () => void;
	user: AuthUser | null;
	setUser: (u: AuthUser | null) => void;
	loginOpen: boolean;
	setLoginOpen: (v: boolean) => void;
	accountOpen: boolean;
	setAccountOpen: (v: boolean) => void;
	playerConfig: PlayerConfig | null;
	setPlayerConfig: (c: PlayerConfig | null) => void;
}
function deriveMediaType(song: Song | null): MediaType {
	if (!song) return 'audio';
	return song.musicPlatform === 'bilibili' ? 'video' : 'audio';
}
export const useStore = create<VoiceCityLiteState>((set, get) => ({
	view: 'find',
	setView: (v) => set({ view: v }),
	previewPlayingId: null,
	setPreviewPlayingId: (id) => set({ previewPlayingId: id }),
	currentSong: null,
	isPlaying: false,
	mediaType: 'audio',
	setCurrentSong: (s) =>
		set({
			currentSong: s,
			isPlaying: !!s,
			mediaType: deriveMediaType(s),
			previewPlayingId: s ? null : get().previewPlayingId,
		}),
	setIsPlaying: (p) => set({ isPlaying: p }),
	playSong: (s) =>
		set({
			currentSong: s,
			isPlaying: true,
			mediaType: deriveMediaType(s),
			previewPlayingId: null,
		}),
	stopPlayer: () => {
		set({ currentSong: null, isPlaying: false, previewPlayingId: null });
	},
	audioMatchOpen: false,
	setAudioMatchOpen: (v) => set({ audioMatchOpen: v }),
	historyVersion: 0,
	bumpHistory: () => set({ historyVersion: get().historyVersion + 1 }),
	user: null,
	setUser: (u) => set({ user: u }),
	loginOpen: false,
	setLoginOpen: (v) => set({ loginOpen: v }),
	accountOpen: false,
	setAccountOpen: (v) => set({ accountOpen: v }),
	playerConfig: null,
	setPlayerConfig: (c) => set({ playerConfig: c }),
}));
