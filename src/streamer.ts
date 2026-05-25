/**
 * Render an agent turn into telegram messages.
 *
 * Design choices (kept here so future-you doesn't have to spelunk git):
 * - Assistant text is committed once at `message_end` (chat.ts) and posted
 *   as one or more sendMessage calls. We don't stream token-by-token —
 *   the resulting mid-turn reasoning prose was noisy in telegram.
 * - All "muted" status (tool start/end, mid-turn preambles, retry
 *   notices) is coalesced into a single rolling **activity message**:
 *   the first event sends one telegram message, subsequent events append
 *   a line and `editMessageText` the same message id. `tool_execution_end`
 *   rewrites the original `📖 …` line in place to `✅ …` / `❌ … : <detail>`
 *   via a saved `{host, lineIndex}` reference. Concurrent tools are
 *   matched by `toolCallId`.
 * - When an activity message hits either cap (ACTIVITY_CHAR_CAP /
 *   ACTIVITY_LINE_CAP), it is sealed (we drop our `this.activity`
 *   reference) and the next event opens a fresh send. Already-recorded
 *   `toolMsgs` entries keep editing the OLD sealed message — telegram
 *   allows edits for ~48h, so cross-seal `toolEnd` rewrites still work.
 * - finalize() never deletes messages and never posts a placeholder. If a
 *   turn produced no assistant text, the activity message(s) alone tell
 *   the story; a bare "(no response)" line was just noise in chat.
 *
 * Telegram caps a single message at 4096 chars; long assistant replies
 * are split at the last newline within budget (or a hard split if no
 * newline fits in the second half of the budget). The activity caps sit
 * well below 4096 so a late append never overflows mid-edit.
 */
import type { Bot } from "grammy";
import { splitMarkdownForTelegram } from "./markdown.ts";
import { scoped } from "./logger.ts";

const MAX_MESSAGE_LEN = 4096;
/** Truncation budget for mid-turn assistant preambles (one-line heartbeat). */
const PREAMBLE_LEN = 80;
/**
 * Coalesce muted activity (preambles, tool status, notices) into a single
 * rolling telegram message that we `editMessageText` as new lines arrive.
 * When either cap is hit, the current message is sealed (tool-end edits
 * to lines it already contains still work — telegram allows edits for
 * ~48h) and the next event opens a fresh activity message.
 *
 * Caps chosen well under telegram's 4096-char hard limit so a late tool
 * line never overflows mid-append.
 */
const ACTIVITY_CHAR_CAP = 3500;
const ACTIVITY_LINE_CAP = 25;

/** Replace the leading status emoji (start-of-tool icon) with a result one. */
function withResultIcon(startLine: string, icon: "✅" | "❌"): string {
	// renderToolStart always emits "<emoji> <rest>". Swap the first cluster.
	const sp = startLine.indexOf(" ");
	if (sp < 0) return `${icon} ${startLine}`;
	return `${icon}${startLine.slice(sp)}`;
}

/**
 * Tracking state for a single rolling activity message. `lines` is the
 * authoritative buffer; `renderedText` is what we last sent to telegram
 * so we can skip edits that wouldn't change anything (avoids "message
 * is not modified" 400s and the per-message edit-rate ceiling).
 */
interface ActivityMessage {
	messageId: number;
	lines: string[];
	/** Sum of line lengths + newline joins; cached so cap checks are O(1). */
	charCount: number;
	renderedText: string;
}

export class TelegramStreamer {
	/**
	 * Rolling "activity" message — one telegram message that grows by
	 * `editMessageText` as preamble / tool-status / notice lines arrive.
	 * `null` means we have no open activity message; the next muted event
	 * will send one. When a cap is hit we null this out (sealing the
	 * current message) so the next event opens a fresh one.
	 */
	private activity: ActivityMessage | null = null;
	/**
	 * Map toolCallId → reference to the activity message + line index that
	 * currently holds its `📖 …` start line. `toolEnd` mutates that line
	 * to `✅`/`❌` and edits the host message in place. The reference
	 * survives across seals: editing an already-sealed activity message is
	 * still fine (telegram allows edits for ~48h).
	 */
	private readonly toolMsgs = new Map<string, { host: ActivityMessage; lineIndex: number }>();
	private finalized = false;
	private readonly log = scoped("streamer");
	/**
	 * Serialization chain for fire-and-forget commits dispatched from
	 * `ChatSession.handleEvent` (which is a sync subscriber and can't
	 * await). `agent_end` fires `commitAssistant`, `tool_execution_end`
	 * fires `toolEnd`, `tool_execution_start` fires `commitPreamble +
	 * toolStart` — all enter the chain via `enqueue()`. `finalize()`
	 * awaits the tail so the last assistant chunk and any pending tool
	 * edits land before we set `finalized = true` and clear `toolMsgs`.
	 *
	 * Without this, `finally { await endTurn() }` in runTurn would race
	 * the `void commitAssistant(...)` scheduled by `agent_end`: finalize
	 * could flip the flag before the first chunk was even sent, swallowing
	 * the whole reply.
	 */
	private tail: Promise<void> = Promise.resolve();

