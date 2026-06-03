/**
 * TelegramBridge — wraps the existing TelegramUI / TelegramStreamer /
 * TypingIndicator trio as a Bridge implementation. No behavior change
 * vs. pre-bridge code; this is purely the seam that lets ChatSession
 * stay grammy-agnostic.
 *
 * Transports are cached per route key so a chat keeps a single UI
 * instance across turns (its pending-request slot survives between
 * messages, which is what callback / text-reply resolution depends on).
 */
import type { Bot } from "grammy";
import type {
	Bridge,
	ChatId,
	SessionRoute,
	SessionTransport,
	Streamer,
} from "../types.ts";
import { TelegramStreamer } from "../../streamer.ts";
import { TelegramUI } from "../../ui-bridge.ts";
import { TypingIndicator } from "../../typing.ts";

/**
 * Same content as the prior in-chat TELEGRAM_SYSTEM_BLOCK, moved here so
 * `withBridgePrompt` in chat.ts is bridge-agnostic. The web bridge will
 * provide its own addendum describing full-markdown rendering rules.
 */
const TELEGRAM_SYSTEM_BLOCK = [
	"# Telegram output guidance",
	"",
	"You are talking to the user through a Telegram bot, not a terminal or IDE.",
	"Telegram MarkdownV2 supports bold/italic, inline code, fenced code",
	"blocks, links, and lists — but NOT real headings, NOT tables, and NOT",
	"wide ASCII diagrams. All of these wrap poorly or render flat on phone",
	"screens.",
	"",
	"For comparisons / option matrices / small data sets, prefer:",
	"  - a markdown list with a one-line summary per item, OR",
	"  - `key: value` lines under a short heading, OR",
	"  - a compact paragraph that names the trade-offs inline.",
	"",
	"Only use a GFM table when the data genuinely has 3+ columns AND",
	"the user explicitly asked for a table. Otherwise the bot wraps the",
	"table in a code fence as a fallback, which is ugly on mobile.",
	"AVOID markdown headings (`#`, `##`, `###`). Telegram has no heading",
	"syntax — every level collapses to a single bold line, so a `#` title",
	"and a `###` subsection look identical and the document hierarchy is",
	"lost. The bridge rewrites headings to distinct visual markers as a",
	"fallback, but the result is still less readable than prose. Prefer:",
	"  - a short bold lead-in line (`**Topic.**`) followed by content, OR",
	"  - a numbered/bulleted list when you'd reach for `###` per item.",
].join("\n");

interface RouteIds {
	chatId: number;
	threadId: number | undefined;
}

/** Telegram route keys are `${chatId}:${threadId ?? ""}` — same scheme
 *  ChatRegistry used pre-bridge, kept verbatim so ChatStore bindings
 *  carry over without migration. */
export function telegramRouteKey(chatId: number, threadId?: number): string {
	return `${chatId}:${threadId ?? ""}`;
}

export function telegramRoute(chatId: number, threadId?: number): SessionRoute {
	const suffix = threadId !== undefined ? `:${threadId}` : "";
	return {
		key: telegramRouteKey(chatId, threadId),
		label: `tg:${chatId}${suffix}`,
	};
}

/** Parse a route key back into chat/thread ids. Used by handlers that
 *  hand the bridge a key and need to call grammy with the underlying
 *  numbers. */
export function parseTelegramRoute(key: string): RouteIds | undefined {
	const idx = key.indexOf(":");
	if (idx < 0) return undefined;
	const chatId = Number(key.slice(0, idx));
	if (!Number.isFinite(chatId)) return undefined;
	const tail = key.slice(idx + 1);
	const threadId = tail === "" ? undefined : Number(tail);
	if (threadId !== undefined && !Number.isFinite(threadId)) return undefined;
	return { chatId, threadId };
}

/**
 * Adapt the existing TelegramStreamer (kept verbatim — no changes to
 * streamer.ts in phase 1/2) to the widened `Streamer` interface that
 * phase 2 introduced (textDelta, structured toolName/args on
 * tool start/end). Telegram drops everything web-only; the extra
 * args are intentionally ignored.
 */
class TelegramStreamerAdapter implements Streamer {
	constructor(private readonly inner: TelegramStreamer) {}

	enqueue(task: () => Promise<void>): void {
		this.inner.enqueue(task);
	}

	textDelta(_text: string): void {
		// no-op: telegram's rolling editMessageText cannot keep up with
		// token-by-token output, so deltas are intentionally dropped.
	}

	commitAssistant(text: string): Promise<void> {
		return this.inner.commitAssistant(text);
	}

	commitPreamble(text: string): Promise<void> {
		return this.inner.commitPreamble(text);
	}

	toolStart(toolCallId: string, line: string, _toolName: string, _args: unknown): Promise<void> {
		return this.inner.toolStart(toolCallId, line);
	}

	toolEnd(toolCallId: string, isError: boolean, errorLine: string | undefined, _toolName: string, _result: unknown): Promise<void> {
		return this.inner.toolEnd(toolCallId, isError, errorLine);
	}

	notice(line: string): Promise<void> {
		return this.inner.notice(line);
	}

