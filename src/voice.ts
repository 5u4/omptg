/**
 * Voice-input pipeline.
 *
 *   telegram voice/audio message  →  download .ogg/.m4a/etc into the
 *   voice cache  →  ffmpeg → 16 kHz mono WAV  →  openai-whisper running
 *   inside an isolated `uv` venv at ~/.omptg/whisper-venv/  →  text.
 *
 * The user sees the transcription with [send / cancel] buttons before
 * the text ever reaches the agent — misrecognition only costs a tap.
 *
 * Everything whisper-related lives under ~/.omptg/ so cleanup is "rm
 * -rf ~/.omptg" with no spillover into the system Python or the
 * user's other whisper consumers:
 *   - venv:           ~/.omptg/whisper-venv/
 *   - model weights:  ~/.omptg/whisper-models/whisper/      (via XDG_CACHE_HOME)
 *   - input cache:    ~/.omptg/voice-cache/
 *
 * Requires `uv` (https://github.com/astral-sh/uv) and `ffmpeg` on PATH.
 * The venv + openai-whisper install is bootstrapped on first use; we
 * cache the "ready" state per-process so subsequent transcriptions skip
 * the import-check round trip.
 */
import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { resolve as resolvePath } from "node:path";
import { randomUUID } from "node:crypto";
import type { Bot } from "grammy";

const OMP_HOME = resolvePath(homedir(), ".omptg");
const CACHE_DIR = resolvePath(OMP_HOME, "voice-cache");
const VENV_DIR = resolvePath(OMP_HOME, "whisper-venv");
const MODEL_CACHE_DIR = resolvePath(OMP_HOME, "whisper-models");

/** Soft cache cap. Voice notes are tiny; 200 MB is months of input. */
const MAX_CACHE_BYTES = 200 * 1024 * 1024;
/** Per-file hard cap. Telegram voice notes top out around 1 hr / ~30 MB,
 *  but uploaded audio (`Audio` not `Voice`) can be much bigger. We refuse
 *  anything past 50 MB so a misclick on a long podcast doesn't tie up
 *  whisper for half an hour. */
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

mkdirSync(CACHE_DIR, { recursive: true });

/** Extensions we trust as audio-bearing. Anything else gets `.ogg` (the
 *  default for telegram voice notes) — ffmpeg will sniff the container
 *  either way, the extension is just a hint. */
const AUDIO_EXTS = new Set([".ogg", ".oga", ".opus", ".mp3", ".m4a", ".aac", ".wav", ".flac", ".webm"]);

const VENV_PYTHON = platform() === "win32"
	? resolvePath(VENV_DIR, "Scripts", "python.exe")
	: resolvePath(VENV_DIR, "bin", "python");

export interface DownloadedAudio {
	path: string;
	bytes: number;
}

/**
 * Download a telegram voice/audio file to the cache, returning the
 * absolute path. Caller is responsible for converting + cleaning up; we
 * keep the original around so the transcription is reproducible.
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
 * wav path. Throws with a recognizable message when ffmpeg is missing
 * or conversion fails.
 */