	constructor(
		private readonly bot: Bot,
		private readonly chatId: number,
		/** Telegram message_id of the user's prompt for this turn. The first
		 *  assistant chunk replies to this so the user can see what their
		 *  turn produced. undefined for synthetic turns (smokes). */
		private readonly replyTo?: number,
		/** Forum topic id (`message_thread_id`). undefined = DM / non-forum
		 *  group / forum General topic. */
		private readonly threadId?: number,
	) {}

	/** Spread into a grammY `Other` options object to route to the topic
	 *  this streamer was created for. Empty object outside forum topics. */
	private topicOpts(): { message_thread_id?: number } {
		return this.threadId !== undefined ? { message_thread_id: this.threadId } : {};
	}

	/**
	 * Append a fire-and-forget commit to the serialization chain. Returned
	 * Promise rejects only when `task` itself throws — callers (and the
	 * tail) swallow errors so one bad commit doesn't poison the chain.
	 *
	 * Tasks run sequentially in submission order: a `commitAssistant`
	 * enqueued by `agent_end` waits behind any prior `toolStart` /
	 * `toolEnd` already in flight, and `finalize()` won't return until
	 * every queued task has settled.
	 */
	enqueue(task: () => Promise<void>): void {
		this.tail = this.tail.then(task).catch(err => {
			this.log.warn("enqueue.task_failed", { err: errMsg(err) });
		});
	}

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

	/**
	 * New tool started: append a `📖 …` line to the current activity
	 * message (opening one if needed) and remember where the line landed
	 * so `toolEnd` can rewrite it in place.
	 */
	async toolStart(toolCallId: string, line: string): Promise<void> {
		if (this.finalized || !line) return;
		const placement = await this.appendActivityLine(line);
		if (placement) this.toolMsgs.set(toolCallId, placement);
	}

	/**
	 * Tool finished: locate the line we wrote at `toolStart` and rewrite
	 * it in place to `✅` / `❌ <detail>`. The host activity message may
	 * already be sealed (a later tool tipped it over the cap); editing
	 * old lines is still fine since telegram allows edits for ~48h.
	 */
	async toolEnd(
		toolCallId: string,
		isError: boolean,
		errorLine: string | undefined,
	): Promise<void> {
		if (this.finalized) return;
		const entry = this.toolMsgs.get(toolCallId);
		if (!entry) return; // never saw the start — nothing to edit
		this.toolMsgs.delete(toolCallId);
		const current = entry.host.lines[entry.lineIndex];
		if (current === undefined) return;
		const next = isError
			? errorLine || withResultIcon(current, "❌")
			: withResultIcon(current, "✅");
		if (next === current) return;
		entry.host.lines[entry.lineIndex] = next;
		await this.flushActivity(entry.host);
	}

	/** One-shot informational line (retries, notices). Coalesced into the
	 *  rolling activity message just like tool status. */
	async notice(line: string): Promise<void> {
		if (this.finalized || !line) return;
		await this.appendActivityLine(line);
	}

	/**
	 * Mid-turn "preamble" assistant text: the model said something before
	 * calling a tool. Show a short heartbeat (first PREAMBLE_LEN chars +
	 * ellipsis if truncated) so the user feels progress without flooding
	 * the chat with mid-turn reasoning prose. Appended to the rolling
	 * activity message; never chunked.
	 */
	async commitPreamble(text: string): Promise<void> {
		if (this.finalized) return;
		const trimmed = text.trim();
		if (!trimmed) return;
		const line = trimmed.length > PREAMBLE_LEN
			? `💭 ${trimmed.slice(0, PREAMBLE_LEN).trimEnd()}…`
			: `💭 ${trimmed}`;
		await this.appendActivityLine(line);
		// Preambles don't count toward "did we say anything"; the real
		// reply at agent_end is what satisfies the (no response) guard.
	}

