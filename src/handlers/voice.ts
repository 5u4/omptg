/**
 * Voice / audio message pipeline.
 *
 * Telegram voice notes (OGG Opus) and uploaded audio attachments
 * (mp3/m4a/…) are both routed here. Flow:
 *
 *   1. Post `🎤 transcribing…` heartbeat so the user sees something.
 *   2. Download to cache, run through ffmpeg → whisper.
 *   3. Edit the heartbeat into the transcribed text with [✅ send / ❌ cancel]
 *      inline buttons. Pending entry indexed by short id (callback budget)
 *      AND by transcript message_id (so a user `reply_to` corrected text
 *      acts as an "edit" override).
 *   4. The actual agent turn is dispatched on tap / reply via runTurn.
 */
import type { Deps } from "../deps.ts";
import { scoped } from "../logger.ts";
import { extractThreadId } from "../topic.ts";
import { downloadVoiceToCache, transcribeAudio } from "../voice.ts";
import {
	encodeVoiceCallback,
	freshVoiceId,
} from "../pending-voice.ts";
import { runTurn } from "./turn.ts";

const log = scoped("voice");

/** Forward an approved (or edited) transcription into a normal agent turn. */
export async function dispatchVoiceText(
	deps: Deps,
	chatId: number,
	threadId: number | undefined,
	text: string,
	replyTo: number,
): Promise<void> {
	const chat = deps.registry.get(chatId, threadId);
	await runTurn({
		chat,
		prompt: text,
		replyTo,
		source: "voice",
	});
}

/**
 * Handle one voice/audio message end-to-end: download → transcribe →
 * post approval keyboard. The actual `chat.prompt()` call doesn't run
 * until the user approves (or edits via reply).
 */
async function handleVoiceMessage(
	deps: Deps,
	chatId: number,
	threadId: number | undefined,
	replyTo: number,
	fileId: string,
	sendInitial: (text: string, opts: Record<string, unknown>) => Promise<{ message_id: number }>,
): Promise<void> {
	const topicOpts = threadId !== undefined ? { message_thread_id: threadId } : {};
	const heartbeat = await sendInitial("🎤 transcribing…", {
		reply_parameters: { message_id: replyTo },
		...topicOpts,
	});
	try {
		const { path, bytes } = await downloadVoiceToCache(deps.bot, fileId);
		log.info("cached", { chat_id: chatId, path, bytes });
		const text = await transcribeAudio(path, {
			modelName: deps.stt.model,
			language: deps.stt.language,
		});
		if (!text) {
			await deps.bot.api.editMessageText(
				chatId,
				heartbeat.message_id,
				"🎤 (empty transcription)",
			);
			return;
		}
		const id = freshVoiceId();
		const body = [
			"🎤 transcription:",
			text,
			"",
			"↳ tap ✅ to send · reply to this message to edit · ❌ to discard",
		].join("\n");
		await deps.bot.api.editMessageText(chatId, heartbeat.message_id, body, {
			reply_markup: {
				inline_keyboard: [[
					{ text: "✅ send", callback_data: encodeVoiceCallback("send", id) },
					{ text: "❌ cancel", callback_data: encodeVoiceCallback("cancel", id) },
				]],
			},
		});
		deps.pendingVoice.put({
			id,
			chatId,
			threadId,
			replyTo,
			transcriptMessageId: heartbeat.message_id,
			text,
		});
		log.info("transcribed", { chat_id: chatId, id, chars: text.length });
	} catch (err) {
		log.error("failed", { chat_id: chatId, err: String(err) });
		const msg = err instanceof Error ? err.message : String(err);
		try {
			await deps.bot.api.editMessageText(chatId, heartbeat.message_id, `❌ ${msg}`);
		} catch {
			await deps.bot.api.sendMessage(chatId, `❌ ${msg}`, {
				reply_parameters: { message_id: replyTo },
				...topicOpts,
			});
		}
	}
}

/** Register message:voice + message:audio handlers. */
export function installVoiceHandlers(deps: Deps): void {
	deps.bot.on("message:voice", async ctx => {
		await handleVoiceMessage(
			deps,
			ctx.chat.id,
			extractThreadId(ctx.message),
			ctx.message.message_id,
			ctx.message.voice.file_id,
			(text, opts) => ctx.reply(text, opts),
		);
	});

	deps.bot.on("message:audio", async ctx => {
		await handleVoiceMessage(
			deps,
			ctx.chat.id,
			extractThreadId(ctx.message),
			ctx.message.message_id,
			ctx.message.audio.file_id,
			(text, opts) => ctx.reply(text, opts),
		);
	});
}
