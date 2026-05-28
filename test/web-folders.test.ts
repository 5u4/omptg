import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebBridge } from "../src/bridge/web/index.ts";
import type { ServerMsg } from "../src/bridge/web/protocol.ts";

interface FakeSub {
	send(msg: ServerMsg): void;
	received: ServerMsg[];
	subs: Set<string>;
}

function makeSub(): FakeSub {
	const received: ServerMsg[] = [];
	return { received, subs: new Set(), send(msg) { received.push(msg); } };
}

let tempDir: string;
let stateFile: string;
const live: WebBridge[] = [];

function makeBridge(): WebBridge {
	const b = new WebBridge({ defaultCwd: tempDir, stateFile });
	live.push(b);
	return b;
}

beforeEach(() => {
	tempDir = realpathSync(mkdtempSync(join(tmpdir(), "omptg-folders-")));
	stateFile = join(tempDir, "web-sessions.json");
});

afterEach(async () => {
	for (const b of live.splice(0)) {
		try { await b.dispose(); } catch { /* ignore */ }
	}
	rmSync(tempDir, { recursive: true, force: true });
});

describe("WebBridge folders", () => {
	it("createFolder broadcasts folder.created and persists", async () => {
		const b = makeBridge();
		const sub = makeSub();
		b.addSubscriber(sub);

		const res = b.createFolder({ name: " Work ", cwd: tempDir });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.folder.id).toBe("f:1");
		expect(res.folder.name).toBe("Work"); // trimmed
		expect(res.folder.cwd).toBe(tempDir);

		const created = sub.received.find(m => m.type === "folder.created");
		expect(created).toMatchObject({ type: "folder.created", folder: { id: "f:1", name: "Work" } });

		await b.dispose();
		const raw = JSON.parse(readFileSync(stateFile, "utf8")) as {
			version: number;
			nextFolderId: number;
			folders: Array<{ id: string; name: string }>;
		};
		expect(raw.version).toBe(2);
		expect(raw.nextFolderId).toBe(2);
		expect(raw.folders).toHaveLength(1);
		expect(raw.folders[0]).toMatchObject({ id: "f:1", name: "Work" });
	});

	it("rejects empty and overlong names", () => {
		const b = makeBridge();
		expect(b.createFolder({ name: "", cwd: tempDir }).ok).toBe(false);
		expect(b.createFolder({ name: "   ", cwd: tempDir }).ok).toBe(false);
		expect(b.createFolder({ name: "x".repeat(81), cwd: tempDir }).ok).toBe(false);
		expect(b.createFolder({ name: "x".repeat(80), cwd: tempDir }).ok).toBe(true);
	});

	it("allows multiple folders on the same cwd", () => {
		const b = makeBridge();
		const a = b.createFolder({ name: "a", cwd: tempDir });
		const c = b.createFolder({ name: "b", cwd: tempDir });
		expect(a.ok).toBe(true);
		expect(c.ok).toBe(true);
		expect(b.listFolders()).toHaveLength(2);
	});

	it("renameFolder updates state and broadcasts folder.updated", () => {
		const b = makeBridge();
		const made = b.createFolder({ name: "old", cwd: tempDir });
		if (!made.ok) throw new Error("setup");
		const sub = makeSub();
		b.addSubscriber(sub);

		const res = b.renameFolder(made.folder.id, "  new  ");
		expect(res.ok).toBe(true);
		expect(b.listFolders()[0]?.name).toBe("new");

		const updated = sub.received.find(m => m.type === "folder.updated");
		expect(updated).toMatchObject({ type: "folder.updated", id: made.folder.id, patch: { name: "new" } });
	});

	it("renameFolder rejects unknown id and bad names", () => {
		const b = makeBridge();
		const made = b.createFolder({ name: "x", cwd: tempDir });
		if (!made.ok) throw new Error("setup");
		expect(b.renameFolder("f:99", "x").ok).toBe(false);
		expect(b.renameFolder(made.folder.id, "").ok).toBe(false);
		expect(b.renameFolder(made.folder.id, "x".repeat(81)).ok).toBe(false);
	});

	it("listFolders is ascending by createdAt then id", async () => {
		const b = makeBridge();
		// Same millisecond is plausible; id tiebreak keeps things stable.
		const a = b.createFolder({ name: "a", cwd: tempDir });
		const c = b.createFolder({ name: "b", cwd: tempDir });
		if (!a.ok || !c.ok) throw new Error("setup");
		const list = b.listFolders();
		expect(list.map(f => f.id)).toEqual(["f:1", "f:2"]);
	});

	it("listFolders tiebreak is numeric (f:10 after f:2, not lex)", () => {
		const b = makeBridge();
		// Mint 10 folders in quick succession. Some pairs will land in
		// the same millisecond; lex compare would sort `f:10` between
		// `f:1` and `f:2`. Verify numeric ordering instead.
		for (let i = 0; i < 10; i++) {
			const r = b.createFolder({ name: `n${i}`, cwd: tempDir });
			if (!r.ok) throw new Error("setup");
		}
		const ids = b.listFolders().map(f => f.id);
		expect(ids).toEqual(["f:1", "f:2", "f:3", "f:4", "f:5", "f:6", "f:7", "f:8", "f:9", "f:10"]);
	});

	it("folderCwd returns the recorded cwd or undefined", () => {
		const b = makeBridge();
		const made = b.createFolder({ name: "x", cwd: tempDir });
		if (!made.ok) throw new Error("setup");
		expect(b.folderCwd(made.folder.id)).toBe(tempDir);
		expect(b.folderCwd("f:does-not-exist")).toBeUndefined();
	});

	it("patchSession({folderId}) carries folderId in session.updated", () => {
		const b = makeBridge();
		const route = b.mintRoute();
		b.open(route); // creates the persisted session entry
		const sub = makeSub();
		b.addSubscriber(sub);

		b.patchSession(route.key, { folderId: "f:1" });

		const updated = sub.received.find(m => m.type === "session.updated");
		expect(updated).toMatchObject({ type: "session.updated", key: route.key, patch: { folderId: "f:1" } });

		const summary = b.listSessions().find(s => s.key === route.key);
		expect(summary?.folderId).toBe("f:1");
	});

	it("persists folders and reloads on restart", async () => {
		{
			const b = makeBridge();
			const made = b.createFolder({ name: "Persisted", cwd: tempDir });
			if (!made.ok) throw new Error("setup");
			await b.dispose();
			live.pop();
		}
		const b2 = makeBridge();
		const list = b2.listFolders();
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({ id: "f:1", name: "Persisted", cwd: tempDir });
		// nextFolderId must continue from disk, not reset to 1.
		const next = b2.createFolder({ name: "after", cwd: tempDir });
		expect(next.ok).toBe(true);
		if (next.ok) expect(next.folder.id).toBe("f:2");
	});

	it("migrates v1 state file: sessions land in Ungrouped, no folders", () => {
		const v1 = {
			version: 1,
			nextId: 7,
			sessions: [
				{ key: "web:3", cwd: tempDir, title: "legacy", lastActivity: 123 },
			],
		};
		writeFileSync(stateFile, JSON.stringify(v1));
		const b = makeBridge();
		expect(b.listFolders()).toHaveLength(0);
		const s = b.listSessions().find(x => x.key === "web:3");
		expect(s).toBeDefined();
		expect(s?.folderId).toBeUndefined();
		// Fresh folder mints from id 1 since the v1 file had no nextFolderId.
		const made = b.createFolder({ name: "x", cwd: tempDir });
		expect(made.ok).toBe(true);
		if (made.ok) expect(made.folder.id).toBe("f:1");
	});
});
