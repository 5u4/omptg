/**
 * Smoke test for `TelegramUI.confirm`. The agent doesn't expose a
 * confirm tool directly (it uses `ask` for user prompts); confirm is
 * an extension UI primitive. So we drive the bridge straight: post a
 * confirm, observe the pending request, synthesize a "yes" callback,
 * verify the promise resolves to true. Repeat with "no" → false.
 */
import { initTheme } from "@oh-my-pi/pi-coding-agent";
import type { Bot } from "grammy";
import { TelegramUI } from "./ui-bridge.ts";

await initTheme();

let nextId = 1;
const sent: { id: number; text: string }[] = [];
const fakeBot = {
	api: {
		async sendMessage(_chatId: number, text: string) {
			const id = nextId++;
			sent.push({ id, text });
			console.log(`  TG.send[${id}] ${text.slice(0, 120).replace(/\n/g, " | ")}`);
			return { message_id: id };
		},
		async editMessageReplyMarkup() {},
	},
} as unknown as Bot;

const ui = new TelegramUI(fakeBot, 42);

async function trial(label: string, answer: "y" | "n", expected: boolean) {
	const p = ui.confirm("Proceed?", `Trial: ${label}`);
	// Yield once so confirm() can post the message and register pending.
	await Promise.resolve();
	const pending = ui.pending();
	if (!pending || pending.kind !== "confirm") {
		throw new Error(`expected pending confirm, got ${pending?.kind}`);
	}
	console.log(`  >> pending reqId=${pending.requestId}, answering '${answer}'`);
	const ok = ui.resolve({
		kind: "callback",
		requestId: pending.requestId,
		value: answer,
	});
	if (!ok) throw new Error("resolve returned false");
	const result = await p;
	if (result !== expected) {
		throw new Error(`expected ${expected}, got ${result}`);
	}
	console.log(`  ✓ ${label} → ${result}`);
}

await trial("yes path", "y", true);
await trial("no path",  "n", false);

console.log("\n✓ confirm bridge round-trip OK (yes + no)");
