/**
 * Discord `messageCreate` handler — Phase 6 agent wiring.
 *
 * Routing mirrors `handlers/text.ts` for Telegram:
 *
 *   - Top-level channel message → auto-create a thread off it, then
 *     dispatch the agent turn into the new thread's session.
 *   - Message inside a thread under an allowlisted parent channel →
 *     dispatch into the thread's session directly.
 *
 * Reply quoting: Discord's "reply" is `msg.reference.messageId`. When
 * present, fetch the referenced message and prepend a markdown
 * blockquote (same shape as the Telegram handler's quote.ts path).
 * Discord has no forward primitive, so the forward branch from
 * handlers/text.ts is intentionally absent.
 *
 * Run the agent turn fire-and-forget. discord.js dispatches gateway
 * events concurrently (AsyncEventEmitter), so unlike grammY there is
 * no deadlock risk — the turn's ui.* prompts can wait on a button tap
 * even while this listener is still running. Voiding the promise just
 * matches the Telegram handler's shape (handler returns quickly, error
 * reporting stays inside runTurn) so the two bridges read the same.
 */
import type { Client, Message, ThreadChannel } from "discord.js";
import { ChannelType, Events } from "discord.js";
import type { ChatRegistry } from "../../chat.ts";
import { scoped } from "../../logger.ts";
import { formatReplyPrompt, type ReplyContext } from "../../quote.ts";
import { runTurn } from "../turn.ts";

const log = scoped("dc-msg");

/** Discord API error code for "Thread has already been created for this
 *  message" — startThread idempotency rejection. */
const ERR_THREAD_ALREADY_CREATED = 160004;

export interface DiscordHandlerOptions {
	client: Client;
	registry: ChatRegistry;
	/** Optional channel allowlist (CSV from env). Empty = allow all. */
	allowedChannels: ReadonlySet<string>;
	/** Optional guild allowlist. Empty = allow all. */
	allowedGuilds: ReadonlySet<string>;
	/** Bot snowflakes whose messages bypass the `msg.author.bot` drop.
	 *  Test-only escape hatch so `scripts/discord-smoke.ts` (which has
	 *  to post as a second bot — user-token automation violates Discord
	 *  TOS) can drive the handler end-to-end. Empty in normal operation;
	 *  bot-authored messages stay ignored. */
	allowedBotAuthors: ReadonlySet<string>;
}

