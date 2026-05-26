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
 * Detect GFM table blocks (`| col | col |` header, `| --- | --- |` separator,
 * then ≥1 data rows) and wrap them in a fenced code block so telegram
 * renders them as monospace + skips entity parsing inside them.
 *
 * Why: telegram MarkdownV2 has no table syntax. telegramify-markdown
 * passes tables through verbatim, leaving raw `|` characters that
 * telegram tries to parse as spoiler delimiters → "can't parse entities"
 * 400. Wrapping in ``` makes them safe AND keeps column alignment so
 * the user can still read the table.
 */
function fenceTables(src: string): string {
	const lines = src.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const header = lines[i];
		const sep = lines[i + 1];
		const isTableStart =
			header !== undefined && sep !== undefined
			&& /^\s*\|.*\|\s*$/.test(header)
			&& /^\s*\|?\s*:?-{2,}:?(\s*\|\s*:?-{2,}:?)+\s*\|?\s*$/.test(sep);
		if (!isTableStart) {
			out.push(header!);
			i++;
			continue;
		}
		// Collect header + sep + every following row that still looks like
		// a table row ("|...|"). Blank line or non-row ends the table.
		const block: string[] = [header!, sep!];
		i += 2;
		while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) {
			block.push(lines[i]!);
			i++;
		}
		out.push("```", ...block, "```");
	}
	return out.join("\n");
}

/**
 * Replace markdown horizontal-rule lines (`---`, `***`, `___`, optionally
 * with internal spaces, on a line by themselves) with an em-dash row.
 *
 * telegramify-markdown emits HR lines verbatim, but MarkdownV2 has no
 * concept of an HR and treats `-` / `*` / `_` as reserved characters.
 * Telegram then rejects the whole message with
 * `Character '-' is reserved and must be escaped`. We can't safely
 * post-escape (would mangle legitimate `\-` already in the converter
 * output), so neutralize at the source.
 */
function neutralizeHorizontalRules(src: string): string {
	return src
		.split("\n")
		.map(line => /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line) ? "———" : line)
		.join("\n");
}


/**
 * GFM uses `` ``…`` `` (double-backtick spans) when the inline content
 * contains a literal backtick that single-backtick code can't hold.
 * `telegramify-markdown` preserves them verbatim under `keep` mode, but
 * Telegram MarkdownV2 has no double-backtick token — its parser reads
 * each `` ` `` independently, treating adjacent `` `` `` as two empty
 * code entities. Any reserved char (`-`, `.`, `(`, `!`, …) caught
 * between two such empty entities is then "outside code" and trips
 * `Bad Request: can't parse entities: Character '…' is reserved`.
 *
 * Fix: flatten every `` `` x `y` z `` `` to a single inline-code span
 * by stripping inner backticks (`` `x y z` ``). The inner emphasis is
 * lost but the message renders instead of fallback-to-plain.
 *
 * Skipped inside triple-backtick fenced blocks so legitimate code stays
 * untouched. The fence tracker matches `splitMarkdownForTelegram`'s.
 */
function neutralizeDoubleBackticks(src: string): string {
	const lines = src.split("\n");
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (FENCE_RE.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		// Match a double-backtick span: `` <content> `` with content that
		// MAY contain single backticks. Non-greedy so we don't swallow
		// across multiple spans on the same line.
		lines[i] = line.replace(/``([\s\S]+?)``/g, (_, inner: string) => {
			// Drop any inner backticks; collapse double spaces that the
			// GFM convention often inserts as visual padding around the
			// embedded backtick.
			const flat = inner.replace(/`/g, "").replace(/  +/g, " ").trim();
			return "`" + flat + "`";
		});
	}
	return lines.join("\n");
}

/**
 * Rewrite ATX headings (`#`, `##`, `###`, …) to plain bold/italic lines
 * with visual prefixes, because Telegram MarkdownV2 has no heading syntax
 * and telegramify-markdown flattens ALL heading levels to a single bold
 * line — so `# Title`, `## Section`, and `### Subsection` all look
 * identical in chat, destroying document hierarchy.
 *
 * Mapping (chosen so each level survives telegramify and stays distinct):
 *   #     → `**━━━ X ━━━**`   bold + box-drawing rails (most prominent)
 *   ##    → `**▸ X**`          bold + caret prefix
 *   ###   → `*X*`              italic only
 *   ####+ → `*X*`              same as ### (Telegram only has 2 emphasis
 *                              styles, no point inventing more)
 *
 * Skipped inside fenced code blocks so a `#` comment in a shell snippet
 * isn't mangled. The fence tracker matches `splitMarkdownForTelegram`'s.
 */
function normalizeHeadings(src: string): string {
	const lines = src.split("\n");
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (FENCE_RE.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (!m) continue;
		const level = m[1]!.length;
		const text = m[2]!;
		if (level === 1) lines[i] = `**━━━ ${text} ━━━**`;
		else if (level === 2) lines[i] = `**▸ ${text}**`;
		else lines[i] = `*${text}*`;
	}
	return lines.join("\n");
}

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
	// Wrap GFM tables in code fences BEFORE line-walking so the fence-balance
	// logic below treats them as ordinary fenced blocks. Strip markdown HR
	// lines first so telegramify can't emit a raw `---` that Telegram rejects.
	const lines = fenceTables(neutralizeHorizontalRules(neutralizeDoubleBackticks(normalizeHeadings(text)))).split("\n");
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
		// Snapshot fence state BEFORE we apply this line's effect, so a
		// rollback (push exceeded budget) can restore it. Without this,
		// dropping a fence-opener line would leave `openInfo` toggled to
		// "open" with no actual opener in `buf`, causing flush() to emit
		// a stray closing ``` and the next chunk to reopen with an empty
		// info string.
		const prevOpenInfo: string | null = openInfo;
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
			// Revert fence toggle: we're flushing `buf` as it was BEFORE
			// `line`, so the chunk's fence state is `prevOpenInfo`. The
			// dropped line goes into the next chunk, where its fence
			// effect will re-apply on the next iteration via the same
			// snapshot mechanism.
			const chunkOpen = prevOpenInfo;
			openInfo = prevOpenInfo;
			flush(chunkOpen !== null);
			if (chunkOpen !== null) buf.push("```" + chunkOpen);
			buf.push(dropped);
			// Re-apply the dropped line's fence effect for the NEW chunk.
			if (fence) {
				openInfo = openInfo === null ? fence[1] ?? "" : null;
			}
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
