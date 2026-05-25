/**
 * Format a telegram reply context into a quote header the LLM can read.
 *
 * When the user replies to a previous message (their own, the bot's, or
 * another participant's), we lose context if we just forward the new
 * text. Prepend a markdown blockquote of the original message so the
 * agent sees what the user is responding to.
 *
 * Bot vs human author matters: the LLM treats "you said earlier" very
 * differently from "another user said". Authorship is tagged explicitly
 * rather than relying on the LLM to guess from username.
 */

export interface ReplyContext {
	/** Author display name (`first_name` or `username`); "you" if it's the bot itself. */
	author: string;
	/** True if the replied-to message was authored by our bot. */
	fromBot: boolean;
	/** The replied-to message's text (or caption). Empty string if neither. */
	text: string;
}

/**
 * Build a quoted-context prompt:
 *   > [replying to <bot|user> <author>]
 *   > line one
 *   > line two
 *
 *   <user's new text>
 *
 * Long quotes are truncated to `maxQuoteChars` with an ellipsis so we
 * don't blow the context window on a giant reply chain.
 */
export function formatReplyPrompt(
	reply: ReplyContext,
	userText: string,
	maxQuoteChars = 800,
): string {
	const role = reply.fromBot ? "bot" : "user";
	const head = `[replying to ${role} ${reply.author}]`;
	const body = reply.text.length > maxQuoteChars
		? `${reply.text.slice(0, maxQuoteChars).trimEnd()}…`
		: reply.text;
	const quoted = body
		? body.split("\n").map(line => `> ${line}`).join("\n")
		: "";
	const prefix = quoted ? `> ${head}\n${quoted}` : `> ${head}`;
	return `${prefix}\n\n${userText}`;
}

export interface ForwardContext {
	/** Telegram MessageOrigin discriminator. */
	kind: "user" | "hidden_user" | "chat" | "channel";
	/** Display name of the original author / chat. */
	name: string;
	/** Original send date (unix seconds). Used as-is for the header tag. */
	date: number;
	/** The forwarded text (or caption); empty for media-only forwards. */
	text: string;
}

/**
 * Build a quoted-context prompt for a forwarded message:
 *   > [forwarded from <kind> <name>]
 *   > <text>
 *
 *   <userText>    ← only present for media forwards where the user adds a caption.
 *
 * For plain text forwards telegram doesn't let the user add inline text,
 * so `userText` is usually empty and the prompt is just the quote block.
 */
export function formatForwardPrompt(
	fwd: ForwardContext,
	userText: string,
	maxQuoteChars = 800,
): string {
	const head = `[forwarded from ${fwd.kind} ${fwd.name}]`;
	const body = fwd.text.length > maxQuoteChars
		? `${fwd.text.slice(0, maxQuoteChars).trimEnd()}…`
		: fwd.text;
	const quoted = body
		? body.split("\n").map(line => `> ${line}`).join("\n")
		: "";
	const prefix = quoted ? `> ${head}\n${quoted}` : `> ${head}`;
	return userText ? `${prefix}\n\n${userText}` : prefix;
}
