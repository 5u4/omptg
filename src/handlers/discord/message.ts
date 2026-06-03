/**
 * Discord `messageCreate` handler — Phase 2 skeleton.
 *
 * - Top-level channel message → auto-create a thread off it, echo the
 *   message inside the new thread.
 * - Message inside an existing bot-owned thread → echo it back in-thread.
 *
 * Agent wiring lands in phase 5; this handler only proves the routing.
 */
import type { Client, Message, ThreadChannel } from "discord.js";
import { ChannelType, Events } from "discord.js";
import type { ChatRegistry } from "../../chat.ts";
import { scoped } from "../../logger.ts";

const log = scoped("dc-msg");

export interface DiscordHandlerOptions {
	client: Client;
	registry: ChatRegistry;
	/** Optional channel allowlist (CSV from env). Empty = allow all. */
	allowedChannels: ReadonlySet<string>;
	/** Optional guild allowlist. Empty = allow all. */
	allowedGuilds: ReadonlySet<string>;
}

export function installDiscordMessageHandler(opts: DiscordHandlerOptions): void {
	const { client, registry, allowedChannels, allowedGuilds } = opts;

	client.on(Events.MessageCreate, async (msg: Message) => {
		try {
			if (msg.author.bot) return;
			if (!msg.guildId) return; // ignore DMs in v1
			if (allowedGuilds.size > 0 && !allowedGuilds.has(msg.guildId)) return;

			const ch = msg.channel;
			if (ch.isThread()) {
				const parentId = ch.parentId;
				if (!parentId) return;
				if (allowedChannels.size > 0 && !allowedChannels.has(parentId)) return;
				// Route into the thread's session; echo for phase 2.
				registry.get(parentId, ch.id);
				await ch.send(msg.content || "(empty)");
				return;
			}

			if (ch.type !== ChannelType.GuildText) return;
			if (allowedChannels.size > 0 && !allowedChannels.has(ch.id)) return;

			// Top-level channel message → spawn (or recover) a thread off it.
			// `msg.startThread` rejects with code 160004 if the message
			// already owns a thread (bot retry, duplicate event delivery,
			// or user manually spawned one between the gateway send and our
			// handler running) — fall back to the existing thread so the
			// echo still lands instead of looking like the bot ignored it.
			const threadName = (msg.content.trim() || "session").slice(0, 80);
			let thread: ThreadChannel;
			if (msg.hasThread && msg.thread) {
				thread = msg.thread;
			} else {
				thread = await msg.startThread({
					name: threadName,
					autoArchiveDuration: 1440,
				});
			}
			registry.get(ch.id, thread.id);
			await thread.send(msg.content || "(empty)");
		} catch (err) {
			log.error("messageCreate.error", { err: String(err) });
		}
	});
}
