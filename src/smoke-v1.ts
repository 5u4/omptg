/**
 * Offline v1 smoke. No telegram, no bot token.
 *
 * Stubs the grammY Bot.api surface that ChatSession touches
 * (sendMessage, editMessageText) so we can drive the full code path:
 *
 *   1. /new   creates a fresh AgentSession in a cwd
 *   2. /dir   switches cwd, gets a new session
 *   3. prompt streams text back
 *   4. ui.confirm() (called from a fake extension) resolves via resolvePending
 *   5. /dirs lists sessions, /resume reopens one
 */
import { ChatSession, listStoredSessions } from "./chat.ts";
import type { Bot } from "grammy";
import { initTheme } from "@oh-my-pi/pi-coding-agent";

await initTheme();

const CWD = Bun.argv[2] ?? "/tmp";

// --- Fake bot ----------------------------------------------------------
type SentMessage = {
	chat_id: number;
	message_id: number;
	text: string;
	keyboard?: unknown;
};
const sent: SentMessage[] = [];
let nextMsgId = 1;
const fakeBot = {
	api: {
		async sendMessage(chat_id: number, text: string, extra?: any) {
			const m: SentMessage = {
				chat_id,
				message_id: nextMsgId++,
				text,
				keyboard: extra?.reply_markup,
			};
			sent.push(m);
			console.log(`  TG.send[${m.message_id}] ${text.slice(0, 80).replace(/\n/g, " | ")}`);
			return { message_id: m.message_id };
		},
		async editMessageText(chat_id: number, message_id: number, text: string) {
			const m = sent.find(s => s.message_id === message_id);
			if (m) m.text = text;
			console.log(`  TG.edit[${message_id}]  ${text.slice(0, 80).replace(/\n/g, " | ")}`);
		},
		async editMessageReplyMarkup() {},
	},
} as unknown as Bot;

const chat = new ChatSession({ chatId: 1, cwd: CWD, bot: fakeBot });

// --- 1. ensure session --------------------------------------------------
console.log("[1] ensure()");
const s1 = await chat.ensure();
console.log(`   sessionId=${s1.sessionId} model=${s1.model?.id} cwd=${chat.cwd}`);

// --- 2. prompt + stream -------------------------------------------------
console.log("\n[2] prompt -> stream");
const streamer = await chat.prompt("Reply with one word: streamcheck");
await s1.waitForIdle();
await streamer.finalize();

// --- 3. /new = swap to a fresh session in same cwd ----------------------
console.log("\n[3] /new");
const s2 = await chat.newSession();
console.log(`   new sessionId=${s2.sessionId} same cwd=${chat.cwd === CWD}`);
if (s1.sessionId === s2.sessionId) throw new Error("newSession() did not change sessionId");

// --- 4. ui bridge: trigger ui.confirm() then "tap" the yes button ------
console.log("\n[4] ui.confirm() round-trip");
// Reach into the AgentSession's set UI to fire a confirm — same path the
// agent would take when calling ui.confirm() from a tool/extension.
const ui = (chat as any).ui as { confirm: (t: string, m: string) => Promise<boolean> };
const confirmPromise = ui.confirm("Run dangerous thing?", "Continue?");
// Brief tick so the sendMessage stub records the keyboard.
await new Promise(r => setTimeout(r, 50));
const pending = chat.pendingUi();
if (!pending) throw new Error("pendingUi missing after confirm()");
console.log(`   pending ${pending.kind} reqId=${pending.requestId}`);
const ok = chat.resolvePending({ kind: "callback", requestId: pending.requestId, value: "y" });
if (!ok) throw new Error("resolvePending returned false");
const answer = await confirmPromise;
console.log(`   confirm() resolved to: ${answer} (expected true)`);
if (answer !== true) throw new Error("UI bridge did not deliver confirm value");

// --- 5. /dirs --------------------------------------------------------
console.log("\n[5] /dirs");
const stored = await listStoredSessions(chat.cwd, 5);
console.log(`   found ${stored.length} sessions in ${chat.cwd}`);
for (const s of stored.slice(0, 3)) {
	console.log(`     - ${s.id.slice(0, 8)} ${s.modified.toISOString().slice(0, 19)} :: ${(s.firstMessage || "").slice(0, 60)}`);
}

// --- 6. /resume: reopen first stored session ----------------------------
if (stored.length > 0) {
	const target = stored[0]!;
	console.log(`\n[6] /resume ${target.id.slice(0, 8)}`);
	const s3 = await chat.resume(target.path);
	console.log(`   resumed sessionId=${s3.sessionId} cwd=${chat.cwd}`);
	// One prompt to make sure the resumed session is healthy.
	const st2 = await chat.prompt("Reply with one word: resumed");
	await s3.waitForIdle();
	await st2.finalize();
}

await chat.dispose();
console.log("\n✓ v1 smoke OK");
