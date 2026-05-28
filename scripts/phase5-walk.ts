/**
 * Phase 5 manual checklist as an automated ws walk. No LLM/network.
 * Exercises: handshake order, folder.create, session.open with folderId
 * forces folder's cwd, rename broadcast, persistence across restart,
 * v1 → v2 migration of an existing state file.
 */
import { WebBridge } from "../src/bridge/web/index.ts";
import { startWebServer } from "../src/bridge/web/server.ts";
import type { ServerMsg, FolderSummary, SessionSummary } from "../src/bridge/web/protocol.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function ok(label: string, cond: unknown): void {
	if (cond) console.log("  ✓", label);
	else { console.error("  ✗", label); process.exitCode = 1; }
}

async function connect(port: number): Promise<{
	ws: WebSocket;
	messages: ServerMsg[];
	waitFor: (pred: (m: ServerMsg) => boolean, timeoutMs?: number) => Promise<ServerMsg>;
}> {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	const messages: ServerMsg[] = [];
	// Attach the message listener before awaiting `open` so we can't
	// miss a handshake envelope (WebSocket spec dispatches `open`
	// before any `message`, but the explicit ordering reads cleaner
	// and silences a stylistic review nit).
	ws.addEventListener("message", e => {
		messages.push(JSON.parse(String(e.data)) as ServerMsg);
	});
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve(), { once: true });
		ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
	});
	const waitFor = (pred: (m: ServerMsg) => boolean, timeoutMs = 1500): Promise<ServerMsg> =>
		new Promise((resolve, reject) => {
			const start = Date.now();
			const tick = (): void => {
				const m = messages.find(pred);
				if (m) return resolve(m);
				if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"));
				setTimeout(tick, 10);
			};
			tick();
		});
	return { ws, messages, waitFor };
}

const tempDirs: string[] = [];
function mkTempDir(label: string): string {
	const d = mkdtempSync(join(tmpdir(), label));
	tempDirs.push(d);
	return d;
}

const tempDir = mkTempDir("omptg-phase5-");
const stateFile = join(tempDir, "web-sessions.json");

// --- Round 1: fresh bridge, create folder, open session in folder. ----
console.log("round 1: fresh state");
{
	const bridge = new WebBridge({ defaultCwd: tempDir, stateFile });
	const running = startWebServer({ host: "127.0.0.1", port: 0, bridge });
	const port = running.server.port!;
	const { ws, messages, waitFor } = await connect(port);

	// Handshake order.
	const folderList = await waitFor(m => m.type === "folder.list");
	const sessionList = await waitFor(m => m.type === "session.list");
	const iFolder = messages.indexOf(folderList);
	const iSession = messages.indexOf(sessionList);
	ok("folder.list precedes session.list", iFolder < iSession);
	ok("folder.list empty on fresh state", (folderList as { folders: FolderSummary[] }).folders.length === 0);

	// Create folder.
	ws.send(JSON.stringify({ type: "folder.create", name: "Work", cwd: tempDir }));
	const created = await waitFor(m => m.type === "folder.created");
	const folder = (created as { folder: FolderSummary }).folder;
	ok("folder.created id is f:1", folder.id === "f:1");
	ok("folder.created name trimmed", folder.name === "Work");
	ok("folder.created cwd matches", folder.cwd === tempDir);

	// Open a session inside the folder. Client deliberately sends a
	// junk cwd to confirm the server ignores it in favor of the
	// folder's cwd.
	ws.send(JSON.stringify({
		type: "session.open",
		folderId: folder.id,
		cwd: "/nonexistent/should/be/ignored",
	}));
	const sCreated = await waitFor(m => m.type === "session.created", 3000);
	const session = (sCreated as { session: SessionSummary }).session;
	ok("session.created in folder", session.folderId === folder.id);
	ok("session.cwd forced to folder cwd", session.cwd === tempDir);

	// Rename folder.
	ws.send(JSON.stringify({ type: "folder.rename", id: folder.id, name: "  Renamed  " }));
	const updated = await waitFor(m => m.type === "folder.updated");
	ok("folder.updated trims name", (updated as { patch: { name: string } }).patch.name === "Renamed");

	// Open an ungrouped session (no folderId).
	ws.send(JSON.stringify({ type: "session.open" }));
	const ungrouped = await new Promise<ServerMsg>((resolve, reject) => {
		const start = Date.now();
		const seen = new Set(messages.filter(m => m.type === "session.created").map(m => m));
		const tick = (): void => {
			const m = messages.find(x => x.type === "session.created" && !seen.has(x));
			if (m) return resolve(m);
			if (Date.now() - start > 3000) return reject(new Error("ungrouped open timeout"));
			setTimeout(tick, 10);
		};
		tick();
	});
	const u = (ungrouped as { session: SessionSummary }).session;
	ok("ungrouped session has no folderId", u.folderId === undefined);

	ws.close();
	await running.stop();
	await bridge.dispose();
}

