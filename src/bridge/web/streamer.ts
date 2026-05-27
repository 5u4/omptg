/**
 * WebStreamer — implements `Streamer` for the web bridge. Each method
 * synthesizes one `SessionEvent` envelope and hands it to the bridge's
 * publish callback, which fans out to subscribed ws clients and
 * archives into the per-session ring buffer.
 *
 * No coalescing, no debouncing: web clients can render the firehose
 * directly. The `enqueue` chain is preserved so ordering matches the
 * telegram path (preamble → tool_start, tool_end before subagent
 * collapse, etc.) — important for any test that drives a synthetic
 * sequence through ChatSession.
 */
import type { Streamer } from "../types.ts";
import type { SessionEvent } from "./protocol.ts";
import { scoped } from "../../logger.ts";

const log = scoped("web-streamer");

export type PublishFn = (event: SessionEvent) => void;

export class WebStreamer implements Streamer {
	private finalized = false;
	/** Same serialization chain as TelegramStreamer.tail — keeps
	 *  enqueue() callers in submission order. We don't need it for
	 *  network safety (publish is synchronous), but ChatSession's
	 *  ordering expectations (preamble → toolStart) depend on it. */
	private tail: Promise<void> = Promise.resolve();

	constructor(private readonly publish: PublishFn) {}

	enqueue(task: () => Promise<void>): void {
		this.tail = this.tail.then(task).catch(err => {
			// Don't rethrow: one bad commit must not poison the chain,
			// but log so silent UI events have a paper trail (mirrors
			// TelegramStreamer.enqueue.task_failed).
			log.warn("enqueue.task_failed", { err: err instanceof Error ? err.message : String(err) });
		});
	}

	textDelta(text: string): void {
		if (this.finalized || !text) return;
		this.publish({ kind: "text_delta", text });
	}

	async commitAssistant(text: string): Promise<void> {
		if (this.finalized) return;
		const trimmed = text.trim();
		if (!trimmed) return;
		this.publish({ kind: "assistant", text: trimmed });
	}

	async commitPreamble(text: string): Promise<void> {
		if (this.finalized) return;
		const trimmed = text.trim();
		if (!trimmed) return;
		this.publish({ kind: "preamble", text: trimmed });
	}

	async toolStart(
		toolCallId: string,
		line: string,
		toolName: string,
		args: unknown,
	): Promise<void> {
		if (this.finalized) return;
		this.publish({ kind: "tool_start", toolCallId, line, toolName, args });
	}

	async toolEnd(
		toolCallId: string,
		isError: boolean,
		errorLine: string | undefined,
		toolName: string,
		result: unknown,
	): Promise<void> {
		if (this.finalized) return;
		this.publish({
			kind: "tool_end",
			toolCallId,
			isError,
			line: errorLine,
			result,
		});
		// Mark `toolName` as used; reserved for future grouping but the
		// frontend already cached it from tool_start.
		void toolName;
	}

	async notice(line: string): Promise<void> {
		if (this.finalized || !line) return;
		this.publish({ kind: "notice", text: line });
	}

	async subagentLine(key: string, line: string): Promise<void> {
		if (this.finalized || !line) return;
		this.publish({ kind: "subagent_line", slotKey: key, line });
	}

	subagentCollapse(keys: readonly string[]): void {
		if (this.finalized || keys.length === 0) return;
		this.publish({ kind: "subagent_collapse", slotKeys: keys });
	}

	async finalize(): Promise<void> {
		if (this.finalized) return;
		// Drain queued commits before sealing so `finalize` envelope
		// arrives strictly after the last user-visible event.
		try {
			await this.tail;
		} catch {
			// already swallowed in enqueue
		}
		this.finalized = true;
		this.publish({ kind: "finalize" });
	}

	async replaceWith(text: string): Promise<void> {
		this.finalized = true;
		this.publish({ kind: "replace", text });
	}
}
