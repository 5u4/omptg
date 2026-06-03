import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore, expandHome } from "../src/chat-store.ts";

let tmpDir: string;
let storePath: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "omptg-store-"));
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
		expect(s.get("tg:123")).toBeUndefined();
	});

	test("set then get round-trips, auto-fills added_at", () => {
		const s = new ChatStore(storePath);
		s.set("tg:42", { cwd: "/x" });
		const b = s.get("tg:42");
		expect(b?.cwd).toBe("/x");
		expect(typeof b?.added_at).toBe("string");
		expect(Number.isFinite(Date.parse(b!.added_at))).toBe(true);
	});

	test("set persists across instances (atomic write + reload)", () => {
		const s1 = new ChatStore(storePath);
		s1.set("tg:7", { cwd: "/p", label: "proj" });
		const s2 = new ChatStore(storePath);
		expect(s2.get("tg:7")).toEqual({
			cwd: "/p",
			label: "proj",
			added_at: s1.get("tg:7")!.added_at,
		});
	});

	test("set creates parent directories", () => {
		const s = new ChatStore(storePath);
		s.set("tg:1", { cwd: "/a" });
		expect(existsSync(storePath)).toBe(true);
	});

	test("delete removes binding and persists", () => {
		const s1 = new ChatStore(storePath);
		s1.set("tg:1", { cwd: "/a" });
		expect(s1.delete("tg:1")).toBe(true);
		expect(s1.get("tg:1")).toBeUndefined();
		const s2 = new ChatStore(storePath);
		expect(s2.get("tg:1")).toBeUndefined();
	});

	test("delete on missing key returns false", () => {
		const s = new ChatStore(storePath);
		expect(s.delete("tg:999")).toBe(false);
	});

	test("preserves caller-supplied added_at", () => {
		const s = new ChatStore(storePath);
		const when = "2024-01-02T03:04:05.000Z";
		s.set("tg:1", { cwd: "/x", added_at: when });
		expect(s.get("tg:1")!.added_at).toBe(when);
	});

	test("namespaced keys for different bridges live side by side", () => {
		const s = new ChatStore(storePath);
		s.set("tg:123", { cwd: "/tg" });
		s.set("dc:123", { cwd: "/dc" });
		expect(s.get("tg:123")?.cwd).toBe("/tg");
		expect(s.get("dc:123")?.cwd).toBe("/dc");
		expect(s.chatIds().sort()).toEqual(["dc:123", "tg:123"]);
	});

	test("corrupt file falls back to empty without overwriting", () => {
		writeFileSync(storePath.replace("/nested/", "/"), "not json");
		const corruptPath = join(tmpDir, "corrupt.json");
		writeFileSync(corruptPath, "{not json");
		const s = new ChatStore(corruptPath);
		expect(s.chatIds()).toEqual([]);
		expect(readFileSync(corruptPath, "utf8")).toBe("{not json");
	});

	test("file with missing `chats` field is treated as empty", () => {
		const path = join(tmpDir, "missing-chats.json");
		writeFileSync(path, JSON.stringify({ other: "field" }));
		const s = new ChatStore(path);
		expect(s.chatIds()).toEqual([]);
	});

	test("non-object `chats` field is treated as empty (does not crash migration)", () => {
		// Defensive: a hand-edited or partially-corrupted file with
		// `{ "chats": "abc" }` was previously fed into Object.entries
		// which iterates the string as characters and migrated them to
		// `tg:0`/`tg:1`/... Reject the load up front instead.
		const path = join(tmpDir, "bad-chats-string.json");
		writeFileSync(path, JSON.stringify({ chats: "abc" }));
		const s = new ChatStore(path);
		expect(s.chatIds()).toEqual([]);
	});

	test("array `chats` field is treated as empty", () => {
		const path = join(tmpDir, "bad-chats-array.json");
		writeFileSync(path, JSON.stringify({ chats: [{ cwd: "/x" }] }));
		const s = new ChatStore(path);
		expect(s.chatIds()).toEqual([]);
	});

	test("atomic write does not leave .tmp file behind", () => {
		const s = new ChatStore(storePath);
		s.set("tg:1", { cwd: "/x" });
		const tmp = `${storePath}.tmp.${process.pid}`;
		expect(existsSync(tmp)).toBe(false);
	});
});

