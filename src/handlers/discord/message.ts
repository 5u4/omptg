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
import type { Attachment, Client, Message, ThreadChannel } from "discord.js";
import { ChannelType, Events } from "discord.js";
import type { ChatRegistry } from "../../chat.ts";
import { scoped } from "../../logger.ts";
import { cacheImageFromUrl } from "../../media.ts";
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
				await dispatch(msg, parentId, ch, msg.id);
				return;
			}

			if (ch.type !== ChannelType.GuildText) return;
			if (allowedChannels.size > 0 && !allowedChannels.has(ch.id)) return;

			// Top-level channel message.
			//
			// Attachment-only messages with no usable image *and* no text
			// are the worst-of-both-worlds case: spawning a thread + then
			// silently dropping the turn makes the bot look broken.
			// Refuse cleanly *before* the thread spawn instead. Reply to
			// the original message so the user sees the explanation in
			// the parent channel.
			const topImages = pickImageAttachments(msg);
			if (!msg.content.trim() && topImages.length === 0) {
				await refuseAttachmentOnly(msg);
				return;
			}

			// Prefer text for the thread name; fall back to a generic
			// label when the user only sent images (Discord requires a
			// non-empty thread name).
			const threadName = (msg.content.trim() || "image").slice(0, 80);
			const thread = await spawnOrRecoverThread(msg, threadName);
			// Top-level → spawned thread: omit replyTo. The first
			// assistant chunk lives in the new thread, but `msg.id`
			// references the triggering message in the parent channel.
			// Discord rejects cross-channel replies (`failIfNotExists:
			// false` then drops the reference silently), so the reply
			// pip never renders. The thread itself is anchored on
			// that message — the reply pip would be redundant even
			// if it worked.
			await dispatch(msg, ch.id, thread, undefined, topImages);
		} catch (err) {
			log.error("messageCreate.error", { err: String(err) });
		}
	});

	/** Resolve the agent prompt (with optional reply-quote framing),
	 *  materialize the per-thread ChatSession, install the auto-title
	 *  rename hook on first turn, and hand off to runTurn. */
	async function dispatch(
		msg: Message,
		channelId: string,
		thread: ThreadChannel,
		replyTo: string | undefined,
		images?: Attachment[],
	): Promise<void> {
		const userText = msg.content;
		// Re-derive image attachments for the in-thread path; the
		// top-level path passes them in already. Either way:
		// attachment-only + no images means the user uploaded
		// something we can't ingest (video, file, etc.) — surface the
		// explanation rather than going silent in the thread.
		const imgAttachments = images ?? pickImageAttachments(msg);
		if (!userText.trim() && imgAttachments.length === 0) {
			await refuseAttachmentOnly(msg);
			return;
		}

		// Download every image to the local cache. We do them in
		// parallel — typical Discord uploads are a handful of files
		// and the CDN handles concurrent fetches well. Per-image
		// failure (oversized, network blip, unsupported mime) is
		// logged at warn and the image is silently dropped from the
		// prompt; losing one attachment shouldn't tank the whole
		// turn. The all-failed case is caught by the explicit guard
		// below so the user still gets feedback when nothing landed.
		const cached = await Promise.all(imgAttachments.map(async a => {
			try {
				const out = await cacheImageFromUrl(a.url, {
					contentType: a.contentType,
					filename: a.name,
				});
				log.info("image.cached", {
					channel: channelId,
					path: out.path,
					bytes: out.bytes,
				});
				return out.path;
			} catch (err) {
				log.warn("image.cache_failed", {
					channel: channelId,
					url: a.url,
					err: String(err),
				});
				return undefined;
			}
		}));
		const imagePaths = cached.filter((p): p is string => p !== undefined);

		// All-failed guard. If the user posted images and no text, and
		// every download failed (oversized / unsupported / CDN blip),
		// the bot would otherwise hand the agent an empty prompt — same
		// "bot looks broken" pathology the early attachment-only refuse
		// gate was added to prevent. Telegram's photo handler surfaces
		// download errors to the user the same way; mirror that. When
		// the user also typed a caption we let the turn proceed: the
		// caption alone is still a meaningful prompt, the partial
		// failures are already logged at warn.
		if (imgAttachments.length > 0 && imagePaths.length === 0 && !userText.trim()) {
			try {
				await msg.reply({
					content: "❌ Couldn't ingest any of the attached images (oversized / unsupported / fetch failed). Check the logs for details.",
					allowedMentions: { parse: [], repliedUser: false },
				});
			} catch (err) {
				log.warn("image.all_failed_reply_failed", { err: String(err) });
			}
			return;
		}
		// Build the agent prompt. Mirrors handlers/photo.ts so the
		// main agent sees the same `[user attached image: …]` framing
		// regardless of bridge. When there's no caption, hand the
		// agent an explicit sentinel so it knows the empty text is
		// intentional (user uploaded image-only).
		const composedText = imagePaths.length > 0
			? [
				...imagePaths.map(p => `[user attached image: ${p}]`),
				"",
				userText.trim() || "(no caption — describe or ask what they want)",
			].join("\n")
			: userText;

		let prompt = composedText;
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
				prompt = formatReplyPrompt(ctx, composedText);
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
			...(replyTo !== undefined ? { replyTo } : {}),
			// Source tag drives per-bridge log scoping in runTurn /
			// turn.failed; an image-bearing dispatch should surface as
			// a photo turn so per-source filtering during incident
			// triage still works (matches handlers/photo.ts).
			source: imagePaths.length > 0 ? "photo" : "text",
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

/** Post the "unsupported attachments" reply with mentions fully
 *  suppressed. Matches the convention used everywhere else in the
 *  Discord bridge (streamer / ui / system messages): user text and
 *  reply context can contain `@everyone`, `<@id>`, etc., and a system
 *  notice has no business re-pinging the user it's replying to. */
async function refuseAttachmentOnly(msg: Message): Promise<void> {
	try {
		await msg.reply({
			content: "ℹ I can only ingest text and image attachments — please add a message describing what you'd like.",
			allowedMentions: { parse: [], repliedUser: false },
		});
	} catch (err) {
		log.warn("attachment_only.reply_failed", { err: String(err) });
	}
}

/** Filter `msg.attachments` to entries we can hand to the image cache.
 *  Trust `contentType` first (Discord populates it for everything its
 *  CDN scans), fall back to a known image extension on the filename
 *  for the rare upload that arrives without a content-type.
 *
 *  Exported for tests; constructing a full Message mock just to
 *  exercise this branch is more ceremony than it's worth. */
export function pickImageAttachments(msg: Message): Attachment[] {
	const out: Attachment[] = [];
	for (const a of msg.attachments.values()) {
		if (a.contentType?.toLowerCase().startsWith("image/")) {
			out.push(a);
			continue;
		}
		const name = a.name?.toLowerCase() ?? "";
		if (/\.(jpe?g|png|webp|gif)$/.test(name)) out.push(a);
	}
	return out;
}
