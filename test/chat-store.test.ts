import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore, expandHome } from "../src/chat-store.ts";

let tmpDir: string;
let storePath: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "omp-tg-store-"));
	storePath = join(tmpDir, "nested", "chats.json");
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("expandHome", () => {
	test("expands lone ~", () => {
		expect(expandHome("~")).toBe(process.env.HOME ?? "");
	});

	test("expands ~/x", () => {
		expect(expandHome("~/foo/bar").endsWith("/foo/bar")).toBe(true);
	});

	test("leaves absolute paths alone", () => {
		expect(expandHome("/abs/path")).toBe("/abs/path");
	});

	test("leaves relative paths alone", () => {
		expect(expandHome("rel/path")).toBe("rel/path");
	});
});

describe("ChatStore", () => {
	test("starts empty when file does not exist", () => {
		const s = new ChatStore(storePath);
		expect(s.chatIds()).toEqual([]);
		expect(s.get(123)).toBeUndefined();
	});

	test("set then get round-trips, auto-fills added_at", () => {
		const s = new ChatStore(storePath);
		s.set(42, { cwd: "/x" });
		const b = s.get(42);
		expect(b?.cwd).toBe("/x");
		expect(typeof b?.added_at).toBe("string");
		expect(Number.isFinite(Date.parse(b!.added_at))).toBe(true);
	});

	test("set persists across instances (atomic write + reload)", () => {
		const s1 = new ChatStore(storePath);
		s1.set(7, { cwd: "/p", label: "proj" });
		const s2 = new ChatStore(storePath);
		expect(s2.get(7)).toEqual({
			cwd: "/p",
			label: "proj",
			added_at: s1.get(7)!.added_at,
		});
	});

	test("set creates parent directories", () => {
		const s = new ChatStore(storePath);
		s.set(1, { cwd: "/a" });
		expect(existsSync(storePath)).toBe(true);
	});

	test("delete removes binding and persists", () => {
		const s1 = new ChatStore(storePath);
		s1.set(1, { cwd: "/a" });
		expect(s1.delete(1)).toBe(true);
		expect(s1.get(1)).toBeUndefined();
		const s2 = new ChatStore(storePath);
		expect(s2.get(1)).toBeUndefined();
	});

	test("delete on missing key returns false", () => {
		const s = new ChatStore(storePath);
		expect(s.delete(999)).toBe(false);
	});

	test("preserves caller-supplied added_at", () => {
		const s = new ChatStore(storePath);
		const when = "2024-01-02T03:04:05.000Z";
		s.set(1, { cwd: "/x", added_at: when });
		expect(s.get(1)!.added_at).toBe(when);
	});

	test("treats numeric and string chat ids identically", () => {
		const s = new ChatStore(storePath);
		s.set(123, { cwd: "/x" });
		expect(s.get("123")).toBeDefined();
		expect(s.get(123)).toBeDefined();
	});

	test("corrupt file falls back to empty without overwriting", () => {
		writeFileSync(storePath.replace("/nested/", "/"), "not json");
		// File at storePath (with nested/) still doesn't exist, so this hits
		// the existsSync false branch. Force the corrupt path by aligning:
		const corruptPath = join(tmpDir, "corrupt.json");
		writeFileSync(corruptPath, "{not json");
		const s = new ChatStore(corruptPath);
		expect(s.chatIds()).toEqual([]);
		// Corrupt file is left intact on disk (we only replace on save).
		expect(readFileSync(corruptPath, "utf8")).toBe("{not json");
	});

	test("file with missing `chats` field is treated as empty", () => {
		const path = join(tmpDir, "missing-chats.json");
		writeFileSync(path, JSON.stringify({ other: "field" }));
		const s = new ChatStore(path);
		expect(s.chatIds()).toEqual([]);
	});

	test("atomic write does not leave .tmp file behind", () => {
		const s = new ChatStore(storePath);
		s.set(1, { cwd: "/x" });
		const tmp = `${storePath}.tmp.${process.pid}`;
		expect(existsSync(tmp)).toBe(false);
	});
});
