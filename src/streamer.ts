/**
 * Render an agent turn into telegram messages.
 *
 * Design choices (kept here so future-you doesn't have to spelunk git):
 * - Assistant text is committed once at `message_end` (chat.ts) and posted
 *   as one or more sendMessage calls. We don't stream token-by-token —
 *   the resulting mid-turn reasoning prose was noisy in telegram.
 * - Each tool invocation gets its OWN persistent message: send the
 *   `📖 read foo.ts` line at `tool_execution_start`, then edit that same
 *   message id to `✅ read foo.ts` (or `❌ … : <detail>`) on
 *   `tool_execution_end`. Concurrent tools are matched by `toolCallId`.
 * - Transient notices (auto_retry, etc.) are posted as their own
 *   sendMessage so they also live in the history.
 * - finalize() never deletes messages and never posts a placeholder. If a
 *   turn produced no assistant text, the tool messages alone tell the
 *   story; a bare "(no response)" line was just noise in chat.
 *
 * Telegram caps a single message at 4096 chars; long assistant replies
 * are split at the last newline within budget (or a hard split if no
 * newline fits in the second half of the budget).
 */
import type { Bot } from "grammy";
import { splitMarkdownForTelegram } from "./markdown.ts";
import { scoped } from "./logger.ts";

const MAX_MESSAGE_LEN = 4096;
/** Truncation budget for mid-turn assistant preambles (one-line heartbeat). */
const PREAMBLE_LEN = 80;

/** Replace the leading status emoji (start-of-tool icon) with a result one. */
function withResultIcon(startLine: string, icon: "✅" | "❌"): string {
	// renderToolStart always emits "<emoji> <rest>". Swap the first cluster.
	const sp = startLine.indexOf(" ");
	if (sp < 0) return `${icon} ${startLine}`;
	return `${icon}${startLine.slice(sp)}`;
}

export class TelegramStreamer {
	/** message_id of the in-flight tool status, keyed by toolCallId. */
	private readonly toolMsgs = new Map<string, { messageId: number; startLine: string }>();
	private finalized = false;
	private readonly log = scoped("streamer");

	constructor(
		private readonly bot: Bot,
		private readonly chatId: number,
		/** Telegram message_id of the user's prompt for this turn. The first
		 *  assistant chunk replies to this so the user can see what their
		 *  turn produced. undefined for synthetic turns (smokes). */
		private readonly replyTo?: number,
	) {}

	/**
	 * Commit a finalized assistant text block. Converts source markdown to
	 * MarkdownV2 (preserving code fences across chunk boundaries) and sends
	 * with parse_mode so bold/code/links/lists render. Falls back to a
	 * plain-text send if telegram rejects the entities (catastrophic escape
	 * bug, weird code-block content, etc.).
	 */
	async commitAssistant(text: string): Promise<void> {
		if (this.finalized) return;
		const trimmed = text.trim();
		if (!trimmed) return;
		const chunks = splitMarkdownForTelegram(trimmed);
		for (let i = 0; i < chunks.length; i++) {
			// Only the first chunk carries reply_to so the conversation
			// stays anchored to the user's prompt without nesting noise.
			await this.sendMarkdown(chunks[i]!, i === 0 ? this.replyTo : undefined);
		}
	}

	/** New tool started: post a persistent status message for it. */
	async toolStart(toolCallId: string, line: string): Promise<void> {
		if (this.finalized || !line) return;
		// Defensive: if we somehow see the same id twice, replace the old entry
		// (the prior message stays in chat but is no longer tracked).
		try {
			const sent = await this.bot.api.sendMessage(this.chatId, line, {
				disable_notification: true,
			});
			this.toolMsgs.set(toolCallId, {
				messageId: sent.message_id,
				startLine: line,
			});
		} catch (err) {
			console.warn("[tool-start] send failed:", errMsg(err));
		}
	}

	/** Tool finished: rewrite its message in place with ✅ or ❌ <detail>. */
	async toolEnd(
		toolCallId: string,
		isError: boolean,
		errorLine: string | undefined,
	): Promise<void> {
		if (this.finalized) return;
		const entry = this.toolMsgs.get(toolCallId);
		if (!entry) return; // never saw the start — nothing to edit
		this.toolMsgs.delete(toolCallId);
		const next = isError
			? errorLine || withResultIcon(entry.startLine, "❌")
			: withResultIcon(entry.startLine, "✅");
		if (next === entry.startLine) return;
		try {
			await this.bot.api.editMessageText(this.chatId, entry.messageId, next);
		} catch (err) {
			const msg = errMsg(err);
			if (!msg.includes("not modified")) {
				console.warn("[tool-end] edit failed:", msg);
			}
		}
		// Note: editMessageText doesn't carry disable_notification; the
		// original send was silent and editing it doesn't re-notify.
	}

