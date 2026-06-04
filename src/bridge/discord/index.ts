/**
 * DiscordBridge — Phase 2 skeleton.
 *
 * Owns one transport per (channelId, threadId) route. The bridge wraps a
 * `discord.js` Client; the entrypoint (`src/discord-main.ts`) constructs
 * the client + bridge + registry + message handler.
 *
 * Phase 2 scope: route + transport plumbing, no-op streamer that posts
 * a single `commitAssistant`, throwing UI, typing via `channel.sendTyping`.
 * Real streaming + UI components land in phases 3-4.
 */
import type { Client, TextChannel, ThreadChannel } from "discord.js";
import { ChannelType, MessageFlags } from "discord.js";
import type {
	Bridge,
	ChatId,
	InteractiveUI,
	SessionRoute,
	SessionTransport,
	Streamer,
	Typing,
} from "../types.ts";
import { DiscordStreamer } from "./streamer.ts";
import { DiscordUI } from "./ui.ts";
import { DiscordTyping } from "./typing.ts";

const DISCORD_SYSTEM_BLOCK = [
	"You are talking through a Discord bot.",
	"Discord supports a subset of GitHub-flavored markdown: **bold**,",
	"*italic* (or `_italic_`), __underline__, ~~strike~~, ||spoiler||,",
	"`inline code`,",
	"```fenced code``` with language tags, headings `#`/`##`/`###`,",
	"`-`/`1.` lists, `>` and `>>>` blockquotes, `[text](url)` links,",
	"`-# subtext`, and @mentions. Write markdown normally — no escaping.",
	"Discord does NOT render:",
	"  - GFM tables (`|`/`---` rows show as literal text)",
	"  - Horizontal rules (`---`, `***`, `___`)",
	"  - Headings deeper than `###` (`####`+ shows the hashes literally)",
	"  - Inline images `![alt](url)` (the `!` form is ignored)",
	"  - Task lists `- [ ]` / `- [x]` (brackets show literally)",
	"  - Footnotes `[^1]` and raw HTML",
	"The bridge rewrites most of these to the closest supported form",
	"(tables → code fence, H4+ → bold, images → plain link, task list →",
	"`☐`/`☑`, HR → `———`), but prefer the native form when you can:",
	"`- **key**: value` reads better than a table on mobile, and a short",
	"bold lead-in reads better than a deep heading.",
	"Per-message hard cap is 2000 characters. The bridge auto-splits long",
	"replies on line boundaries (closing/reopening fenced code blocks",
	"across the split), but shorter, well-scoped messages render better",
	"on Discord — prefer multiple focused replies over one wall of text.",
].join("\n");

export interface DiscordRouteIds {
	channelId: string;
	threadId: string | undefined;
}

/** Route key shape: `dc:${channelId}:${threadId ?? ""}`. The `dc:`
 *  prefix namespaces Discord routes inside the shared ChatStore
 *  (`~/.omptg/chats.json`) so a numeric Discord channel snowflake can't
 *  collide with a numeric Telegram chat id — see
 *  `docs/discord-bridge.md` Open Question #1. ChatRegistry uses this
 *  string verbatim as its Map key and as the `/bind` storage key. */
export function discordRouteKey(channelId: string, threadId?: string): string {
	return `dc:${channelId}:${threadId ?? ""}`;
}

export function discordRoute(channelId: string, threadId?: string): SessionRoute {
	const suffix = threadId !== undefined ? `:${threadId}` : "";
	return {
		key: discordRouteKey(channelId, threadId),
		label: `dc:${channelId}${suffix}`,
	};
}

export function parseDiscordRoute(key: string): DiscordRouteIds | undefined {
	if (!key.startsWith("dc:")) return undefined;
	const rest = key.slice(3);
	const idx = rest.indexOf(":");
	if (idx < 0) return undefined;
	const channelId = rest.slice(0, idx);
	if (!channelId) return undefined;
	const tail = rest.slice(idx + 1);
	const threadId = tail === "" ? undefined : tail;
	return { channelId, threadId };
}

class DiscordTransport implements SessionTransport {
	readonly ui: InteractiveUI;
	readonly typing: Typing;

	constructor(
		private readonly client: Client,
		private readonly channelId: string,
		private readonly threadId: string | undefined,
	) {
		this.ui = new DiscordUI(client, channelId, threadId);
		this.typing = new DiscordTyping(client, channelId, threadId);
	}

