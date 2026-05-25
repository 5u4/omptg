/**
 * Smoke for formatReplyPrompt.
 *   bun run src/smoke-quote.ts
 */
import { formatReplyPrompt, formatForwardPrompt } from "./quote.ts";

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

// 6. Forward from known user.
{
	const out = formatForwardPrompt(
		{ kind: "user", name: "alice", date: 0, text: "look at this bug" },
		"",
	);
	assert(out === "> [forwarded from user alice]\n> look at this bug",
		`unexpected: ${out}`);
	console.log("✓ forward from user, no extra text");
}

// 7. Forward from channel with user caption appended.
{
	const out = formatForwardPrompt(
		{ kind: "channel", name: "TheChannel", date: 0, text: "breaking news" },
		"thoughts?",
	);
	assert(out === "> [forwarded from channel TheChannel]\n> breaking news\n\nthoughts?",
		`unexpected: ${out}`);
	console.log("✓ forward from channel + user caption");
}

// 8. Forward from hidden_user with empty body.
{
	const out = formatForwardPrompt(
		{ kind: "hidden_user", name: "anon", date: 0, text: "" },
		"",
	);
	assert(out === "> [forwarded from hidden_user anon]", `unexpected: ${out}`);
	console.log("✓ forward hidden_user empty body → header only");
}

console.log("all quote smokes OK");
