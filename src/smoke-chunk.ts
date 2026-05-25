/**
 * Smoke for the streamer: assistant commit + ephemeral status + chunking.
 * Stubs bot.api with recorders; no telegram traffic.
 *
 *   bun run src/smoke-chunk.ts
 */
import type { Bot } from "grammy";
import { splitForTelegram, TelegramStreamer } from "./streamer.ts";

interface SendCall { messageId: number; text: string }
interface EditCall { messageId: number; text: string }
interface DeleteCall { messageId: number }

function makeFakeBot(): {
	bot: Bot;
	sends: SendCall[];
	edits: EditCall[];
	deletes: DeleteCall[];
} {
	const sends: SendCall[] = [];
	const edits: EditCall[] = [];
	const deletes: DeleteCall[] = [];
	let nextId = 1000;
	const api = {
		sendMessage(_chatId: number, text: string) {
			if (text.length > 4096) {
				throw new Error(`sendMessage would overflow: ${text.length} chars`);
			}
			const message_id = ++nextId;
			sends.push({ messageId: message_id, text });
			return Promise.resolve({ message_id });
		},
		editMessageText(_chatId: number, messageId: number, text: string) {
			if (text.length > 4096) {
				throw new Error(`editMessageText would overflow: ${text.length}`);
			}
			edits.push({ messageId, text });
			return Promise.resolve(true);
		},
		deleteMessage(_chatId: number, messageId: number) {
			deletes.push({ messageId });
			return Promise.resolve(true);
		},
		sendChatAction(_chatId: number, _action: string) {
			return Promise.resolve(true);
		},
	};
	return { bot: { api } as unknown as Bot, sends, edits, deletes };
}

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`assert: ${msg}`);
}

async function main() {
	// --- Case 1: long assistant text splits across multiple sends. ---
	{
		const { bot, sends } = makeFakeBot();
		const streamer = new TelegramStreamer(bot, 1);
		const line = "x".repeat(79);
		const payload = Array.from({ length: 150 }, () => line).join("\n");
		assert(payload.length > 4096 * 2, "payload should span 3+ messages");
		await streamer.commitAssistant(payload);
		await streamer.finalize();
		assert(sends.length >= 3, `expected ≥3 sends, got ${sends.length}`);
		for (const s of sends) {
			assert(s.text.length <= 4096, `chunk too long: ${s.text.length}`);
			assert(s.text.length > 0, `empty chunk`);
		}
		console.log(`✓ long commit split across ${sends.length} messages`);
	}

	// --- Case 2: short assistant text is one send, no status traffic. ---
	{
		const { bot, sends, edits, deletes } = makeFakeBot();
		const streamer = new TelegramStreamer(bot, 1);
		await streamer.commitAssistant("hello world");
		await streamer.finalize();
		assert(sends.length === 1, `expected 1 send, got ${sends.length}`);
		assert(sends[0]!.text === "hello world", "text mismatch");
		assert(edits.length === 0 && deletes.length === 0, "no status traffic expected");
		console.log("✓ short commit stays in one message");
	}

	// --- Case 3: status message lifecycle (send → edit → delete on commit). ---
	{
		const { bot, sends, edits, deletes } = makeFakeBot();
		const streamer = new TelegramStreamer(bot, 1);
		await streamer.setStatus("📖 read foo.ts");
		await streamer.setStatus("📖 read bar.ts");
		await streamer.commitAssistant("done");
		await streamer.finalize();
		assert(sends.length === 2,
			`expected 2 sends (status + commit), got ${sends.length}`);
		assert(sends[0]!.text === "📖 read foo.ts", "initial status mismatch");
		assert(edits.length === 1, `expected 1 status edit, got ${edits.length}`);
		assert(edits[0]!.text === "📖 read bar.ts", "status edit mismatch");
		assert(deletes.length === 1, `expected 1 status delete, got ${deletes.length}`);
		assert(deletes[0]!.messageId === sends[0]!.messageId, "wrong msg deleted");
		assert(sends[1]!.text === "done", "commit text mismatch");
		console.log("✓ status message life-cycles cleanly around commit");
	}

	// --- Case 4: empty turn → "(no response)" fallback. ---
	{
		const { bot, sends, deletes } = makeFakeBot();
		const streamer = new TelegramStreamer(bot, 1);
		await streamer.finalize();
		assert(sends.length === 1 && sends[0]!.text === "(no response)",
			"expected (no response) placeholder");
		assert(deletes.length === 0, "nothing to delete on bare finalize");
		console.log("✓ empty turn yields (no response)");
	}

	// --- Case 5: status alone (no commit) is still deleted at finalize. ---
	{
		const { bot, sends, deletes } = makeFakeBot();
		const streamer = new TelegramStreamer(bot, 1);
		await streamer.setStatus("✨ thinking…");
		await streamer.finalize();
		assert(deletes.length === 1, `status should be deleted, got ${deletes.length}`);
		assert(sends.some(s => s.text === "(no response)"),
			"no-response fallback missing");
		console.log("✓ orphaned status is cleaned up on finalize");
	}

	// --- Case 6: splitForTelegram preserves content + respects budget. ---
	{
		const payload = "alpha\n".repeat(2000); // 12000 chars
		const chunks = splitForTelegram(payload);
		assert(chunks.length >= 3, `expected ≥3 chunks, got ${chunks.length}`);
		for (const c of chunks) assert(c.length <= 4096, `chunk too big: ${c.length}`);
		console.log(`✓ splitForTelegram produced ${chunks.length} chunks`);
	}
}

main().catch(err => {
	console.error("smoke-chunk failed:", err);
	process.exit(1);
});