export function installDiscordMessageHandler(opts: DiscordHandlerOptions): void {
	const { client, registry, allowedChannels, allowedGuilds, allowedBotAuthors } = opts;

	// Pin our bot id at ClientReady. `client.user` can transiently null
	// during reconnects; capturing once means the reply-quote author
	// check ("is this referencing one of our prior messages?") doesn't
	// misfire during a gateway flap.
	let myId: string | undefined;
	client.once(Events.ClientReady, c => { myId = c.user.id; });

	client.on(Events.MessageCreate, async (msg: Message) => {
		try {
			if (msg.author.bot && !allowedBotAuthors.has(msg.author.id)) return;
			if (!msg.guildId) return; // ignore DMs in v1
			if (allowedGuilds.size > 0 && !allowedGuilds.has(msg.guildId)) return;

			const ch = msg.channel;

			// Inside a thread: dispatch directly into that thread's session.
			if (ch.isThread()) {
				const parentId = ch.parentId;
				if (!parentId) return;
				if (allowedChannels.size > 0 && !allowedChannels.has(parentId)) return;
				await dispatch(msg, parentId, ch);
				return;
			}

			if (ch.type !== ChannelType.GuildText) return;
			if (allowedChannels.size > 0 && !allowedChannels.has(ch.id)) return;

			// Top-level channel message.
			//
			// Attachment-only messages (no usable text) are the worst-of-
			// both-worlds case: spawning a thread + then silently dropping
			// the turn makes the bot look broken. v1 doesn't handle
			// attachments at all (Phase 4.5), so refuse cleanly *before*
			// the thread spawn instead. Reply to the original message so
			// the user sees the explanation in the parent channel.
			if (!msg.content.trim()) {
				await refuseAttachmentOnly(msg);
				return;
			}

			const threadName = msg.content.trim().slice(0, 80);
			const thread = await spawnOrRecoverThread(msg, threadName);
			await dispatch(msg, ch.id, thread);
		} catch (err) {
			log.error("messageCreate.error", { err: String(err) });
		}
	});

	/** Resolve the agent prompt (with optional reply-quote framing),
	 *  materialize the per-thread ChatSession, install the auto-title
	 *  rename hook on first turn, and hand off to runTurn. */
	async function dispatch(msg: Message, channelId: string, thread: ThreadChannel): Promise<void> {
		const userText = msg.content;
		// In-thread guard: same attachment-only logic as the top-level
		// branch. We don't own thread creation here, so we just decline
		// without spawning a turn — but still surface the explanation so
		// the user understands why the bot went quiet in the thread.
		if (!userText.trim()) {
			await refuseAttachmentOnly(msg);
			return;
		}

		let prompt = userText;
		const refId = msg.reference?.messageId;
		if (refId) {
			try {
				const referenced = await msg.channel.messages.fetch(refId);
				const fromBot = myId !== undefined && referenced.author.id === myId;
				const ctx: ReplyContext = {
					author: fromBot ? "you" : (referenced.author.globalName ?? referenced.author.username),
					fromBot,
					text: referenced.content,
				};
				prompt = formatReplyPrompt(ctx, userText);
			} catch (err) {
				// Non-fatal: lose the quote framing but still run the turn
				// with the raw text rather than dropping the user's message.
				log.warn("reply_fetch_failed", { ref: refId, err: String(err) });
			}
		}

		const chat = registry.get(channelId, thread.id);
		// Install the rename hook on every turn dispatch, gated on
		// `titleAttempted` to skip sessions that already had a name at
		// boot (resumed) or generated one earlier in this process. The
		// callback is multi-shot — it also fires on manual setTitle /
		// regenerateTitle — but inside the gate the first auto-title
		// will flip titleAttempted, so re-running this branch on later
		// turns is a no-op. Re-installing every turn is intentional:
		// the closure captures the most recent `thread` handle, so a
		// gateway-driven refetch can't strand the callback on a stale
		// ThreadChannel.
		if (!chat.titleAttempted) {
			chat.onTitleGenerated = title => {
				// Discord limits to 2 thread renames per 10min per
				// thread. Auto-title fires once; manual title /
				// regenerate add to the budget. setName rejections
				// (including 429 rate-limit) surface as the catch
				// below and are logged, never crash the turn.
				const name = title.slice(0, 100);
				thread.setName(name, "omptg auto-title").catch(err => {
					log.warn("thread.rename_failed", {
						thread_id: thread.id,
						err: String(err),
					});
				});
			};
		}
		void runTurn({
			chat,
			prompt,
			replyTo: msg.id,
			source: "text",
		});
	}
}

/** Auto-create a thread off `msg`, or recover the existing one if Discord
 *  refuses with 160004 ("Thread has already been created for this
 *  message"). The cached `msg.hasThread / msg.thread` shortcut catches
 *  the common case; the API rejection covers gateway redeliveries and
 *  the race where a user manually right-click → Create Thread between
 *  the message landing and our handler running. */
async function spawnOrRecoverThread(msg: Message, name: string): Promise<ThreadChannel> {
	if (msg.hasThread && msg.thread) return msg.thread;
	try {
		return await msg.startThread({ name, autoArchiveDuration: 1440 });
	} catch (err) {
		const code = (err as { code?: number }).code;
		if (code !== ERR_THREAD_ALREADY_CREATED) throw err;
		const refreshed = await msg.fetch();
		if (!refreshed.thread) throw err;
		return refreshed.thread;
	}
}

/** Post the "attachments not supported yet" reply with mentions fully
 *  suppressed. Matches the convention used everywhere else in the
 *  Discord bridge (streamer / ui / system messages): user text and
 *  reply context can contain `@everyone`, `<@id>`, etc., and a system
 *  notice has no business re-pinging the user it's replying to. */
async function refuseAttachmentOnly(msg: Message): Promise<void> {
	try {
		await msg.reply({
			content: "ℹ attachments aren't supported yet — please add a text message describing what you'd like.",
			allowedMentions: { parse: [], repliedUser: false },
		});
	} catch (err) {
		log.warn("attachment_only.reply_failed", { err: String(err) });
	}
}
