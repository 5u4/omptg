import { describe, expect, test } from "bun:test";
import { formatForwardPrompt, formatReplyPrompt } from "../src/quote.ts";

describe("formatReplyPrompt", () => {
	test("bot reply tagged + quoted", () => {
		const out = formatReplyPrompt(
			{ author: "you", fromBot: true, text: "I'll read foo.ts then edit bar.ts" },
			"actually edit baz.ts instead",
		);
		expect(out.startsWith("> [replying to bot you]\n")).toBe(true);
		expect(out).toContain("\n> I'll read foo.ts");
		expect(out.endsWith("\n\nactually edit baz.ts instead")).toBe(true);
	});

	test("user reply tagged with display name", () => {
		const out = formatReplyPrompt(
			{ author: "sen", fromBot: false, text: "first message" },
			"second",
		);
		expect(out.startsWith("> [replying to user sen]\n")).toBe(true);
		expect(out).toContain("\n> first message");
	});

	test("multiline quote prefixes every line", () => {
		const out = formatReplyPrompt(
			{ author: "you", fromBot: true, text: "line one\nline two\nline three" },
			"ok",
		);
		const quotedLines = out.split("\n\n")[0]!.split("\n");
		expect(quotedLines).toHaveLength(4);
		for (const l of quotedLines) expect(l.startsWith("> ")).toBe(true);
	});

	test("long quote truncates with ellipsis", () => {
		const long = "x".repeat(2000);
		const out = formatReplyPrompt(
			{ author: "you", fromBot: true, text: long },
			"…",
			800,
		);
		const quoted = out.split("\n\n")[0]!;
		expect(quoted.includes("…\n") || quoted.endsWith("…")).toBe(true);
		expect(quoted.length).toBeLessThan(long.length + 200);
	});

	test("empty replied-to text → header only", () => {
		const out = formatReplyPrompt(
			{ author: "you", fromBot: true, text: "" },
			"hello",
		);
		expect(out).toBe("> [replying to bot you]\n\nhello");
	});
});

describe("formatForwardPrompt", () => {
	test("forward from known user, no extra text", () => {
		const out = formatForwardPrompt(
			{ kind: "user", name: "alice", date: 0, text: "look at this bug" },
			"",
		);
		expect(out).toBe("> [forwarded from user alice]\n> look at this bug");
	});

	test("forward from channel with user caption appended", () => {
		const out = formatForwardPrompt(
			{ kind: "channel", name: "TheChannel", date: 0, text: "breaking news" },
			"thoughts?",
		);
		expect(out).toBe(
			"> [forwarded from channel TheChannel]\n> breaking news\n\nthoughts?",
		);
	});

	test("forward from hidden_user with empty body → header only", () => {
		const out = formatForwardPrompt(
			{ kind: "hidden_user", name: "anon", date: 0, text: "" },
			"",
		);
		expect(out).toBe("> [forwarded from hidden_user anon]");
	});
});
