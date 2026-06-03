/**
 * The single agent-turn dispatch path. Voice, photo, and text handlers
 * all used to inline the same five-step dance:
 *
 *   1. If a turn is already running, post a `↪ steered` ack so the user
 *      knows their new message routes through session.steer().
 *   2. chat.prompt(text, { replyTo })
 *   3. ensure() the session, waitForIdle()
 *   4. On throw, surface the error back into chat.
 *   5. Always endTurn() in finally.
 *
 * Inlining this in three places guaranteed they drifted; pulling it
 * here means a fix to (e.g.) steered ack wording lands once.
 *
 * Phase 1 of the discord-bridge plan extracted the grammy-direct
 * sendMessage calls behind `SessionTransport.postSystemMessage`, so
 * this file is bridge-agnostic — the only handle it needs is the
 * `ChatSession` itself.
 */
import type { ChatSession } from "../chat.ts";
import { scoped } from "../logger.ts";

const log = scoped("turn");

export interface TurnArgs {
	/** chatId / threadId are read off this — callers used to pass them
	 *  separately and could (and occasionally did) get them out of sync. */
	chat: ChatSession;
	/** Already-composed prompt text (caller wraps quote / forward / image-path
	 *  framing). The agent receives this verbatim. */
	prompt: string;
	/** Triggering-message id for the bridge to anchor system messages
	 *  against (telegram: numeric `reply_parameters.message_id`;
	 *  discord: snowflake string). Opaque to this layer; the transport
	 *  decides how (or whether) to use it. */
	replyTo: number | string;
	/** Tag for log scoping ("voice", "photo", "text"). */
	source: "voice" | "photo" | "text";
}

/**
 * Dispatch one user turn. Fire-and-forget: callers SHOULD `void` the
 * returned promise — handlers must return to grammY quickly so the next
 * update (which may be the button tap resolving a pending UI request)
 * can flow through, otherwise we deadlock on our own session.
 */
export async function runTurn(args: TurnArgs): Promise<void> {
	const { chat, prompt, replyTo, source } = args;
	try {
		if (chat.isTurnActive) {
			// Silent: the new message is mid-turn input, not a fresh
			// prompt. The user already heard the bubble fire when they
			// sent, so suppress notification on the ack.
			await chat.postSystemMessage("↪ steered (/cancel to abort)", {
				replyTo,
				silent: true,
			});
		}
		await chat.prompt(prompt, { replyTo });
		const s = await chat.ensure();
		await s.waitForIdle();
	} catch (err) {
		log.error("turn.failed", {
			source,
			chat_id: chat.chatId,
			err: String(err),
			stack: err instanceof Error ? err.stack : undefined,
		});
		try {
			await chat.postSystemMessage(
				`❌ ${err instanceof Error ? err.message : String(err)}`,
				{ replyTo },
			);
		} catch (replyErr) {
			log.error("turn.error_reply_failed", { source, err: String(replyErr) });
		}
	} finally {
		await chat.endTurn();
	}
}
