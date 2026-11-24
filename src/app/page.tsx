'use client';
import { useEffect } from 'react';
import { useStore } from '@/lib/store';
import { api } from '@/lib/api-client';
import { SiteFooter } from '@/components/voicehub/site-footer';
import { FindMusicView } from '@/components/voicehub/views/find-music-view';
import { PlayHistoryView } from '@/components/voicehub/views/play-history-view';
import { MusicPlayer } from '@/components/voicehub/music-player';
import { SetupGuard } from '@/components/voicehub/setup-guard';
import { LoginDialog } from '@/components/voicehub/login-dialog';
import { AccountDialog } from '@/components/voicehub/account-dialog';
export default function HomePage() {
	const { view, setUser, setPlayerConfig } = useStore();
	useEffect(() => {
		(async () => {
			try {
				const config = await api.getPlayerConfig();
				setPlayerConfig(config);
			} catch {}
			try {
				const { user } = await api.me();
				setUser(user);
			} catch {
				setUser(null);
			}
		})();
	}, [setUser, setPlayerConfig]);
	return (
		<div className="relative min-h-screen flex flex-col bg-background overflow-x-hidden">
			<div className="ellipse-glow" />
			<main className="relative z-10 flex-1 flex flex-col w-full">
				{view === 'find' && <FindMusicView />}
				{view === 'history' && <PlayHistoryView />}
			</main>
			<MusicPlayer />
			<SiteFooter />
			<LoginDialog />
			<AccountDialog />
			<SetupGuard />
		</div>
	);
}
