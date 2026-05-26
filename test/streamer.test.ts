import { describe, expect, test } from "bun:test";
import type { Bot } from "grammy";
import { TelegramStreamer } from "../src/streamer.ts";

interface Sent {
	chatId: number;
	text: string;
	opts?: Record<string, unknown>;
	messageId: number;
}
interface Edited {
	chatId: number;
	messageId: number;
	text: string;
	opts?: Record<string, unknown>;
}

interface Stub {
	bot: Bot;
	sends: Sent[];
	edits: Edited[];
	failEdit: (n: number, err: Error) => void;
	/** Block the Nth edit call until the returned `release` is called.
	 *  Use to simulate a slow `editMessageText` (autoRetry backoff, slow
	 *  network) and observe drain semantics. */
	gateEdit: (n: number) => { release: () => void };
}

function stubBot(): Stub {
	const sends: Sent[] = [];
	const edits: Edited[] = [];
	const editFailures = new Map<number, Error>();
	const editGates = new Map<number, Promise<void>>();
	let id = 1000;
	let editCalls = 0;
	const api = {
		sendMessage: async (chatId: number, text: string, opts?: Record<string, unknown>) => {
			const messageId = ++id;
			sends.push({ chatId, text, opts, messageId });
			return { message_id: messageId };
		},
		editMessageText: async (
			chatId: number,
			messageId: number,
			text: string,
			opts?: Record<string, unknown>,
		) => {
			editCalls++;
			const gate = editGates.get(editCalls);
			if (gate) await gate;
			const forced = editFailures.get(editCalls);
			if (forced) throw forced;
			edits.push({ chatId, messageId, text, opts });
			return true;
		},
	};
	return {
		bot: { api } as unknown as Bot,
		sends,
		edits,
		failEdit: (n, err) => editFailures.set(n, err),
		gateEdit: (n) => {
			let release!: () => void;
			editGates.set(n, new Promise<void>(r => { release = r; }));
			return { release };
		},
	};
}

