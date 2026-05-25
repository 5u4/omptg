/**
 * In-memory holder for transcribed voice notes awaiting user approval.
 *
 * Telegram callback_data is capped at 64 bytes, which doesn't fit a full
 * transcription. We stash the text + routing context here, keyed by a
 * short random id, and embed only that id in the inline-keyboard
 * callback_data. The transcription message_id is also tracked so a user
 * `reply_to_message` can be matched as an "edit" override.
 *
 * Entries expire after TTL_MS so an abandoned approval doesn't leak.
 * Tests stub `Date.now()` via the `now` arg.
 */
export interface PendingVoice {
	id: string;
	chatId: number;
	threadId: number | undefined;
	/** Reply target — the user's original voice message. */
	replyTo: number;
	/** The bot's transcription message we posted; reply-to-this acts as
	 *  the edit channel. */
	transcriptMessageId: number;
	text: string;
	createdAt: number;
}

const DEFAULT_TTL_MS = 30 * 60_000; // 30 min

const CALLBACK_PREFIX = "voice:";

export type VoiceAction = "send" | "cancel";

export function encodeVoiceCallback(action: VoiceAction, id: string): string {
	return `${CALLBACK_PREFIX}${action}:${id}`;
}

export function parseVoiceCallback(
	data: string,
): { action: VoiceAction; id: string } | undefined {
	if (!data.startsWith(CALLBACK_PREFIX)) return undefined;
	const rest = data.slice(CALLBACK_PREFIX.length);
	const sep = rest.indexOf(":");
	if (sep < 0) return undefined;
	const action = rest.slice(0, sep);
	const id = rest.slice(sep + 1);
	if ((action !== "send" && action !== "cancel") || !id) return undefined;
	return { action, id };
}

export class PendingVoiceStore {
	private readonly byId = new Map<string, PendingVoice>();
	/** Reverse index: `${chatId}:${transcriptMessageId}` → id, for
	 *  matching user replies to the transcription message as edits. */
	private readonly byMsg = new Map<string, string>();

	constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

	private msgKey(chatId: number, messageId: number): string {
		return `${chatId}:${messageId}`;
	}

	put(entry: Omit<PendingVoice, "createdAt">, now: number = Date.now()): PendingVoice {
		const full: PendingVoice = { ...entry, createdAt: now };
		this.byId.set(full.id, full);
		this.byMsg.set(this.msgKey(full.chatId, full.transcriptMessageId), full.id);
		this.evictExpired(now);
		return full;
	}

	get(id: string, now: number = Date.now()): PendingVoice | undefined {
		const entry = this.byId.get(id);
		if (!entry) return undefined;
		if (now - entry.createdAt > this.ttlMs) {
			this.delete(id);
			return undefined;
		}
		return entry;
	}

	/** Look up by `(chatId, transcriptMessageId)` — the keys we can recover
	 *  from a user's reply-to-this-message. */
	getByTranscriptMessage(
		chatId: number,
		messageId: number,
		now: number = Date.now(),
	): PendingVoice | undefined {
		const id = this.byMsg.get(this.msgKey(chatId, messageId));
		if (!id) return undefined;
		return this.get(id, now);
	}

	/** Atomically take + remove an entry, returning undefined if missing
	 *  or expired. Use this for terminal actions (send / cancel / edit). */
	take(id: string, now: number = Date.now()): PendingVoice | undefined {
		const entry = this.get(id, now);
		if (!entry) return undefined;
		this.delete(id);
		return entry;
	}

	takeByTranscriptMessage(
		chatId: number,
		messageId: number,
		now: number = Date.now(),
	): PendingVoice | undefined {
		const id = this.byMsg.get(this.msgKey(chatId, messageId));
		if (!id) return undefined;
		return this.take(id, now);
	}

	delete(id: string): void {
		const entry = this.byId.get(id);
		if (!entry) return;
		this.byId.delete(id);
		this.byMsg.delete(this.msgKey(entry.chatId, entry.transcriptMessageId));
	}

	size(): number {
		return this.byId.size;
	}

	private evictExpired(now: number): void {
		// Two-step so we don't delete from the Map we're iterating; the JS
		// spec allows it, but the iterator's "stable across mutation"
		// behavior is subtle (current-entry deletion is fine, but
		// surrounding shape edits aren't) and it's easier to reason about
		// the snapshot.
		const stale: string[] = [];
		for (const [id, entry] of this.byId) {
			if (now - entry.createdAt > this.ttlMs) stale.push(id);
		}
		for (const id of stale) this.delete(id);
	}
}

/** Short id that fits in a callback_data budget: 12 hex chars = 6 bytes. */
export function freshVoiceId(): string {
	let out = "";
	for (let i = 0; i < 12; i++) {
		out += Math.floor(Math.random() * 16).toString(16);
	}
	return out;
}
