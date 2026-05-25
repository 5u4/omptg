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
});