	/**
	 * Append `line` to the current rolling activity message, sealing and
	 * opening a fresh one if the addition would breach either cap. Returns
	 * the host + line index so callers (toolStart) can edit the line later.
	 * Returns null only on a send failure for a brand-new activity message.
	 */
	private async appendActivityLine(
		line: string,
	): Promise<{ host: ActivityMessage; lineIndex: number } | null> {
		const cur = this.activity;
		// `+1` covers the newline join. Seal & start fresh when the new
		// line would tip either cap.
		const wouldOverflow = cur !== null && (
			cur.lines.length + 1 > ACTIVITY_LINE_CAP ||
			cur.charCount + 1 + line.length > ACTIVITY_CHAR_CAP
		);
		if (cur && !wouldOverflow) {
			const lineIndex = cur.lines.length;
			cur.lines.push(line);
			cur.charCount += 1 + line.length;
			await this.flushActivity(cur);
			return { host: cur, lineIndex };
		}
		// Open a fresh activity message. Sealing the previous one is just
		// dropping our reference — its toolMsgs entries (if any) still
		// point at it and can be edited.
		try {
			const sent = await this.bot.api.sendMessage(this.chatId, line, {
				disable_notification: true,
				link_preview_options: { is_disabled: true },
				...this.topicOpts(),
			});
			const host: ActivityMessage = {
				messageId: sent.message_id,
				lines: [line],
				charCount: line.length,
				renderedText: line,
			};
			this.activity = host;
			return { host, lineIndex: 0 };
		} catch (err) {
			this.log.warn("activity.send_failed", { err: errMsg(err) });
			return null;
		}
	}

	/**
	 * Re-render `host.lines` and `editMessageText` if the result differs
	 * from what we last sent for that message. No-op when nothing changed
	 * (avoids telegram's "message is not modified" 400s).
	 */
	private async flushActivity(host: ActivityMessage): Promise<void> {
		const text = host.lines.join("\n");
		if (text === host.renderedText) return;
		try {
			await this.bot.api.editMessageText(this.chatId, host.messageId, text, {
				// URL-containing lines (bash: curl …, read https://…) would
				// otherwise pop a link-preview card on every edit, flickering
				// the rolling message. Suppress.
				link_preview_options: { is_disabled: true },
			});
			// Only update the cache on success. Updating it BEFORE the await
			// would poison the diff on transient edit failures: a later
			// toolEnd rewrite back to the failed text would early-return at
			// the `text === renderedText` check and leave stale chat content.
			host.renderedText = text;
		} catch (err) {
			const msg = errMsg(err);
			if (msg.includes("not modified")) {
				// Telegram confirms it already has this exact text — cache
				// is in sync regardless of what we thought it held.
				host.renderedText = text;
				return;
			}
			this.log.warn("activity.edit_failed", { err: msg });
		}
	}

	async finalize(): Promise<void> {
		if (this.finalized) return;
		// Drain anything still queued (e.g. the assistant reply scheduled
		// by agent_end) BEFORE we flip `finalized` and clear `toolMsgs`.
		// Otherwise the void task started by handleEvent would no-op or
		// fail to find its tool entry.
		try {
			await this.tail;
		} catch {
			// Tail's own catch already logged; swallow here so finalize is
			// truly idempotent and safe in a shutdown path.
		}
		this.finalized = true;
		// Anything still "in-flight" at finalize had no end event — leave the
		// start message as-is rather than guessing a result icon. We also do
		// NOT post a placeholder when the turn produced no assistant text:
		// the tool messages already show what happened, and a bare
		// "(no response)" line was just noise.
		this.toolMsgs.clear();
		this.activity = null;
	}

	/** Surface an error after a turn fails: send verbatim text. */
	async replaceWith(text: string): Promise<void> {
		this.finalized = true;
		this.toolMsgs.clear();
		this.activity = null;
		await this.send(text);
	}

	private async send(text: string, opts?: { silent?: boolean; replyTo?: number }): Promise<void> {
		try {
			await this.bot.api.sendMessage(this.chatId, text, {
				disable_notification: opts?.silent ?? false,
				...(opts?.replyTo !== undefined && {
					reply_parameters: { message_id: opts.replyTo },
				}),
				...this.topicOpts(),
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
				...this.topicOpts(),
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
			// `chunk.md` fit the 4096-char budget, but `chunk.src` (raw
			// markdown) can be longer than its MarkdownV2 conversion —
			// telegramify shortens some sequences (e.g. `**x**` → `*x*`).
			// Re-chunk the plain-text fallback so a single send doesn't
			// silently exceed the cap and lose the message.
			const parts = splitForTelegram(chunk.src);
			for (let i = 0; i < parts.length; i++) {
				await this.send(parts[i]!, i === 0 ? { replyTo } : undefined);
			}
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
