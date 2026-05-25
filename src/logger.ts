/**
 * Structured logger that writes JSONL to logs/<date>.log and mirrors a
 * compact line to stdout. Read with `read logs/<date>.log` or tail it
 * live with `bun --watch`.
 *
 * Fields are intentionally flat so the assistant can grep / jq them
 * without parsing nested objects.
 */
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

const LOG_DIR = resolvePath(import.meta.dir, "..", "logs");
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

type Level = "debug" | "info" | "warn" | "error";

function todayPath(): string {
	const d = new Date();
	const stamp = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
	return resolvePath(LOG_DIR, `${stamp}.log`);
}

function pad(n: number): string {
	return n.toString().padStart(2, "0");
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return JSON.stringify(String(value));
	}
}

function emit(level: Level, scope: string, msg: string, fields?: Record<string, unknown>): void {
	const entry = {
		ts: new Date().toISOString(),
		level,
		scope,
		msg,
		...(fields ?? {}),
	};
	const line = `${safeStringify(entry)}\n`;
	try {
		appendFileSync(todayPath(), line);
	} catch (err) {
		// fall back to stderr so we at least see the event
		process.stderr.write(`[log-fail] ${err}\n`);
	}
	const compact = fields
		? `[${level}] ${scope}: ${msg} ${safeStringify(fields)}`
		: `[${level}] ${scope}: ${msg}`;
	const sink = level === "error" || level === "warn" ? process.stderr : process.stdout;
	sink.write(`${compact}\n`);
}

export function scoped(scope: string) {
	return {
		debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", scope, msg, fields),
		info:  (msg: string, fields?: Record<string, unknown>) => emit("info",  scope, msg, fields),
		warn:  (msg: string, fields?: Record<string, unknown>) => emit("warn",  scope, msg, fields),
		error: (msg: string, fields?: Record<string, unknown>) => emit("error", scope, msg, fields),
	};
}

export type Logger = ReturnType<typeof scoped>;

export const logPath = todayPath;
export const logDir = (): string => LOG_DIR;
