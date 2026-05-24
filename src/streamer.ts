/**
 * Coalesce streaming text deltas into telegram message edits.
 * Telegram bot API rate-limits edits aggressively (~1/sec per message),
 * so we throttle to every 600ms or every 200 chars, whichever first.
 */
import type { Bot } from "grammy";

const MIN_INTERVAL_MS = 600;
const DELTA_THRESHOLD = 200;

export class TelegramStreamer {
	private buffer = "";
	private lastSent = "";
	private statusTail = "";
	private pending: ReturnType<typeof setTimeout> | undefined;
	private inflight = false;
	private finalized = false;

	constructor(
		private readonly bot: Bot,
		private readonly chatId: number,
		private readonly messageId: number,
	) {}

	pushDelta(delta: string): void {
		this.buffer += delta;
		this.maybeFlush();
	}

	/** Empty string clears. */
	pushStatus(line: string): void {
		this.statusTail = line;
		this.maybeFlush();
	}

	private maybeFlush(): void {
		if (this.finalized) return;
		const pendingChars = this.buffer.length - this.lastSent.length;
		if (pendingChars >= DELTA_THRESHOLD) {
			void this.flush();
		} else if (!this.pending) {
			this.pending = setTimeout(() => {
				this.pending = undefined;
				void this.flush();
			}, MIN_INTERVAL_MS);
		}
	}

	private async flush(): Promise<void> {
		if (this.inflight || this.finalized) return;
		const next = this.compose();
		if (next === this.lastSent || next.length === 0) return;
		this.inflight = true;
		try {
			await this.bot.api.editMessageText(
				this.chatId,
				this.messageId,
				next,
			);
			this.lastSent = next;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!msg.includes("not modified")) {
				console.warn("[edit] failed:", msg);
			}
		} finally {
			this.inflight = false;
		}
	}

	private compose(): string {
		const body = this.buffer || "✨ thinking…";
		return this.statusTail ? `${body}\n\n${this.statusTail}` : body;
	}

	async finalize(): Promise<void> {
		if (this.pending) {
			clearTimeout(this.pending);
			this.pending = undefined;
		}
		this.finalized = true;
		const final = this.buffer || "(no response)";
		if (final !== this.lastSent) {
			try {
				await this.bot.api.editMessageText(
					this.chatId,
					this.messageId,
					final,
				);
			} catch (err) {
				console.warn("[final edit] failed:", err);
			}
		}
	}

	async replaceWith(text: string): Promise<void> {
		this.finalized = true;
		try {
			await this.bot.api.editMessageText(this.chatId, this.messageId, text);
		} catch (err) {
			console.warn("[replace] failed:", err);
		}
	}
}
