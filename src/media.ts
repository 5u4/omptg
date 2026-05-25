/**
 * Helpers for downloading telegram-hosted media into the local image
 * cache so the agent's `inspect_image` tool (or anything else that takes
 * a filesystem path) can read it.
 *
 * Hermes-style flow:
 *   1. Telegram delivers file_id for a PhotoSize.
 *   2. We resolve the file URL via getFile(), fetch bytes, write to
 *      `~/.omptg/image-cache/<uuid>.<ext>`, return the local path.
 *   3. main.ts injects the path into the agent prompt as text
 *      ("[user attached image: /path/...]"); the main agent decides
 *      whether to call inspect_image with its own question.
 *
 * Cache hygiene: prune the cache directory when it grows past
 * MAX_CACHE_BYTES, keeping the most recently modified files.
 */
import { Buffer } from "node:buffer";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { randomUUID } from "node:crypto";
import type { Bot } from "grammy";

const CACHE_DIR = resolvePath(homedir(), ".omptg", "image-cache");
/** Soft cap; pruning runs after every write that crosses this. */
const MAX_CACHE_BYTES = 200 * 1024 * 1024; // 200 MB
/** Hard per-file cap (decompression bombs / accidental huge forwards). */
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

mkdirSync(CACHE_DIR, { recursive: true });

/** Map telegram-served extension → standard mime. */
const EXT_TO_MIME: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
	".gif": "image/gif",
};

/**
 * Download a telegram file to the local image cache. Returns the absolute
 * path on disk. Caller should treat the path as ephemeral — survives long
 * enough for the agent turn that referenced it but may be pruned later.
 *
 * Throws on:
 *   - getFile rejection / no file_path
 *   - HTTP non-OK
 *   - oversized payload (> MAX_DOWNLOAD_BYTES)
 */
export async function downloadPhotoToCache(bot: Bot, fileId: string): Promise<{
	path: string;
	mimeType: string;
	bytes: number;
}> {
	const file = await bot.api.getFile(fileId);
	if (!file.file_path) {
		throw new Error(`getFile returned no file_path for ${fileId}`);
	}
	// URL embeds bot token; do not log this.
	const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`download ${file.file_path} → HTTP ${res.status}`);
	}
	const contentLength = Number(res.headers.get("content-length") ?? 0);
	if (contentLength > MAX_DOWNLOAD_BYTES) {
		throw new Error(`image too large: ${contentLength} > ${MAX_DOWNLOAD_BYTES}`);
	}
	const buf = Buffer.from(await res.arrayBuffer());
	if (buf.length > MAX_DOWNLOAD_BYTES) {
		throw new Error(`image too large: ${buf.length} > ${MAX_DOWNLOAD_BYTES}`);
	}

	// Pick extension from telegram's file_path; default .jpg (telegram
	// serves all photo sizes as JPEG anyway).
	const dot = file.file_path.lastIndexOf(".");
	const ext = (dot >= 0 ? file.file_path.slice(dot) : ".jpg").toLowerCase();
	const safeExt = ext in EXT_TO_MIME ? ext : ".jpg";

	const path = resolvePath(CACHE_DIR, `${randomUUID()}${safeExt}`);
	writeFileSync(path, buf);

	// Best-effort prune; we run sync to keep ordering simple but skip on error.
	try {
		pruneCacheIfNeeded();
	} catch {
		// Pruning failure must not break the request.
	}

	return { path, mimeType: EXT_TO_MIME[safeExt]!, bytes: buf.length };
}

/**
 * Drop oldest-modified files until total cache size ≤ MAX_CACHE_BYTES.
 * Sync because called right after writeFileSync; the per-write cost is
 * O(files in cache) but cache is bounded so this stays cheap.
 */
function pruneCacheIfNeeded(): void {
	const entries = readdirSync(CACHE_DIR).map(name => {
		const full = resolvePath(CACHE_DIR, name);
		const st = statSync(full);
		return { full, size: st.size, mtime: st.mtimeMs };
	});
	let total = entries.reduce((a, e) => a + e.size, 0);
	if (total <= MAX_CACHE_BYTES) return;
	entries.sort((a, b) => a.mtime - b.mtime); // oldest first
	for (const e of entries) {
		if (total <= MAX_CACHE_BYTES) break;
		try {
			unlinkSync(e.full);
			total -= e.size;
		} catch {
			// File vanished mid-prune (concurrent run) — ignore.
		}
	}
}
