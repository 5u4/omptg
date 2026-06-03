/**
 * DiscordStreamer tests — mirror the telegram suite but assert against a
 * stubbed `discord.js` target. The streamer goes through
 * `resolveSendTarget(client, channelId, threadId)` to obtain a channel
 * or thread; we patch the client's `channels.fetch` to return a fake
 * that records sends and edits.
 *
 * Coverage:
 *   - debounce coalescing of activity-message edits
 *   - toolEnd rewriting on error
 *   - activity-cap rollover (line + char)
 *   - finalize drains pending edits and is idempotent
 *   - commitAssistant splits long markdown on Discord's 2000-char cap
 *     (delegates to splitMarkdownForDiscord; verify multiple sends)
 */
import { describe, expect, test } from "bun:test";
import type { Client } from "discord.js";
import { DiscordStreamer } from "../src/bridge/discord/streamer.ts";
import { splitMarkdownForDiscord } from "../src/bridge/discord/markdown.ts";

interface Sent {
	content: string;
	opts?: Record<string, unknown>;
	messageId: string;
}
interface Edited {
	messageId: string;
	content: string;
}

interface FakeTarget {
	send: (payload: { content: string } & Record<string, unknown>) => Promise<{ id: string; edit: (p: { content: string }) => Promise<unknown> }>;
}

interface Stub {
	client: Client;
	channelId: string;
	sends: Sent[];
	edits: Edited[];
}

function stubClient(): Stub {
	const sends: Sent[] = [];
	const edits: Edited[] = [];
	let id = 1000;
	const channelId = "111";

	const target: FakeTarget = {
		send: async (payload) => {
			const messageId = String(++id);
			const { content, ...opts } = payload;
			sends.push({ content, opts: Object.keys(opts).length ? opts : undefined, messageId });
			return {
				id: messageId,
				edit: async (p: { content: string }) => {
					edits.push({ messageId, content: p.content });
					return undefined;
				},
			};
		},
	};

	// Minimal Channel shape: must satisfy `ch.type === ChannelType.GuildText`
	// (= 0) and expose `send`. `isThread()` returns false.
	const fakeChannel = {
		type: 0,
		isThread: () => false,
		send: target.send,
	};

	const client = {
		channels: {
			fetch: async (_id: string) => fakeChannel,
		},
	} as unknown as Client;

	return { client, channelId, sends, edits };
}

