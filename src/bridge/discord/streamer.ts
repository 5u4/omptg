/**
 * Render an agent turn into Discord messages.
 *
 * Mirrors `TelegramStreamer`'s activity-message model but adapted to
 * Discord's transport:
 *   - per-message cap is 2000 chars (vs telegram's 4096) — activity
 *     caps tightened to 1800 chars / 20 lines so the headroom for a
 *     last-appended status line is preserved.
 *   - assistant text uses GFM markdown verbatim (no MarkdownV2 escape).
 *   - editing an old message: discord.js `Message.edit({content})`,
 *     valid for the channel's lifetime (no telegram 48h window).
 *
 * One streamer per `ChatSession.prompt()` call. `finalize()` drains the
 * tail and any pending debounced edits before sealing.
 */
import { type Client, type Message, type TextChannel, type ThreadChannel, MessageFlags } from "discord.js";
import type { Streamer } from "../types.ts";
import { resolveSendTarget } from "./index.ts";
import { splitMarkdownForDiscord } from "./markdown.ts";
import { scoped } from "../../logger.ts";

/** Coalesce muted activity (preambles, tool status, notices) into a
 *  single Discord message. Caps tightened relative to the 2000-char
 *  hard send cap so a last appended status line has headroom. */
const ACTIVITY_CHAR_CAP = 1800;
const ACTIVITY_LINE_CAP = 20;
/** Default `allowedMentions` applied to every send: don't parse any
 *  mention type, and don't ping the user we're replying to. Tool args,
 *  filenames, and assistant output can contain `@everyone`, `@here`,
 *  `<@123>`, etc.; without this, those would notify real users. */
const NO_MENTIONS = {
	parse: [] as never[],
	repliedUser: false,
};
/** Debounce window for activity-message edits. Coalesces tool start /
 *  end / preamble bursts into one `Message.edit` round-trip. Discord
 *  rate-limits message edits per channel; bursts at ≤250ms would
 *  otherwise eat the bucket. */
const FLUSH_DEBOUNCE_MS = 250;
/** Truncation budget for mid-turn assistant preambles (one-line heartbeat). */
const PREAMBLE_LEN = 80;

interface ActivityMessage {
	/** discord.js Message handle used for `edit({content})`. */
	msg: Message;
	/** Logical lines; `""` slots are tombstones (kept so toolMsgs /
	 *  subagentSlots line-index references stay stable). Filtered at
	 *  render time. */
	lines: string[];
	/** Maintained invariant: sum of non-empty line lengths +
	 *  max(0, count(non-empty)-1) for newline joins. */
	charCount: number;
	/** Last text we successfully sent for this host. Used to short-
	 *  circuit no-op edits. */
	renderedText: string;
	pendingFlush: Promise<void> | null;
	pendingFlushRun: (() => Promise<void>) | null;
	/** Tail of the per-host serialization chain. New flushes await this
	 *  before issuing their own edit so a slow first edit can't be
	 *  overwritten by a faster second one carrying a stale snapshot. */
	lastFlush: Promise<void> | null;
}

interface ToolPlacement {
	host: ActivityMessage;
	lineIndex: number;
}

interface SubagentSlot {
	host: ActivityMessage;
	lineIndex: number;
	tombstoned: boolean;
}

function withErrorIcon(startLine: string): string {
	// Replace the leading status emoji with ❌, preserving the rest of
	// the line verbatim. Mirrors `TelegramStreamer.withErrorIcon` 1:1
	// (indexOf avoids regex codepoint surprises with multi-unit emoji).
	const sp = startLine.indexOf(" ");
	if (sp < 0) return `❌ ${startLine}`;
	return `❌${startLine.slice(sp)}`;
}

function recomputeCharCount(lines: readonly string[]): number {
	let sum = 0;
	let n = 0;
	for (const l of lines) {
		if (l === "") continue;
		sum += l.length;
		n += 1;
	}
	return sum + Math.max(0, n - 1);
}

