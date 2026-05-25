/**
 * Smoke for formatReplyPrompt.
 *   bun run src/smoke-quote.ts
 */
import { formatReplyPrompt } from "./quote.ts";

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`assert: ${msg}`);
}

// 1. Bot reply: tagged "bot" + author "you".
{
	const out = formatReplyPrompt(
		{ author: "you", fromBot: true, text: "I'll read foo.ts then edit bar.ts" },
		"actually edit baz.ts instead",
	);
	assert(out.startsWith("> [replying to bot you]\n"), `head wrong: ${out}`);
	assert(out.includes("\n> I'll read foo.ts"), "quoted body missing");
	assert(out.endsWith("\n\nactually edit baz.ts instead"), `tail wrong: ${out}`);
	console.log("✓ bot reply tagged + quoted");
}

// 2. User reply: tagged "user" + author display name.
{
	const out = formatReplyPrompt(
		{ author: "sen", fromBot: false, text: "first message" },
		"second",
	);
	assert(out.startsWith("> [replying to user sen]\n"), `head wrong: ${out}`);
	assert(out.includes("\n> first message"), "quoted body missing");
	console.log("✓ user reply tagged");
}

// 3. Multiline quote: every line prefixed with `> `.
{
	const out = formatReplyPrompt(
		{ author: "you", fromBot: true, text: "line one\nline two\nline three" },
		"ok",
	);
	const quotedLines = out.split("\n\n")[0]!.split("\n");
	assert(quotedLines.length === 4, `expected 4 quoted lines, got ${quotedLines.length}`);
	for (const l of quotedLines) assert(l.startsWith("> "), `unquoted line: ${l}`);
	console.log("✓ multiline quote prefixed per-line");
}

// 4. Long quote truncates with ellipsis at maxQuoteChars.
{
	const long = "x".repeat(2000);
	const out = formatReplyPrompt(
		{ author: "you", fromBot: true, text: long },
		"…",
		800,
	);
	const quoted = out.split("\n\n")[0]!;
	assert(quoted.includes("…\n") || quoted.endsWith("…"), "ellipsis missing");
	assert(quoted.length < long.length + 200, `quote not truncated: ${quoted.length}`);
	console.log("✓ long quote truncates");
}

// 5. Empty replied-to text: header only, no quoted body.
{
	const out = formatReplyPrompt(
		{ author: "you", fromBot: true, text: "" },
		"hello",
	);
	assert(out === "> [replying to bot you]\n\nhello", `unexpected: ${out}`);
	console.log("✓ empty quote → header only");
}

console.log("all quote smokes OK");
