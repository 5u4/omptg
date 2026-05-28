import { describe, expect, test } from "bun:test";
import { splitMarkdownForTelegram } from "../src/markdown.ts";

describe("splitMarkdownForTelegram", () => {
	test("neutralizes `---` horizontal rule (Telegram rejects raw `-`)", () => {
		const chunks = splitMarkdownForTelegram("foo\n\n---\n\nbar");
		const chunk = chunks[0]!;
		expect(chunk.md).not.toContain("---");
		expect(chunk.md).toContain("———");
	});

	test("also neutralizes `***` and `___` HRs", () => {
		const a = splitMarkdownForTelegram("a\n\n***\n\nb")[0]!.md;
		const b = splitMarkdownForTelegram("a\n\n___\n\nb")[0]!.md;
		expect(a).not.toMatch(/\*\*\*/);
		expect(b).not.toMatch(/___/);
		expect(a).toContain("———");
		expect(b).toContain("———");
	});

	test("leaves list items (`- item`) alone", () => {
		const md = splitMarkdownForTelegram("- one\n- two\n- three")[0]!.md;
		// telegramify renders list bullets with a bullet glyph
		expect(md).toContain("one");
		expect(md).toContain("two");
		expect(md).not.toContain("———");
	});

	test("escapes inline `-` so Telegram accepts the MarkdownV2", () => {
		const md = splitMarkdownForTelegram("ui-bridge.ts is a file")[0]!.md;
		expect(md).toContain("\\-");
	});

	test("escapes inline `.` so Telegram accepts the MarkdownV2", () => {
		const md = splitMarkdownForTelegram("see section 3.1 below")[0]!.md;
		expect(md).toContain("\\.");
	});

	test("wraps GFM tables in code fences (Telegram can't render tables)", () => {
		const src = "| a | b |\n| --- | --- |\n| 1 | 2 |";
		const chunks = splitMarkdownForTelegram(src);
		const chunk = chunks[0]!;
		expect(chunk.md).toContain("```");
		expect(chunk.md).toContain("| a | b |");
	});

	test("splits long input at newline boundary", () => {
		const para = "x".repeat(100);
		const src = Array(60).fill(para).join("\n\n");
		const chunks = splitMarkdownForTelegram(src);
		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) expect(c.md.length).toBeLessThanOrEqual(4096);
	});

	test("rewrites # / ## / ### to visually-distinct bold/italic markers", () => {
		const src = "# Big\n\n## Section\n\n### Subsection\n\n#### Deeper";
		const md = splitMarkdownForTelegram(src)[0]!.md;
		expect(md).toContain("*━━━ Big ━━━*");
		expect(md).toContain("*▸ Section*");
		expect(md).toContain("_Subsection_");
		expect(md).toContain("_Deeper_");
		expect(md.split("\n").every(l => !/^#{1,6}\s/.test(l))).toBe(true);
	});

	test("leaves `#` lines inside fenced code blocks alone", () => {
		const src = "```sh\n# shell comment\necho hi\n```";
		const md = splitMarkdownForTelegram(src)[0]!.md;
		expect(md).toContain("# shell comment");
		expect(md).not.toContain("━━━");
		expect(md).not.toContain("▸");
	});

	test("heading rewrite ignores `#` mid-line (not a heading)", () => {
		const md = splitMarkdownForTelegram("see issue #42 for context")[0]!.md;
		expect(md).toContain("#42");
		expect(md).not.toContain("━━━");
	});

	test("flattens GFM double-backtick spans that telegram can't parse", () => {
		// Regression: my own message dogfooded a `` ``- `priority`: 0-3 `` `` —
		// GFM double-backtick form for embedding a literal `. telegramify-markdown
		// preserves it verbatim, but telegram treats each ` independently,
		// turning the outer `` `` into empty code entities and exposing the
		// bare `-` to MarkdownV2's reserved-char rule. Output: HTTP 400.
		const src = "the snippet ``- `priority`: 0-3 `` lives there";
		const md = splitMarkdownForTelegram(src)[0]!.md;
		// Inner-emphasis backticks gone; single inline-code span survives.
		expect(md).not.toMatch(/``/);
		// We preserve inner whitespace verbatim (no normalize/trim) so any
		// alignment the author intended survives. The original source has
		// no leading/trailing space inside the `` `` `` span, so the
		// rewrite keeps the dash adjacent to the open delimiter.
		// Must be inside a single-backtick inline-code span. Without the
		// backtick anchors a future regression where the neutralizer
		// loses its wrapping (and telegramify escapes the `-` outside
		// code) would still pass `toContain("priority: 0-3")`.
		expect(md).toMatch(/`[^`]*priority: 0-3[^`]*`/);
	});

	test("flattens minimal `` x `` spans (telegramify already handles these but check pipeline)", () => {
		const md = splitMarkdownForTelegram("call ``foo`` here")[0]!.md;
		expect(md).not.toMatch(/``/);
		expect(md).toContain("`foo`");
	});

	test("leaves triple-backtick fenced blocks untouched (only inline `` `` neutralized)", () => {
		const src = "```ts\nconst x = `` ``;\n```";
		const md = splitMarkdownForTelegram(src)[0]!.md;
		// Inside a fence, the double-backticks are literal code content.
		expect(md).toContain("``");
	});

	test("does NOT touch double-backticks inside a GFM table cell (fenceTables wraps the table first)", () => {
		// Regression: original implementation ran neutralizeDoubleBackticks
		// BEFORE fenceTables, so a `` ``x`` `` inside a table cell would
		// be flattened to `` `x` `` and then the whole table got fenced
		// — the in-cell literal was silently rewritten. After reorder
		// (fenceTables → neutralizeDoubleBackticks), the table content is
		// already inside a triple-backtick block when the neutralizer
		// runs, so its fence tracker skips it and the cell stays literal.
		const src = [
			"| name | code |",
			"| --- | --- |",
			"| foo | ``literal`` |",
		].join("\n");
		const md = splitMarkdownForTelegram(src)[0]!.md;
		// Inside the fence telegramify escapes backticks for safety, so
		// the literal `` `` `` come through as `\`\``. What matters is
		// the neutralizer did NOT collapse them to a single backtick —
		// if it had run, we'd see `\`literal\`` (one pair). The double
		// pair surviving is the proof that fenceTables ran first and
		// the neutralizer skipped the now-fenced content.
		expect(md).toMatch(/\\`\\`literal\\`\\`/);
	});

	test("preserves multi-space alignment inside flattened double-backtick spans", () => {
		// Regression: original implementation called replace(/  +/g, ' ')
		// and trimmed, which silently rewrote any code span that relied
		// on multiple spaces for alignment / fixed-width formatting.
		const src = "look ``foo   bar`` here";
		const md = splitMarkdownForTelegram(src)[0]!.md;
		// At least 3 spaces survive between `foo` and `bar` (telegramify
		// may not add escapes inside code, so the literal is verbatim).
		expect(md).toMatch(/foo {3,}bar/);
	});

	test("neutralizeDoubleBackticks does NOT collapse an all-space span to empty code", () => {
		// Regression: edge-space rule used to fire unconditionally. A
		// `` `` `` (two literal spaces) would become "" → output `` ``
		// (two adjacent backticks = empty code entity) — the exact
		// failure mode the neutralizer exists to prevent.
		const src = "blank ``  `` here";
		const md = splitMarkdownForTelegram(src)[0]!.md;
		// At minimum: no two-in-a-row backticks in the output.
		expect(md).not.toMatch(/``/);
	});

	test("neutralizeHorizontalRules skips `---` inside fenced code blocks", () => {
		// Regression: HR neutralizer was line-by-line without fence
		// tracking, so a fenced snippet showing a literal `---` would
		// have its content silently rewritten to `———`. Telegram accepts
		// `---` inside a fence (chars are code content, not parsed as
		// reserved), so the rewrite was both unnecessary and lossy.
		const src = "```\n---\n```";
		const md = splitMarkdownForTelegram(src)[0]!.md;
		expect(md).toContain("---");
		expect(md).not.toContain("———");
	});


	test("neutralizes inline code containing only `\\` (would eat closing backtick)", () => {
		// Regression: an inline `` `\` `` span reaches Telegram as
		// "` \ `" where the backslash escapes the closing backtick →
		// span never closes → entity offsets shift → HTTP 400. We
		// replace `\` with U+FF3C inside spans so the codepoint stays
		// visually equivalent but parser-inert.
		const src = "see `\\` for details";
		const md = splitMarkdownForTelegram(src)[0]!.md;
		expect(md).not.toMatch(/`\\`/);
		expect(md).toContain("\uFF3C");
	});

	test("flattens 4-backtick spans (CommonMark allows runs of any length)", () => {
		// Regression: original regex only matched exactly two
		// backticks, leaving GFM `` ```` ` ```` `` (4 outer, 1 inner)
		// untouched. telegramify-markdown then preserved them and
		// telegram parsed each backtick independently.
		const src = "use ```` ` ```` to embed a backtick";
		const md = splitMarkdownForTelegram(src)[0]!.md;
		// No run of ≥2 backticks survives.
		expect(md).not.toMatch(/``+/);
	});

	test("does NOT treat CommonMark-escaped backticks (`\\``) as span delimiters", () => {
		// Regression: a backslash-escaped backtick is literal text per
		// CommonMark and must not open or close a code span. Without
		// the (?<!\\) lookbehind, input like \`literal\` was rewritten
		// as a span and the closing escape became U+FF3C.
		const src = "literal \\`foo\\` here";
		const md = splitMarkdownForTelegram(src)[0]!.md;
		// The word "foo" survives without being wrapped in real
		// backticks (telegramify will escape the source backticks).
		expect(md).not.toMatch(/`foo`/);
		// And no fullwidth backslash leaks into the escape sequence.
		expect(md).not.toContain("\uFF3C");
	});

	test("correctly classifies 3-backslash run before backtick as escaped", () => {
		// Regression for the fixed-window lookbehind: 3 (or any odd N ≥ 3)
		// consecutive backslashes before a backtick still escape it per
		// CommonMark (pairs become escaped backslashes, the last `\`
		// escapes the backtick). The match callback now counts the full
		// run instead of peeking only 2 chars back.
		const src = "literal \\\\\\`foo\\\\\\` here";
		const md = splitMarkdownForTelegram(src)[0]!.md;
		expect(md).not.toMatch(/`foo`/);
		expect(md).not.toContain("\uFF3C");
	});
});
