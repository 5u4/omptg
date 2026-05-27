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

	newStreamer(opts: { replyTo?: number }): Streamer {
		return new TelegramStreamer(this.bot, this.chatId, opts.replyTo, this.threadId);
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

	route(chatId: number, threadId?: number): SessionRoute {
		return telegramRoute(chatId, threadId);
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

