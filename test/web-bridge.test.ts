import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebBridge } from "../src/bridge/web/index.ts";
import type { ServerMsg } from "../src/bridge/web/protocol.ts";

interface FakeSub {
	send(msg: ServerMsg): void;
	received: ServerMsg[];
	subs: Map<string, number>;
}

function makeSub(): FakeSub {
	const received: ServerMsg[] = [];
	return {
		received,
		subs: new Map(),
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
	tempDir = mkdtempSync(join(tmpdir(), "omptg-web-"));
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
});