describe("TelegramStreamer activity coalescing", () => {
	test("debounce: a burst of appends collapses into one edit carrying the latest snapshot", async () => {
		const { bot, sends, edits } = stubBot();
		const s = new TelegramStreamer(bot, 42);
		await s.toolStart("t1", "📖 read a.ts");
		await s.commitPreamble("thinking out loud");
		await s.notice("🔄 retry 1/3");
		await s.toolStart("t2", "💻 bash: ls");
		await s.flushPending();
		expect(sends.length).toBe(1);
		expect(sends[0]!.text).toBe("📖 read a.ts");
		// All three appends happened within the debounce window → 1 edit.
		expect(edits.length).toBe(1);
		const finalEdit = edits[edits.length - 1]!;
		expect(finalEdit.messageId).toBe(sends[0]!.messageId);
		expect(finalEdit.text).toBe(
			"📖 read a.ts\n💭 thinking out loud\n🔄 retry 1/3\n💻 bash: ls",
		);
	});

	test("activity send and edit suppress link previews", async () => {
		const { bot, sends, edits } = stubBot();
		const s = new TelegramStreamer(bot, 42);
		await s.toolStart("t1", "📖 read a.ts");
		await s.notice("🌐 hit https://example.com");
		await s.flushPending();
		expect(sends[0]!.opts?.link_preview_options).toEqual({ is_disabled: true });
		expect(edits[0]!.opts?.link_preview_options).toEqual({ is_disabled: true });
	});

	test("toolEnd rewrites the original line in place", async () => {
		const { bot, sends, edits } = stubBot();
		const s = new TelegramStreamer(bot, 42);
		await s.toolStart("t1", "📖 read a.ts");
		await s.toolStart("t2", "💻 bash: ls");
		await s.toolEnd("t1", false, undefined);
		await s.flushPending();
		expect(sends.length).toBe(1);
		expect(edits[edits.length - 1]!.text).toBe("✅ read a.ts\n💻 bash: ls");
	});

	test("toolEnd with error uses errorLine in place", async () => {
		const { bot, edits } = stubBot();
		const s = new TelegramStreamer(bot, 42);
		await s.toolStart("t1", "📖 read a.ts");
		await s.toolEnd("t1", true, "❌ read failed: ENOENT");
		await s.flushPending();
		expect(edits[edits.length - 1]!.text).toBe("❌ read failed: ENOENT");
	});

	test("seals and opens a new activity message when line cap is reached", async () => {
		const { bot, sends, edits } = stubBot();
		const s = new TelegramStreamer(bot, 42);
		// Default cap = 25 lines. Push 25 then one more triggers a new send.
		for (let i = 0; i < 25; i++) await s.toolStart(`t${i}`, `📖 read f${i}.ts`);
		expect(sends.length).toBe(1);
		await s.toolStart("t25", "📖 read f25.ts");
		expect(sends.length).toBe(2);
		expect(sends[1]!.text).toBe("📖 read f25.ts");
		// Editing an old tool's line should still target the FIRST message.
		await s.toolEnd("t0", false, undefined);
		await s.flushPending();
		// At least one edit lands on the first (sealed) message with ✅ on f0.
		const firstMsgEdits = edits.filter(e => e.messageId === sends[0]!.messageId);
		expect(firstMsgEdits.length).toBeGreaterThan(0);
		const last = firstMsgEdits[firstMsgEdits.length - 1]!;
		expect(last.text.startsWith("✅ read f0.ts\n")).toBe(true);
	});

	test("seals when char cap would overflow, fresh message starts with the overflowing line", async () => {
		const { bot, sends } = stubBot();
		const s = new TelegramStreamer(bot, 42);
		const big = "x".repeat(1000);
		// 3500-char cap. Three 1000-char lines (+joins = 3002) fit; a fourth tips it.
		await s.toolStart("a", big);
		await s.toolStart("b", big);
		await s.toolStart("c", big);
		expect(sends.length).toBe(1);
		await s.toolStart("d", big);
		expect(sends.length).toBe(2);
		expect(sends[1]!.text).toBe(big);
	});

	test("finalize drains pending edits and is idempotent", async () => {
		const { bot, sends, edits } = stubBot();
		const s = new TelegramStreamer(bot, 42);
		await s.toolStart("t1", "📖 read a.ts");
		await s.toolStart("t2", "💻 bash: ls");
		// No flushPending — finalize itself must drain.
		await s.finalize();
		await s.finalize();
		expect(edits.length).toBe(1);
		expect(edits[0]!.text).toBe("📖 read a.ts\n💻 bash: ls");
		// After finalize, further toolStart is a no-op.
		await s.toolStart("t3", "📖 read b.ts");
		expect(sends.length).toBe(1);
	});

	test("a failed edit is recovered on the next successful flush (regression)", async () => {
		// Before the fix, flushActivity wrote `renderedText = text` BEFORE
		// the await, so a transient edit failure poisoned the cache: a
		// future flush back to that exact text would early-return at the
		// `text === renderedText` check, permanently leaving the user with
		// stale chat content. Observable guarantee: after a failed edit,
		// the next successful flush carries the missing line.
		const stub = stubBot();
		const s = new TelegramStreamer(stub.bot, 42);
		stub.failEdit(1, new Error("Bad Request: too many requests"));
		await s.toolStart("t1", "📖 read a.ts"); // send msg (no edit yet)
		await s.toolStart("t2", "💻 bash: ls");
		await s.flushPending(); // edit #1 fires and fails
		expect(stub.edits.length).toBe(0);
		await s.notice("ok"); // queue a new flush
		await s.flushPending(); // edit #2 — must include the bash line
		expect(stub.edits.length).toBe(1);
		expect(stub.edits[0]!.text).toBe("📖 read a.ts\n💻 bash: ls\nok");
	});

	test("'message is not modified' response keeps cache consistent", async () => {
		const stub = stubBot();
		const s = new TelegramStreamer(stub.bot, 42);
		await s.toolStart("t1", "📖 read a.ts");
		stub.failEdit(1, new Error("Bad Request: message is not modified"));
		// First notice attempts an edit; telegram returns not-modified.
		// The error is swallowed; cache must update so we don't re-attempt
		// an identical-state edit on the next flush.
		await s.notice("ok");
		await s.flushPending(); // edit #1: 'not modified'
		await s.notice("more"); // genuine change
		await s.flushPending(); // edit #2: succeeds
		expect(stub.edits.length).toBe(1);
		expect(stub.edits[0]!.text).toBe("📖 read a.ts\nok\nmore");
	});
	test("finalize awaits an in-flight edit whose timer already fired", async () => {
		// Regression: an earlier draft nulled `pendingFlush` synchronously
		// inside runOnce, so `drainHost` could return before the in-flight
		// `editMessageText` settled. `ChatSession.dispose` would then treat
		// the streamer as done while the final ✅ frame was still on the
		// wire. Now `finalize` awaits every `inflightFlushes` entry.
		const stub = stubBot();
		const s = new TelegramStreamer(stub.bot, 42);
		const gate = stub.gateEdit(1);
		await s.toolStart("t1", "📖 read a.ts");
		await s.toolStart("t2", "💻 bash: ls");
		// Trigger the timer manually by waiting > debounce. Drain starts
		// the edit, which then blocks inside the gated stub.
		await Bun.sleep(300);
		// Edit is in flight but not yet recorded — the gate is still closed.
		expect(stub.edits.length).toBe(0);
		const finalizing = s.finalize();
		// `finalize` must NOT resolve while the edit is gated.
		const raced = await Promise.race([
			finalizing.then(() => "finalize"),
			Bun.sleep(50).then(() => "timeout"),
		]);
		expect(raced).toBe("timeout");
		gate.release();
		await finalizing;
		expect(stub.edits.length).toBe(1);
		expect(stub.edits[0]!.text).toBe("📖 read a.ts\n💻 bash: ls");
	});

	test("replaceWith awaits an in-flight edit so the error message lands last", async () => {
		const stub = stubBot();
		const s = new TelegramStreamer(stub.bot, 42);
		const gate = stub.gateEdit(1);
		await s.toolStart("t1", "📖 read a.ts");
		await s.toolStart("t2", "💻 bash: ls");
		await Bun.sleep(300); // timer fires, edit blocks in stub
		const order: string[] = [];
		const stubSend = stub.bot.api.sendMessage as unknown as (
			...args: unknown[]
		) => Promise<{ message_id: number }>;
		const wrapped = stub.bot.api.sendMessage;
		(stub.bot.api as unknown as { sendMessage: typeof stubSend }).sendMessage =
			async (...args) => {
				order.push("send");
				return wrapped.apply(stub.bot.api, args as Parameters<typeof wrapped>);
			};
		const replacing = s.replaceWith("error: boom");
		// Edit hasn't landed yet — neither should the error send.
		await Bun.sleep(20);
		expect(stub.edits.length).toBe(0);
		expect(order).toEqual([]);
		gate.release();
		await replacing;
		expect(stub.edits.length).toBe(1); // edit landed first
		expect(order).toEqual(["send"]);   // then error message
	});

	test("replaceWith during the debounce window doesn't hang (regression)", async () => {
		// Copilot review caught this: scheduleFlush used to add the pending
		// promise to inflightFlushes immediately. If replaceWith cleared
		// the timer before runOnce fired, the promise never resolved and
		// Promise.allSettled hung indefinitely. Fix: only track post-timer
		// flushes in inflightFlushes.
		const stub = stubBot();
		const s = new TelegramStreamer(stub.bot, 42);
		await s.toolStart("t1", "📖 read a.ts");
		await s.toolStart("t2", "💻 bash: ls"); // timer pending, not fired
		const replacing = s.replaceWith("error: boom");
		// Must complete promptly — well under the debounce window.
		const raced = await Promise.race([
			replacing.then(() => "done"),
			Bun.sleep(100).then(() => "hang"),
		]);
		expect(raced).toBe("done");
		// Error message landed; pending edit was cancelled before firing.
		expect(stub.sends.some(s => s.text === "error: boom")).toBe(true);
		expect(stub.edits.length).toBe(0);
	});

	test("chained edits serialize per host so a slow first edit can't overwrite a faster second (regression)", async () => {
		// Copilot review caught this: scheduleFlush nulls pendingFlushRun
		// before awaiting flushActivityNow, so a post-timer append starts a
		// fresh debounce. If the first edit was delayed (autoRetry backoff
		// on 429), the second edit could land first and then be overwritten
		// by the first's stale snapshot. Fix: each new flush awaits the
		// host's lastFlush before sending its own editMessageText.
		const stub = stubBot();
		const s = new TelegramStreamer(stub.bot, 42);
		const gate1 = stub.gateEdit(1); // first edit blocks
		await s.toolStart("t1", "📖 read a.ts");
		await s.toolStart("t2", "💻 bash: ls");
		await Bun.sleep(300); // timer fires; runOnce A starts, blocks on gate
		// While A is blocked, mutate state and trigger a second debounce.
		await s.notice("late line");
		await Bun.sleep(300); // timer for B fires
		// B must NOT have edited yet — it's chained behind A.
		expect(stub.edits.length).toBe(0);
		gate1.release(); // A completes first
		await s.flushPending();
		// Two edits, in order: A's snapshot, then B's snapshot. B's is the
		// authoritative final state with all three lines.
		expect(stub.edits.length).toBe(2);
		expect(stub.edits[0]!.text).toBe("📖 read a.ts\n💻 bash: ls");
		expect(stub.edits[1]!.text).toBe("📖 read a.ts\n💻 bash: ls\nlate line");
	});
});

