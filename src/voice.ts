/**
 * Voice-input pipeline.
 *
 *   telegram voice/audio message  →  download .ogg/.m4a/etc into the
 *   voice cache  →  ffmpeg → 16 kHz mono WAV  →  openai-whisper
 *   (vendored via @oh-my-pi/pi-coding-agent/stt)  →  plain text.
 *
 * The user sees the transcription with [send / edit / cancel] buttons
 * before the text ever reaches the agent — misrecognition only costs a
 * tap, not an agent turn. The send path then takes the same prompt route
 * as a typed message.
 *
 * ffmpeg is required (telegram voice notes are OGG Opus and whisper
 * needs PCM WAV). Python + openai-whisper are required for transcription
 * itself; we surface the SDK's "pip install openai-whisper" hint as-is.
 */
import { Buffer } from "node:buffer";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { randomUUID } from "node:crypto";
import type { Bot } from "grammy";
import { transcribe } from "@oh-my-pi/pi-coding-agent/stt/transcriber";

const CACHE_DIR = resolvePath(homedir(), ".omp-tg", "voice-cache");
/** Soft cache cap. Voice notes are tiny; 200 MB is months of input. */
const MAX_CACHE_BYTES = 200 * 1024 * 1024;
/** Per-file hard cap. Telegram voice notes top out around 1 hr / ~30 MB,
 *  but uploaded audio (`Audio` not `Voice`) can be much bigger. We refuse
 *  anything past 50 MB so a misclick on a long podcast doesn't tie up
 *  whisper for half an hour. */
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

mkdirSync(CACHE_DIR, { recursive: true });

/** Extensions we trust as audio-bearing. Anything else gets `.bin` and
 *  ffmpeg sniffs the container — kept for forward-compat with new
 *  telegram audio types. */
const AUDIO_EXTS = new Set([".ogg", ".oga", ".opus", ".mp3", ".m4a", ".aac", ".wav", ".flac", ".webm"]);

export interface DownloadedAudio {
	path: string;
	bytes: number;
}

/**
 * Download a telegram voice/audio file to the cache, returning the
 * absolute path. Caller is responsible for converting + cleaning up; we
 * keep the original around so the transcription is reproducible and the
 * user could conceivably re-listen via the cache.
 */
export async function downloadVoiceToCache(bot: Bot, fileId: string): Promise<DownloadedAudio> {
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
		throw new Error(`audio too large: ${contentLength} > ${MAX_DOWNLOAD_BYTES}`);
	}
	const buf = Buffer.from(await res.arrayBuffer());
	if (buf.length > MAX_DOWNLOAD_BYTES) {
		throw new Error(`audio too large: ${buf.length} > ${MAX_DOWNLOAD_BYTES}`);
	}

	const dot = file.file_path.lastIndexOf(".");
	const rawExt = (dot >= 0 ? file.file_path.slice(dot) : "").toLowerCase();
	const ext = AUDIO_EXTS.has(rawExt) ? rawExt : ".ogg"; // voice notes default
	const path = resolvePath(CACHE_DIR, `${randomUUID()}${ext}`);
	writeFileSync(path, buf);

	try {
		pruneCacheIfNeeded();
	} catch {
		// pruning failure must not break the request
	}
	return { path, bytes: buf.length };
}

/**
 * ffmpeg `<input>` → 16 kHz mono PCM WAV next to the input. Returns the
 * wav path. Throws with the last line of ffmpeg's stderr if conversion
 * fails (usually "command not found" — surfaced explicitly).
 */
export async function convertToWav(inputPath: string): Promise<string> {
	const wavPath = `${inputPath.replace(/\.[^.]+$/, "")}.wav`;
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn(
			["ffmpeg", "-y", "-loglevel", "error", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath],
			{ stdout: "pipe", stderr: "pipe" },
		);
	} catch (err) {
		throw new Error(`ffmpeg not available (${err instanceof Error ? err.message : String(err)}). Install ffmpeg and retry.`);
	}
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = proc.stderr instanceof ReadableStream
			? await new Response(proc.stderr).text()
			: "";
		const lastLine = stderr.trim().split("\n").pop() ?? `exit ${exitCode}`;
		throw new Error(`ffmpeg conversion failed: ${lastLine}`);
	}
	return wavPath;
}

export interface TranscribeOptions {
	modelName?: string;
	language?: string;
}

/**
 * Full pipeline: downloaded telegram file → wav → whisper → trimmed text.
 * The intermediate wav is deleted on success or failure; the original
 * download is left in the voice cache (pruned by LRU).
 */
export async function transcribeAudio(audioPath: string, options?: TranscribeOptions): Promise<string> {
	const wavPath = await convertToWav(audioPath);
	try {
		return (await transcribe(wavPath, options)).trim();
	} finally {
		try {
			unlinkSync(wavPath);
		} catch {
			// best effort
		}
	}
}

function pruneCacheIfNeeded(): void {
	const entries = readdirSync(CACHE_DIR).map(name => {
		const full = resolvePath(CACHE_DIR, name);
		const st = statSync(full);
		return { full, size: st.size, mtime: st.mtimeMs };
	});
	let total = entries.reduce((a, e) => a + e.size, 0);
	if (total <= MAX_CACHE_BYTES) return;
	entries.sort((a, b) => a.mtime - b.mtime);
	for (const e of entries) {
		if (total <= MAX_CACHE_BYTES) break;
		try {
			unlinkSync(e.full);
			total -= e.size;
		} catch {
			// concurrent prune raced us
		}
	}
}