describe("DiscordStreamer activity coalescing", () => {
	test("debounce: a burst of appends collapses into one edit carrying the latest snapshot", async () => {
		const { client, channelId, sends, edits } = stubClient();
		const s = new DiscordStreamer(client, channelId, undefined);
		await s.toolStart("t1", "📖 read a.ts", "read", {});
		await s.commitPreamble("thinking out loud");
		await s.notice("🔄 retry 1/3");
		await s.toolStart("t2", "💻 bash: ls", "bash", {});
		await s.flushPending();
		expect(sends.length).toBe(1);
		expect(sends[0]!.content).toBe("📖 read a.ts");
		expect(edits.length).toBe(1);
		expect(edits[0]!.messageId).toBe(sends[0]!.messageId);
		expect(edits[0]!.content).toBe(
			"📖 read a.ts\n💭 thinking out loud\n🔄 retry 1/3\n💻 bash: ls",
		);
	});

	test("toolEnd on success leaves the original tool-start line unchanged", async () => {
		const { client, channelId, sends, edits } = stubClient();
		const s = new DiscordStreamer(client, channelId, undefined);
		await s.toolStart("t1", "📖 read a.ts", "read", {});
		await s.toolStart("t2", "💻 bash: ls", "bash", {});
		await s.toolEnd("t1", false, undefined, "read", {});
		await s.flushPending();
		expect(sends.length).toBe(1);
		expect(edits[edits.length - 1]!.content).toBe("📖 read a.ts\n💻 bash: ls");
	});

	test("toolEnd with error uses errorLine in place", async () => {
		const { client, channelId, edits } = stubClient();
		const s = new DiscordStreamer(client, channelId, undefined);
		await s.toolStart("t1", "📖 read a.ts", "read", {});
		await s.toolEnd("t1", true, "❌ read failed: ENOENT", "read", undefined);
		await s.flushPending();
		expect(edits[edits.length - 1]!.content).toBe("❌ read failed: ENOENT");
	});

	test("toolEnd error without errorLine rewrites leading emoji to ❌", async () => {
		const { client, channelId, edits } = stubClient();
		const s = new DiscordStreamer(client, channelId, undefined);
		await s.toolStart("t1", "📖 read a.ts", "read", {});
		await s.toolEnd("t1", true, undefined, "read", undefined);
		await s.flushPending();
		expect(edits[edits.length - 1]!.content).toBe("❌ read a.ts");
	});

	test("toolEnd can rewrite a tool line on a sealed (predecessor) host", async () => {
		const { client, channelId, sends, edits } = stubClient();
		const s = new DiscordStreamer(client, channelId, undefined);
		// Fill the first activity message to the line cap, then add one
		// more which seals it and opens a fresh host.
		for (let i = 0; i < 20; i++) await s.toolStart(`t${i}`, `📖 read f${i}.ts`, "read", {});
		expect(sends.length).toBe(1);
		await s.toolStart("t20", "📖 read f20.ts", "read", {});
		expect(sends.length).toBe(2);
		// Rewrite a line on the SEALED first host.
		await s.toolEnd("t0", true, "❌ read failed: ENOENT", "read", undefined);
		await s.flushPending();
		const firstHostEdits = edits.filter(e => e.messageId === sends[0]!.messageId);
		expect(firstHostEdits.length).toBeGreaterThan(0);
		const last = firstHostEdits[firstHostEdits.length - 1]!;
		expect(last.content.startsWith("❌ read failed: ENOENT\n")).toBe(true);
	});

	test("seals and opens a new activity message when line cap is reached", async () => {
		const { client, channelId, sends } = stubClient();
		const s = new DiscordStreamer(client, channelId, undefined);
		for (let i = 0; i < 20; i++) await s.toolStart(`t${i}`, `📖 read f${i}.ts`, "read", {});
		expect(sends.length).toBe(1);
		await s.toolStart("t20", "📖 read f20.ts", "read", {});
		expect(sends.length).toBe(2);
		expect(sends[1]!.content).toBe("📖 read f20.ts");
	});

	test("seals when char cap would overflow, fresh message starts with the overflowing line", async () => {
		const { client, channelId, sends } = stubClient();
		const s = new DiscordStreamer(client, channelId, undefined);
		// 1800-char cap. Three 500-char lines (+joins = 1502) fit; a fourth tips it.
		const big = "x".repeat(500);
		await s.toolStart("a", big, "read", {});
		await s.toolStart("b", big, "read", {});
		await s.toolStart("c", big, "read", {});
		expect(sends.length).toBe(1);
		await s.toolStart("d", big, "read", {});
		expect(sends.length).toBe(2);
		expect(sends[1]!.content).toBe(big);
	});

	test("finalize drains pending edits and is idempotent", async () => {
		const { client, channelId, sends, edits } = stubClient();
		const s = new DiscordStreamer(client, channelId, undefined);
		await s.toolStart("t1", "📖 read a.ts", "read", {});
		await s.toolStart("t2", "💻 bash: ls", "bash", {});
		await s.finalize();
		await s.finalize();
		expect(edits.length).toBe(1);
		expect(edits[0]!.content).toBe("📖 read a.ts\n💻 bash: ls");
		expect(sends.length).toBe(1);
	});
});

