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
		expect(md).toContain("`- priority: 0-3`");
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

});
