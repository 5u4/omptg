import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebBridge } from "../src/bridge/web/index.ts";
import type { ServerMsg } from "../src/bridge/web/protocol.ts";
import { startWebServer, type RunningServer } from "../src/bridge/web/server.ts";

interface FakeSub {
	send(msg: ServerMsg): void;
	received: ServerMsg[];
	subs: Set<string>;
}

function makeSub(): FakeSub {
	const received: ServerMsg[] = [];
	return {
		received,
		subs: new Set(),
		send(msg) { received.push(msg); },
	};
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
	// realpath so the canonicalized defaultCwd assertions don't flap
	// on macOS where /var/folders is a symlink to /private/var/folders.
	tempDir = realpathSync(mkdtempSync(join(tmpdir(), "omptg-web-")));
	stateFile = join(tempDir, "web-sessions.json");
});

afterEach(async () => {
	for (const b of live.splice(0)) {
		try { await b.dispose(); } catch { /* ignore */ }
	}
	rmSync(tempDir, { recursive: true, force: true });
});

describe("WebBridge", () => {
	it("mints monotonic web:<n> routes", () => {
		const b = makeBridge();
		const r1 = b.mintRoute();
		const r2 = b.mintRoute();
		expect(r1.key).toBe("web:1");
		expect(r2.key).toBe("web:2");
	});

	it("open() returns the same transport for the same route", () => {
		const b = makeBridge();
		const r = b.mintRoute();
		const t1 = b.open(r);
		const t2 = b.open(r);
		expect(t1).toBe(t2);
	});

	it("events fan out only to subscribers of the matching key", async () => {
		const b = makeBridge();
		const a = makeSub();
		const c = makeSub();
		b.addSubscriber(a);
		b.addSubscriber(c);
		const r = b.mintRoute();
		const t = b.open(r);
		b.applySubscription(a, [{ key: r.key }]);
		// `c` subscribes to a different (nonexistent) key
		b.applySubscription(c, [{ key: "web:99" }]);

		const streamer = t.newStreamer({});
		await streamer.commitAssistant("hi");

		const aEvents = a.received.filter(m => m.type === "session.event");
		const cEvents = c.received.filter(m => m.type === "session.event");
		expect(aEvents).toHaveLength(1);
		expect(cEvents).toHaveLength(0);
	});

	it("backfills new subscribers with events since the supplied seq", async () => {
		const b = makeBridge();
		const r = b.mintRoute();
		const t = b.open(r);
		const sub = makeSub();
		b.addSubscriber(sub);

		const streamer = t.newStreamer({});
		await streamer.commitAssistant("one");
		await streamer.commitAssistant("two");
		await streamer.commitAssistant("three");

		// Subscribe asking for backfill since seq 1 (i.e. want events 2+)
		b.applySubscription(sub, [{ key: r.key, since: 1 }]);

		const backfills = sub.received.filter(m => m.type === "session.backfill");
		expect(backfills).toHaveLength(1);
		const bf = backfills[0] as { events: Array<{ seq: number }> };
		expect(bf.events.map(e => e.seq)).toEqual([2, 3]);
	});

	it("persists and reloads session metadata across instances", async () => {
		const b1 = makeBridge();
		const r = b1.mintRoute();
		b1.open(r);
		b1.patchSession(r.key, { title: "hello", sessionFile: "/tmp/x.jsonl" });
		await b1.dispose();

		const b2 = makeBridge();
		const list = b2.listSessions();
		expect(list).toHaveLength(1);
		expect(list[0]?.title).toBe("hello");
		expect(list[0]?.sessionFile).toBe("/tmp/x.jsonl");
		// nextId should continue from where b1 left off
		const r2 = b2.mintRoute();
		expect(r2.key).toBe("web:2");
	});

	it("backfill carries earliestSeq so the client can detect a ring-overflow gap", async () => {
		// We don't push >500 events (that'd be slow); we instead
		// subscribe with a `since` older than the ring's earliest seq
		// to simulate the overflow window from the client's POV.
		const b = makeBridge();
		const r = b.mintRoute();
		const t = b.open(r);
		const streamer = t.newStreamer({});
		await streamer.commitAssistant("first");
		await streamer.commitAssistant("second");

		const sub = makeSub();
		b.addSubscriber(sub);
		b.applySubscription(sub, [{ key: r.key, since: 0 }]);

		const bf = sub.received.find(m => m.type === "session.backfill") as
			| { type: "session.backfill"; from: number; earliestSeq: number; events: Array<{ seq: number }> }
			| undefined;
		expect(bf).toBeDefined();
		expect(bf!.from).toBe(0);
		expect(bf!.earliestSeq).toBe(1);
		// gap detection: earliestSeq === from + 1 means no gap
		expect(bf!.earliestSeq).toBe(bf!.from + 1);
	});

	it("late subscriber receives the current turn-active state via session.turn", async () => {
		const b = makeBridge();
		const r = b.mintRoute();
		const t = b.open(r);
		// Simulate a turn start before anyone subscribed.
		t.typing.start();

		const sub = makeSub();
		b.addSubscriber(sub);
		b.applySubscription(sub, [{ key: r.key }]);

		const turn = sub.received.find(m => m.type === "session.turn") as
			| { type: "session.turn"; active: boolean } | undefined;
		expect(turn).toBeDefined();
		expect(turn!.active).toBe(true);

		// listSessions also reflects current turn state.
		const list = b.listSessions();
		expect(list[0]?.turnActive).toBe(true);

		t.typing.stop();
		// Drop the timer so afterEach doesn't fire late persist
		await b.dispose();
	});

	it("patchSession with empty title does not clobber the existing title", () => {
		const b = makeBridge();
		const r = b.mintRoute();
		b.open(r);
		b.patchSession(r.key, { title: "generated" });
		b.patchSession(r.key, { title: "" });   // post-turn patch before next title gen
		expect(b.listSessions()[0]?.title).toBe("generated");
	});

	it("validateCwd accepts defaultCwd and any other absolute path", () => {
		const b = makeBridge();
		// defaultCwd === tempDir per makeBridge
		expect(b.validateCwd(undefined)).toBe(tempDir);
		expect(b.validateCwd(tempDir)).toBe(tempDir);
		expect(b.validateCwd(join(tempDir, "sub"))).toBe(join(tempDir, "sub"));
		// No more allowlist — any absolute path is accepted (the
		// per-request resolveCwd still stat-checks for existence).
		// Use tempdir-derived paths so the assertions don't depend on
		// platform-specific realpath behavior (e.g. /etc → /private/etc
		// on macOS).
		const insideDefault = join(tempDir, "elsewhere");
		expect(b.validateCwd(insideDefault)).toBe(insideDefault);
		// And a path that lives entirely outside defaultCwd — derived
		// from a real tempdir we delete immediately so the assertion
		// doesn't depend on any pre-existing host path.
		const outsideRoot = realpathSync(mkdtempSync(join(tmpdir(), "omptg-outside-")));
		rmSync(outsideRoot, { recursive: true, force: true });
		const outside = join(outsideRoot, "child");
		expect(b.validateCwd(outside)).toBe(outside);
	});

	it("ui.cancel reaches sibling subscribers when one client resolves a ui.request", () => {
		const b = makeBridge();
		const r = b.mintRoute();
		const t = b.open(r);
		const a = makeSub();
		const c = makeSub();
		b.addSubscriber(a);
		b.addSubscriber(c);
		b.applySubscription(a, [{ key: r.key }]);
		b.applySubscription(c, [{ key: r.key }]);

		// Agent posts a select; both clients receive a ui.request envelope.
		const p = t.ui.select("pick", ["a", "b"]);
		const req = a.received.find(m => m.type === "ui.request") as
			| { type: "ui.request"; reqId: string } | undefined;
		expect(req).toBeDefined();
		expect(c.received.find(m => m.type === "ui.request")).toBeDefined();

		// One client resolves; the bridge fans out ui.cancel so siblings clear the form.
		t.ui.resolve({ kind: "callback", requestId: req!.reqId, value: "a" });
		b.broadcastUiCancelFor(r.key, req!.reqId);

		expect(c.received.some(m => m.type === "ui.cancel" && m.reqId === req!.reqId)).toBe(true);
		return p; // settle to keep the test runner happy
	});

	it("resolveCwd reports denied / missing / not-a-directory", () => {
		const b = makeBridge();
		expect(b.resolveCwd(undefined)).toEqual({ ok: true, cwd: tempDir });
		expect(b.resolveCwd(tempDir)).toEqual({ ok: true, cwd: tempDir });
		// `denied` now covers two cases: relative paths (rejected at
		// validateCwd) and EACCES/EPERM from statSync. The latter is
		// exercised in a separate test so we don't need root here.
		expect(b.resolveCwd("relative/path")).toEqual({ ok: false, reason: "denied" });
		expect(b.resolveCwd("/this/path/should/not/exist")).toEqual({ ok: false, reason: "missing" });

		// A path under defaultCwd that doesn't exist on disk → missing
		const missing = join(tempDir, "nope");
		expect(b.resolveCwd(missing)).toEqual({ ok: false, reason: "missing" });

		// A regular file under defaultCwd → not-a-directory
		const file = join(tempDir, "f");
		writeFileSync(file, "x");
		expect(b.resolveCwd(file)).toEqual({ ok: false, reason: "not-a-directory" });
	});

	it("resolveCwd maps EACCES/EPERM to denied", () => {
		// statSync on a 0o000 directory raises EACCES for non-root on
		// POSIX. Skip on Windows (chmod is largely a no-op there) and
		// under root (chmod no-ops, the test would spuriously fail).
		if (process.platform === "win32") return;
		if (process.getuid?.() === 0) return;
		const b = makeBridge();
		const locked = join(tempDir, "locked");
		mkdirSync(locked);
		const inner = join(locked, "child");
		mkdirSync(inner);
		chmodSync(locked, 0o000);
		try {
			expect(b.resolveCwd(inner)).toEqual({ ok: false, reason: "denied" });
		} finally {
			chmodSync(locked, 0o700);  // so afterEach rmSync can clean up
		}
	});

	it("modelId is broadcast on patchSession and surfaces in listSessions", () => {
		const b = makeBridge();
		const r = b.mintRoute();
		b.open(r);
		const sub = makeSub();
		b.addSubscriber(sub);
		b.patchSession(r.key, { modelId: "claude-3-5-sonnet" });

		expect(b.listSessions()[0]?.modelId).toBe("claude-3-5-sonnet");
		const updates = sub.received.filter(m => m.type === "session.updated") as Array<{ patch: { modelId?: string } }>;
		expect(updates[updates.length - 1]?.patch.modelId).toBe("claude-3-5-sonnet");
	});

	it("modelId round-trips through persistence", async () => {
		const b1 = makeBridge();
		const r = b1.mintRoute();
		b1.open(r);
		b1.patchSession(r.key, { modelId: "gpt-5" });
		await b1.dispose();

		const b2 = makeBridge();
		expect(b2.listSessions()[0]?.modelId).toBe("gpt-5");
	});

	it("backfill is sent for empty sessions so the client gets earliestSeq", () => {
		// N1: even with no events, a fresh subscriber must receive a
		// backfill envelope so the gap-detect predicate works on the
		// very first event the server later assigns.
		const b = makeBridge();
		const r = b.mintRoute();
		b.open(r);

		const sub = makeSub();
		b.addSubscriber(sub);
		b.applySubscription(sub, [{ key: r.key }]);

		const bf = sub.received.find(m => m.type === "session.backfill") as
			| { type: "session.backfill"; earliestSeq: number; events: unknown[] }
			| undefined;
		expect(bf).toBeDefined();
		expect(bf!.events).toEqual([]);
		// nextSeq is 1 (no events yet); earliestSeq === 1 means no gap.
		expect(bf!.earliestSeq).toBe(1);
	});

	it("validateCwd rejects relative paths", () => {
		// resolvePath would otherwise rebase "../foo" onto process.cwd(),
		// which is almost never what a malformed client meant.
		const b = makeBridge();
		expect(b.validateCwd("relative/path")).toBeUndefined();
		expect(b.validateCwd("../escape")).toBeUndefined();
		expect(b.validateCwd("./dot")).toBeUndefined();
	});

	it("validateCwd realpath-canonicalizes symlinks", () => {
		// Symlinks resolve to their target so two routes to the same
		// directory collapse to a single session/folder entry. Target a
		// second tempdir so we don't depend on /etc not being itself a
		// symlink (it is, on macOS).
		const b = makeBridge();
		const target = realpathSync(mkdtempSync(join(tmpdir(), "omptg-target-")));
		try {
			const link = join(tempDir, "link-to-target");
			symlinkSync(target, link);
			expect(b.validateCwd(link)).toBe(target);
		} finally {
			rmSync(target, { recursive: true, force: true });
		}
	});

	it("ws handshake: folder.list arrives before session.list", async () => {
		const b = makeBridge();
		b.createFolder({ name: "first", cwd: tempDir });
		const running: RunningServer = startWebServer({ host: "127.0.0.1", port: 0, bridge: b });
		try {
			const url = running.server.url;
			const wsUrl = `ws://${url.hostname}:${url.port}/ws`;
			const ws = new WebSocket(wsUrl);
			const messages: ServerMsg[] = [];
			const opened = new Promise<void>((resolve, reject) => {
				ws.addEventListener("open", () => resolve());
				ws.addEventListener("error", () => reject(new Error("ws error")));
			});
			ws.addEventListener("message", ev => {
				messages.push(JSON.parse(String(ev.data)) as ServerMsg);
			});
			await opened;
			// Wait for both handshake envelopes.
			const deadline = Date.now() + 2000;
			while (messages.length < 2 && Date.now() < deadline) {
				await new Promise(r => setTimeout(r, 10));
			}
			ws.close();
			expect(messages[0]?.type).toBe("folder.list");
			expect(messages[1]?.type).toBe("session.list");
			if (messages[0]?.type === "folder.list") {
				expect(messages[0].folders).toHaveLength(1);
			}
		} finally {
			await running.stop();
		}
	});
});
