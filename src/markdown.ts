/**
 * MarkdownV2 conversion + safe chunking for telegram.
 *
 * Telegram messages cap at 4096 chars (MAX_MESSAGE_LEN). The agent emits
 * standard markdown (** bold **, ``` fences, [link](url), lists, etc.);
 * we convert to telegram's MarkdownV2 dialect via `telegramify-markdown`
 * and chunk the result so each piece is independently parseable.
 *
 * The hard problem is fenced code blocks (```) that span our chunk
 * boundary — splitting them mid-fence yields two messages with broken
 * entity parsing. We solve it by tracking fence parity per source chunk:
 * if a chunk closes inside an open fence, close the fence at the chunk
 * boundary and reopen it at the start of the next chunk (preserving the
 * info string when we can). Then each chunk gets `telegramify` applied
 * separately and is independently valid MarkdownV2.
 *
 * If conversion or telegram parsing still fails downstream, the caller
 * is expected to fall back to plain text (see streamer.ts).
 */

import telegramify from "telegramify-markdown";

/** Telegram's per-message hard cap. */
const MAX_MESSAGE_LEN = 4096;

/** Match a line that opens or closes a fenced code block. */
const FENCE_RE = /^ {0,3}```(.*)$/;

/**
 * Split `text` into chunks of at most `budget` characters (after telegramify
 * conversion) such that fenced code blocks never span a chunk boundary.
 * Returns the MarkdownV2 strings ready to send.
 *
 * Algorithm:
 *  1. Walk the source by lines, accumulating into a buffer.
 *  2. Track whether we're inside a fence (`openInfo` is the info string
 *     of the active opening fence, or null).
 *  3. Flush when adding the next line would exceed `budget` AFTER
 *     conversion (conservative: assume telegramify roughly preserves
 *     length within ~1.3× for escape sequences — we re-convert and
 *     measure to be precise).
 *  4. When flushing inside an open fence, append a closing ``` to the
 *     flushed chunk and prepend ```<info> to the next chunk.
 */
export interface MarkdownChunk {
	/** Original markdown source for this chunk (fence-balanced). */
	src: string;
	/** Telegram MarkdownV2 conversion of `src`. */
	md: string;
}

export function splitMarkdownForTelegram(
	text: string,
	budget = MAX_MESSAGE_LEN,
): MarkdownChunk[] {
	const lines = text.split("\n");
	const out: MarkdownChunk[] = [];
	let buf: string[] = [];
	let openInfo: string | null = null;

	const tryConvert = (src: string): string => telegramify(src, "keep");

	const flush = (carryOpen: boolean) => {
		if (buf.length === 0) return;
		let chunkSrc = buf.join("\n");
		if (carryOpen && openInfo !== null) {
			// Close the fence we leave behind, and remember to reopen it
			// on the next chunk's first line.
			chunkSrc += "\n```";
		}
		const md = tryConvert(chunkSrc);
		if (md) out.push({ src: chunkSrc, md });
		buf = [];
	};

	for (const line of lines) {
		const fence = line.match(FENCE_RE);
		if (fence) {
			openInfo = openInfo === null ? fence[1] ?? "" : null;
		}

		// Tentatively add this line and re-check budget.
		buf.push(line);
		const tentative = tryConvert(buf.join("\n") + (openInfo !== null ? "\n```" : ""));
		if (tentative.length > budget && buf.length > 1) {
			// Roll back the line, flush what we had, then start a new chunk
			// with this line — and reopen the fence if we were inside one.
			const dropped = buf.pop()!;
			const wasOpen = openInfo !== null;
			flush(wasOpen);
			if (wasOpen) buf.push("```" + openInfo);
			buf.push(dropped);
		} else if (tentative.length > budget) {
			// Single line already exceeds budget — fall back to hard split
			// on the converted form. Rare for sane assistant text.
			const srcOnly = buf.join("\n");
			const hard = tryConvert(srcOnly);
			for (let i = 0; i < hard.length; i += budget) {
				out.push({ src: srcOnly, md: hard.slice(i, i + budget) });
			}
			buf = [];
		}
	}
	flush(false);
	return out;
}

/**
 * Convert a single short markdown blob to MarkdownV2. Returns undefined
 * if conversion produces empty output. No chunking, no fence handling —
 * intended for short chrome messages.
 */
export function toMarkdownV2(text: string): string | undefined {
	const out = telegramify(text, "keep");
	return out || undefined;
}