export async function convertToWav(inputPath: string): Promise<string> {
	const base = inputPath.replace(/\.[^.]+$/, "");
	const wavPath = inputPath.toLowerCase().endsWith(".wav") ? `${base}.16k.wav` : `${base}.wav`;
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

// ---------- isolated whisper venv -----------------------------------------

/** Reads WAV with stdlib `wave`, resamples to 16k mono, runs whisper.
 *  Accepts `language="auto"` as "let whisper detect". */
const TRANSCRIBE_SCRIPT = `
import sys, wave, re
import numpy as np
import whisper

def load_wav(path):
    with wave.open(path, "rb") as wf:
        rate, channels, width = wf.getframerate(), wf.getnchannels(), wf.getsampwidth()
        raw = wf.readframes(wf.getnframes())
    if width == 2:
        audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif width == 1:
        audio = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif width == 4:
        audio = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"Unsupported sample width: {width}")
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    if rate != 16000:
        n = int(len(audio) * 16000 / rate)
        audio = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype(np.float32)
    return audio

path = sys.argv[1]
model_name = sys.argv[2] if len(sys.argv) > 2 else "base"
language = sys.argv[3] if len(sys.argv) > 3 else "en"
lang_arg = None if language.lower() in ("auto", "") else language
if lang_arg is not None and not re.fullmatch(r"[A-Za-z]{2,3}(-[A-Za-z]{2})?", lang_arg):
    print(f"Invalid language code: {language}", file=sys.stderr)
    sys.exit(1)

audio = load_wav(path)
model = whisper.load_model(model_name)
result = model.transcribe(audio, language=lang_arg)
print(result["text"].strip())
`;

/** Memoized per-process: skip the import probe on subsequent calls. */
let envReady: Promise<void> | undefined;

/**
 * Bootstrap (or reuse) ~/.omptg/whisper-venv with openai-whisper installed.
 * Idempotent: a second concurrent caller awaits the same promise.
 */
export function ensureWhisperEnv(): Promise<void> {
	if (envReady) return envReady;
	envReady = (async () => {
		// Create venv only if the python binary doesn't already exist.
		if (!existsSync(VENV_PYTHON)) {
			await runOrThrow(
				["uv", "venv", VENV_DIR],
				"uv venv failed",
				`uv not found — install it first (https://github.com/astral-sh/uv, e.g. \`brew install uv\`)`,
			);
		}
		// Cheap probe: is whisper importable inside the venv?
		const probe = Bun.spawn([VENV_PYTHON, "-c", "import whisper"], {
			stdout: "pipe", stderr: "pipe",
		});
		if ((await probe.exited) === 0) return;
		// Install (this fetches torch + openai-whisper — ~1-2 GB, slow first time).
		await runOrThrow(
			["uv", "pip", "install", "--python", VENV_PYTHON, "openai-whisper"],
			"uv pip install openai-whisper failed",
			`uv not found — install it first (https://github.com/astral-sh/uv)`,
		);
	})().catch(err => {
		// Reset on failure so the next request retries (e.g. user just installed uv).
		envReady = undefined;
		throw err;
	});
	return envReady;
}

async function runOrThrow(cmd: string[], failPrefix: string, enoentMsg: string): Promise<void> {
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === "ENOENT") throw new Error(enoentMsg);
		throw new Error(`${failPrefix}: ${err instanceof Error ? err.message : String(err)}`);
	}
	const exitCode = await proc.exited;
	if (exitCode === 0) return;
	const stderr = proc.stderr instanceof ReadableStream
		? (await new Response(proc.stderr).text()).trim()
		: "";
	const lastLine = stderr.split("\n").pop() ?? `exit ${exitCode}`;
	throw new Error(`${failPrefix}: ${lastLine}`);
}

export interface TranscribeOptions {
	modelName?: string;
	language?: string;
}

const TRANSCRIBE_TIMEOUT_MS = 5 * 60_000;

/**
 * Full pipeline: downloaded telegram file → wav → whisper → trimmed text.
 * The intermediate wav is deleted on success or failure; the original
 * download is left in the voice cache (pruned by LRU).
 */
export async function transcribeAudio(audioPath: string, options?: TranscribeOptions): Promise<string> {
	await ensureWhisperEnv();
	const wavPath = await convertToWav(audioPath);
	try {
		const proc = Bun.spawn(
			[
				VENV_PYTHON, "-c", TRANSCRIBE_SCRIPT,
				wavPath,
				options?.modelName ?? "base",
				options?.language ?? "en",
			],
			{
				stdout: "pipe",
				stderr: "pipe",
				// Pin whisper's model cache under ~/.omptg so it's removable
				// with the rest of our state. XDG_CACHE_HOME → ~/.cache by
				// default; whisper appends /whisper to whatever this resolves to.
				env: { ...process.env, XDG_CACHE_HOME: MODEL_CACHE_DIR },
			},
		);
		const timer = setTimeout(() => proc.kill(), TRANSCRIBE_TIMEOUT_MS);
		const exitCode = await proc.exited;
		clearTimeout(timer);
		const stdout = proc.stdout instanceof ReadableStream
			? await new Response(proc.stdout).text()
			: "";
		if (exitCode !== 0) {
			const stderr = proc.stderr instanceof ReadableStream
				? (await new Response(proc.stderr).text()).trim()
				: "";
			const lastLine = stderr.split("\n").pop() ?? `exit ${exitCode}`;
			throw new Error(`Transcription failed: ${lastLine}`);
		}
		return stdout.trim();
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
