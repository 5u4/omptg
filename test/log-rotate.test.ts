import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, statSync, writeFileSync, utimesSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { gunzipSync } from "node:zlib";
import {
	applyRotation,
	compressLogFile,
	planRotation,
	rotateLogs,
	scanLogDir,
	type FileEntry,
} from "../src/log-rotate.ts";

const MS_PER_DAY = 86_400_000;
const NOW = 1_700_000_000_000;
const CONFIG = { retainDays: 30, compressAfterDays: 7 };

function ago(days: number, now = NOW): number {
	return now - days * MS_PER_DAY;
}

describe("planRotation", () => {
	test("active file is always skipped", () => {
		const files: FileEntry[] = [{ name: "2024-01-01.log", mtimeMs: ago(100), gzipped: false }];
		expect(planRotation(files, "2024-01-01.log", NOW, CONFIG)).toEqual([]);
	});

	test("delete past retention", () => {
		const files: FileEntry[] = [
			{ name: "old.log", mtimeMs: ago(31), gzipped: false },
			{ name: "older.log.gz", mtimeMs: ago(60), gzipped: true },
		];
		expect(planRotation(files, "today.log", NOW, CONFIG)).toEqual([
			{ kind: "delete", name: "old.log" },
			{ kind: "delete", name: "older.log.gz" },
		]);
	});

	test("compress in the middle band", () => {
		const files: FileEntry[] = [{ name: "mid.log", mtimeMs: ago(10), gzipped: false }];
		expect(planRotation(files, "today.log", NOW, CONFIG)).toEqual([
			{ kind: "compress", name: "mid.log" },
		]);
	});

	test("already-gzipped files in the middle band are left alone", () => {
		const files: FileEntry[] = [{ name: "mid.log.gz", mtimeMs: ago(10), gzipped: true }];
		expect(planRotation(files, "today.log", NOW, CONFIG)).toEqual([]);
	});

	test("recent files are left alone", () => {
		const files: FileEntry[] = [{ name: "recent.log", mtimeMs: ago(3), gzipped: false }];
		expect(planRotation(files, "today.log", NOW, CONFIG)).toEqual([]);
	});

	test("boundary: exactly at compress threshold does NOT compress (> not >=)", () => {
		const files: FileEntry[] = [
			{ name: "edge.log", mtimeMs: NOW - 7 * MS_PER_DAY, gzipped: false },
		];
		expect(planRotation(files, "today.log", NOW, CONFIG)).toEqual([]);
	});

	test("boundary: exactly at retain threshold does NOT delete", () => {
		const files: FileEntry[] = [
			{ name: "edge.log.gz", mtimeMs: NOW - 30 * MS_PER_DAY, gzipped: true },
		];
		expect(planRotation(files, "today.log", NOW, CONFIG)).toEqual([]);
	});

	test("mixed batch: delete + compress + keep + skip-active", () => {
		const files: FileEntry[] = [
			{ name: "today.log", mtimeMs: ago(0), gzipped: false },
			{ name: "yesterday.log", mtimeMs: ago(1), gzipped: false },
			{ name: "midweek.log", mtimeMs: ago(10), gzipped: false },
			{ name: "monthold.log", mtimeMs: ago(45), gzipped: false },
			{ name: "monthold.log.gz", mtimeMs: ago(45), gzipped: true },
		];
		const actions = planRotation(files, "today.log", NOW, CONFIG);
		expect(actions).toEqual([
			{ kind: "compress", name: "midweek.log" },
			{ kind: "delete", name: "monthold.log" },
			{ kind: "delete", name: "monthold.log.gz" },
		]);
	});
});

