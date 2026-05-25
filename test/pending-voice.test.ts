import { describe, expect, test } from "bun:test";
import {
	PendingVoiceStore,
	encodeVoiceCallback,
	parseVoiceCallback,
	freshVoiceId,
} from "../src/pending-voice.ts";

describe("voice callback encoding", () => {
	test("send roundtrips", () => {
		const data = encodeVoiceCallback("send", "abc123");
		expect(parseVoiceCallback(data)).toEqual({ action: "send", id: "abc123" });
	});
	test("cancel roundtrips", () => {
		const data = encodeVoiceCallback("cancel", "xyz");
		expect(parseVoiceCallback(data)).toEqual({ action: "cancel", id: "xyz" });
	});
	test("rejects wrong prefix", () => {
		expect(parseVoiceCallback("ompui:abc:y")).toBeUndefined();
		expect(parseVoiceCallback("send:abc")).toBeUndefined();
	});
	test("rejects unknown action", () => {
		expect(parseVoiceCallback("voice:edit:abc")).toBeUndefined();
	});
	test("rejects empty id", () => {
		expect(parseVoiceCallback("voice:send:")).toBeUndefined();
	});
	test("rejects missing separator", () => {
		expect(parseVoiceCallback("voice:send")).toBeUndefined();
	});
	test("fits telegram callback_data 64-byte budget", () => {
		const data = encodeVoiceCallback("cancel", freshVoiceId());
		expect(data.length).toBeLessThanOrEqual(64);
	});
});

const baseEntry = {
	id: "id1",
	chatId: 1001,
	threadId: undefined,
	replyTo: 42,
	transcriptMessageId: 43,
	text: "hello world",
};

describe("PendingVoiceStore", () => {
	test("put then get returns entry", () => {
		const store = new PendingVoiceStore(60_000);
		store.put(baseEntry, 0);
		const got = store.get("id1", 1_000);
		expect(got?.text).toBe("hello world");
		expect(got?.createdAt).toBe(0);
	});

	test("take removes entry", () => {
		const store = new PendingVoiceStore(60_000);
		store.put(baseEntry, 0);
		expect(store.take("id1", 0)?.text).toBe("hello world");
		expect(store.get("id1", 0)).toBeUndefined();
		expect(store.size()).toBe(0);
	});

	test("get past TTL evicts and returns undefined", () => {
		const store = new PendingVoiceStore(1_000);
		store.put(baseEntry, 0);
		expect(store.get("id1", 1_001)).toBeUndefined();
		expect(store.size()).toBe(0);
	});

	test("getByTranscriptMessage matches reply target", () => {
		const store = new PendingVoiceStore();
		store.put(baseEntry, 0);
		expect(store.getByTranscriptMessage(1001, 43, 0)?.id).toBe("id1");
		// Different chatId or message_id: miss.
		expect(store.getByTranscriptMessage(1001, 99, 0)).toBeUndefined();
		expect(store.getByTranscriptMessage(9999, 43, 0)).toBeUndefined();
	});

	test("takeByTranscriptMessage consumes entry", () => {
		const store = new PendingVoiceStore();
		store.put(baseEntry, 0);
		expect(store.takeByTranscriptMessage(1001, 43, 0)?.id).toBe("id1");
		expect(store.getByTranscriptMessage(1001, 43, 0)).toBeUndefined();
		expect(store.get("id1", 0)).toBeUndefined();
	});

	test("delete is idempotent", () => {
		const store = new PendingVoiceStore();
		store.put(baseEntry, 0);
		store.delete("id1");
		store.delete("id1");
		store.delete("ghost");
		expect(store.size()).toBe(0);
	});

	test("threadId is preserved on entries", () => {
		const store = new PendingVoiceStore();
		store.put({ ...baseEntry, threadId: 7 }, 0);
		expect(store.get("id1", 0)?.threadId).toBe(7);
	});

	test("put evicts other expired entries", () => {
		const store = new PendingVoiceStore(1_000);
		store.put({ ...baseEntry, id: "old", transcriptMessageId: 10 }, 0);
		store.put({ ...baseEntry, id: "new", transcriptMessageId: 11 }, 2_000);
		expect(store.get("old", 2_000)).toBeUndefined();
		expect(store.get("new", 2_000)?.id).toBe("new");
	});
});

describe("freshVoiceId", () => {
	test("returns 12 hex chars", () => {
		const id = freshVoiceId();
		expect(id).toMatch(/^[0-9a-f]{12}$/);
	});
	test("collisions exceedingly unlikely", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 1000; i++) seen.add(freshVoiceId());
		expect(seen.size).toBe(1000);
	});
});