	/** One-shot informational line (retries, notices). Posted as its own msg. */
	async notice(line: string): Promise<void> {
		if (this.finalized || !line) return;
		await this.send(line, { silent: true });
	}

	/**
	 * Mid-turn "preamble" assistant text: the model said something before
	 * calling a tool. Show a short heartbeat (first PREAMBLE_LEN chars +
	 * ellipsis if truncated) so the user feels progress without flooding
	 * the chat with mid-turn reasoning prose. Never chunked.
	 */
	async commitPreamble(text: string): Promise<void> {
		if (this.finalized) return;
		const trimmed = text.trim();
		if (!trimmed) return;
		const line = trimmed.length > PREAMBLE_LEN
			? `💭 ${trimmed.slice(0, PREAMBLE_LEN).trimEnd()}…`
			: `💭 ${trimmed}`;
		await this.send(line, { silent: true });
		// Preambles don't count toward "did we say anything"; the real
		// reply at agent_end is what satisfies the (no response) guard.
	}

	async finalize(): Promise<void> {
		if (this.finalized) return;
		this.finalized = true;
		// Anything still "in-flight" at finalize had no end event — leave the
		// start message as-is rather than guessing a result icon. We also do
		// NOT post a placeholder when the turn produced no assistant text:
		// the tool messages already show what happened, and a bare
		// "(no response)" line was just noise.
		this.toolMsgs.clear();
	}

	/** Surface an error after a turn fails: send verbatim text. */
	async replaceWith(text: string): Promise<void> {
		this.finalized = true;
		this.toolMsgs.clear();
		await this.send(text);
	}

	private async send(text: string, opts?: { silent?: boolean; replyTo?: number }): Promise<void> {
		try {
			await this.bot.api.sendMessage(this.chatId, text, {
				disable_notification: opts?.silent ?? false,
				...(opts?.replyTo !== undefined && {
					reply_parameters: { message_id: opts.replyTo },
				}),
			});
		} catch (err) {
			console.warn("[send] failed:", errMsg(err));
		}
	}

	/**
	 * Send a pre-converted MarkdownV2 chunk. If telegram rejects the entity
	 * parsing (any 400 BAD REQUEST or "can't parse entities"), we fall back
	 * to sending the ORIGINAL markdown source as plain text — that's much
	 * more readable than the MarkdownV2-escaped form (no `\.` `\(` `\!`
	 * noise) and tells the user we hit a converter edge case rather than
	 * dropping the message.
	 */
	private async sendMarkdown(chunk: { src: string; md: string }, replyTo?: number): Promise<void> {
		try {
			await this.bot.api.sendMessage(this.chatId, chunk.md, {
				parse_mode: "MarkdownV2",
				...(replyTo !== undefined && {
					reply_parameters: { message_id: replyTo },
				}),
			});
		} catch (err) {
			const m = errMsg(err);
			this.log.warn("md.fallback_plain", {
				chat_id: this.chatId,
				err: m,
				src_len: chunk.src.length,
				md_len: chunk.md.length,
				md_head: chunk.md.slice(0, 200),
			});
			await this.send(chunk.src, { replyTo });
		}
	}
}

/**
 * Split text into telegram-sized chunks, preferring the last newline
 * within budget. Falls back to a hard split if no newline fits in at
 * least the second half (avoids one early newline pinning us to a tiny
 * first chunk followed by a giant second one).
 */
export function splitForTelegram(text: string, budget = MAX_MESSAGE_LEN): string[] {
	if (text.length <= budget) return [text];
	const out: string[] = [];
	let rest = text;
	while (rest.length > budget) {
		const slice = rest.slice(0, budget);
		const nl = slice.lastIndexOf("\n");
		const cut = nl >= budget / 2 ? nl + 1 : budget;
		out.push(rest.slice(0, cut).trimEnd());
		rest = rest.slice(cut);
	}
	if (rest.length) out.push(rest);
	return out;
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