describe("TelegramStreamer subagent slots", () => {
	test("subagentLine appends first time, replaces in place on subsequent calls", async () => {
		const { bot, sends, edits } = stubBot();
		const s = new TelegramStreamer(bot, 42);
		await s.toolStart("t-task", "🤖 task → 2 × explore");
		await s.subagentLine("k0", "  └ [0] explore  📖 read a.ts  · 1 tools");
		await s.subagentLine("k1", "  └ [1] explore  🔍 search /foo/  · 2 tools");
		await s.subagentLine("k0", "  └ [0] explore  💻 bash: ls  · 3 tools"); // replace
		await s.flushPending();
		expect(sends.length).toBe(1);
		expect(edits.length).toBeGreaterThanOrEqual(1);
		const finalText = edits[edits.length - 1]!.text;
		const lines = finalText.split("\n");
		expect(lines.length).toBe(3); // task + 2 subagent rows; row 0 replaced not appended
		expect(lines[1]).toContain("💻 bash: ls");
		expect(lines[2]).toContain("search /foo/");
	});

	test("subagentLine no-op when called with identical text (no extra edit)", async () => {
		const { bot, edits } = stubBot();
		const s = new TelegramStreamer(bot, 42);
		await s.toolStart("t", "🤖 task → 1 × explore");
		await s.subagentLine("k0", "  └ [0] explore  📖 read a.ts");
		await s.flushPending();
		const editsBefore = edits.length;
		await s.subagentLine("k0", "  └ [0] explore  📖 read a.ts"); // same
		await s.flushPending();
		expect(edits.length).toBe(editsBefore);
	});

	test("subagentCollapse tombstones registered slots and frees their cap budget", async () => {
		const { bot, edits } = stubBot();
		const s = new TelegramStreamer(bot, 42);
		await s.toolStart("t-task", "🤖 task → 2 × explore");
		await s.subagentLine("k0", "  └ [0] explore  📖 read a.ts");
		await s.subagentLine("k1", "  └ [1] explore  🔍 search /x/");
		await s.flushPending();
		s.subagentCollapse(["k0", "k1"]);
		await s.flushPending();
		const finalText = edits[edits.length - 1]!.text;
		// Subagent rows gone; only the parent task line remains.
		expect(finalText).toBe("🤖 task → 2 × explore");
	});

	test("subagentCollapse preserves toolEnd line-index references for later tools", async () => {
		// Regression: collapse must not delete array slots or it shifts the
		// lineIndex of any later tool start line, sending toolEnd to the
		// wrong row.
		const { bot, edits } = stubBot();
		const s = new TelegramStreamer(bot, 42);
		await s.toolStart("t-task", "🤖 task → 1 × explore");
		await s.subagentLine("k0", "  └ [0] explore  📖 read a.ts");
		await s.toolEnd("t-task", false, undefined); // task tool finished
		s.subagentCollapse(["k0"]);
		await s.toolStart("t-next", "📖 read b.ts");
		await s.toolEnd("t-next", false, undefined);
		await s.flushPending();
		const finalText = edits[edits.length - 1]!.text;
		const lines = finalText.split("\n");
		expect(lines).toEqual([
			"✅ task → 1 × explore",
			"✅ read b.ts",
		]);
	});

	test("subagentLine after collapse does not resurrect a tombstoned slot", async () => {
		const { bot, edits } = stubBot();
		const s = new TelegramStreamer(bot, 42);
		await s.toolStart("t", "🤖 task → 1 × explore");
		await s.subagentLine("k0", "  └ [0] explore  📖 read a.ts");
		await s.flushPending();
		s.subagentCollapse(["k0"]);
		await s.flushPending();
		await s.subagentLine("k0", "  └ [0] explore  💻 LATE");
		await s.flushPending();
		const finalText = edits[edits.length - 1]!.text;
		expect(finalText).toBe("🤖 task → 1 × explore");
	});
});