describe("DiscordStreamer commitAssistant", () => {
	test("splits long markdown into multiple sends, first carries the reply anchor", async () => {
		const { client, channelId, sends } = stubClient();
		const s = new DiscordStreamer(client, channelId, undefined, "999");
		// Build a 3-chunk message: 3 paragraphs of 900 chars each
		// (well over the 2000 cap).
		const para = (n: number) => `paragraph ${n}: ` + "x".repeat(900);
		const text = [para(1), para(2), para(3)].join("\n\n");
		await s.commitAssistant(text);
		const chunks = splitMarkdownForDiscord(text);
		expect(chunks.length).toBeGreaterThan(1);
		expect(sends.length).toBe(chunks.length);
		// First send has reply anchor; subsequent sends do not.
		expect(sends[0]!.opts?.reply).toEqual({
			messageReference: "999",
			failIfNotExists: false,
		});
		for (let i = 1; i < sends.length; i++) {
			expect(sends[i]!.opts?.reply).toBeUndefined();
		}
		// All chunks together reconstruct (modulo split insertions).
		for (let i = 0; i < chunks.length; i++) {
			expect(sends[i]!.content).toBe(chunks[i]!);
		}
	});

	test("commitAssistant no-op on empty text", async () => {
		const { client, channelId, sends } = stubClient();
		const s = new DiscordStreamer(client, channelId, undefined);
		await s.commitAssistant("   \n  ");
		expect(sends.length).toBe(0);
	});

	test("commitAssistant after finalize is dropped", async () => {
		const { client, channelId, sends } = stubClient();
		const s = new DiscordStreamer(client, channelId, undefined);
		await s.finalize();
		await s.commitAssistant("hi");
		expect(sends.length).toBe(0);
	});
});

describe("DiscordStreamer replaceWith", () => {
	test("cancels pending activity edits and posts the error body", async () => {
		const { client, channelId, sends, edits } = stubClient();
		const s = new DiscordStreamer(client, channelId, undefined);
		await s.toolStart("t1", "📖 read a.ts", "read", {});
		// Don't flush — there's a pending debounced edit.
		await s.replaceWith("fatal: agent crashed");
		// The activity message was sent (initial open), but the debounced
		// edit was cancelled — no edit observed.
		expect(sends.some(s => s.content === "📖 read a.ts")).toBe(true);
		expect(sends.some(s => s.content === "fatal: agent crashed")).toBe(true);
		expect(edits.length).toBe(0);
	});
});

describe("splitMarkdownForDiscord", () => {
	test("short single-line input returns one chunk", () => {
		expect(splitMarkdownForDiscord("hello")).toEqual(["hello"]);
	});

	test("text exactly at the cap stays one chunk", () => {
		const s = "x".repeat(2000);
		expect(splitMarkdownForDiscord(s)).toEqual([s]);
	});

	test("text over the cap splits on a line boundary", () => {
		const lines: string[] = [];
		for (let i = 0; i < 100; i++) lines.push("line " + i + " " + "x".repeat(50));
		const text = lines.join("\n");
		const out = splitMarkdownForDiscord(text);
		expect(out.length).toBeGreaterThan(1);
		for (const c of out) expect(c.length).toBeLessThanOrEqual(2000);
		// Reassembly preserves all lines.
		expect(out.join("\n")).toBe(text);
	});

	test("fenced code block straddling a split closes and reopens with the info string", () => {
		// Force a split inside a typescript fence.
		const body = "x".repeat(1900);
		const text = "```ts\n" + body + "\nmore body line\n```";
		const out = splitMarkdownForDiscord(text, 1000);
		expect(out.length).toBeGreaterThan(1);
		// First chunk ends with a closing ```.
		expect(out[0]!.endsWith("\n```")).toBe(true);
		// Second chunk starts with the reopener carrying the info string.
		expect(out[1]!.startsWith("```ts\n")).toBe(true);
		// Final chunk still ends with the original closing fence.
		expect(out[out.length - 1]!.endsWith("\n```")).toBe(true);
	});

	test("oversized single line is hard-split to fit budget (regression)", () => {
		const s = "x".repeat(3000);
		const out = splitMarkdownForDiscord(s);
		expect(out.length).toBeGreaterThan(1);
		for (const c of out) expect(c.length).toBeLessThanOrEqual(2000);
		expect(out.join("")).toBe(s);
	});

	test("oversized line inside a fence wraps every hard-split slice as code", () => {
		const body = "y".repeat(3000);
		const text = "```ts\n" + body + "\n```";
		const out = splitMarkdownForDiscord(text, 2000);
		expect(out.length).toBeGreaterThan(1);
		for (const c of out) expect(c.length).toBeLessThanOrEqual(2000);
		// Every middle chunk that holds body content must be a balanced
		// `` ```ts\n…\n``` `` block — Discord otherwise renders it as prose.
		for (const c of out) {
			if (c.includes("y")) {
				expect(c.startsWith("```ts\n")).toBe(true);
				expect(c.endsWith("\n```")).toBe(true);
			}
		}
		// Reassembled body characters round-trip.
		const recovered = out
			.map(c => c.replace(/^```ts\n/, "").replace(/\n```$/, ""))
			.join("");
		expect(recovered.replace(/```ts\n```/g, "")).toContain(body);
	});

	test("splitter never emits empty / fence-only chunks", () => {
		const body = "z".repeat(3000);
		// Cases: fence opener followed by oversized body and closer;
		// budget too small to keep opener with body in one chunk.
		const cases: { text: string; budget: number }[] = [
			{ text: "```ts\n" + body + "\n```", budget: 2000 },
			{ text: "```\n" + body + "\n```", budget: 1000 },
			{ text: "```ts\n" + body + "\n```\ntrailer", budget: 1500 },
		];
		for (const { text, budget } of cases) {
			const out = splitMarkdownForDiscord(text, budget);
			expect(out.length).toBeGreaterThan(0);
			for (const c of out) {
				expect(c).not.toBe("```");
				// Empty fenced block: opener + immediate closer with no body
				// content. Any chunk where every line is bare fence chrome
				// would render as a visible empty code block to the user.
				expect(/^```[^\n]*\n```$/.test(c)).toBe(false);
				expect(c.length).toBeGreaterThan(0);
			}
		}
	});

	test("budget <= 0 throws RangeError instead of looping", () => {
		expect(() => splitMarkdownForDiscord("hello", 0)).toThrow(RangeError);
		expect(() => splitMarkdownForDiscord("hello", -10)).toThrow(RangeError);
	});

	test("empty input returns no chunks", () => {
		expect(splitMarkdownForDiscord("")).toEqual([]);
		expect(splitMarkdownForDiscord("   \n  ")).toEqual([]);
	});
});

