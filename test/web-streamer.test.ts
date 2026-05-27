import { describe, expect, it } from "bun:test";
import { WebStreamer } from "../src/bridge/web/streamer.ts";
import type { SessionEvent } from "../src/bridge/web/protocol.ts";

function capture(): { events: SessionEvent[]; streamer: WebStreamer } {
	const events: SessionEvent[] = [];
	const streamer = new WebStreamer(e => events.push(e));
	return { events, streamer };
}

describe("WebStreamer envelope shapes", () => {
	it("emits text_delta with the verbatim chunk", () => {
		const { events, streamer } = capture();
		streamer.textDelta("hello ");
		streamer.textDelta("world");
		expect(events).toEqual([
			{ kind: "text_delta", text: "hello " },
			{ kind: "text_delta", text: "world" },
		]);
	});

	it("drops empty text_delta", () => {
		const { events, streamer } = capture();
		streamer.textDelta("");
		expect(events).toHaveLength(0);
	});

	it("commitAssistant emits a single assistant envelope with trimmed text", async () => {
		const { events, streamer } = capture();
		await streamer.commitAssistant("  done.  ");
		expect(events).toEqual([{ kind: "assistant", text: "done." }]);
	});

	it("commitAssistant skips empty after trim", async () => {
		const { events, streamer } = capture();
		await streamer.commitAssistant("   ");
		expect(events).toHaveLength(0);
	});

	it("toolStart carries name and args for structured rendering", async () => {
		const { events, streamer } = capture();
		await streamer.toolStart("call-1", "📖 read foo.ts", "read", { path: "foo.ts" });
		expect(events).toEqual([
			{ kind: "tool_start", toolCallId: "call-1", line: "📖 read foo.ts", toolName: "read", args: { path: "foo.ts" } },
		]);
	});

	it("toolEnd omits line on success but keeps result", async () => {
		const { events, streamer } = capture();
		await streamer.toolEnd("call-1", false, undefined, "read", "file body");
		expect(events).toEqual([
			{ kind: "tool_end", toolCallId: "call-1", isError: false, line: undefined, result: "file body" },
		]);
	});

	it("toolEnd carries errorLine on failure", async () => {
		const { events, streamer } = capture();
		await streamer.toolEnd("call-1", true, "❌ read failed: ENOENT", "read", "missing");
		expect(events).toEqual([
			{ kind: "tool_end", toolCallId: "call-1", isError: true, line: "❌ read failed: ENOENT", result: "missing" },
		]);
	});

	it("subagentLine and subagentCollapse emit their respective envelopes", async () => {
		const { events, streamer } = capture();
		await streamer.subagentLine("k:0", "running thing");
		streamer.subagentCollapse(["k:0", "k:1"]);
		expect(events).toEqual([
			{ kind: "subagent_line", slotKey: "k:0", line: "running thing" },
			{ kind: "subagent_collapse", slotKeys: ["k:0", "k:1"] },
		]);
	});

	it("finalize drains enqueued work before sealing", async () => {
		const { events, streamer } = capture();
		streamer.enqueue(() => streamer.commitAssistant("first"));
		streamer.enqueue(() => streamer.commitAssistant("second"));
		await streamer.finalize();
		expect(events).toEqual([
			{ kind: "assistant", text: "first" },
			{ kind: "assistant", text: "second" },
			{ kind: "finalize" },
		]);
	});

	it("post-finalize commits are dropped", async () => {
		const { events, streamer } = capture();
		await streamer.finalize();
		streamer.textDelta("late");
		await streamer.commitAssistant("late");
		expect(events).toEqual([{ kind: "finalize" }]);
	});

	it("replaceWith seals and emits a replace envelope", async () => {
		const { events, streamer } = capture();
		await streamer.replaceWith("turn failed");
		streamer.textDelta("dropped");
		expect(events).toEqual([{ kind: "replace", text: "turn failed" }]);
	});
});
