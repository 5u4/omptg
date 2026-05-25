/**
 * Telegram chat-action ("typing…") refresher.
 *
 * Telegram auto-expires `sendChatAction` after ~5s on the client. To keep
 * the bubble alive across long agent turns we refresh on an interval well
 * inside that window. Cribbed from hermes-agent's `_keep_typing` loop
 * (`gateway/platforms/base.py`): bound each network call so a stalled
 * Telegram round-trip can't blow the cadence, and swallow errors — a
 * dropped typing bubble is non-fatal.
 */
import type { Bot } from "grammy";

const REFRESH_MS = 4000;
const CALL_TIMEOUT_MS = 3000;

export class TypingIndicator {
	private timer: ReturnType<typeof setInterval> | undefined;
	private running = false;

	constructor(
		private readonly bot: Bot,
		private readonly chatId: number,
	) {}

	start(): void {
		if (this.running) return;
		this.running = true;
		// Fire immediately so the bubble shows up before the first 4s tick.
		void this.tick();
		this.timer = setInterval(() => void this.tick(), REFRESH_MS);
	}

	stop(): void {
		this.running = false;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	private async tick(): Promise<void> {
		if (!this.running) return;
		try {
			await Promise.race([
				this.bot.api.sendChatAction(this.chatId, "typing"),
				new Promise<void>((_, rej) =>
					setTimeout(
						() => rej(new Error("sendChatAction timeout")),
						CALL_TIMEOUT_MS,
					),
				),
			]);
		} catch {
			// Non-fatal — next tick will retry.
		}
	}
}
