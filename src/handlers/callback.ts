/**
 * Inline-keyboard callback router. Two protocols share the same
 * `callback_query` channel:
 *
 *   - `voice:<send|cancel>:<id>` — voice approval (independent of any
 *      in-flight UI request); dispatched directly to dispatchVoiceText.
 *   - `ompui:<requestId>:<value>` — TelegramUI pending-request resolution
 *      (select / confirm / input answer). Routed through chat.resolvePending.
 *
 * For both, on success we strip the inline keyboard so the buttons can't
 * be re-pressed and the message stays as plain context.
 */
import type { Deps } from "../deps.ts";
import { scoped } from "../logger.ts";
import { extractThreadId } from "../topic.ts";
import { parseCallback } from "../ui-bridge.ts";
import { parseVoiceCallback } from "../pending-voice.ts";
import { dispatchVoiceText } from "./voice.ts";

const log = scoped("callback");

export function installCallbackHandler(deps: Deps): void {
	deps.bot.on("callback_query:data", async ctx => {
		const data = ctx.callbackQuery.data;
		const parsed = parseCallback(data);
		log.info("recv", {
			raw: data,
			parsed,
			ctx_chat_id: ctx.chat?.id,
			ctx_chat_id_alias: ctx.chatId,
			msg_chat_id: ctx.callbackQuery.message?.chat.id,
		});

		// Voice approval — own prefix, independent of TelegramUI state.
		const voice = parseVoiceCallback(data);
		if (voice) {
			const chatId = ctx.chatId ?? ctx.callbackQuery.message?.chat.id;
			if (chatId === undefined) {
				await ctx.answerCallbackQuery("no chat context");
				return;
			}
			const entry = deps.pendingVoice.take(voice.id);
			if (!entry) {
				await ctx.answerCallbackQuery("expired");
			} else {
				await ctx.answerCallbackQuery(voice.action === "send" ? "sent" : "discarded");
			}
			if (ctx.callbackQuery.message) {
				try {
					await ctx.api.editMessageReplyMarkup(
						ctx.callbackQuery.message.chat.id,
						ctx.callbackQuery.message.message_id,
						{ reply_markup: { inline_keyboard: [] } },
					);
				} catch (err) {
					log.warn("voice.strip_keyboard_failed", { err: String(err) });
				}
			}
			if (entry && voice.action === "send") {
				void dispatchVoiceText(deps, entry.chatId, entry.threadId, entry.text, entry.replyTo);
			}
			return;
		}

		if (!parsed) {
			await ctx.answerCallbackQuery();
			return;
		}
		const chatId = ctx.chatId ?? ctx.callbackQuery.message?.chat.id;
		if (chatId === undefined) {
			log.warn("no_chat_id", { raw: data });
			await ctx.answerCallbackQuery("no chat context");
			return;
		}
		const threadId = extractThreadId(ctx.callbackQuery.message);
		const chat = deps.registry.get(chatId, threadId);
		const pending = chat.pendingUi();
		log.info("resolve_attempt", {
			chat_id: chatId,
			req_id: parsed.requestId,
			value: parsed.value,
			pending_kind: pending?.kind,
			pending_req_id: pending?.requestId,
			pending_awaits_text: pending?.awaitsText,
		});
		const ok = chat.resolvePending({
			kind: "callback",
			requestId: parsed.requestId,
			value: parsed.value,
		});
		log.info("resolved", { ok, chat_id: chatId, req_id: parsed.requestId });
		await ctx.answerCallbackQuery(ok ? undefined : "expired");
		if (ok && ctx.callbackQuery.message) {
			try {
				await ctx.api.editMessageReplyMarkup(
					ctx.callbackQuery.message.chat.id,
					ctx.callbackQuery.message.message_id,
					{ reply_markup: { inline_keyboard: [] } },
				);
			} catch (err) {
				log.warn("strip_keyboard_failed", { err: String(err) });
			}
		}
	});
}