	subagentLine(key: string, line: string): Promise<void> {
		return this.inner.subagentLine(key, line);
	}

	subagentCollapse(keys: readonly string[]): void {
		this.inner.subagentCollapse(keys);
	}

	finalize(): Promise<void> {
		return this.inner.finalize();
	}

	replaceWith(text: string): Promise<void> {
		return this.inner.replaceWith(text);
	}
}

class TelegramTransport implements SessionTransport {
	readonly ui: TelegramUI;
	readonly typing: TypingIndicator;

	constructor(
		private readonly bot: Bot,
		private readonly chatId: number,
		private readonly threadId: number | undefined,
	) {
		this.ui = new TelegramUI(bot, chatId, threadId);
		this.typing = new TypingIndicator(bot, chatId, threadId);
	}

	newStreamer(opts: { replyTo?: number | string }): Streamer {
		const inner = new TelegramStreamer(
			this.bot,
			this.chatId,
			this.narrowReplyTo(opts.replyTo),
			this.threadId,
		);
		return new TelegramStreamerAdapter(inner);
	}

	async postSystemMessage(text: string, opts?: { replyTo?: number | string; silent?: boolean }): Promise<void> {
		// Telegram parity with the pre-bridge handler/turn.ts behavior:
		// reply-anchored to the user's triggering message, posted into
		// the forum topic when this transport is forum-scoped, and
		// silenced for the steered-mid-turn ack (the user already heard
		// the original send ping).
		const reply = this.narrowReplyTo(opts?.replyTo);
		const topicOpts = this.threadId !== undefined ? { message_thread_id: this.threadId } : {};
		const replyOpts = reply !== undefined ? { reply_parameters: { message_id: reply } } : {};
		const silentOpts = opts?.silent ? { disable_notification: true } : {};
		await this.bot.api.sendMessage(this.chatId, text, { ...topicOpts, ...replyOpts, ...silentOpts });
	}

	/** Same precision-loss guard as `TelegramBridge.route`'s chatId
	 *  narrowing: a string `replyTo` is only legal if it round-trips
	 *  through `Number` AND stays within the safe-integer range.
	 *  `Number.isFinite` is not enough — snowflakes like
	 *  `"1099511627776000000"` look like clean round-trips but are
	 *  not safe integers. Anything else is a misroute (most likely a
	 *  discord snowflake message id) and we throw rather than silently
	 *  anchor a reply to a rounded message_id. */
	private narrowReplyTo(replyTo: number | string | undefined): number | undefined {
		if (replyTo === undefined) return undefined;
		const n = typeof replyTo === "number" ? replyTo : Number(replyTo);
		if (!Number.isSafeInteger(n) || (typeof replyTo === "string" && String(n) !== replyTo)) {
			throw new Error(`TelegramTransport: non-numeric or out-of-range replyTo "${replyTo}"`);
		}
		return n;
	}

	async dispose(): Promise<void> {
		this.typing.stop();
	}
}

export class TelegramBridge implements Bridge {
	readonly kind = "telegram" as const;
	private readonly transports = new Map<string, TelegramTransport>();

	constructor(private readonly bot: Bot) {}

	systemPromptAddendum(): string {
		return TELEGRAM_SYSTEM_BLOCK;
	}

	route(chatId: ChatId, threadId?: number | string): SessionRoute {
		// Telegram chat ids are numeric and well within JS safe-integer
		// range. A string here means a caller (most likely a future
		// discord-bridge route mistakenly hitting the telegram bridge)
		// is misrouted. Coerce, but reject any value that loses
		// precision under `Number(...)`: snowflakes like
		// `"1099511627776000000"` round-trip through `String(n)`
		// identically yet are NOT safe integers — the only reliable
		// guard is `Number.isSafeInteger`. The loud throw is the
		// contract phase 2 depends on for misroute detection.
		let n: number;
		if (typeof chatId === "number") {
			n = chatId;
		} else {
			n = Number(chatId);
		}
		if (!Number.isSafeInteger(n) || (typeof chatId === "string" && String(n) !== chatId)) {
			throw new Error(`TelegramBridge: non-numeric or out-of-range chatId "${chatId}"`);
		}
		let tid: number | undefined;
		if (threadId === undefined) {
			tid = undefined;
		} else if (typeof threadId === "number") {
			tid = threadId;
		} else {
			const tn = Number(threadId);
			if (!Number.isSafeInteger(tn) || String(tn) !== threadId) {
				throw new Error(`TelegramBridge: non-numeric or out-of-range threadId "${threadId}"`);
			}
			tid = tn;
		}
		return telegramRoute(n, tid);
	}

	open(route: SessionRoute): SessionTransport {
		let t = this.transports.get(route.key);
		if (!t) {
			const ids = parseTelegramRoute(route.key);
			if (!ids) {
				throw new Error(`TelegramBridge: invalid route key "${route.key}"`);
			}
			t = new TelegramTransport(this.bot, ids.chatId, ids.threadId);
			this.transports.set(route.key, t);
		}
		return t;
	}

	async dispose(): Promise<void> {
		await Promise.allSettled([...this.transports.values()].map(t => t.dispose()));
		this.transports.clear();
	}
}

