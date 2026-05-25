/**
 * Log rotation for the per-day JSONL files written by `logger.ts`.
 *
 * Two passes, in this order:
 *
 *   1. **Compress**: any `<date>.log` whose mtime is older than
 *      COMPRESS_AFTER_DAYS but newer than RETAIN_DAYS gets gzipped
 *      to `<date>.log.gz` in place. The original is removed once the
 *      gzip is on disk.
 *   2. **Delete**: any file (`.log` or `.log.gz`) whose mtime is older
 *      than RETAIN_DAYS is unlinked.
 *
 * `today.log` (the file the current process appends to) is *always*
 * skipped — rotating an open append handle out from under the process
 * is a recipe for confusion. We compare against `currentLogPath()` so
 * the active file is left alone even across UTC midnight rollovers
 * (next boot picks it up).
 *
 * The plan operates on file descriptors via a pluggable IO layer so
 * tests can drive deterministic before/after states.
 */
import { createReadStream, createWriteStream, readdirSync, statSync, unlinkSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

export interface LogRotateConfig {
	/** Files older than this are deleted outright. */
	retainDays: number;
	/** Files older than this (but newer than retainDays) get gzipped. */
	compressAfterDays: number;
}

export interface FileEntry {
	name: string;
	mtimeMs: number;
	/** True if already gzipped. We never re-compress these, only delete. */
	gzipped: boolean;
}

export type RotateAction =
	| { kind: "compress"; name: string }
	| { kind: "delete"; name: string };

const MS_PER_DAY = 86_400_000;

/**
 * Pure planner: given the current set of log files + the active log name,
 * return the actions that should be taken. No IO. Tests pin this.
 *
 * Decision matrix (age = now - mtime, in days):
 *   - active file:        skip
 *   - age > retainDays:   delete
 *   - age > compress, !gz: compress
 *   - everything else:    skip
 */
export function planRotation(
	files: FileEntry[],
	activeName: string,
	now: number,
	config: LogRotateConfig,
): RotateAction[] {
	const actions: RotateAction[] = [];
	const retainMs = config.retainDays * MS_PER_DAY;
	const compressMs = config.compressAfterDays * MS_PER_DAY;
	for (const f of files) {
		if (f.name === activeName) continue;
		const age = now - f.mtimeMs;
		if (age > retainMs) {
			actions.push({ kind: "delete", name: f.name });
			continue;
		}
		if (!f.gzipped && age > compressMs) {
			actions.push({ kind: "compress", name: f.name });
		}
	}
	return actions;
}

/** Filesystem read of log directory state, filtered to the files we care
 *  about (`*.log` and `*.log.gz`). Hidden files and unrelated junk in the
 *  dir are ignored. */
export function scanLogDir(dir: string): FileEntry[] {
	const out: FileEntry[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const name of entries) {
		if (!name.endsWith(".log") && !name.endsWith(".log.gz")) continue;
		try {
			const st = statSync(resolvePath(dir, name));
			if (!st.isFile()) continue;
			out.push({ name, mtimeMs: st.mtimeMs, gzipped: name.endsWith(".log.gz") });
		} catch {
			// vanished mid-scan
		}
	}
	return out;
}

/** Compress one file in place: write `<path>.gz` then delete the original. */
export async function compressLogFile(dir: string, name: string): Promise<void> {
	const src = resolvePath(dir, name);
	const dst = `${src}.gz`;
	await pipeline(createReadStream(src), createGzip(), createWriteStream(dst));
	unlinkSync(src);
}

/**
 * Apply a rotation plan. Returns per-action results so the caller can
 * log a single summary. Errors on one file do not abort the rest.
 */
export async function applyRotation(
	dir: string,
	actions: RotateAction[],
): Promise<{ done: RotateAction[]; failed: Array<RotateAction & { err: string }> }> {
	const done: RotateAction[] = [];
	const failed: Array<RotateAction & { err: string }> = [];
	for (const action of actions) {
		try {
			if (action.kind === "compress") {
				await compressLogFile(dir, action.name);
			} else {
				unlinkSync(resolvePath(dir, action.name));
			}
			done.push(action);
		} catch (err) {
			failed.push({ ...action, err: err instanceof Error ? err.message : String(err) });
		}
	}
	return { done, failed };
}

/**
 * One-shot convenience: scan dir, plan, apply. Designed to be called from
 * boot. Active-file path is required to avoid touching the live JSONL.
 */
export async function rotateLogs(
	dir: string,
	activeAbsPath: string,
	config: LogRotateConfig,
	now: number = Date.now(),
): Promise<{
	planned: RotateAction[];
	done: RotateAction[];
	failed: Array<RotateAction & { err: string }>;
}> {
	const files = scanLogDir(dir);
	const activeName = activeAbsPath.slice(activeAbsPath.lastIndexOf("/") + 1);
	const planned = planRotation(files, activeName, now, config);
	const { done, failed } = await applyRotation(dir, planned);
	return { planned, done, failed };
}
