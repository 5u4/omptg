import { describe, expect, test } from "bun:test";
import type { Bot } from "grammy";
import { encodeCallback, parseCallback, TelegramUI } from "../src/ui-bridge.ts";

describe("parseCallback", () => {
	test("round-trips encodeCallback", () => {
		const data = encodeCallback("req-1", "i3");
		expect(parseCallback(data)).toEqual({ requestId: "req-1", value: "i3" });
	});

	test("returns undefined for foreign prefix", () => {
		expect(parseCallback("other:req:val")).toBeUndefined();
	});

	test("returns undefined when separator missing", () => {
		expect(parseCallback("ompui:no-colon-here")).toBeUndefined();
	});

	test("preserves value containing colons (splits on first only)", () => {
		const data = encodeCallback("req-1", "key:with:colons");
		expect(parseCallback(data)).toEqual({
			requestId: "req-1",
			value: "key:with:colons",
		});
	});

	test("empty value parses as empty string", () => {
		expect(parseCallback("ompui:abc:")).toEqual({ requestId: "abc", value: "" });
	});
});

/** Stub Bot: records each sendMessage / editMessageText call so tests can
 *  assert on previews and on the post-resolution feedback edit. */
function stubBot(): {
	bot: Bot;
	nextMessageId: () => number;
	sent: { text: string; opts: unknown }[];
	edits: { messageId: number; text: string }[];
} {
	let counter = 100;
	const sent: { text: string; opts: unknown }[] = [];
	const edits: { messageId: number; text: string }[] = [];
	const bot = {
		api: {
			sendMessage: async (_chatId: number, text: string, opts?: unknown) => {
				sent.push({ text, opts });
				return { message_id: ++counter };
			},
			editMessageText: async (_chatId: number, messageId: number, text: string) => {
				edits.push({ messageId, text });
				return undefined;
			},
			editMessageReplyMarkup: async () => undefined,
		},
	} as unknown as Bot;
	return { bot, nextMessageId: () => counter, sent, edits };
}

describe("TelegramUI.resolve", () => {
	test("returns false when no pending request", () => {
		const { bot } = stubBot();
		const ui = new TelegramUI(bot, 1);
		expect(
			ui.resolve({ kind: "callback", requestId: "x", value: "y" }),
		).toBe(false);
		expect(ui.resolve({ kind: "text", text: "hi" })).toBe(false);
	});

	test("callback with matching requestId resolves the select promise", async () => {
		const { bot } = stubBot();
		const ui = new TelegramUI(bot, 1);
		const p = ui.select("pick", ["a", "b"]);
		// Pending is set synchronously after the sendMessage await; yield.
		await Promise.resolve();
		await Promise.resolve();
		const pending = ui.pending();
		expect(pending?.kind).toBe("select");
		const ok = ui.resolve({
			kind: "callback",
			requestId: pending!.requestId,
			value: "i1",
		});
		expect(ok).toBe(true);
		expect(await p).toBe("b");
		expect(ui.pending()).toBeUndefined();
	});

	test("callback with mismatched requestId is rejected, pending preserved", async () => {
		const { bot } = stubBot();
		const ui = new TelegramUI(bot, 1);
		const p = ui.select("pick", ["a"]);
		await Promise.resolve();
		await Promise.resolve();
		const pending = ui.pending();
		expect(
			ui.resolve({ kind: "callback", requestId: "wrong-id", value: "i0" }),
		).toBe(false);
		// Pending still there
		expect(ui.pending()?.requestId).toBe(pending!.requestId);
		// Clean up so the promise doesn't dangle
		ui.resolve({
			kind: "callback",
			requestId: pending!.requestId,
			value: "cancel",
		});
		expect(await p).toBeUndefined();
	});

	test("text payload into select (non-text pending) is rejected", async () => {
		const { bot } = stubBot();
		const ui = new TelegramUI(bot, 1);
		const p = ui.select("pick", ["a"]);
		await Promise.resolve();
		await Promise.resolve();
		const pending = ui.pending();
		expect(ui.resolve({ kind: "text", text: "free typing" })).toBe(false);
		expect(ui.pending()?.requestId).toBe(pending!.requestId);
		// Drain
		ui.resolve({
			kind: "callback",
			requestId: pending!.requestId,
			value: "cancel",
		});
		expect(await p).toBeUndefined();
	});

	test("text payload into input (awaitsText) resolves with the text", async () => {
		const { bot } = stubBot();
		const ui = new TelegramUI(bot, 1);
		const p = ui.input("Your name?");
		await Promise.resolve();
		await Promise.resolve();
		const pending = ui.pending();
		expect(pending?.awaitsText).toBe(true);
		expect(ui.resolve({ kind: "text", text: "Alice" })).toBe(true);
		expect(await p).toBe("Alice");
		expect(ui.pending()).toBeUndefined();
	});

	test("callback with cancel value resolves select to undefined", async () => {
		const { bot } = stubBot();
		const ui = new TelegramUI(bot, 1);
		const p = ui.select("pick", ["a", "b"]);
		await Promise.resolve();
		await Promise.resolve();
		const pending = ui.pending();
		expect(
			ui.resolve({
				kind: "callback",
				requestId: pending!.requestId,
				value: "cancel",
			}),
		).toBe(true);
		expect(await p).toBeUndefined();
	});

	test("starting a second select rejects the first in-flight one", async () => {
		const { bot } = stubBot();
		const ui = new TelegramUI(bot, 1);
		const p1 = ui.select("first", ["a"]);
		await Promise.resolve();
		await Promise.resolve();
		const p2 = ui.select("second", ["b"]);
		await Promise.resolve();
		await Promise.resolve();
		// First should be resolved to undefined by the in-flight rejection.
		expect(await p1).toBeUndefined();
		const pending = ui.pending();
		expect(pending).toBeDefined();
		ui.resolve({
			kind: "callback",
			requestId: pending!.requestId,
			value: "cancel",
		});
		expect(await p2).toBeUndefined();
	});
});

