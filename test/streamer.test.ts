import { describe, expect, test } from "bun:test";
import type { Bot } from "grammy";
import { TelegramStreamer } from "../src/streamer.ts";

interface Sent {
	chatId: number;
	text: string;
	opts?: Record<string, unknown>;
	messageId: number;
}
interface Edited {
	chatId: number;
	messageId: number;
	text: string;
	opts?: Record<string, unknown>;
}

interface Stub {
	bot: Bot;
	sends: Sent[];
	edits: Edited[];
	failEdit: (n: number, err: Error) => void;
	/** Block the Nth edit call until the returned `release` is called.
	 *  Use to simulate a slow `editMessageText` (autoRetry backoff, slow
	 *  network) and observe drain semantics. */
	gateEdit: (n: number) => { release: () => void };
}

function stubBot(): Stub {
	const sends: Sent[] = [];
	const edits: Edited[] = [];
	const editFailures = new Map<number, Error>();
	const editGates = new Map<number, Promise<void>>();
	let id = 1000;
	let editCalls = 0;
	const api = {
		sendMessage: async (chatId: number, text: string, opts?: Record<string, unknown>) => {
			const messageId = ++id;
			sends.push({ chatId, text, opts, messageId });
			return { message_id: messageId };
		},
		editMessageText: async (
			chatId: number,
			messageId: number,
			text: string,
			opts?: Record<string, unknown>,
		) => {
			editCalls++;
			const gate = editGates.get(editCalls);
			if (gate) await gate;
			const forced = editFailures.get(editCalls);
			if (forced) throw forced;
			edits.push({ chatId, messageId, text, opts });
			return true;
		},
	};
	return {
		bot: { api } as unknown as Bot,
		sends,
		edits,
		failEdit: (n, err) => editFailures.set(n, err),
		gateEdit: (n) => {
			let release!: () => void;
			editGates.set(n, new Promise<void>(r => { release = r; }));
			return { release };
		},
	};
}

