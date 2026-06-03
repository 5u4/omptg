/**
 * DiscordUI tests — assert the four interactive primitives (select,
 * confirm, input, editor) post the right components, resolve the
 * pending promise on a synthetic interaction, and finalize the carrier.
 *
 * Discord.js is stubbed enough to satisfy resolveSendTarget's needs:
 * a client with channels.fetch → a TextChannel-shaped target exposing
 * send() and messages.fetch(). The latter returns a record whose edit()
 * captures the carrier rewrite so we can assert the "✅ … → choice"
 * cleanup landed.
 *
 * Each interaction handler is invoked with a fake ButtonInteraction /
 * StringSelectMenuInteraction / ModalSubmitInteraction shape — only
 * the fields DiscordUI.handleInteraction actually touches are present.
 * The fakes capture the args passed to update/showModal so tests can
 * assert against actual builder payloads (not just call counts).
 */
import { describe, expect, test } from "bun:test";
import type {
	ButtonInteraction,
	Client,
	ModalSubmitInteraction,
	StringSelectMenuInteraction,
} from "discord.js";
import { DiscordUI, parseDiscordCustomId } from "../src/bridge/discord/ui.ts";

interface SentMessage {
	id: string;
	content: string;
	components: unknown[];
	edits: { content?: string; components?: unknown[] }[];
}

interface Stub {
	client: Client;
	channelId: string;
	sends: SentMessage[];
}

function stubClient(): Stub {
	const sends: SentMessage[] = [];
	const messagesById = new Map<string, SentMessage>();
	let id = 5000;
	const target = {
		type: 0,
		isThread: () => false,
		send: async (payload: { content: string; components?: unknown[] }) => {
			const messageId = String(++id);
			const rec: SentMessage = {
				id: messageId,
				content: payload.content,
				components: payload.components ?? [],
				edits: [],
			};
			sends.push(rec);
			messagesById.set(messageId, rec);
			return { id: messageId };
		},
		messages: {
			fetch: async (mid: string) => {
				const rec = messagesById.get(mid);
				if (!rec) throw new Error(`unknown message ${mid}`);
				return {
					edit: async (p: { content?: string; components?: unknown[] }) => {
						rec.edits.push(p);
						return rec;
					},
				};
			},
		},
	};
	const client = {
		channels: { fetch: async (_id: string) => target },
	} as unknown as Client;
	return { client, channelId: "ch-1", sends };
}

/** Pull `omp:<reqId>:<tag>` out of the components blob so tests can
 *  build a matching interaction without re-deriving the requestId.
 *  Works on both raw ActionRowBuilder instances and `.toJSON()` payloads
 *  because both expose `custom_id` after walking through `Object.values`
 *  (builders carry `.data.custom_id`; JSON carries `.custom_id` directly). */
function customIds(components: unknown[]): string[] {
	const out: string[] = [];
	const walk = (node: unknown): void => {
		if (!node || typeof node !== "object") return;
		const obj = node as Record<string, unknown>;
		if (typeof obj.custom_id === "string") out.push(obj.custom_id);
		for (const v of Object.values(obj)) {
			if (Array.isArray(v)) v.forEach(walk);
			else if (v && typeof v === "object") walk(v);
		}
	};
	components.forEach(walk);
	return out;
}

function findId(components: unknown[], match: (id: string) => boolean): string {
	const id = customIds(components).find(match);
	if (!id) throw new Error(`no custom_id matching predicate in ${JSON.stringify(components)}`);
	return id;
}

interface ButtonCalls {
	deferUpdate: number;
	reply: number;
	showModal: number;
	update: number;
	updatePayloads: { components?: unknown[]; content?: string }[];
	modalPayloads: unknown[];
}

interface FakeButtonOpts {
	deferred?: boolean;
	replied?: boolean;
}