describe("scanLogDir", () => {
	test("filters to .log / .log.gz and reads mtime", () => {
		const dir = mkdtempSync(resolvePath(tmpdir(), "logrotate-scan-"));
		writeFileSync(resolvePath(dir, "a.log"), "x");
		writeFileSync(resolvePath(dir, "b.log.gz"), "x");
		writeFileSync(resolvePath(dir, "ignore.txt"), "x");
		writeFileSync(resolvePath(dir, ".hidden"), "x");
		const entries = scanLogDir(dir);
		const names = entries.map(e => e.name).sort();
		expect(names).toEqual(["a.log", "b.log.gz"]);
		const gz = entries.find(e => e.name === "b.log.gz")!;
		expect(gz.gzipped).toBe(true);
		expect(entries.find(e => e.name === "a.log")!.gzipped).toBe(false);
	});

	test("missing directory returns empty list", () => {
		expect(scanLogDir(resolvePath(tmpdir(), `does-not-exist-${Date.now()}`))).toEqual([]);
	});
});

describe("compressLogFile", () => {
	test("writes .gz, removes original, content roundtrips", async () => {
		const dir = mkdtempSync(resolvePath(tmpdir(), "logrotate-gz-"));
		const original = "hello\nworld\n";
		writeFileSync(resolvePath(dir, "thing.log"), original);
		await compressLogFile(dir, "thing.log");
		const names = readdirSync(dir).sort();
		expect(names).toEqual(["thing.log.gz"]);
		const decoded = gunzipSync(readFileSync(resolvePath(dir, "thing.log.gz"))).toString();
		expect(decoded).toBe(original);
	});
});

describe("applyRotation", () => {
	test("executes deletes + compresses; survives missing files", async () => {
		const dir = mkdtempSync(resolvePath(tmpdir(), "logrotate-apply-"));
		writeFileSync(resolvePath(dir, "live.log"), "stuff");
		const { done, failed } = await applyRotation(dir, [
			{ kind: "compress", name: "live.log" },
			{ kind: "delete", name: "ghost.log" },
		]);
		expect(done.map(a => a.name)).toEqual(["live.log"]);
		expect(failed.map(a => a.name)).toEqual(["ghost.log"]);
		expect(readdirSync(dir).sort()).toEqual(["live.log.gz"]);
	});
});

describe("rotateLogs end-to-end", () => {
	test("compresses middle-band, deletes past retention, leaves active + fresh alone", async () => {
		const dir = mkdtempSync(resolvePath(tmpdir(), "logrotate-e2e-"));
		const now = Date.now();
		const make = (name: string, daysOld: number) => {
			const full = resolvePath(dir, name);
			writeFileSync(full, `payload:${name}\n`);
			const t = (now - daysOld * MS_PER_DAY) / 1000;
			utimesSync(full, t, t);
		};
		make("today.log", 0);
		make("recent.log", 2);
		make("midweek.log", 12);
		make("ancient.log", 60);
		make("ancient.log.gz", 60);

		const result = await rotateLogs(dir, resolvePath(dir, "today.log"), CONFIG, now);
		expect(result.failed).toEqual([]);
		const kinds = result.done.reduce<Record<string, string[]>>((acc, a) => {
			(acc[a.kind] ??= []).push(a.name);
			return acc;
		}, {});
		expect(kinds.compress?.sort()).toEqual(["midweek.log"]);
		expect(kinds.delete?.sort()).toEqual(["ancient.log", "ancient.log.gz"]);

		const remaining = readdirSync(dir).sort();
		expect(remaining).toEqual(["midweek.log.gz", "recent.log", "today.log"]);
		// Active file untouched.
		const beforeSize = statSync(resolvePath(dir, "today.log")).size;
		expect(beforeSize).toBeGreaterThan(0);
	});

	test("no-op when nothing matches", async () => {
		const dir = mkdtempSync(resolvePath(tmpdir(), "logrotate-noop-"));
		writeFileSync(resolvePath(dir, "today.log"), "x");
		const result = await rotateLogs(dir, resolvePath(dir, "today.log"), CONFIG);
		expect(result.planned).toEqual([]);
		expect(result.done).toEqual([]);
	});
});
