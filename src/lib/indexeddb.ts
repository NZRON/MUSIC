'use client';
import type { Song } from '@/types/voicehub';
const DB_NAME = 'voicecity-lite';
const DB_VERSION = 2;
const HISTORY_STORE = 'play-history';
const FAVORITES_STORE = 'favorites';
let dbPromise: Promise<IDBDatabase> | null = null;
function openDB(): Promise<IDBDatabase> {
	if (dbPromise) return dbPromise;
	dbPromise = new Promise((resolve, reject) => {
		if (typeof indexedDB === 'undefined') {
			reject(new Error('当前环境不支持 indexedDB'));
			return;
		}
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(HISTORY_STORE)) {
				db.createObjectStore(HISTORY_STORE, { keyPath: 'id' });
			}
			if (!db.objectStoreNames.contains(FAVORITES_STORE)) {
				db.createObjectStore(FAVORITES_STORE, { keyPath: 'id' });
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
	return dbPromise;
}
export async function addPlayHistory(song: Song): Promise<void> {
	const db = await openDB();
	const existing = await new Promise<Song | undefined>((resolve) => {
		const tx = db.transaction(HISTORY_STORE, 'readonly');
		const r = tx.objectStore(HISTORY_STORE).get(song.id);
		r.onsuccess = () => resolve(r.result as Song | undefined);
		r.onerror = () => resolve(undefined);
	});
	const record: Song = {
		...song,
		playedAt: new Date().toISOString(),
		favorited: existing?.favorited ?? false,
	};
	return new Promise((resolve, reject) => {
		const tx = db.transaction(HISTORY_STORE, 'readwrite');
		tx.objectStore(HISTORY_STORE).put(record);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}
export async function getPlayHistory(): Promise<Song[]> {
	const db = await openDB();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(HISTORY_STORE, 'readonly');
		const req = tx.objectStore(HISTORY_STORE).getAll();
		req.onsuccess = () => {
			const all = (req.result as Song[]) ?? [];
			const favorites = all.filter((s) => s.favorited);
			const normal = all.filter((s) => !s.favorited);
			const sortByPlayedAt = (a: Song, b: Song) => {
				const ta = a.playedAt ? new Date(a.playedAt).getTime() : 0;
				const tb = b.playedAt ? new Date(b.playedAt).getTime() : 0;
				return tb - ta;
			};
			favorites.sort(sortByPlayedAt);
			normal.sort(sortByPlayedAt);
			resolve([...favorites, ...normal]);
		};
		req.onerror = () => reject(req.error);
	});
}
export async function deletePlayHistory(id: string): Promise<void> {
	const db = await openDB();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(HISTORY_STORE, 'readwrite');
		tx.objectStore(HISTORY_STORE).delete(id);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}
export async function clearPlayHistory(): Promise<void> {
	const db = await openDB();
	const all = await getPlayHistory();
	const toDelete = all.filter((s) => !s.favorited);
	return new Promise((resolve, reject) => {
		const tx = db.transaction(HISTORY_STORE, 'readwrite');
		const store = tx.objectStore(HISTORY_STORE);
		for (const s of toDelete) {
			store.delete(s.id);
		}
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}
export async function favoriteSong(song: Song): Promise<void> {
	const db = await openDB();
	const favRecord: Song = {
		...song,
		favorited: true,
		favoritedAt: new Date().toISOString(),
	};
	return new Promise((resolve, reject) => {
		const tx = db.transaction(
			[FAVORITES_STORE, HISTORY_STORE],
			'readwrite'
		);
		tx.objectStore(FAVORITES_STORE).put(favRecord);
		const histStore = tx.objectStore(HISTORY_STORE);
		const getReq = histStore.get(song.id);
		getReq.onsuccess = () => {
			if (getReq.result) {
				const existing = getReq.result as Song;
				histStore.put({ ...existing, favorited: true });
			}
		};
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}
export async function unfavoriteSong(id: string): Promise<void> {
	const db = await openDB();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(
			[FAVORITES_STORE, HISTORY_STORE],
			'readwrite'
		);
		tx.objectStore(FAVORITES_STORE).delete(id);
		const histStore = tx.objectStore(HISTORY_STORE);
		const getReq = histStore.get(id);
		getReq.onsuccess = () => {
			if (getReq.result) {
				const existing = getReq.result as Song;
				histStore.put({ ...existing, favorited: false });
			}
		};
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}
export async function isFavorited(id: string): Promise<boolean> {
	const db = await openDB();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(FAVORITES_STORE, 'readonly');
		const r = tx.objectStore(FAVORITES_STORE).get(id);
		r.onsuccess = () => resolve(!!r.result);
		r.onerror = () => reject(r.error);
	});
}
export async function deleteFavorite(id: string): Promise<void> {
	const db = await openDB();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(
			[FAVORITES_STORE, HISTORY_STORE],
			'readwrite'
		);
		tx.objectStore(FAVORITES_STORE).delete(id);
		tx.objectStore(HISTORY_STORE).delete(id);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}
