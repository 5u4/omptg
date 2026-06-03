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

/** Discord per-message hard cap. */
export const DISCORD_MAX_MESSAGE_LEN = 2000;

/** Match a line that opens or closes a fenced code block. */
const FENCE_RE = /^ {0,3}```(.*)$/;
/** Closing-fence overhead added at flush time when a chunk leaves a
 *  fence open: `"\n```"` = 4 chars. */
const CLOSE_FENCE_COST = 4;
/** Opening-fence chrome added to a reopening chunk: `"```<info>\n"` —
 *  the variable info-string length is added by callers. */
const OPEN_FENCE_PREFIX_FIXED = 4; // `"```" + "\n"`

/**
 * Split `text` into chunks of at most `budget` characters, preserving
 * fenced code blocks across boundaries by closing/reopening the fence.
 */
export function splitMarkdownForDiscord(
	text: string,
	budget = DISCORD_MAX_MESSAGE_LEN,
): string[] {
	if (!text || text.trim() === "") return [];
	const lines = text.split("\n");
	// Drop a trailing empty line caused by a final "\n"; preserve
	// in-fence whitespace exactly.
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	if (lines.length === 0) return [];

	const out: string[] = [];
	let buf: string[] = [];
	let bufLen = 0; // length of `buf.join("\n")`
	let openInfo: string | null = null;

	const flush = (carryOpen: boolean): void => {
		if (buf.length === 0) return;
		let chunk = buf.join("\n");
		if (carryOpen && openInfo !== null) chunk += "\n```";
		out.push(chunk);
		buf = [];
		bufLen = 0;
	};

	for (const line of lines) {
		const prevOpenInfo: string | null = openInfo;
		const fence = line.match(FENCE_RE);
		if (fence) openInfo = openInfo === null ? fence[1] ?? "" : null;

		const joinCost = buf.length > 0 ? 1 : 0;
		const closeAfter = openInfo !== null ? CLOSE_FENCE_COST : 0;
		const tentativeLen = bufLen + joinCost + line.length + closeAfter;

		if (tentativeLen <= budget) {
			buf.push(line);
			bufLen += joinCost + line.length;
			continue;
		}

		// Adding `line` busts budget. If `buf` has content, flush it and
		// start a fresh chunk carrying the prior fence state.
		if (buf.length > 0) {
			openInfo = prevOpenInfo;
			flush(prevOpenInfo !== null);
			if (prevOpenInfo !== null) {
				const reopener = "```" + prevOpenInfo;
				buf.push(reopener);
				bufLen += reopener.length;
			}
			// Re-apply this line's fence effect for the fresh chunk.
			if (fence) openInfo = openInfo === null ? fence[1] ?? "" : null;
		}
		// `buf` may be empty (fresh chunk) or hold just the reopener.
		// Two sub-cases:
		//   a) `line` fits in what's left of the budget → push and continue.
		//   b) `line` is single-line oversized → emit the buffered prefix
		//      (if any) as its own chunk, then hard-split `line` with
		//      fence wrapping on every slice.
		const joinCost2 = buf.length > 0 ? 1 : 0;
		const closeAfter2 = openInfo !== null ? CLOSE_FENCE_COST : 0;
		const lineFits = bufLen + joinCost2 + line.length + closeAfter2 <= budget;
		if (lineFits) {
			buf.push(line);
			bufLen += joinCost2 + line.length;
			continue;
		}

		// Hard-split path. Emit the buffered reopener (if any) as a
		// standalone, fence-balanced chunk so the hard-split can start
		// fresh.
		if (buf.length > 0) flush(openInfo !== null);
		hardSplitLine(out, line, budget, openInfo);
	}
	flush(false);
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