function countNonEmptyLines(lines: readonly string[]): number {
	let n = 0;
	for (const l of lines) if (l !== "") n += 1;
	return n;
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export class DiscordStreamer implements Streamer {
	private activity: ActivityMessage | null = null;
	private readonly toolMsgs = new Map<string, ToolPlacement>();
	private readonly subagentSlots = new Map<string, SubagentSlot>();
	private finalized = false;
	private readonly log;
	private tail: Promise<void> = Promise.resolve();
	private readonly flushHostTimers = new Map<ActivityMessage, ReturnType<typeof setTimeout>>();
	private readonly inflightFlushes = new Set<Promise<void>>();
	/** Cached resolved channel/thread. `resolveSendTarget` does a
	 *  `client.channels.fetch` round-trip; cache the result for the
	 *  streamer's lifetime so per-edit bursts stay in-process. */
	private targetPromise: Promise<TextChannel | ThreadChannel> | null = null;
	/** Anchor message id (the user's prompt) for the first assistant
	 *  chunk's reply. Undefined for synthetic turns. */
	private readonly replyTo: string | undefined;

	constructor(
		private readonly client: Client,
		private readonly channelId: string,
		private readonly threadId: string | undefined,
		replyTo?: string,
	) {
		this.log = scoped(`dc-streamer:${channelId}${threadId ? `:${threadId}` : ""}`);
		this.replyTo = replyTo;
	}

	enqueue(task: () => Promise<void>): void {
		this.tail = this.tail.then(task).catch(err => {
			this.log.warn("enqueue.task_failed", { err: errMsg(err) });
		});
	}

	textDelta(_text: string): void {
		// Discord has no streaming surface; tokens render at agent_end.
	}

	async commitAssistant(text: string): Promise<void> {
		if (this.finalized) return;
		const trimmed = text.trim();
		if (!trimmed) return;
		const chunks = splitMarkdownForDiscord(trimmed);
		let target: TextChannel | ThreadChannel;
		try {
			target = await this.target();
		} catch (err) {
			this.log.warn("commitAssistant.resolve_failed", { err: errMsg(err) });
			return;
		}
		for (let i = 0; i < chunks.length; i++) {
			const content = chunks[i]!;
			const isFirst = i === 0;
			try {
				await target.send({
					content,
					allowedMentions: NO_MENTIONS,
					...(isFirst && this.replyTo !== undefined
						? { reply: { messageReference: this.replyTo, failIfNotExists: false } }
						: {}),
				});
			} catch (err) {
				this.log.warn("commitAssistant.send_failed", {
					err: errMsg(err),
					len: content.length,
				});
			}
		}
	}

	async commitPreamble(text: string): Promise<void> {
		if (this.finalized) return;
		const trimmed = text.trim();
		if (!trimmed) return;
		const line = trimmed.length > PREAMBLE_LEN
			? `💭 ${trimmed.slice(0, PREAMBLE_LEN).trimEnd()}…`
			: `💭 ${trimmed}`;
		await this.appendActivityLine(line);
	}

	async toolStart(toolCallId: string, line: string, _toolName: string, _args: unknown): Promise<void> {
		if (this.finalized || !line) return;
		const placement = await this.appendActivityLine(line);
		if (placement) this.toolMsgs.set(toolCallId, placement);
	}

	async toolEnd(
		toolCallId: string,
		isError: boolean,
		errorLine: string | undefined,
		_toolName: string,
		_result: unknown,
	): Promise<void> {
		if (this.finalized) return;
		const entry = this.toolMsgs.get(toolCallId);
		if (!entry) return;
		this.toolMsgs.delete(toolCallId);
		const current = entry.host.lines[entry.lineIndex];
		if (current === undefined) return;
		if (!isError) return; // success: keep the original tool-start line
		const next = errorLine || withErrorIcon(current);
		if (next === current) return;
		entry.host.charCount += next.length - current.length;
		entry.host.lines[entry.lineIndex] = next;
		this.scheduleFlush(entry.host);
	}

	async notice(line: string): Promise<void> {
		if (this.finalized || !line) return;
		await this.appendActivityLine(line);
	}

	async subagentLine(key: string, line: string): Promise<void> {
		if (this.finalized || !line) return;
		const slot = this.subagentSlots.get(key);
		if (slot) {
			if (slot.tombstoned) return;
			const host = slot.host;
			const current = host.lines[slot.lineIndex];
			if (current === undefined || current === line) return;
			host.charCount += line.length - current.length;
			host.lines[slot.lineIndex] = line;
			this.scheduleFlush(host);
			return;
		}
		const placement = await this.appendActivityLine(line);
		if (placement) {
			this.subagentSlots.set(key, {
				host: placement.host,
				lineIndex: placement.lineIndex,
				tombstoned: false,
			});
		}
	}

	subagentCollapse(keys: readonly string[]): void {
		if (this.finalized || keys.length === 0) return;
		const dirtyHosts = new Set<ActivityMessage>();
		for (const key of keys) {
			const slot = this.subagentSlots.get(key);
			if (!slot || slot.tombstoned) continue;
			const host = slot.host;
			const text = host.lines[slot.lineIndex];
			if (text === undefined || text === "") {
				slot.tombstoned = true;
				continue;
			}
			host.lines[slot.lineIndex] = "";
			slot.tombstoned = true;
			dirtyHosts.add(host);
		}
		for (const host of dirtyHosts) {
			host.charCount = recomputeCharCount(host.lines);
			this.scheduleFlush(host);
		}
	}

	private async appendActivityLine(line: string): Promise<ToolPlacement | null> {
		const cur = this.activity;
		const curNonEmpty = cur ? countNonEmptyLines(cur.lines) : 0;
		const wouldOverflow = cur !== null && (
			curNonEmpty + 1 > ACTIVITY_LINE_CAP ||
			cur.charCount + line.length + (curNonEmpty > 0 ? 1 : 0) > ACTIVITY_CHAR_CAP
		);
		if (cur && !wouldOverflow) {
			const lineIndex = cur.lines.length;
			cur.lines.push(line);
			cur.charCount += line.length + (curNonEmpty > 0 ? 1 : 0);
			this.scheduleFlush(cur);
			return { host: cur, lineIndex };
		}
		try {
			const target = await this.target();
			// Suppress push notification on the rolling activity message:
			// it's muted progress, not an announcement. Telegram does the
			// same with `disable_notification: true`.
			const sent = await target.send({
				content: line,
				flags: MessageFlags.SuppressNotifications,
				allowedMentions: NO_MENTIONS,
			});
			const host: ActivityMessage = {
				msg: sent,
				lines: [line],
				charCount: line.length,
				renderedText: line,
				pendingFlush: null,
				pendingFlushRun: null,
				lastFlush: null,
			};
			this.activity = host;
			return { host, lineIndex: 0 };
		} catch (err) {
			this.log.warn("activity.send_failed", { err: errMsg(err) });
			return null;
		}
	}

	private scheduleFlush(host: ActivityMessage): Promise<void> {
		if (host.pendingFlushRun) return host.pendingFlush!;
		const predecessor = host.lastFlush;
		let runOnce: () => Promise<void>;
		const p = new Promise<void>(resolve => {
			let done = false;
			runOnce = async () => {
				if (done) return;
				done = true;
				const t = this.flushHostTimers.get(host);
				if (t !== undefined) {
					clearTimeout(t);
					this.flushHostTimers.delete(host);
				}
				host.pendingFlushRun = null;
				this.inflightFlushes.add(p);
				try {
					if (predecessor) await predecessor.catch(() => {});
					await this.flushActivityNow(host);
				} finally {
					if (host.pendingFlush === p) host.pendingFlush = null;
					if (host.lastFlush === p) host.lastFlush = null;
					this.inflightFlushes.delete(p);
					resolve();
				}
			};
			const timer = setTimeout(() => { void runOnce(); }, FLUSH_DEBOUNCE_MS);
			this.flushHostTimers.set(host, timer);
		});
		host.pendingFlush = p;
		host.pendingFlushRun = runOnce!;
		host.lastFlush = p;
		return p;
	}

	private async drainHost(host: ActivityMessage): Promise<void> {
		const run = host.pendingFlushRun;
		if (run) await run();
		if (host.lastFlush) await host.lastFlush;
	}

	async flushPending(): Promise<void> {
		while (this.flushHostTimers.size > 0 || this.inflightFlushes.size > 0) {
			for (const host of [...this.flushHostTimers.keys()]) await this.drainHost(host);
			if (this.inflightFlushes.size > 0) {
				await Promise.allSettled([...this.inflightFlushes]);
			}
		}
	}

	private async flushActivityNow(host: ActivityMessage): Promise<void> {
		const text = host.lines.filter(l => l !== "").join("\n");
		if (text === host.renderedText || text === "") return;
		try {
			await host.msg.edit({ content: text });
			host.renderedText = text;
		} catch (err) {
			this.log.warn("activity.edit_failed", { err: errMsg(err) });
		}
	}

	async finalize(): Promise<void> {
		if (this.finalized) return;
		try {
			await this.tail;
		} catch {
			// tail.catch already logged
		}
		await this.flushPending();
		this.finalized = true;
		this.toolMsgs.clear();
		this.subagentSlots.clear();
		this.activity = null;
	}

	async replaceWith(text: string): Promise<void> {
		this.finalized = true;
		for (const timer of this.flushHostTimers.values()) clearTimeout(timer);
		this.flushHostTimers.clear();
		if (this.inflightFlushes.size > 0) {
			await Promise.allSettled([...this.inflightFlushes]);
		}
		this.toolMsgs.clear();
		this.subagentSlots.clear();
		this.activity = null;
		const body = text.trim();
		if (!body) return;
		try {
			const target = await this.target();
			const chunks = splitMarkdownForDiscord(body);
			for (const content of chunks) {
				await target.send({ content, allowedMentions: NO_MENTIONS });
			}
		} catch (err) {
			this.log.warn("replaceWith.send_failed", { err: errMsg(err) });
		}
	}

	private target(): Promise<TextChannel | ThreadChannel> {
		if (!this.targetPromise) {
			// Cache the in-flight promise so concurrent callers share one
			// `channels.fetch`. On failure, evict so subsequent sends can
			// retry — a transient gateway error otherwise poisons the
			// streamer for the rest of the turn.
			const p = resolveSendTarget(this.client, this.channelId, this.threadId);
			p.catch(() => {
				if (this.targetPromise === p) this.targetPromise = null;
			});
			this.targetPromise = p;
		}
		return this.targetPromise;
	}
}