function fakeButton(customId: string, opts: FakeButtonOpts = {}): ButtonInteraction {
	const calls: ButtonCalls = {
		deferUpdate: 0, reply: 0, showModal: 0, update: 0,
		updatePayloads: [], modalPayloads: [],
	};
	const i = {
		customId,
		isButton: () => true,
		isStringSelectMenu: () => false,
		isModalSubmit: () => false,
		replied: opts.replied ?? false,
		deferred: opts.deferred ?? false,
		deferUpdate: async () => { calls.deferUpdate += 1; return undefined; },
		reply: async () => { calls.reply += 1; return undefined; },
		showModal: async (m: unknown) => { calls.showModal += 1; calls.modalPayloads.push(m); return undefined; },
		update: async (p: { components?: unknown[]; content?: string }) => {
			calls.update += 1;
			calls.updatePayloads.push(p);
			return undefined;
		},
		_calls: calls,
	};
	return i as unknown as ButtonInteraction;
}

function calls(b: ButtonInteraction): ButtonCalls {
	return (b as unknown as { _calls: ButtonCalls })._calls;
}

function fakeSelectMenu(customId: string, values: string[]): StringSelectMenuInteraction {
	const i = {
		customId,
		values,
		isButton: () => false,
		isStringSelectMenu: () => true,
		isModalSubmit: () => false,
		replied: false,
		deferred: false,
		deferUpdate: async () => undefined,
		reply: async () => undefined,
	};
	return i as unknown as StringSelectMenuInteraction;
}

function fakeModalSubmit(customId: string, text: string): ModalSubmitInteraction {
	const i = {
		customId,
		isButton: () => false,
		isStringSelectMenu: () => false,
		isModalSubmit: () => true,
		replied: false,
		deferred: false,
		deferUpdate: async () => undefined,
		reply: async () => undefined,
		fields: { getTextInputValue: (_k: string) => text },
	};
	return i as unknown as ModalSubmitInteraction;
}