	newStreamer(opts: { replyTo?: number | string }): Streamer {
		const replyTo = opts.replyTo === undefined ? undefined : String(opts.replyTo);
		return new DiscordStreamer(this.client, this.channelId, this.threadId, replyTo);
	}

	async postSystemMessage(text: string, opts?: { replyTo?: number | string; silent?: boolean }): Promise<void> {
		const target = await resolveSendTarget(this.client, this.channelId, this.threadId);
		const reply = opts?.replyTo !== undefined ? { messageReference: String(opts.replyTo), failIfNotExists: false } : undefined;
		await target.send({
			content: text,
			// Never let system-message content (errors etc.) ping channels
			// or roles; the `repliedUser: false` part also guards the
			// "↪ steered" ack from re-pinging the user even when `silent`
			// is unset.
			allowedMentions: { parse: [], repliedUser: false },
			...(reply ? { reply } : {}),
			...(opts?.silent ? { flags: MessageFlags.SuppressNotifications } : {}),
		});
	}

	async dispose(): Promise<void> {
		this.typing.stop();
	}
}

/** Resolve the `discord.js` channel/thread we should post into. Threads
 *  must be fetched explicitly because the cache may not hold them after
 *  process restarts. */
export async function resolveSendTarget(
	client: Client,
	channelId: string,
	threadId: string | undefined,
): Promise<TextChannel | ThreadChannel> {
	if (threadId !== undefined) {
		const ch = await client.channels.fetch(threadId);
		if (!ch || !ch.isThread()) {
			throw new Error(`DiscordBridge: thread ${threadId} not found or not a thread`);
		}
		if (ch.parentId !== channelId) {
			// Defense against misrouted route keys (caller paired a thread
			// id with the wrong channel) and against threads that were
			// administratively moved out of the channel they were bound
			// against — silently posting into a different channel is the
			// worst-possible failure mode, so refuse loudly.
			throw new Error(`DiscordBridge: thread ${threadId} parentId ${ch.parentId} != bound channel ${channelId}`);
		}
		return ch;
	}
	const ch = await client.channels.fetch(channelId);
	if (!ch || ch.type !== ChannelType.GuildText) {
		throw new Error(`DiscordBridge: channel ${channelId} is not a guild text channel`);
	}
	return ch;
}

export class DiscordBridge implements Bridge {
	readonly kind = "discord" as const;
	readonly pinsSessions = true;
	private readonly transports = new Map<string, DiscordTransport>();

	constructor(private readonly client: Client) {}

	systemPromptAddendum(): string {
		return DISCORD_SYSTEM_BLOCK;
	}

	route(chatId: ChatId, threadId?: number | string): SessionRoute {
		// Discord ids are snowflake strings. We accept `number` defensively
		// in case a caller stringified-then-parsed an id, but warn-by-throw
		// if it crossed into the unsafe range (precision lost).
		const channelId = normalizeSnowflake(chatId, "channelId");
		const tid = threadId === undefined ? undefined : normalizeSnowflake(threadId, "threadId");
		return discordRoute(channelId, tid);
	}

	bindingKey(chatId: ChatId): string {
		// Discord ids are snowflake strings; `dc:` prefix mirrors what
		// route()/discordRouteKey already do for in-memory routes, but
		// here applied to the persistent /bind store key.
		return `dc:${normalizeSnowflake(chatId, "channelId")}`;
	}

	open(route: SessionRoute): SessionTransport {
		let t = this.transports.get(route.key);
		if (!t) {
			const ids = parseDiscordRoute(route.key);
			if (!ids) {
				throw new Error(`DiscordBridge: invalid route key "${route.key}"`);
			}
			t = new DiscordTransport(this.client, ids.channelId, ids.threadId);
			this.transports.set(route.key, t);
		}
		return t;
	}

	async dispose(): Promise<void> {
		await Promise.allSettled([...this.transports.values()].map(t => t.dispose()));
		this.transports.clear();
	}
}

function normalizeSnowflake(value: number | string, label: string): string {
	if (typeof value === "string") {
		if (!/^\d+$/.test(value)) {
			throw new Error(`DiscordBridge: ${label} "${value}" is not a numeric snowflake string`);
		}
		return value;
	}
	if (!Number.isSafeInteger(value)) {
		// Snowflakes exceeding safe-integer range can't survive a number
		// round-trip; refuse so we don't silently corrupt the id.
		throw new Error(`DiscordBridge: ${label} ${value} exceeds safe-integer range; pass as string`);
	}
	return String(value);
}
