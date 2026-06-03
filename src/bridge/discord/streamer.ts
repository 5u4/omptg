/**
 * DiscordStreamer — Phase 2 stub.
 *
 * Only `commitAssistant` posts a real message; every other event is a
 * no-op. Phase 3 replaces this with the activity-message + split logic.
 */
import type { Client } from "discord.js";
import type { Streamer } from "../types.ts";
import { resolveSendTarget } from "./index.ts";
import { scoped } from "../../logger.ts";

export class DiscordStreamer implements Streamer {
	private readonly log;
	private tail: Promise<void> = Promise.resolve();

	constructor(
		private readonly client: Client,
		private readonly channelId: string,
		private readonly threadId: string | undefined,
	) {
		this.log = scoped(`dc-streamer:${channelId}${threadId ? `:${threadId}` : ""}`);
	}

	enqueue(task: () => Promise<void>): void {
		this.tail = this.tail.then(task).catch(err => {
			this.log.warn("enqueue.error", { err: String(err) });
		});
	}

	textDelta(_text: string): void {
		// Phase 2: no live streaming yet.
	}

	async commitAssistant(text: string): Promise<void> {
		const body = text.trim();
		if (!body) return;
		const target = await resolveSendTarget(this.client, this.channelId, this.threadId);
		// Phase 2 stub: destructive head-truncate to Discord's 2000-char
		// hard cap. Phase 3 replaces this with `splitMarkdownForDiscord`
		// (safe-boundary splits, fenced-code preservation). The
		// UTF-16-codeunit slice can split a surrogate pair (emoji); also
		// deferred to phase 3.
		let content = body;
		if (body.length > 2000) {
			this.log.warn("commitAssistant.truncated", { len: body.length });
			content = `${body.slice(0, 1997)}...`;
		}
		await target.send({ content });
	}

	async commitPreamble(_text: string): Promise<void> {}
	async toolStart(_id: string, _line: string, _name: string, _args: unknown): Promise<void> {}
	async toolEnd(_id: string, _isError: boolean, _errorLine: string | undefined, _name: string, _result: unknown): Promise<void> {}
	async notice(_line: string): Promise<void> {}
	async subagentLine(_key: string, _line: string): Promise<void> {}
	subagentCollapse(_keys: readonly string[]): void {}

	async finalize(): Promise<void> {
		await this.tail;
	}

	async replaceWith(text: string): Promise<void> {
		await this.commitAssistant(text);
	}
}
