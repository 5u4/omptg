/**
 * Reproduce the user-reported bug: ask the agent to call its `ask` tool.
 * Pre-fix this throws "undefined is not an object (evaluating 'theme.status')"
 * because TelegramUI shipped `{} as Theme` instead of OMP's real theme.
 *
 * Post-fix the `ask` tool renders, our UI bridge captures the pending
 * request, we answer it programmatically, the tool resolves, the agent
 * acknowledges the answer.
 */
import { ChatSession } from "./chat.ts";
import { initTheme } from "@oh-my-pi/pi-coding-agent";
import type { Bot } from "grammy";

await initTheme();

const sent: { id: number; text: string }[] = [];
let nextId = 1;
const fakeBot = {
	api: {
		async sendMessage(_chatId: number, text: string) {
			const id = nextId++;
			sent.push({ id, text });
			console.log(`  TG.send[${id}] ${text.slice(0, 100).replace(/\n/g, " | ")}`);
			return { message_id: id };
		},
		async editMessageText(_c: number, id: number, text: string) {
			console.log(`  TG.edit[${id}]  ${text.slice(0, 100).replace(/\n/g, " | ")}`);
		},
		async editMessageReplyMarkup() {},
	},
} as unknown as Bot;

const chat = new ChatSession({ chatId: 42, cwd: "/tmp", bot: fakeBot });

// Background watcher: as soon as the UI bridge has a pending request,
// answer it. This stands in for a human tapping the inline button.
let answered = false;
const watcher = setInterval(() => {
	if (answered) return;
	const pending = chat.pendingUi();
	if (!pending) return;
	console.log(
		`  >> pending ${pending.kind} reqId=${pending.requestId} awaitsText=${pending.awaitsText}`,
	);
	answered = true;
	if (pending.awaitsText) {
		chat.resolvePending({ kind: "text", text: "telegram" });
	} else {
		// For confirm: "y"; for select: index 0.
		const value = pending.kind === "confirm" ? "y" : "i0";
		chat.resolvePending({
			kind: "callback",
			requestId: pending.requestId,
			value,
		});
	}
	console.log(`  >> answered with synthetic reply`);
}, 100);

try {
	const streamer = await chat.prompt(
		"Please call the `ask` tool once with question 'Which client am I?' " +
			"and options ['telegram', 'cli', 'vscode']. Then tell me which I picked.",
	);
	const s = await chat.ensure();
	await s.waitForIdle();
	await streamer.finalize();
	console.log("\n✓ ask-tool round-trip completed without theme crash");
} finally {
	clearInterval(watcher);
	await chat.dispose();
}