describe("TelegramUI.select preview", () => {
	test("CJK options wider than the budget trigger a numbered preview", async () => {
		const { bot, sent } = stubBot();
		const ui = new TelegramUI(bot, 1);
		// ~35 CJK code points → visual width ≈ 70, well over the 20-col budget
		// even though `.length` is only 35.
		const longCjk =
			"字符上限（如三千五百字）：超过则封存当前消息，开新消息继续显示新内容";
		const p = ui.select("活动消息上限策略？", [longCjk, "短选项"]);
		await Promise.resolve();
		await Promise.resolve();
		// First send is the preview (full text), second is the keyboard carrier.
		expect(sent[0]?.text).toContain(longCjk);
		expect(sent[0]?.text).toContain("1)");
		expect(sent[1]?.text).toBe("👇 pick one");
		// Drain so the dangling promise doesn't leak.
		const pending = ui.pending();
		ui.resolve({ kind: "callback", requestId: pending!.requestId, value: "cancel" });
		expect(await p).toBeUndefined();
	});

	test("short ASCII options keep the verbatim-button layout (no preview)", async () => {
		const { bot, sent } = stubBot();
		const ui = new TelegramUI(bot, 1);
		const p = ui.select("pick", ["yes", "no"]);
		await Promise.resolve();
		await Promise.resolve();
		expect(sent).toHaveLength(1);
		expect(sent[0]?.text).toBe("❓ pick");
		const pending = ui.pending();
		ui.resolve({ kind: "callback", requestId: pending!.requestId, value: "cancel" });
		expect(await p).toBeUndefined();
	});
});