describe("ChatStore — legacy-key migration", () => {
	test("rewrites bare-numeric keys to tg:<id> and persists", () => {
		// Simulate a file written by the pre-namespacing schema (Telegram
		// was the only bridge that ever wrote bindings).
		const path = join(tmpDir, "legacy.json");
		writeFileSync(path, JSON.stringify({
			chats: {
				"42": { cwd: "/a", added_at: "2024-01-01T00:00:00.000Z" },
				"-1001234567890": { cwd: "/b", added_at: "2024-02-01T00:00:00.000Z" },
			},
		}));
		const s = new ChatStore(path);
		expect(s.chatIds().sort()).toEqual(["tg:-1001234567890", "tg:42"]);
		expect(s.get("tg:42")?.cwd).toBe("/a");
		expect(s.get("tg:-1001234567890")?.cwd).toBe("/b");

		// Migration was persisted: a fresh instance sees prefixed keys directly.
		const s2 = new ChatStore(path);
		expect(s2.chatIds().sort()).toEqual(["tg:-1001234567890", "tg:42"]);

		// File on disk no longer carries the bare keys.
		const onDisk = JSON.parse(readFileSync(path, "utf8")) as { chats: Record<string, unknown> };
		expect(Object.keys(onDisk.chats).sort()).toEqual(["tg:-1001234567890", "tg:42"]);
	});

	test("leaves already-prefixed keys untouched (idempotent)", () => {
		const path = join(tmpDir, "prefixed.json");
		writeFileSync(path, JSON.stringify({
			chats: {
				"tg:42": { cwd: "/a", added_at: "2024-01-01T00:00:00.000Z" },
				"dc:123456789012345678": { cwd: "/b", added_at: "2024-02-01T00:00:00.000Z" },
				"web:7": { cwd: "/c", added_at: "2024-03-01T00:00:00.000Z" },
			},
		}));
		const s = new ChatStore(path);
		expect(s.chatIds().sort()).toEqual(["dc:123456789012345678", "tg:42", "web:7"]);
	});

	test("on bare/prefixed collision, prefixed entry wins and bare is dropped", () => {
		// Defensive: if a file somehow has BOTH `42` and `tg:42`, the
		// prefixed entry is authoritative (it was written by a newer code
		// path) and the bare entry is discarded rather than overwriting.
		const path = join(tmpDir, "collision.json");
		writeFileSync(path, JSON.stringify({
			chats: {
				"42": { cwd: "/old", added_at: "2024-01-01T00:00:00.000Z" },
				"tg:42": { cwd: "/new", added_at: "2024-02-01T00:00:00.000Z" },
			},
		}));
		const s = new ChatStore(path);
		expect(s.chatIds()).toEqual(["tg:42"]);
		expect(s.get("tg:42")?.cwd).toBe("/new");
	});

	test("non-numeric, non-prefixed keys are kept verbatim (not silently relabeled as tg:)", () => {
		// A future bridge or operator hand-edit might write a key the
		// current code doesn't recognize. Migration must not silently
		// brand it as Telegram — that would lose data the next time the
		// real bridge tries to read it. Pass through untouched.
		const path = join(tmpDir, "unknown-scheme.json");
		writeFileSync(path, JSON.stringify({
			chats: {
				"unknown-scheme-id": { cwd: "/u", added_at: "2024-01-01T00:00:00.000Z" },
				"42": { cwd: "/t", added_at: "2024-02-01T00:00:00.000Z" },
			},
		}));
		const s = new ChatStore(path);
		// `42` migrates; `unknown-scheme-id` survives as-is.
		expect(s.chatIds().sort()).toEqual(["tg:42", "unknown-scheme-id"]);
		expect(s.get("unknown-scheme-id")?.cwd).toBe("/u");
	});
});

