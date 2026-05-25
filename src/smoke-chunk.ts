/**
 * Smoke for the streamer: assistant commit, per-tool persistent status
 * messages (sendMessage on start, editMessageText on end), and chunking.
 * Stubs bot.api with recorders; no telegram traffic.
 *
 *   bun run src/smoke-chunk.ts
 */
import type { Bot } from "grammy";
import { splitForTelegram, TelegramStreamer } from "./streamer.ts";

interface SendCall { messageId: number; text: string; silent: boolean }
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
		sendMessage(_chatId: number, text: string, opts?: { disable_notification?: boolean }) {
			if (text.length > 4096) {
				throw new Error(`sendMessage would overflow: ${text.length} chars`);
			}
			const message_id = ++nextId;
			sends.push({ messageId: message_id, text, silent: opts?.disable_notification === true });
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

	// --- Case 3: each tool gets its own message; end rewrites it in place. ---
	{
		const { bot, sends, edits, deletes } = makeFakeBot();
		const streamer = new TelegramStreamer(bot, 1);
		await streamer.toolStart("call-1", "📖 read foo.ts");
		await streamer.toolStart("call-2", "💻 bash: ls");
		await streamer.toolEnd("call-1", false, undefined);
		await streamer.toolEnd("call-2", true, "❌ bash failed: nope");
		await streamer.commitAssistant("done");
		await streamer.finalize();

		assert(sends.length === 3,
			`expected 3 sends (2 tools + commit), got ${sends.length}`);
		assert(sends[0]!.text === "📖 read foo.ts", "call-1 start text");
		assert(sends[1]!.text === "💻 bash: ls", "call-2 start text");
		assert(sends[2]!.text === "done", "commit text");
		assert(edits.length === 2, `expected 2 edits, got ${edits.length}`);
		// Match edits to their original send by messageId.
		const editFor = (id: number) => edits.find(e => e.messageId === id);
		assert(editFor(sends[0]!.messageId)?.text === "✅ read foo.ts",
			`call-1 end should be ✅ read foo.ts, got ${editFor(sends[0]!.messageId)?.text}`);
		assert(editFor(sends[1]!.messageId)?.text === "❌ bash failed: nope",
			`call-2 end should be ❌ bash failed: nope, got ${editFor(sends[1]!.messageId)?.text}`);
		assert(deletes.length === 0, "tool messages must NOT be deleted");
		console.log("✓ per-tool messages rewritten in place, none deleted");
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

	// --- Case 5: an in-flight tool at finalize stays as its start line. ---
	{
		const { bot, sends, edits, deletes } = makeFakeBot();
		const streamer = new TelegramStreamer(bot, 1);
		await streamer.toolStart("call-x", "🔍 search /todo/ in src");
		await streamer.finalize();
		assert(sends.length === 2,
			`expected start + no-response, got ${sends.length}`);
		assert(sends[0]!.text === "🔍 search /todo/ in src", "start line missing");
		assert(edits.length === 0, "no end event → no edit");
		assert(deletes.length === 0, "nothing should be deleted");
		console.log("✓ in-flight tool at finalize keeps its start message");
	}

	// --- Case 6: notice() posts a persistent message of its own. ---
	{
		const { bot, sends, edits, deletes } = makeFakeBot();
		const streamer = new TelegramStreamer(bot, 1);
		await streamer.notice("🔄 retry 1/3");
		await streamer.commitAssistant("ok");
		await streamer.finalize();
		assert(sends.length === 2, `expected notice + commit, got ${sends.length}`);
		assert(sends[0]!.text === "🔄 retry 1/3", "notice text");
		assert(sends[1]!.text === "ok", "commit text");
		assert(edits.length === 0 && deletes.length === 0, "notice should not edit/delete");
		console.log("✓ notice is its own persistent message");
	}

	// --- Case 7: splitForTelegram preserves content + respects budget. ---
	{
		const payload = "alpha\n".repeat(2000); // 12000 chars
		const chunks = splitForTelegram(payload);
		assert(chunks.length >= 3, `expected ≥3 chunks, got ${chunks.length}`);
		for (const c of chunks) assert(c.length <= 4096, `chunk too big: ${c.length}`);
		console.log(`✓ splitForTelegram produced ${chunks.length} chunks`);
	}

	// --- Case 8: commitPreamble truncates long text + adds 💭 prefix. ---
	{
		const { bot, sends } = makeFakeBot();
		const streamer = new TelegramStreamer(bot, 1);
		const long = "I'll read the file then make the edit because ".repeat(20);
		await streamer.commitPreamble(long);
		await streamer.commitPreamble("short note");
		await streamer.finalize();
		// finalize sees committedAny=false (preambles don't count) → emits (no response)
		assert(sends.length === 3, `expected 2 preambles + no-response, got ${sends.length}`);
		assert(sends[0]!.text.startsWith("💭 "), "preamble missing prefix");
		assert(sends[0]!.text.endsWith("…"), "long preamble should be ellipsized");
		assert(sends[0]!.text.length < long.length, "long preamble not truncated");
		assert(sends[1]!.text === "💭 short note", "short preamble verbatim");
		assert(sends[2]!.text === "(no response)", "preamble alone shouldn't satisfy committedAny");
		console.log("✓ preamble truncates + does not satisfy committedAny");
	}

	// --- Case 9: chrome is silent, assistant reply notifies. ---
	{
		const { bot, sends } = makeFakeBot();
		const streamer = new TelegramStreamer(bot, 1);
		await streamer.toolStart("c1", "📖 read x");
		await streamer.toolEnd("c1", false, undefined);
		await streamer.commitPreamble("about to do thing");
		await streamer.notice("🔄 retry 1/3");
		await streamer.commitAssistant("here is the real reply");
		await streamer.finalize();
		const find = (text: string) => sends.find(s => s.text === text);
		assert(find("📖 read x")?.silent === true, "tool start must be silent");
		assert(find("💭 about to do thing")?.silent === true, "preamble must be silent");
		assert(find("🔄 retry 1/3")?.silent === true, "notice must be silent");
		assert(find("here is the real reply")?.silent === false, "assistant reply must NOT be silent");
		console.log("✓ chrome silent, assistant reply notifies");
	}
}

main().catch(err => {
	console.error("smoke-chunk failed:", err);
	process.exit(1);
});