describe("DiscordStreamer mention safety + target caching", () => {
	test("every send carries allowedMentions = { parse: [], repliedUser: false }", async () => {
		const { client, channelId, sends } = stubClient();
		const s = new DiscordStreamer(client, channelId, undefined, "999");
		// Activity send (initial open) + commitAssistant send.
		await s.toolStart("t1", "📖 read a.ts", "read", {});
		await s.commitAssistant("@everyone hi");
		expect(sends.length).toBeGreaterThanOrEqual(2);
		for (const sent of sends) {
			expect(sent.opts?.allowedMentions).toEqual({ parse: [], repliedUser: false });
		}
	});

	test("replaceWith body also carries allowedMentions", async () => {
		const { client, channelId, sends } = stubClient();
		const s = new DiscordStreamer(client, channelId, undefined);
		await s.replaceWith("fatal: @here something broke");
		const errorSend = sends.find(x => x.content === "fatal: @here something broke");
		expect(errorSend).toBeDefined();
		expect(errorSend!.opts?.allowedMentions).toEqual({ parse: [], repliedUser: false });
	});

	test("a failed channel fetch is not cached; subsequent sends retry the fetch", async () => {
		const sends: Sent[] = [];
		let fetchCalls = 0;
		const target: FakeTarget = {
			send: async (payload) => {
				const messageId = String(++fetchCalls + 1000);
				const { content, ...opts } = payload;
				sends.push({ content, opts: Object.keys(opts).length ? opts : undefined, messageId });
				return { id: messageId, edit: async () => undefined };
			},
		};
		const fakeChannel = { type: 0, isThread: () => false, send: target.send };
		const client = {
			channels: {
				fetch: async (_id: string) => {
					fetchCalls++;
					if (fetchCalls === 1) throw new Error("transient gateway error");
					return fakeChannel;
				},
			},
		} as unknown as Client;

		const s = new DiscordStreamer(client, "111", undefined);
		// First send fails at the resolve step; nothing in `sends`.
		await s.commitAssistant("first try");
		expect(sends.length).toBe(0);
		// Second send must retry the channel fetch (poisoned cache would
		// reuse the rejected promise and never call send).
		await s.commitAssistant("second try");
		expect(sends.some(x => x.content === "second try")).toBe(true);
	});
});
