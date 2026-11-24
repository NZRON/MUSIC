export interface LyricLine {
	time: number;
	text: string;
}
export interface ParsedLyric {
	lines: LyricLine[];
	title?: string;
	artist?: string;
	album?: string;
	by?: string;
	offset: number;
}
const TIME_TAG_RE = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const META_RE = /^\[(ti|ar|al|by|offset):(.*)\]$/i;
export function parseLrc(raw: string): ParsedLyric {
	const result: ParsedLyric = { lines: [], offset: 0 };
	if (!raw) return result;
	const lines = raw.split(/\r?\n/);
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const meta = META_RE.exec(trimmed);
		if (meta) {
			const key = meta[1].toLowerCase();
			const val = meta[2].trim();
			if (key === 'ti') result.title = val;
			else if (key === 'ar') result.artist = val;
			else if (key === 'al') result.album = val;
			else if (key === 'by') result.by = val;
			else if (key === 'offset') result.offset = parseInt(val, 10) || 0;
			continue;
		}
		const times: number[] = [];
		let lastIndex = 0;
		let m: RegExpExecArray | null;
		TIME_TAG_RE.lastIndex = 0;
		let textStart = 0;
		while ((m = TIME_TAG_RE.exec(trimmed)) !== null) {
			const min = parseInt(m[1], 10);
			const sec = parseInt(m[2], 10);
			const ms = m[3] ? parseInt(m[3].padEnd(3, '0'), 10) : 0;
			times.push(min * 60 + sec + ms / 1000);
			textStart = TIME_TAG_RE.lastIndex;
			lastIndex = textStart;
		}
		if (times.length === 0) continue;
		const text = trimmed.slice(lastIndex).trim();
		for (const t of times) {
			result.lines.push({ time: t + result.offset / 1000, text });
		}
	}
	result.lines.sort((a, b) => a.time - b.time);
	return result;
}
export function findActiveLineIndex(
	lines: LyricLine[],
	currentTime: number
): number {
	if (lines.length === 0) return -1;
	let lo = 0;
	let hi = lines.length - 1;
	let ans = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (lines[mid].time <= currentTime) {
			ans = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return ans;
}
export function formatTime(sec: number): string {
	if (!Number.isFinite(sec) || sec < 0) return '0:00';
	const m = Math.floor(sec / 60);
	const s = Math.floor(sec % 60);
	return `${m}:${s.toString().padStart(2, '0')}`;
}
