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
	/** Force the Nth (1-indexed) editMessageText call to throw the given error. */
	failEdit(n: number, err: Error): void;
}

function stubBot(): Stub {
	const sends: Sent[] = [];
	const edits: Edited[] = [];
	const editFailures = new Map<number, Error>();
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
	};
}

describe("TelegramStreamer activity coalescing", () => {
	test("toolStart sends once; subsequent tool/preamble/notice edit the same message", async () => {
		const { bot, sends, edits } = stubBot();
		const s = new TelegramStreamer(bot, 42);
		await s.toolStart("t1", "📖 read a.ts");
		await s.commitPreamble("thinking out loud");
		await s.notice("🔄 retry 1/3");
		await s.toolStart("t2", "💻 bash: ls");
		expect(sends.length).toBe(1);
		expect(sends[0]!.text).toBe("📖 read a.ts");
		expect(edits.length).toBe(3);
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
		expect(sends[0]!.opts?.link_preview_options).toEqual({ is_disabled: true });
		expect(edits[0]!.opts?.link_preview_options).toEqual({ is_disabled: true });
	});

	test("toolEnd rewrites the original line in place", async () => {
		const { bot, sends, edits } = stubBot();
		const s = new TelegramStreamer(bot, 42);
		await s.toolStart("t1", "📖 read a.ts");
		await s.toolStart("t2", "💻 bash: ls");
		await s.toolEnd("t1", false, undefined);
		expect(sends.length).toBe(1);
		expect(edits[edits.length - 1]!.text).toBe("✅ read a.ts\n💻 bash: ls");
	});

	test("toolEnd with error uses errorLine in place", async () => {
		const { bot, edits } = stubBot();
		const s = new TelegramStreamer(bot, 42);
		await s.toolStart("t1", "📖 read a.ts");
		await s.toolEnd("t1", true, "❌ read failed: ENOENT");
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
		const editsBefore = edits.length;
		await s.toolEnd("t0", false, undefined);
		expect(edits.length).toBe(editsBefore + 1);
		expect(edits[edits.length - 1]!.messageId).toBe(sends[0]!.messageId);
		expect(edits[edits.length - 1]!.text.startsWith("✅ read f0.ts\n")).toBe(true);
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

	test("finalize clears state and is idempotent", async () => {
		const { bot, sends } = stubBot();
		const s = new TelegramStreamer(bot, 42);
		await s.toolStart("t1", "📖 read a.ts");
		await s.finalize();
		await s.finalize();
		// After finalize, further toolStart is a no-op.
		await s.toolStart("t2", "📖 read b.ts");
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
		await s.toolStart("t2", "💻 bash: ls"); // edit #1: forced failure
		expect(stub.edits.length).toBe(0);
		await s.notice("ok"); // next flush — must include the bash line
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
		await s.notice("more"); // genuine change — one edit
		expect(stub.edits.length).toBe(1);
		expect(stub.edits[0]!.text).toBe("📖 read a.ts\nok\nmore");
	});
});
