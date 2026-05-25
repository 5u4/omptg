/**
 * Text message handler. Three paths in priority order:
 *
 *   1. Reply to a pending voice transcription      → edit-then-dispatch
 *   2. Slash command not handled by bot.command()  → "unknown command"
 *   3. Reply to a pending UI request that awaits text → ui.resolve()
 *   4. Otherwise → normal agent turn, with reply/forward framing
 *
 * The slash-command branch exists because grammY only routes registered
 * /commands; anything starting with `/` that we don't know would otherwise
 * fall into the agent turn, which is rarely what the user meant.
 */
import type { Deps } from "../deps.ts";
import { extractThreadId } from "../topic.ts";
import { knownCommands } from "../commands.ts";
import {
	formatForwardPrompt,
	formatReplyPrompt,
	type ForwardContext,
	type ReplyContext,
} from "../quote.ts";
import { dispatchVoiceText } from "./voice.ts";
import { runTurn } from "./turn.ts";

export function installTextHandler(deps: Deps): void {
	deps.bot.on("message:text", async ctx => {
		// 1. Voice transcription override: if the user replied to one of
		//    our "🎤 transcription:" messages with a corrected version,
		//    swap it in and dispatch as if they tapped ✅. The original
		//    keyboard is stripped so the buttons can't be re-used.
		const replyToId = ctx.message.reply_to_message?.message_id;
		if (replyToId !== undefined) {
			const edited = deps.pendingVoice.takeByTranscriptMessage(ctx.chat.id, replyToId);
			if (edited) {
				try {
					await ctx.api.editMessageReplyMarkup(
						ctx.chat.id,
						edited.transcriptMessageId,
						{ reply_markup: { inline_keyboard: [] } },
					);
				} catch {
					// Stripping the keyboard is cosmetic — proceed even if
					// telegram rejects (message too old, etc.).
				}
				await ctx.reply("↪ using edited transcription");
				void dispatchVoiceText(deps, edited.chatId, edited.threadId, ctx.message.text, edited.replyTo);
				return;
			}
		}

		const rawText = ctx.message.text;

		// 2. Detect telegram's native reply (long-press → reply). The
		//    replied-to message goes through quote.ts as a markdown
		//    blockquote so the agent can read what the user is referring
		//    back to. Done for non-command, non-pendingUi-text replies —
		//    the awaitsText path below handles the "answering my own /ask"
		//    case separately.
		const replyMsg = ctx.message.reply_to_message;
		let reply: ReplyContext | undefined;
		if (replyMsg) {
			const author = replyMsg.from;
			const fromBot = author?.id === ctx.me.id;
			reply = {
				author: fromBot
					? "you"
					: author?.first_name || author?.username || "someone",
				fromBot,
				text: replyMsg.text ?? replyMsg.caption ?? "",
			};
		}

		// 3. Telegram forward (any message with forward_origin). Wrap the
		//    forwarded body the same way as a reply, tagging the original
		//    source kind (user / hidden_user / chat / channel) and name.
		//    For plain text forwards the user can't add inline text in
		//    the same message, so the prompt becomes just the quote block.
		const fwdOrigin = ctx.message.forward_origin;
		let forward: ForwardContext | undefined;
		if (fwdOrigin) {
			let kind: ForwardContext["kind"];
			let name: string;
			switch (fwdOrigin.type) {
				case "user":
					kind = "user";
					name = fwdOrigin.sender_user.first_name
						|| fwdOrigin.sender_user.username
						|| "user";
					break;
				case "hidden_user":
					kind = "hidden_user";
					name = fwdOrigin.sender_user_name || "hidden user";
					break;
				case "chat":
					kind = "chat";
					name = ("title" in fwdOrigin.sender_chat && fwdOrigin.sender_chat.title)
						|| "chat";
					break;
				case "channel":
					kind = "channel";
					name = fwdOrigin.chat.title || fwdOrigin.chat.username || "channel";
					break;
			}
			forward = { kind, name, date: fwdOrigin.date, text: rawText };
		}

		const text = rawText;

		// 4. Forwarded messages: the text might literally start with
		//    "/something" but it's the forwarded body, not a command.
		//    Skip the slash-command branch entirely so the body falls
		//    through to the normal agent turn.
		if (text.startsWith("/") && !forward) {
			const entities = ctx.message.entities ?? [];
			const cmdEntity = entities.find(
				e => e.type === "bot_command" && e.offset === 0,
			);
			if (!cmdEntity) return; // not actually a command, just text starting with /
			const raw = text.slice(1, cmdEntity.length);
			const atIdx = raw.indexOf("@");
			const cmd = atIdx >= 0 ? raw.slice(0, atIdx) : raw;
			// `@bot` suffix targeting another bot: not for us, ignore.
			if (atIdx >= 0) {
				const target = raw.slice(atIdx + 1).toLowerCase();
				const me = ctx.me.username.toLowerCase();
				if (target !== me) return;
			}
			if (knownCommands().has(cmd)) return; // real handler already ran
			await ctx.reply(
				`unknown command: /${cmd}\ntype /start for the list`,
			);
			return;
		}

		const chat = deps.registry.get(ctx.chat.id, extractThreadId(ctx.message));

		// 5. If a UI prompt is awaiting a text reply, route this message there.
		const pending = chat.pendingUi();
		if (pending?.awaitsText) {
			const handled = chat.resolvePending({ kind: "text", text });
			if (handled) {
				await ctx.reply("↪ sent to agent");
				return;
			}
		}

		// 6. Normal agent turn.
		//
		// CRITICAL: grammY processes updates SEQUENTIALLY by default, and
		// only advances after this handler returns. The agent turn can
		// call ui.select / ui.confirm and then block waiting for the
		// user's button tap — but that tap is the very next telegram
		// update, which grammY can't deliver until we return. So we'd
		// deadlock.
		//
		// Fire-and-forget the turn. runTurn captures errors and reports
		// them back into the chat asynchronously so we don't lose them.
		// Wrap order: forward first (the message itself is the quoted
		// thing), then reply (annotates relationship to a prior message).
		// If both are set on the same telegram message the user replied
		// while forwarding, which is rare — handle by stacking.
		let promptText = text;
		if (forward) promptText = formatForwardPrompt(forward, "");
		if (reply) promptText = formatReplyPrompt(reply, promptText);

		void runTurn({
			bot: deps.bot,
			chat,
			prompt: promptText,
			chatId: ctx.chat.id,
			threadId: extractThreadId(ctx.message),
			replyTo: ctx.message.message_id,
			source: "text",
		});
	});
}
