/**
 * Smoke for src/markdown.ts: splitMarkdownForTelegram + fence handling.
 *   bun run src/smoke-markdown.ts
 */
import { splitMarkdownForTelegram, toMarkdownV2 } from "./markdown.ts";

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`assert: ${msg}`);
}

// 1. Short text: one chunk, special chars escaped, bold preserved.
{
	const src = "Hello **world** with 1+1=2 and a `code` span.";
	const out = splitMarkdownForTelegram(src);
	assert(out.length === 1, `expected 1 chunk, got ${out.length}`);
	assert(out[0]!.md.includes("*world*"), `bold not converted: ${out[0]}`);
	assert(out[0]!.md.includes("\\+"), `'+' not escaped: ${out[0]}`);
	assert(out[0]!.md.includes("\\="), `'=' not escaped: ${out[0]}`);
	assert(out[0]!.md.includes("`code`"), `code span lost: ${out[0]}`);
	console.log("✓ short markdown → escaped MarkdownV2");
}

// 2. Fenced code block stays in one chunk when it fits.
{
	const src = "Before\n```ts\nconst x = 1;\nconst y = 2;\n```\nAfter";
	const out = splitMarkdownForTelegram(src);
	assert(out.length === 1, `should fit in 1 chunk, got ${out.length}`);
	assert(out[0]!.md.includes("```"), `fence opener missing: ${out[0]}`);
	assert(out[0]!.md.includes("const x = 1;"), `code body lost`);
	console.log("✓ fenced code preserved when it fits");
}

// 3. Code fence spans a chunk boundary → split closes + reopens the fence.
{
	// Build a long code block that forces a split mid-fence.
	const body = Array.from({ length: 500 }, (_, i) => `line ${i} = ${i * 2};`).join("\n");
	const src = `Intro paragraph.\n\n\`\`\`ts\n${body}\n\`\`\`\n\nOutro paragraph.`;
	const out = splitMarkdownForTelegram(src, 2000);
	assert(out.length >= 2, `should split, got ${out.length}`);
	for (const chunk of out) {
		assert(chunk.md.length <= 2000, `chunk too big: ${chunk.md.length}`);
		// Each chunk's fence count must be even (balanced) — telegram
		// rejects unterminated entities.
		const fences = (chunk.md.match(/```/g) ?? []).length;
		assert(fences % 2 === 0, `unbalanced fences in chunk: ${fences}`);
	}
	console.log(`✓ long fenced code split into ${out.length} balanced chunks`);
}

// 4. Lists + links + headers round-trip into MarkdownV2.
{
	const src = "# Header\n\n* item one\n* item two\n\n[link](https://example.com)";
	const out = splitMarkdownForTelegram(src);
	assert(out.length === 1, "header+list+link should fit in one chunk");
	assert(out[0]!.md.includes("*Header*"), `header missing: ${out[0]}`);
	assert(out[0]!.md.includes("[link]("), `link missing: ${out[0]}`);
	assert(out[0]!.md.includes("https://example\\.com") || out[0]!.md.includes("https://example.com"),
		`link target wrong: ${out[0]}`);
	console.log("✓ headers + lists + links converted");
}

// 5. toMarkdownV2 round-trips bare text.
{
	const out = toMarkdownV2("just text.");
	assert(out !== undefined && out.includes("just text\\."), `unexpected: ${out}`);
	console.log("✓ toMarkdownV2 escapes period");
}

// 6. GFM tables get wrapped in fenced code blocks so telegram doesn't
//    try to parse raw `|` characters as entity delimiters.
{
	const src = "Intro\n\n| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nOutro";
	const out = splitMarkdownForTelegram(src);
	assert(out.length === 1, "should fit one chunk");
	const md = out[0]!.md;
	// The table lines must be inside ``` ... ```. After wrapping, the
	// pipe characters MUST NOT be escaped (\|) because they're now in
	// a code block.
	assert(md.includes("```"), "expected fence around table");
	assert(!md.includes("\\|"), `pipes leaked outside code block: ${md}`);
	// Header row should still be visible as monospace text.
	assert(md.includes("| A"), `header row missing: ${md}`);
	// Fence count is even (balanced).
	const fences = (md.match(/```/g) ?? []).length;
	assert(fences % 2 === 0, `unbalanced fences: ${fences}`);
	console.log("✓ tables wrapped in fences, pipes not escaped");
}

console.log("all markdown smokes OK");
