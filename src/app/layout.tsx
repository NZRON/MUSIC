import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Toaster as SonnerToaster } from '@/components/ui/sonner';
import { IOS_POLYFILL_SCRIPT } from '@/lib/ios-polyfills';
export const metadata: Metadata = {
	title: 'VoiceCity',
	description:
		'找歌 · 听歌识曲 · 播放列表 — 统一播放器，本地 indexedDB 记录。',
	icons: { icon: '/logo.svg' },
};
export const viewport: Viewport = {
	width: 'device-width',
	initialScale: 1,
	maximumScale: 5,
	viewportFit: 'cover',
	themeColor: '#e0e7ff',
};
export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang="zh-CN" suppressHydrationWarning>
			<head>
				<script
					dangerouslySetInnerHTML={{ __html: IOS_POLYFILL_SCRIPT }}
				/>
			</head>
			<body className="antialiased min-h-screen text-slate-800 selection:bg-blue-500 selection:text-white">
				{children}
				<SonnerToaster theme="light" position="top-center" richColors />
			</body>
		</html>
	);
}