describe("TelegramUI choice reflection", () => {
	test("select edits the carrier message to show the chosen option", async () => {
		const { bot, edits } = stubBot();
		const ui = new TelegramUI(bot, 1);
		const p = ui.select("pick", ["alpha", "beta"]);
		await Promise.resolve();
		await Promise.resolve();
		const pending = ui.pending()!;
		ui.resolve({ kind: "callback", requestId: pending.requestId, value: "i1" });
		expect(await p).toBe("beta");
		expect(edits).toHaveLength(1);
		expect(edits[0]?.messageId).toBe(pending.messageId);
		expect(edits[0]?.text).toContain("pick");
		expect(edits[0]?.text).toContain("beta");
	});

	test("select cancel marks the message as cancelled", async () => {
		const { bot, edits } = stubBot();
		const ui = new TelegramUI(bot, 1);
		const p = ui.select("pick", ["a"]);
		await Promise.resolve();
		await Promise.resolve();
		const pending = ui.pending()!;
		ui.resolve({ kind: "callback", requestId: pending.requestId, value: "cancel" });
		expect(await p).toBeUndefined();
		expect(edits[0]?.text).toContain("cancelled");
	});

	test("confirm edits the message to show yes/no", async () => {
		const { bot, edits } = stubBot();
		const ui = new TelegramUI(bot, 1);
		const p = ui.confirm("proceed?", "really?");
		await Promise.resolve();
		await Promise.resolve();
		const pending = ui.pending()!;
		ui.resolve({ kind: "callback", requestId: pending.requestId, value: "y" });
		expect(await p).toBe(true);
		expect(edits[0]?.text).toContain("→ yes");
	});

	test("input text reply edits the carrier to show the answer", async () => {
		const { bot, edits } = stubBot();
		const ui = new TelegramUI(bot, 1);
		const p = ui.input("Your name?");
		await Promise.resolve();
		await Promise.resolve();
		ui.resolve({ kind: "text", text: "Alice" });
		expect(await p).toBe("Alice");
		expect(edits[0]?.text).toContain("Your name?");
		expect(edits[0]?.text).toContain("Alice");
	});

	test("confirm 'no' is reflected as → no", async () => {
		const { bot, edits } = stubBot();
		const ui = new TelegramUI(bot, 1);
		const p = ui.confirm("proceed?", "really?");
		await Promise.resolve();
		await Promise.resolve();
		const pending = ui.pending()!;
		ui.resolve({ kind: "callback", requestId: pending.requestId, value: "n" });
		expect(await p).toBe(false);
		expect(edits[0]?.text).toContain("→ no");
	});

	test("superseding an in-flight confirm renders cancelled, not → no", async () => {
		const { bot, edits } = stubBot();
		const ui = new TelegramUI(bot, 1);
		const p1 = ui.confirm("first?", "first?");
		await Promise.resolve();
		await Promise.resolve();
		// Second request supersedes the first via rejectInFlight.
		const p2 = ui.confirm("second?", "second?");
		await Promise.resolve();
		await Promise.resolve();
		// Superseded confirm degrades to false but the carrier MUST NOT
		// claim the user tapped "no" — it must read as cancelled.
		expect(await p1).toBe(false);
		expect(edits[0]?.text).toContain("cancelled");
		expect(edits[0]?.text).not.toContain("→ no");
		// Drain the second one.
		const pending = ui.pending()!;
		ui.resolve({ kind: "callback", requestId: pending.requestId, value: "n" });
		expect(await p2).toBe(false);
	});

	test("input cancel button is reflected as cancelled", async () => {
		const { bot, edits } = stubBot();
		const ui = new TelegramUI(bot, 1);
		const p = ui.input("Your name?");
		await Promise.resolve();
		await Promise.resolve();
		const pending = ui.pending()!;
		ui.resolve({ kind: "callback", requestId: pending.requestId, value: "cancel" });
		expect(await p).toBeUndefined();
		expect(edits[0]?.text).toContain("Your name?");
		expect(edits[0]?.text).toContain("cancelled");
	});

	test("long-CJK select edits the carrier, not the preview", async () => {
		const { bot, sent, edits } = stubBot();
		const ui = new TelegramUI(bot, 1);
		const longCjk = "字符上限（如三千五百字）：超过则封存当前消息，开新消息继续显示新内容";
		const p = ui.select("活动消息上限策略？", [longCjk, "短选项"]);
		await Promise.resolve();
		await Promise.resolve();
		// sent[0] = preview, sent[1] = "👇 pick one" carrier. The carrier
		// is the one that should be rewritten; the preview must survive
		// so the user can still see the full option text.
		const pending = ui.pending()!;
		ui.resolve({ kind: "callback", requestId: pending.requestId, value: "i0" });
		expect(await p).toBe(longCjk);
		expect(edits).toHaveLength(1);
		expect(edits[0]?.messageId).toBe(pending.messageId);
		expect(edits[0]?.text).toContain("活动消息上限策略？");
		expect(edits[0]?.text).toContain(longCjk);
		// Preview text in sent[0] still present (we never edited it).
		expect(sent[0]?.text).toContain(longCjk);
	});
});
