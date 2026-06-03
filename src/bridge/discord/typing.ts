/**
 * DiscordTyping — periodic `channel.sendTyping()` while active.
 *
 * Discord's typing indicator auto-expires after ~10s, so we re-send
 * every 8s while a turn is in flight. Mirrors `TypingIndicator` in
 * shape: idempotent `start()` / `stop()`, swallows transport errors.
 */
import type { Client, TextChannel, ThreadChannel } from "discord.js";
import type { Typing } from "../types.ts";
import { resolveSendTarget } from "./index.ts";
import { scoped } from "../../logger.ts";

const TYPING_REFRESH_MS = 8_000;

export class DiscordTyping implements Typing {
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly log;

	constructor(
		private readonly client: Client,
		private readonly channelId: string,
		private readonly threadId: string | undefined,
	) {
		this.log = scoped(`dctyping:${channelId}${threadId ? `:${threadId}` : ""}`);
	}

	start(): void {
		if (this.timer) return;
		void this.send();
		this.timer = setInterval(() => { void this.send(); }, TYPING_REFRESH_MS);
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	private async send(): Promise<void> {
		try {
			const target: TextChannel | ThreadChannel = await resolveSendTarget(this.client, this.channelId, this.threadId);
			await target.sendTyping();
		} catch (err) {
			this.log.warn("typing.error", { err: String(err) });
		}
	}
}