describe("ChatStore — topic bindings", () => {
	test("setTopic / getTopic round-trip, auto-fills added_at", () => {
		const s = new ChatStore(storePath);
		s.setTopic("tg:1", 5, { cwd: "/y" });
		const t = s.getTopic("tg:1", 5);
		expect(t?.cwd).toBe("/y");
		expect(Number.isFinite(Date.parse(t!.added_at))).toBe(true);
	});

	test("topic binding persists across instances", () => {
		const s1 = new ChatStore(storePath);
		s1.setTopic("tg:1", 5, { cwd: "/y", label: "feature" });
		const s2 = new ChatStore(storePath);
		expect(s2.getTopic("tg:1", 5)?.cwd).toBe("/y");
		expect(s2.getTopic("tg:1", 5)?.label).toBe("feature");
	});

	test("setTopic on chat with no group binding still works", () => {
		const s = new ChatStore(storePath);
		s.setTopic("tg:1", 5, { cwd: "/y" });
		expect(s.get("tg:1")?.cwd).toBeNull();
		expect(s.getTopic("tg:1", 5)?.cwd).toBe("/y");
	});

	test("topicIds lists configured topics", () => {
		const s = new ChatStore(storePath);
		s.setTopic("tg:1", 5, { cwd: "/a" });
		s.setTopic("tg:1", 12, { cwd: "/b" });
		expect(s.topicIds("tg:1").sort()).toEqual(["12", "5"]);
	});

	test("topicIds is empty when no topics configured", () => {
		const s = new ChatStore(storePath);
		s.set("tg:1", { cwd: "/x" });
		expect(s.topicIds("tg:1")).toEqual([]);
	});

	test("deleteTopic removes the override but keeps group binding", () => {
		const s = new ChatStore(storePath);
		s.set("tg:1", { cwd: "/x" });
		s.setTopic("tg:1", 5, { cwd: "/y" });
		expect(s.deleteTopic("tg:1", 5)).toBe(true);
		expect(s.getTopic("tg:1", 5)).toBeUndefined();
		expect(s.get("tg:1")?.cwd).toBe("/x");
	});

	test("deleteTopic returns false when nothing to delete", () => {
		const s = new ChatStore(storePath);
		expect(s.deleteTopic("tg:1", 5)).toBe(false);
	});

	test("deleteTopic GCs the chat entry when no group binding + no remaining topics", () => {
		const s = new ChatStore(storePath);
		s.setTopic("tg:1", 5, { cwd: "/y" });
		s.deleteTopic("tg:1", 5);
		expect(s.get("tg:1")).toBeUndefined();
		expect(s.chatIds()).toEqual([]);
	});

	test("group-level delete preserves topic bindings", () => {
		const s = new ChatStore(storePath);
		s.set("tg:1", { cwd: "/x" });
		s.setTopic("tg:1", 5, { cwd: "/y" });
		s.delete("tg:1");
		expect(s.get("tg:1")?.cwd).toBeNull();
		expect(s.getTopic("tg:1", 5)?.cwd).toBe("/y");
	});

	test("group-level set preserves existing topics", () => {
		const s = new ChatStore(storePath);
		s.setTopic("tg:1", 5, { cwd: "/y" });
		s.set("tg:1", { cwd: "/x", label: "proj" });
		expect(s.get("tg:1")?.cwd).toBe("/x");
		expect(s.get("tg:1")?.label).toBe("proj");
		expect(s.getTopic("tg:1", 5)?.cwd).toBe("/y");
	});

	test("Discord-style snowflake topic ids round-trip", () => {
		const s = new ChatStore(storePath);
		// Discord thread snowflakes routinely exceed Number.MAX_SAFE_INTEGER.
		s.setTopic("dc:111111111111111111", "1245612342819725313", { cwd: "/a" });
		s.setTopic("dc:111111111111111111", "1245612342819725314", { cwd: "/b" });
		expect(s.topicIds("dc:111111111111111111").sort())
			.toEqual(["1245612342819725313", "1245612342819725314"]);
		expect(s.getTopic("dc:111111111111111111", "1245612342819725313")?.cwd).toBe("/a");
		expect(s.getTopic("dc:111111111111111111", "1245612342819725314")?.cwd).toBe("/b");
	});
});

describe("ChatStore.resolveCwd — topic > group > undefined", () => {
	test("topic binding wins when threadId given", () => {
		const s = new ChatStore(storePath);
		s.set("tg:1", { cwd: "/group" });
		s.setTopic("tg:1", 5, { cwd: "/topic" });
		expect(s.resolveCwd("tg:1", 5)).toBe("/topic");
	});

	test("falls back to group when topic has no override", () => {
		const s = new ChatStore(storePath);
		s.set("tg:1", { cwd: "/group" });
		expect(s.resolveCwd("tg:1", 99)).toBe("/group");
	});

	test("threadId undefined uses group binding directly", () => {
		const s = new ChatStore(storePath);
		s.set("tg:1", { cwd: "/group" });
		expect(s.resolveCwd("tg:1", undefined)).toBe("/group");
	});

	test("returns undefined when nothing bound at any level", () => {
		const s = new ChatStore(storePath);
		expect(s.resolveCwd("tg:1", undefined)).toBeUndefined();
		expect(s.resolveCwd("tg:1", 5)).toBeUndefined();
	});

	test("topic-only binding does not satisfy threadId=undefined lookup", () => {
		const s = new ChatStore(storePath);
		s.setTopic("tg:1", 5, { cwd: "/topic" });
		expect(s.resolveCwd("tg:1", undefined)).toBeUndefined();
	});

	test("blank group cwd (after group-level delete) does not count as a fallback", () => {
		const s = new ChatStore(storePath);
		s.set("tg:1", { cwd: "/group" });
		s.setTopic("tg:1", 5, { cwd: "/topic" });
		s.delete("tg:1");
		expect(s.resolveCwd("tg:1", 99)).toBeUndefined();
		expect(s.resolveCwd("tg:1", 5)).toBe("/topic");
	});
});