// --- Round 2: restart bridge, verify persistence. ---------------------
console.log("round 2: restart, expect persisted folder + sessions");
{
	const bridge = new WebBridge({ defaultCwd: tempDir, stateFile });
	const running = startWebServer({ host: "127.0.0.1", port: 0, bridge });
	const port = running.server.port!;
	const { ws, waitFor } = await connect(port);

	const folderList = await waitFor(m => m.type === "folder.list");
	const folders = (folderList as { folders: FolderSummary[] }).folders;
	ok("one folder restored", folders.length === 1);
	ok("folder name restored as 'Renamed'", folders[0]?.name === "Renamed");

	const sessionList = await waitFor(m => m.type === "session.list");
	const sessions = (sessionList as { sessions: SessionSummary[] }).sessions;
	ok("two sessions restored", sessions.length === 2);
	const grouped = sessions.find(s => s.folderId === folders[0]?.id);
	const ungrouped = sessions.find(s => s.folderId === undefined);
	ok("one session in folder", grouped !== undefined);
	ok("one ungrouped session", ungrouped !== undefined);

	// Disk format sanity.
	const raw = JSON.parse(readFileSync(stateFile, "utf8")) as { version: number; nextFolderId: number };
	ok("disk version is 2", raw.version === 2);
	ok("nextFolderId persisted (>=2)", raw.nextFolderId >= 2);

	ws.close();
	await running.stop();
	await bridge.dispose();
}

// --- Round 3: v1 state file migrates cleanly. --------------------------
console.log("round 3: v1 → v2 migration");
{
	const v1Dir = mkTempDir("omptg-phase5-v1-");
	const v1File = join(v1Dir, "web-sessions.json");
	writeFileSync(v1File, JSON.stringify({
		version: 1,
		nextId: 5,
		sessions: [
			{ key: "web:3", cwd: v1Dir, title: "legacy session", lastActivity: 1000 },
		],
	}));

	const bridge = new WebBridge({ defaultCwd: v1Dir, stateFile: v1File });
	const running = startWebServer({ host: "127.0.0.1", port: 0, bridge });
	const port = running.server.port!;
	const { ws, waitFor } = await connect(port);

	const folderList = await waitFor(m => m.type === "folder.list");
	ok("no folders after v1 migration", (folderList as { folders: FolderSummary[] }).folders.length === 0);

	const sessionList = await waitFor(m => m.type === "session.list");
	const sessions = (sessionList as { sessions: SessionSummary[] }).sessions;
	const legacy = sessions.find(s => s.key === "web:3");
	ok("legacy session present", legacy !== undefined);
	ok("legacy session.folderId undefined", legacy?.folderId === undefined);

	ws.close();
	await running.stop();
	await bridge.dispose();
}


// Always cleanup temp dirs — including on uncaught exceptions, so
// repeated runs don't pile up state in /tmp.
process.on("exit", () => {
	for (const d of tempDirs) {
		try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
	}
});
if (process.exitCode) {
	console.error("phase 5 walk: FAILURES present");
	process.exit(process.exitCode);
}
console.log("phase 5 walk: all checks passed");
process.exit(0);
