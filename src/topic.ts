/**
 * Forum topic identification helpers.
 *
 * Telegram forum supergroups split messages into "topics", each with a
 * `message_thread_id`. The default "General" topic is a special case:
 * its messages have `is_topic_message: false` and we treat them as
 * "no topic" (same as a DM or non-forum group) so a forum's General
 * keeps the same ChatRegistry key as the supergroup had before forums
 * were enabled — no migration needed.
 *
 * This module is the SINGLE source of truth for "is this message in a
 * specific topic?" so every command handler agrees.
 */

/** Minimal shape we need from a telegram Message / CallbackQuery.message. */
export interface TopicContext {
	is_topic_message?: boolean;
	message_thread_id?: number;
}

/** Return the `message_thread_id` if this message is in a non-General
 *  forum topic, otherwise undefined. */
export function extractThreadId(msg: TopicContext | undefined): number | undefined {
	if (!msg) return undefined;
	if (!msg.is_topic_message) return undefined;
	return msg.message_thread_id;
}
