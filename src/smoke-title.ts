/**
 * Verify auto-title generation: send a prompt, wait for agent_end, confirm
 * session.sessionName populated and SessionManager.list reports it.
 */
import { ChatSession, listStoredSessions } from "./chat.ts";
import { initTheme } from "@oh-my-pi/pi-coding-agent";
import type { Bot } from "grammy";

await initTheme();

const sent: { id: number; text: string }[] = [];
let nextId = 1;
const fakeBot = {
	api: {
		async sendMessage(_c: number, text: string) {
			const id = nextId++;
			sent.push({ id, text });
			console.log(`  TG.send[${id}] ${text.slice(0, 60).replace(/\n/g, " | ")}`);
			return { message_id: id };
		},
		async editMessageText(_c: number, id: number, text: string) {
			console.log(`  TG.edit[${id}]  ${text.slice(0, 60).replace(/\n/g, " | ")}`);
		},
		async editMessageReplyMarkup() {},
	},
} as unknown as Bot;

const chat = new ChatSession({ chatId: 9001, cwd: "/tmp", bot: fakeBot });

console.log("[1] first prompt");
const streamer = await chat.prompt(
	"List three short fruit names separated by commas.",
);
const s = await chat.ensure();
await s.waitForIdle();
await streamer.finalize();

console.log(
	`[2] session.sessionName immediately after waitForIdle: ${JSON.stringify(s.sessionName)}`,
);

// Title generation is fire-and-forget after agent_end; give it a tick.
console.log("[3] waiting 8s for background title generation…");
await new Promise(r => setTimeout(r, 8000));
console.log(`    session.sessionName: ${JSON.stringify(s.sessionName)}`);

console.log("[4] SessionManager.list view");
const stored = await listStoredSessions("/tmp", 3);
for (const ss of stored) {
	console.log(
		`    ${ss.id.slice(0, 8)} title=${JSON.stringify(ss.title)} firstMessage=${JSON.stringify(ss.firstMessage?.slice(0, 50))}`,
	);
}

const own = stored.find(ss => ss.id === s.sessionId);
const ok = Boolean(own?.title && own.title.length > 0);
console.log(`\n${ok ? "✓" : "✗"} title persisted to session file`);

await chat.dispose();
process.exit(ok ? 0 : 1);
