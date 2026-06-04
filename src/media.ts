/**
 * Image cache for inspect_image's Hermes-style indirect-vision flow.
 *
 * The agent's `inspect_image` tool takes a filesystem path; bridges
 * download user-attached images, drop them in `~/.omptg/image-cache/`,
 * and inject `[user attached image: <path>]` into the prompt so the
 * main agent can hand the path to inspect_image with its own question.
 *
 * Two entry points:
 *   - `downloadPhotoToCache(bot, fileId)` — telegram (needs the bot
 *     token to resolve `getFile` → CDN URL, hence the grammY coupling).
 *   - `cacheImageFromUrl(url, hint?)` — bridge-agnostic. Discord
 *     attachment CDN URLs are pre-signed and need no auth, so the
 *     caller just hands us the URL + optional content-type hint.
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

/** Map standard mime → preferred extension. Bidirectional lookups go
 *  through this single table so the URL path (extension-only) and the
 *  Discord path (content-type-first) stay in sync. */
const MIME_TO_EXT: Record<string, string> = {
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/webp": ".webp",
	"image/gif": ".gif",
};
const EXT_TO_MIME: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
	".gif": "image/gif",
};

export interface CachedImage {
	path: string;
	mimeType: string;
	bytes: number;
}

/**
 * Download an arbitrary image URL into the local cache. Used by bridges
 * whose CDN URLs need no auth header (Discord). `hint` lets the caller
 * pass a known content-type (e.g. discord.js `Attachment.contentType`)
 * so we don't have to guess from the URL when both sides already know.
 *
 * SECURITY: `url` is fetched with no host allowlist, no scheme check,
 * and no redirect cap. The caller MUST guarantee the URL comes from a
 * trusted source (e.g. an attachment object the platform issued itself
 * — Discord's CDN, telegram's file API, etc.). Passing a user-typed
 * URL through this function without first resolving + rejecting
 * non-public hosts opens SSRF (e.g. `http://169.254.169.254/…`,
 * `file://`, RFC1918 ranges).
 *
 * Throws on HTTP non-OK, oversized payload (> MAX_DOWNLOAD_BYTES), or
 * unsupported mime (anything outside MIME_TO_EXT).
 */
export async function cacheImageFromUrl(
	url: string,
	hint?: { contentType?: string | null; filename?: string | null },
): Promise<CachedImage> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`download ${url} → HTTP ${res.status}`);
	const contentLength = Number(res.headers.get("content-length") ?? 0);
	if (contentLength > MAX_DOWNLOAD_BYTES) {
		throw new Error(`image too large: ${contentLength} > ${MAX_DOWNLOAD_BYTES}`);
	}
	const buf = Buffer.from(await res.arrayBuffer());
	if (buf.length > MAX_DOWNLOAD_BYTES) {
		throw new Error(`image too large: ${buf.length} > ${MAX_DOWNLOAD_BYTES}`);
	}

	// Resolve mime: prefer caller hint, then response header, then filename ext.
	const headerType = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
	const mime = pickMime(hint?.contentType, headerType, hint?.filename);
	if (!mime) throw new Error(`unsupported image type: ${hint?.contentType ?? headerType ?? "unknown"}`);
	return writeCached(buf, mime);
}

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
export async function downloadPhotoToCache(bot: Bot, fileId: string): Promise<CachedImage> {
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
	// Telegram serves photos as JPEG regardless of original; fall back to .jpg
	// when the file_path extension isn't one we recognize.
	const mime = pickMime(undefined, undefined, file.file_path) ?? "image/jpeg";
	return writeCached(buf, mime);
}

/** Resolve a canonical mime from any combination of caller hint,
 *  HTTP content-type header, and filename. Returns undefined when none
 *  of the sources map to a supported image type. */
function pickMime(
	hint: string | null | undefined,
	header: string | null | undefined,
	filename: string | null | undefined,
): string | undefined {
	for (const ct of [hint, header]) {
		if (!ct) continue;
		const norm = ct.split(";")[0]?.trim().toLowerCase();
		if (norm && norm in MIME_TO_EXT) return norm;
	}
	if (filename) {
		const dot = filename.lastIndexOf(".");
		if (dot >= 0) {
			const ext = filename.slice(dot).toLowerCase();
			if (ext in EXT_TO_MIME) return EXT_TO_MIME[ext]!;
		}
	}
	return undefined;
}

/** Write `buf` to the cache under a fresh uuid + extension derived from
 *  `mime`, run a best-effort prune, and return the descriptor. */
function writeCached(buf: Buffer, mime: string): CachedImage {
	const ext = MIME_TO_EXT[mime] ?? ".jpg";
	const path = resolvePath(CACHE_DIR, `${randomUUID()}${ext}`);
	writeFileSync(path, buf);
	try {
		pruneCacheIfNeeded();
	} catch {
		// Pruning failure must not break the request.
	}
	return { path, mimeType: mime, bytes: buf.length };
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