async function settle(): Promise<void> {
	// editCarrier is fire-and-forget; flush microtasks so its edit lands
	// before assertions.
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("parseDiscordCustomId", () => {
	test("recognizes the three tag shapes; rejects garbage", () => {
		expect(parseDiscordCustomId("omp:r1:sel")).toEqual({ tag: "sel", requestId: "r1" });
		expect(parseDiscordCustomId("omp:r2:mod")).toEqual({ tag: "mod", requestId: "r2" });
		expect(parseDiscordCustomId("omp:r3:btn:y")).toEqual({ tag: "btn", requestId: "r3", value: "y" });
		expect(parseDiscordCustomId("omp:r3:btn:i7")).toEqual({ tag: "btn", requestId: "r3", value: "i7" });
		expect(parseDiscordCustomId("omp:r3:btn:pg2")).toEqual({ tag: "btn", requestId: "r3", value: "pg2" });
		expect(parseDiscordCustomId("ompui:r1:y")).toBeUndefined();
		expect(parseDiscordCustomId("omp:r1:unknown")).toBeUndefined();
		expect(parseDiscordCustomId("not-ours")).toBeUndefined();
	});
});

describe("DiscordUI.confirm", () => {
	test("yes button resolves true and rewrites the carrier", async () => {
		const { client, channelId, sends } = stubClient();
		const ui = new DiscordUI(client, channelId, undefined);
		const p = ui.confirm("proceed?", "do the thing");
		await settle();
		expect(sends.length).toBe(1);
		const yesId = findId(sends[0]!.components, id => id.endsWith(":btn:y"));
		const ok = await ui.handleInteraction(fakeButton(yesId));
		expect(ok).toBe(true);
		expect(await p).toBe(true);
		await settle();
		const last = sends[0]!.edits.at(-1);
		expect(last?.content).toContain("✅");
		expect(last?.content).toContain("→ yes");
		expect(last?.components).toEqual([]);
	});

	test("no button resolves false", async () => {
		const { client, channelId, sends } = stubClient();
		const ui = new DiscordUI(client, channelId, undefined);
		const p = ui.confirm("proceed?", "msg");
		await settle();
		const noId = findId(sends[0]!.components, id => id.endsWith(":btn:n"));
		await ui.handleInteraction(fakeButton(noId));
		expect(await p).toBe(false);
	});

	test("mismatched requestId → ephemeral expired, original still pending", async () => {
		const { client, channelId, sends } = stubClient();
		const ui = new DiscordUI(client, channelId, undefined);
		const p = ui.confirm("proceed?", "msg");
		await settle();
		const bogus = fakeButton("omp:r999:btn:y");
		await ui.handleInteraction(bogus);
		expect(calls(bogus).reply).toBe(1);
		// Now resolve for real.
		const yesId = findId(sends[0]!.components, id => id.endsWith(":btn:y"));
		await ui.handleInteraction(fakeButton(yesId));
		expect(await p).toBe(true);
	});
});

describe("DiscordUI.select", () => {
	test("≤25 options posts a select menu + cancel button; submit resolves the chosen value", async () => {
		const { client, channelId, sends } = stubClient();
		const ui = new DiscordUI(client, channelId, undefined);
		const p = ui.select("pick", ["alpha", "beta", "gamma"]);
		await settle();
		expect(sends.length).toBe(1);
		const selId = findId(sends[0]!.components, id => id.endsWith(":sel"));
		await ui.handleInteraction(fakeSelectMenu(selId, ["i1"]));
		expect(await p).toBe("beta");
		await settle();
		expect(sends[0]!.edits.at(-1)?.content).toContain("→ beta");
	});

	test("cancel button resolves undefined", async () => {
		const { client, channelId, sends } = stubClient();
		const ui = new DiscordUI(client, channelId, undefined);
		const p = ui.select("pick", ["a", "b"]);
		await settle();
		const cancelId = findId(sends[0]!.components, id => id.endsWith(":btn:cancel"));
		await ui.handleInteraction(fakeButton(cancelId));
		expect(await p).toBeUndefined();
	});

	test(">25 options paginates; never exceeds Discord's 5-ActionRow cap; nav re-renders in place", async () => {
		const { client, channelId, sends } = stubClient();
		const ui = new DiscordUI(client, channelId, undefined);
		const options = Array.from({ length: 30 }, (_, i) => `opt${i}`);
		const p = ui.select("pick", options);
		await settle();
		expect(sends.length).toBe(1);
		// P0 regression guard: 16 opts/page × 4-cols → 4 option rows + 1 nav = 5.
		expect(sends[0]!.components.length).toBeLessThanOrEqual(5);
		const ids = customIds(sends[0]!.components);
		const reqId = parseDiscordCustomId(ids[0]!)!.requestId;
		// Page 1 shows i0..i15, has pg1 (next) and no pg-1 (prev disabled).
		for (let i = 0; i < 16; i++) expect(ids).toContain(`omp:${reqId}:btn:i${i}`);
		expect(ids).not.toContain(`omp:${reqId}:btn:i16`);
		expect(ids).toContain(`omp:${reqId}:btn:pg1`);

		// Tap "next": handler should call interaction.update with page 2's
		// components (i16..i29) and a pg0 prev button. Without this
		// assertion, "always renders page 0" regressions slip through.
		const nextBtn = fakeButton(`omp:${reqId}:btn:pg1`);
		await ui.handleInteraction(nextBtn);
		expect(calls(nextBtn).update).toBe(1);
		const page2Components = calls(nextBtn).updatePayloads[0]!.components!;
		expect(page2Components.length).toBeLessThanOrEqual(5);
		const page2Ids = customIds(page2Components);
		for (let i = 16; i < 30; i++) expect(page2Ids).toContain(`omp:${reqId}:btn:i${i}`);
		expect(page2Ids).not.toContain(`omp:${reqId}:btn:i0`);
		expect(page2Ids).toContain(`omp:${reqId}:btn:pg0`);

		// Tap option 25 (only reachable on page 2).
		await ui.handleInteraction(fakeButton(`omp:${reqId}:btn:i25`));
		expect(await p).toBe("opt25");
	});

	test("disabled noop page-indicator button is acked, never resolves the select", async () => {
		const { client, channelId, sends } = stubClient();
		const ui = new DiscordUI(client, channelId, undefined);
		const options = Array.from({ length: 30 }, (_, i) => `opt${i}`);
		const p = ui.select("pick", options);
		await settle();
		const ids = customIds(sends[0]!.components);
		const reqId = parseDiscordCustomId(ids[0]!)!.requestId;
		const noopBtn = fakeButton(`omp:${reqId}:btn:noop`);
		await ui.handleInteraction(noopBtn);
		expect(calls(noopBtn).deferUpdate).toBe(1);
		// The select must still be pending; resolve it cleanly so the
		// promise doesn't leak.
		expect(ui.pending()?.kind).toBe("select");
		await ui.handleInteraction(fakeButton(`omp:${reqId}:btn:i3`));
		expect(await p).toBe("opt3");
	});

	test("supersede: a second select cancels the first (carrier edited to ⊘ cancelled, components stripped)", async () => {
		const { client, channelId, sends } = stubClient();
		const ui = new DiscordUI(client, channelId, undefined);
		const p1 = ui.select("first", ["a"]);
		await settle();
		const p2 = ui.select("second", ["b"]);
		await settle();
		expect(await p1).toBeUndefined();
		expect(sends.length).toBe(2);
		// First carrier should now show the cancelled state with no
		// components — guards against a regression where supersede
		// resolves the promise but forgets to clean the user-visible
		// message (leaving a stale tap target).
		const firstLast = sends[0]!.edits.at(-1);
		expect(firstLast?.content).toContain("⊘ cancelled");
		expect(firstLast?.components).toEqual([]);
		// Second carrier is fresh, unedited.
		expect(sends[1]!.edits.length).toBe(0);
		const selId = findId(sends[1]!.components, id => id.endsWith(":sel"));
		await ui.handleInteraction(fakeSelectMenu(selId, ["i0"]));
		expect(await p2).toBe("b");
	});
});

describe("DiscordUI.input + editor", () => {
	test("input: answer button opens a Short-style modal with no prefill; submit resolves the text", async () => {
		const { client, channelId, sends } = stubClient();
		const ui = new DiscordUI(client, channelId, undefined);
		const p = ui.input("your name?", "e.g. Alice");
		await settle();
		const ids = customIds(sends[0]!.components);
		const answerId = ids.find(i => i.endsWith(":btn:answer"))!;
		const reqId = parseDiscordCustomId(answerId)!.requestId;
		const btn = fakeButton(answerId);
		await ui.handleInteraction(btn);
		expect(calls(btn).showModal).toBe(1);
		const modalJson = (calls(btn).modalPayloads[0] as { toJSON: () => Record<string, unknown> }).toJSON();
		// Discord wire format: components → [{ type:1, components:[{ type:4, style:1, ... }] }]
		// style 1 = Short, style 2 = Paragraph. Pin both style and the
		// absence of prefill so an accidental swap to Paragraph or a
		// stray .setValue() trips the test.
		const inputField = ((modalJson.components as { components: Record<string, unknown>[] }[])[0]!.components[0]!);
		expect(inputField.style).toBe(1);
		expect(inputField.value).toBeUndefined();

		await ui.handleInteraction(fakeModalSubmit(`omp:${reqId}:mod`, "Alice"));
		expect(await p).toBe("Alice");
		await settle();
		expect(sends[0]!.edits.at(-1)?.content).toContain("→ Alice");
	});

	test("input: cancel button resolves undefined without showing a modal", async () => {
		const { client, channelId, sends } = stubClient();
		const ui = new DiscordUI(client, channelId, undefined);
		const p = ui.input("your name?");
		await settle();
		const cancelId = findId(sends[0]!.components, id => id.endsWith(":btn:cancel"));
		const btn = fakeButton(cancelId);
		await ui.handleInteraction(btn);
		expect(calls(btn).showModal).toBe(0);
		expect(await p).toBeUndefined();
	});

	test("editor: opens a Paragraph-style modal pre-filled with the prefill string", async () => {
		const { client, channelId, sends } = stubClient();
		const ui = new DiscordUI(client, channelId, undefined);
		const p = ui.editor("describe", "previous draft");
		await settle();
		expect(ui.pending()?.kind).toBe("editor");
		const ids = customIds(sends[0]!.components);
		const answerId = ids.find(i => i.endsWith(":btn:answer"))!;
		const reqId = parseDiscordCustomId(answerId)!.requestId;
		const btn = fakeButton(answerId);
		await ui.handleInteraction(btn);
		const modalJson = (calls(btn).modalPayloads[0] as { toJSON: () => Record<string, unknown> }).toJSON();
		const inputField = ((modalJson.components as { components: Record<string, unknown>[] }[])[0]!.components[0]!);
		expect(inputField.style).toBe(2); // Paragraph
		expect(inputField.value).toBe("previous draft");

		await ui.handleInteraction(fakeModalSubmit(`omp:${reqId}:mod`, "new long body"));
		expect(await p).toBe("new long body");
	});
});

describe("DiscordUI.handleInteraction guards", () => {
	test("ignores customIds without the omp: prefix", async () => {
		const { client, channelId } = stubClient();
		const ui = new DiscordUI(client, channelId, undefined);
		expect(await ui.handleInteraction(fakeButton("voice:send:1"))).toBe(false);
	});

	test("late tap with no pending → expired ephemeral reply (handled)", async () => {
		const { client, channelId } = stubClient();
		const ui = new DiscordUI(client, channelId, undefined);
		const btn = fakeButton("omp:r-stale:btn:y");
		expect(await ui.handleInteraction(btn)).toBe(true);
		expect(calls(btn).reply).toBe(1);
	});

	test("late tap on an already-deferred interaction: replyEphemeral is suppressed", async () => {
		const { client, channelId } = stubClient();
		const ui = new DiscordUI(client, channelId, undefined);
		// `deferred: true` simulates the realistic case where another
		// handler already acked this interaction (preventing the
		// "InteractionAlreadyReplied" throw we'd otherwise get).
		const btn = fakeButton("omp:r-stale:btn:y", { deferred: true });
		expect(await ui.handleInteraction(btn)).toBe(true);
		expect(calls(btn).reply).toBe(0);
	});
});

describe("DiscordUI.pending + resolve", () => {
	test("pending() reflects the active kind/requestId; resolve() forwards callback values", async () => {
		const { client, channelId, sends } = stubClient();
		const ui = new DiscordUI(client, channelId, undefined);
		const p = ui.confirm("ok?", "msg");
		await settle();
		const pend = ui.pending();
		expect(pend?.kind).toBe("confirm");
		expect(pend?.awaitsText).toBe(false);
		expect(ui.resolve({ kind: "callback", requestId: pend!.requestId, value: "y" })).toBe(true);
		expect(await p).toBe(true);
		expect(ui.pending()).toBeUndefined();
		expect(sends.length).toBe(1);
	});

	test("resolve() rejects text into a non-text pending", async () => {
		const { client, channelId } = stubClient();
		const ui = new DiscordUI(client, channelId, undefined);
		const p = ui.confirm("ok?", "msg");
		await settle();
		expect(ui.resolve({ kind: "text", text: "yes" })).toBe(false);
		// Wrap up so the unresolved promise doesn't leak.
		const pend = ui.pending();
		ui.resolve({ kind: "callback", requestId: pend!.requestId, value: "n" });
		expect(await p).toBe(false);
	});
});
