/**
 * Render an agent turn into telegram messages.
 *
 * Old behaviour streamed every text_delta into a single growing message,
 * which surfaced a lot of mid-turn reasoning prose to the chat. We now
 * commit assistant text only when a message finishes (`message_end` in
 * `chat.ts`) and keep an ephemeral one-line status message that ticks
 * with the active tool. The status message is deleted at finalize so the
 * persistent chat history is just user prompts → final replies.
 *
 * Telegram caps a single message at 4096 chars. Long assistant replies
 * are split at the last newline within budget, falling back to a hard
 * split if no newline fits.
 */
import type { Bot } from "grammy";

const MAX_MESSAGE_LEN = 4096;

export class TelegramStreamer {
	private statusMsgId: number | undefined;
	private statusText = "";
	private committedAny = false;
	private finalized = false;

	constructor(
		private readonly bot: Bot,
		private readonly chatId: number,
	) {}

	/** Commit a finalized assistant text block as one or more messages. */
	async commitAssistant(text: string): Promise<void> {
		if (this.finalized) return;
		const trimmed = text.trim();
		if (!trimmed) return;
		// Drop the live status before posting the real reply so the
		// status bubble doesn't sit visually below an answer it preceded.
		await this.clearStatus();
		for (const chunk of splitForTelegram(trimmed)) {
			await this.send(chunk);
		}
		this.committedAny = true;
	}

	/** Show (or update) the ephemeral status line. Empty string clears. */
	async setStatus(line: string): Promise<void> {
		if (this.finalized) return;
		if (line === this.statusText) return;
		this.statusText = line;
		if (!line) {
			await this.clearStatus();
			return;
		}
		if (this.statusMsgId === undefined) {
			try {
				const sent = await this.bot.api.sendMessage(this.chatId, line);
				this.statusMsgId = sent.message_id;
			} catch (err) {
				console.warn("[status] send failed:", errMsg(err));
			}
			return;
		}
		try {
			await this.bot.api.editMessageText(
				this.chatId,
				this.statusMsgId,
				line,
			);
		} catch (err) {
			const msg = errMsg(err);
			if (!msg.includes("not modified")) {
				console.warn("[status] edit failed:", msg);
			}
		}
	}

	async finalize(): Promise<void> {
		if (this.finalized) return;
		this.finalized = true;
		await this.clearStatus();
		if (!this.committedAny) {
			await this.send("(no response)");
		}
	}

	/** Surface an error after a turn fails: clear status, send verbatim text. */
	async replaceWith(text: string): Promise<void> {
		this.finalized = true;
		await this.clearStatus();
		await this.send(text);
	}

	private async clearStatus(): Promise<void> {
		if (this.statusMsgId === undefined) return;
		const id = this.statusMsgId;
		this.statusMsgId = undefined;
		this.statusText = "";
		try {
			await this.bot.api.deleteMessage(this.chatId, id);
		} catch (err) {
			// Already deleted, too old to delete, or rate-limited — non-fatal.
			const msg = errMsg(err);
			if (!msg.includes("message to delete not found")) {
				console.warn("[status] delete failed:", msg);
			}
		}
	}

	private async send(text: string): Promise<void> {
		try {
			await this.bot.api.sendMessage(this.chatId, text);
		} catch (err) {
			console.warn("[send] failed:", errMsg(err));
		}
	}
}

/**
 * Split text into telegram-sized chunks, preferring the last newline
 * within budget. Falls back to a hard split if no newline fits in at
 * least the second half (avoids one early newline pinning us to a tiny
 * first chunk followed by a giant second one).
 */
export function splitForTelegram(text: string, budget = MAX_MESSAGE_LEN): string[] {
	if (text.length <= budget) return [text];
	const out: string[] = [];
	let rest = text;
	while (rest.length > budget) {
		const slice = rest.slice(0, budget);
		const nl = slice.lastIndexOf("\n");
		const cut = nl >= budget / 2 ? nl + 1 : budget;
		out.push(rest.slice(0, cut).trimEnd());
		rest = rest.slice(cut);
	}
	if (rest.length) out.push(rest);
	return out;
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
