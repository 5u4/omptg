/**
 * Discord-flavored markdown chunking.
 *
 * Discord accepts GitHub-flavored markdown verbatim (no MarkdownV2
 * escape dance) but enforces a 2000-character per-message hard cap.
 * Splits at line boundaries within the budget; if a fenced code block
 * straddles a flush, the chunk is closed with ``` and the next chunk
 * reopens with ```<info> so each emitted chunk is fence-balanced.
 * Oversized single lines are hard-split as a last resort, preserving
 * the active fence wrapper across every emitted slice.
 *
 * Pure text in / text out — no `discord.js` types, no I/O. Mirrors the
 * structural intent of `splitMarkdownForTelegram` without the
 * conversion pass.
 */

import { fenceTables, neutralizeHorizontalRules } from "../../markdown.ts";

/** Discord per-message hard cap. */
export const DISCORD_MAX_MESSAGE_LEN = 2000;

/** Match a line that opens or closes a fenced code block. */
const FENCE_RE = /^ {0,3}```(.*)$/;
/** Closing-fence overhead added at flush time when a chunk leaves a
 *  fence open: `"\n```"` = 4 chars. */
const CLOSE_FENCE_COST = 4;

/**
 * Split `text` into chunks of at most `budget` characters, preserving
 * fenced code blocks across boundaries by closing/reopening the fence.
 *
 * The invariant we maintain: `buf` holds source lines only. Fence
 * chrome (synthetic reopener at chunk start, closer at chunk end) is
 * added at flush time based on `chunkStartOpen` and the live
 * `openInfo`. This avoids emitting empty `` ```ts\n``` `` chunks when
 * a hard-split or flush boundary lands on bare fence chrome.
 */

/**
 * Demote ATX headings deeper than H3 to bold lines. Discord renders
 * `#`, `##`, `###` but treats `####`+ as literal text (the hashes show
 * up in the message). Anything we rewrite must be fence-aware so a
 * `#` comment in a shell snippet stays untouched.
 */
