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

/** Stub Bot: only `bot.api.sendMessage` is exercised by select/input. */
function stubBot(): { bot: Bot; nextMessageId: () => number } {
	let counter = 100;
	const bot = {
		api: {
			sendMessage: async (_chatId: number, _text: string) => ({
				message_id: ++counter,
			}),
			editMessageText: async () => undefined,
			editMessageReplyMarkup: async () => undefined,
		},
	} as unknown as Bot;
	return { bot, nextMessageId: () => counter };
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