describe("TelegramStreamer activity coalescing", () => {
	test("debounce: a burst of appends collapses into one edit carrying the latest snapshot", async () => {
		const { bot, sends, edits } = stubBot();
		const s = new TelegramStreamer(bot, 42);
		await s.toolStart("t1", "📖 read a.ts");
		await s.commitPreamble("thinking out loud");
		await s.notice("🔄 retry 1/3");
		await s.toolStart("t2", "💻 bash: ls");
		await s.flushPending();
		expect(sends.length).toBe(1);
		expect(sends[0]!.text).toBe("📖 read a.ts");
		// All three appends happened within the debounce window → 1 edit.
		expect(edits.length).toBe(1);
		const finalEdit = edits[edits.length - 1]!;
		expect(finalEdit.messageId).toBe(sends[0]!.messageId);
		expect(finalEdit.text).toBe(
			"📖 read a.ts\n💭 thinking out loud\n🔄 retry 1/3\n💻 bash: ls",
		);
	});

	test("activity send and edit suppress link previews", async () => {
		const { bot, sends, edits } = stubBot();
		const s = new TelegramStreamer(bot, 42);
		await s.toolStart("t1", "📖 read a.ts");
		await s.notice("🌐 hit https://example.com");
		await s.flushPending();
		expect(sends[0]!.opts?.link_preview_options).toEqual({ is_disabled: true });
		expect(edits[0]!.opts?.link_preview_options).toEqual({ is_disabled: true });
	});

	test("toolEnd rewrites the original line in place", async () => {
		const { bot, sends, edits } = stubBot();
		const s = new TelegramStreamer(bot, 42);
		await s.toolStart("t1", "📖 read a.ts");
		await s.toolStart("t2", "💻 bash: ls");
		await s.toolEnd("t1", false, undefined);
		await s.flushPending();
		expect(sends.length).toBe(1);
		expect(edits[edits.length - 1]!.text).toBe("✅ read a.ts\n💻 bash: ls");
	});

	test("toolEnd with error uses errorLine in place", async () => {
		const { bot, edits } = stubBot();
		const s = new TelegramStreamer(bot, 42);
		await s.toolStart("t1", "📖 read a.ts");
		await s.toolEnd("t1", true, "❌ read failed: ENOENT");
		await s.flushPending();
		expect(edits[edits.length - 1]!.text).toBe("❌ read failed: ENOENT");
	});

	test("seals and opens a new activity message when line cap is reached", async () => {
		const { bot, sends, edits } = stubBot();
		const s = new TelegramStreamer(bot, 42);
		// Default cap = 25 lines. Push 25 then one more triggers a new send.
		for (let i = 0; i < 25; i++) await s.toolStart(`t${i}`, `📖 read f${i}.ts`);
		expect(sends.length).toBe(1);
		await s.toolStart("t25", "📖 read f25.ts");
		expect(sends.length).toBe(2);
		expect(sends[1]!.text).toBe("📖 read f25.ts");
		// Editing an old tool's line should still target the FIRST message.
		await s.toolEnd("t0", false, undefined);
		await s.flushPending();
		// At least one edit lands on the first (sealed) message with ✅ on f0.
		const firstMsgEdits = edits.filter(e => e.messageId === sends[0]!.messageId);
		expect(firstMsgEdits.length).toBeGreaterThan(0);
		const last = firstMsgEdits[firstMsgEdits.length - 1]!;
		expect(last.text.startsWith("✅ read f0.ts\n")).toBe(true);
	});

	test("seals when char cap would overflow, fresh message starts with the overflowing line", async () => {
		const { bot, sends } = stubBot();
		const s = new TelegramStreamer(bot, 42);
		const big = "x".repeat(1000);
		// 3500-char cap. Three 1000-char lines (+joins = 3002) fit; a fourth tips it.
		await s.toolStart("a", big);
		await s.toolStart("b", big);
		await s.toolStart("c", big);
		expect(sends.length).toBe(1);
		await s.toolStart("d", big);
		expect(sends.length).toBe(2);
		expect(sends[1]!.text).toBe(big);
	});

	test("finalize drains pending edits and is idempotent", async () => {
		const { bot, sends, edits } = stubBot();
		const s = new TelegramStreamer(bot, 42);
		await s.toolStart("t1", "📖 read a.ts");
		await s.toolStart("t2", "💻 bash: ls");
		// No flushPending — finalize itself must drain.
		await s.finalize();
		await s.finalize();
		expect(edits.length).toBe(1);
		expect(edits[0]!.text).toBe("📖 read a.ts\n💻 bash: ls");
		// After finalize, further toolStart is a no-op.
		await s.toolStart("t3", "📖 read b.ts");
		expect(sends.length).toBe(1);
	});

	test("a failed edit is recovered on the next successful flush (regression)", async () => {
		// Before the fix, flushActivity wrote `renderedText = text` BEFORE
		// the await, so a transient edit failure poisoned the cache: a
		// future flush back to that exact text would early-return at the
		// `text === renderedText` check, permanently leaving the user with
		// stale chat content. Observable guarantee: after a failed edit,
		// the next successful flush carries the missing line.
		const stub = stubBot();
		const s = new TelegramStreamer(stub.bot, 42);
		stub.failEdit(1, new Error("Bad Request: too many requests"));
		await s.toolStart("t1", "📖 read a.ts"); // send msg (no edit yet)
		await s.toolStart("t2", "💻 bash: ls");
		await s.flushPending(); // edit #1 fires and fails
		expect(stub.edits.length).toBe(0);
		await s.notice("ok"); // queue a new flush
		await s.flushPending(); // edit #2 — must include the bash line
		expect(stub.edits.length).toBe(1);
		expect(stub.edits[0]!.text).toBe("📖 read a.ts\n💻 bash: ls\nok");
	});

	test("'message is not modified' response keeps cache consistent", async () => {
		const stub = stubBot();
		const s = new TelegramStreamer(stub.bot, 42);
		await s.toolStart("t1", "📖 read a.ts");
		stub.failEdit(1, new Error("Bad Request: message is not modified"));
		// First notice attempts an edit; telegram returns not-modified.
		// The error is swallowed; cache must update so we don't re-attempt
		// an identical-state edit on the next flush.
		await s.notice("ok");
		await s.flushPending(); // edit #1: 'not modified'
		await s.notice("more"); // genuine change
		await s.flushPending(); // edit #2: succeeds
		expect(stub.edits.length).toBe(1);
		expect(stub.edits[0]!.text).toBe("📖 read a.ts\nok\nmore");
	});
	test("finalize awaits an in-flight edit whose timer already fired", async () => {
		// Regression: an earlier draft nulled `pendingFlush` synchronously
		// inside runOnce, so `drainHost` could return before the in-flight
		// `editMessageText` settled. `ChatSession.dispose` would then treat
		// the streamer as done while the final ✅ frame was still on the
		// wire. Now `finalize` awaits every `inflightFlushes` entry.
		const stub = stubBot();
		const s = new TelegramStreamer(stub.bot, 42);
		const gate = stub.gateEdit(1);
		await s.toolStart("t1", "📖 read a.ts");
		await s.toolStart("t2", "💻 bash: ls");
		// Trigger the timer manually by waiting > debounce. Drain starts
		// the edit, which then blocks inside the gated stub.
		await Bun.sleep(300);
		// Edit is in flight but not yet recorded — the gate is still closed.
		expect(stub.edits.length).toBe(0);
		const finalizing = s.finalize();
		// `finalize` must NOT resolve while the edit is gated.
		const raced = await Promise.race([
			finalizing.then(() => "finalize"),
			Bun.sleep(50).then(() => "timeout"),
		]);
		expect(raced).toBe("timeout");
		gate.release();
		await finalizing;
		expect(stub.edits.length).toBe(1);
		expect(stub.edits[0]!.text).toBe("📖 read a.ts\n💻 bash: ls");
	});

	test("replaceWith awaits an in-flight edit so the error message lands last", async () => {
		const stub = stubBot();
		const s = new TelegramStreamer(stub.bot, 42);
		const gate = stub.gateEdit(1);
		await s.toolStart("t1", "📖 read a.ts");
		await s.toolStart("t2", "💻 bash: ls");
		await Bun.sleep(300); // timer fires, edit blocks in stub
		const order: string[] = [];
		const stubSend = stub.bot.api.sendMessage as unknown as (
			...args: unknown[]
		) => Promise<{ message_id: number }>;
		const wrapped = stub.bot.api.sendMessage;
		(stub.bot.api as unknown as { sendMessage: typeof stubSend }).sendMessage =
			async (...args) => {
				order.push("send");
				return wrapped.apply(stub.bot.api, args as Parameters<typeof wrapped>);
			};
		const replacing = s.replaceWith("error: boom");
		// Edit hasn't landed yet — neither should the error send.
		await Bun.sleep(20);
		expect(stub.edits.length).toBe(0);
		expect(order).toEqual([]);
		gate.release();
		await replacing;
		expect(stub.edits.length).toBe(1); // edit landed first
		expect(order).toEqual(["send"]);   // then error message
	});

	test("replaceWith during the debounce window doesn't hang (regression)", async () => {
		// Copilot review caught this: scheduleFlush used to add the pending
		// promise to inflightFlushes immediately. If replaceWith cleared
		// the timer before runOnce fired, the promise never resolved and
		// Promise.allSettled hung indefinitely. Fix: only track post-timer
		// flushes in inflightFlushes.
		const stub = stubBot();
		const s = new TelegramStreamer(stub.bot, 42);
		await s.toolStart("t1", "📖 read a.ts");
		await s.toolStart("t2", "💻 bash: ls"); // timer pending, not fired
		const replacing = s.replaceWith("error: boom");
		// Must complete promptly — well under the debounce window.
		const raced = await Promise.race([
			replacing.then(() => "done"),
			Bun.sleep(100).then(() => "hang"),
		]);
		expect(raced).toBe("done");
		// Error message landed; pending edit was cancelled before firing.
		expect(stub.sends.some(s => s.text === "error: boom")).toBe(true);
		expect(stub.edits.length).toBe(0);
	});
});