function demoteDeepHeadings(src: string): string {
	const lines = src.split("\n");
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (FENCE_RE.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const m = /^(#{4,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (m) lines[i] = `**${m[2]!}**`;
	}
	return lines.join("\n");
}

/**
 * Rewrite GFM image syntax `![alt](url)` to a plain link `[alt](url)`.
 * Discord ignores the `!` form entirely — the line renders as literal
 * text — but a bare link auto-embeds the image when the URL points at
 * an image asset. Empty alt falls back to the URL.
 *
 * Fence-aware so `![x](y)` inside a code block stays literal.
 */
function rewriteImages(src: string): string {
	const lines = src.split("\n");
	let inFence = false;
	const IMG_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (FENCE_RE.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		lines[i] = line.replace(IMG_RE, (_m, alt: string, url: string) =>
			alt.length > 0 ? `[${alt}](${url})` : url,
		);
	}
	return lines.join("\n");
}

/**
 * Rewrite GFM task list markers `- [ ]` / `- [x]` to unicode boxes.
 * Discord renders the brackets as literal text, which looks broken.
 * `☐` / `☑` survive any font and convey the same meaning. Ordered
 * variants (`1. [ ]`) are handled too.
 */
function rewriteTaskLists(src: string): string {
	const lines = src.split("\n");
	let inFence = false;
	const TASK_RE = /^(\s*(?:[-*+]|\d+\.)\s+)\[([ xX])\]\s+/;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (FENCE_RE.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const m = TASK_RE.exec(line);
		if (m) {
			const checked = m[2] !== " ";
			lines[i] = m[1]! + (checked ? "☑ " : "☐ ") + line.slice(m[0]!.length);
		}
	}
	return lines.join("\n");
}

export function splitMarkdownForDiscord(
	text: string,
	budget = DISCORD_MAX_MESSAGE_LEN,
): string[] {
	if (budget <= 0) throw new RangeError(`splitMarkdownForDiscord: budget must be > 0 (got ${budget})`);
	if (!text || text.trim() === "") return [];
	// Pre-split normalization. ORDER MATTERS:
	//   1. fenceTables: wrap GFM tables in ``` so subsequent passes
	//      treat their cells as code and leave them alone.
	//   2. demoteDeepHeadings: rewrite H4+ to bold before anything else
	//      inspects line shape.
	//   3. rewriteImages / rewriteTaskLists: line-local rewrites that
	//      are safe to run in any order, both fence-aware.
	//   4. neutralizeHorizontalRules: kill bare `---`/`***`/`___` HR
	//      lines that Discord renders as literal characters. Replaces
	//      with `———` (em-dashes) for a similar visual.
	let pre = fenceTables(text);
	pre = demoteDeepHeadings(pre);
	pre = rewriteImages(pre);
	pre = rewriteTaskLists(pre);
	pre = neutralizeHorizontalRules(pre);
	const lines = pre.split("\n");
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	if (lines.length === 0) return [];

	const out: string[] = [];
	let buf: string[] = [];
	let bufLen = 0; // length of `buf.join("\n")`
	/** Fence state at the START of the current `buf`. If set, flush
	 *  prepends `` ```<info>\n `` to make the chunk fence-balanced. */
	let chunkStartOpen: string | null = null;
	/** Live fence state after applying every line currently in `buf`.
	 *  If set at flush, flush appends `\n```` to close. */
	let openInfo: string | null = null;

	/** Render the current `buf` with appropriate fence wrappers, or
	 *  drop it if it would render as nothing but empty fence chrome.
	 *  After flushing, `buf` is cleared and `chunkStartOpen` resets to
	 *  the current `openInfo` (the next chunk continues from here). */
	const flush = (): void => {
		if (buf.length === 0) {
			chunkStartOpen = openInfo;
			return;
		}
		// If every buffered line is bare fence chrome (matches
		// FENCE_RE), the chunk would render as one or more empty code
		// blocks. Drop it; preserve fence state for the next chunk.
		if (buf.every(l => FENCE_RE.test(l))) {
			buf = [];
			bufLen = 0;
			chunkStartOpen = openInfo;
			return;
		}
		const body = buf.join("\n");
		const prefix = chunkStartOpen !== null ? "```" + chunkStartOpen + "\n" : "";
		const suffix = openInfo !== null ? "\n```" : "";
		out.push(prefix + body + suffix);
		buf = [];
		bufLen = 0;
		chunkStartOpen = openInfo;
	};

	/** Length the chunk WOULD render at, given current buf + live
	 *  open-fence state, including any wrappers. */
	const renderedLen = (): number => {
		if (buf.length === 0) return 0;
		const prefixLen = chunkStartOpen !== null ? 3 + chunkStartOpen.length + 1 : 0;
		const suffixLen = openInfo !== null ? CLOSE_FENCE_COST : 0;
		return prefixLen + bufLen + suffixLen;
	};

	for (const line of lines) {
		const fence = line.match(FENCE_RE);
		const prevOpenInfo: string | null = openInfo;
		const nextOpenInfo: string | null = fence
			? (openInfo === null ? fence[1] ?? "" : null)
			: openInfo;

		const joinCost = buf.length > 0 ? 1 : 0;
		const prefixLen = chunkStartOpen !== null ? 3 + chunkStartOpen.length + 1 : 0;
		const suffixLen = nextOpenInfo !== null ? CLOSE_FENCE_COST : 0;
		const tentativeLen = prefixLen + bufLen + joinCost + line.length + suffixLen;

		if (tentativeLen <= budget) {
			buf.push(line);
			bufLen += joinCost + line.length;
			openInfo = nextOpenInfo;
			continue;
		}

		// Adding `line` would bust budget. Flush the existing buf with
		// its prior fence state so the closing `` ``` `` only counts
		// against the PRIOR chunk's budget, and start a fresh chunk.
		if (buf.length > 0) {
			// At flush time we want the chunk to close based on
			// prevOpenInfo (the state BEFORE this line's fence toggle).
			// Briefly rewind `openInfo` so flush() uses the right value.
			openInfo = prevOpenInfo;
			flush();
			// After flush, chunkStartOpen = prevOpenInfo. Restore the
			// live state in preparation for processing `line`.
			openInfo = prevOpenInfo;
		}

		// Now buf is empty. Two sub-cases:
		//   a) `line` (with wrappers from chunkStartOpen + nextOpenInfo)
		//      fits in budget → push it.
		//   b) oversized → hard-split with fence wrapping.
		const newPrefixLen = chunkStartOpen !== null ? 3 + chunkStartOpen.length + 1 : 0;
		const newSuffixLen = nextOpenInfo !== null ? CLOSE_FENCE_COST : 0;
		const lineFits = newPrefixLen + line.length + newSuffixLen <= budget;
		if (lineFits) {
			buf.push(line);
			bufLen += line.length;
			openInfo = nextOpenInfo;
			continue;
		}

		// Hard-split path. If `line` is itself a fence opener/closer,
		// just toggling the fence — push it and let the next iteration
		// handle the body (the toggle should never need hard-splitting
		// because a fence line is at most a few chars).
		if (fence) {
			buf.push(line);
			bufLen += line.length;
			openInfo = nextOpenInfo;
			continue;
		}
		// Wrap each hard-split slice in `chunkStartOpen` (the active
		// fence at slice time). If chunkStartOpen is null, the line
		// lives outside any fence and hard-splits as plain text.
		hardSplitLine(out, line, budget, chunkStartOpen);
		// After hard-split the line is fully emitted; reset buf, keep
		// fence state. `nextOpenInfo === openInfo` here (fence is null
		// for this branch), so the next chunk continues the same fence.
		buf = [];
		bufLen = 0;
		chunkStartOpen = openInfo;
	}
	flush();
	return out;
}

/** Hard-split a single oversized `line` into ≤budget chunks. When
 *  `openInfo !== null`, every emitted chunk is wrapped as
 *  `` ```<info>\n<slice>\n``` `` so middle slices still render as code.
 *  Surrogate-pair safe. */
function hardSplitLine(
	out: string[],
	line: string,
	budget: number,
	openInfo: string | null,
): void {
	if (openInfo === null) {
		hardSplitPlain(out, line, budget);
		return;
	}
	const opener = "```" + openInfo + "\n";
	const closer = "\n```";
	const sliceBudget = budget - opener.length - closer.length;
	if (sliceBudget <= 0) {
		// Pathological: budget too small to wrap. Fall back to plain
		// hard-split; rendering will be wrong but at least every chunk
		// is sendable.
		hardSplitPlain(out, line, budget);
		return;
	}
	let i = 0;
	while (i < line.length) {
		let end = Math.min(i + sliceBudget, line.length);
		end = backOffSurrogate(line, end);
		out.push(opener + line.slice(i, end) + closer);
		i = end;
	}
}

/** Surrogate-pair-safe raw character hard split. */
function hardSplitPlain(out: string[], src: string, budget: number): void {
	let i = 0;
	while (i < src.length) {
		let end = Math.min(i + budget, src.length);
		end = backOffSurrogate(src, end);
		out.push(src.slice(i, end));
		i = end;
	}
}

function backOffSurrogate(src: string, end: number): number {
	if (end >= src.length) return end;
	const code = src.charCodeAt(end - 1);
	if (code >= 0xd800 && code <= 0xdbff) return end - 1;
	return end;
}