describe("TelegramStreamer subagent cross-host regressions", () => {
	test("subagentCollapse follows the slot to its original host after a seal", async () => {
		// Open host A, register a subagent slot on it, then force a cap
		// overflow so host B opens. Collapse must mutate host A (where the
		// subagent row actually lives), NOT silent no-op against host B.
		const { bot, sends, edits } = stubBot();
		const s = new TelegramStreamer(bot, 42);
		await s.toolStart("t-task", "🤖 task → 1 × explore");
		await s.subagentLine("k0", "  └ [0] explore  📖 read a.ts");
		// Push past ACTIVITY_LINE_CAP (25) so the next append seals A.
		for (let i = 0; i < 25; i++) await s.notice(`note ${i}`);
		await s.flushPending();
		expect(sends.length).toBe(2); // A sealed, B opened
		const hostAId = sends[0]!.messageId;
		const hostBId = sends[1]!.messageId;
		s.subagentCollapse(["k0"]);
		await s.flushPending();
		// Find the most recent edit to host A — it should have the subagent
		// row tombstoned (so the rendered text no longer contains it).
		const aEdits = edits.filter(e => e.messageId === hostAId);
		const finalAText = aEdits[aEdits.length - 1]!.text;
		expect(finalAText).not.toContain("[0] explore");
		// Host B is unaffected.
		const bEdits = edits.filter(e => e.messageId === hostBId);
		if (bEdits.length > 0) {
			expect(bEdits[bEdits.length - 1]!.text).not.toContain("[0] explore");
		}
	});

	test("subagentLine continues updating the original host after a seal (replace-in-place across seal)", async () => {
		const { bot, sends, edits } = stubBot();
		const s = new TelegramStreamer(bot, 42);
		await s.toolStart("t-task", "🤖 task → 1 × explore");
		await s.subagentLine("k0", "  └ [0] explore  📖 read a.ts");
		for (let i = 0; i < 25; i++) await s.notice(`note ${i}`);
		await s.flushPending();
		const hostAId = sends[0]!.messageId;
		// Late progress update for the slot that lives on A. Must rewrite
		// the row on A in place; NOT append a fresh row to B.
		await s.subagentLine("k0", "  └ [0] explore  💻 LATE");
		await s.flushPending();
		const aEdits = edits.filter(e => e.messageId === hostAId);
		const finalAText = aEdits[aEdits.length - 1]!.text;
		expect(finalAText).toContain("💻 LATE");
		expect(finalAText).not.toContain("📖 read a.ts"); // replaced
		// B must not have grown a stray subagent row.
		const bSend = sends[1]!;
		const bEdits = edits.filter(e => e.messageId === bSend.messageId);
		const finalB = bEdits.length > 0 ? bEdits[bEdits.length - 1]!.text : bSend.text;
		expect(finalB).not.toContain("[0] explore");
	});

	test("post-collapse cap math still admits a near-cap append into the now-empty host", async () => {
		// Activity message starts fresh with a subagent row at index 0
		// (e.g. main agent had no recent activity when progress arrived).
		// Arithmetic decrement of `text.length + 1` would dip charCount
		// negative; recomputeCharCount must clamp at 0. Symmetrically,
		// the cap check has to use the conditional newline-join cost so
		// a near-cap append after collapse doesn't falsely overflow.
		const { bot, sends, edits } = stubBot();
		const s = new TelegramStreamer(bot, 42);
		await s.subagentLine("k0", "  └ [0] explore  📖 read a.ts");
		await s.flushPending();
		const hostAId = sends[0]!.messageId;
		s.subagentCollapse(["k0"]);
		await s.flushPending();
		// 3000 chars < ACTIVITY_CHAR_CAP (3500), well within budget for an
		// empty host. With correct cap math this edits the existing host;
		// a regression that mis-counts a phantom newline would seal A and
		// open B with the big line as a fresh send.
		const big = "x".repeat(3000);
		await s.notice(big);
		await s.flushPending();
		// Hard invariant: the big line must appear somewhere — either the
		// last edit on host A, or a fresh send if the host was sealed.
		const aEdits = edits.filter(e => e.messageId === hostAId);
		const aLast = aEdits.length > 0 ? aEdits[aEdits.length - 1]!.text : "";
		const landedOnA = aLast.includes(big);
		const landedOnNewSend = sends.slice(1).some(s => s.text.includes(big));
		expect(landedOnA || landedOnNewSend).toBe(true);
		// Stronger invariant: with correct cap math, A wasn't sealed —
		// the big line landed on A, not a fresh send.
		expect(landedOnA).toBe(true);
		expect(sends.length).toBe(1);
	});

	test("toolEnd updates charCount so a longer error line is reflected in cap math", async () => {
		// Regression: toolEnd used to swap host.lines[i] without adjusting
		// charCount, so an `❌ tool failed: <80-char detail>` replacing a
		// short `💻 bash: ls` would silently under-count the cap. Probe by
		// stuffing the host near cap with short tool-start lines, swapping
		// each to a long error line, then trying to append one more line
		// that would clearly overflow if charCount tracked actual content.
		const { bot, sends, edits } = stubBot();
		const s = new TelegramStreamer(bot, 42);
		// 20 tool starts at ~14 chars each → ~280 chars before any errors.
		for (let i = 0; i < 20; i++) {
			await s.toolStart(`t${i}`, `💻 bash: cmd${i}`);
		}
		// Each errorLine adds ~140 chars → total grows by ~2520 chars.
		const longErr = "❌ bash failed: " + "x".repeat(120);
		for (let i = 0; i < 20; i++) {
			await s.toolEnd(`t${i}`, true, longErr);
		}
		await s.flushPending();
		// 20 × ~136 = ~2720 chars + 19 newlines = ~2739 used. A 1000-char
		// append should now overflow ACTIVITY_CHAR_CAP (3500) and seal the
		// host. Pre-fix, the bogus charCount would mistakenly admit it.
		await s.notice("y".repeat(1000));
		await s.flushPending();
		// Two activity messages = host A sealed, host B opened with the
		// big notice. The fix is what makes this happen.
		expect(sends.length).toBe(2);
		expect(sends[1]!.text.startsWith("y")).toBe(true);
	});
});
