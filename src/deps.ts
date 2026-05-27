/**
 * Shared runtime dependencies, threaded through every install*() function
 * in middleware.ts / commands.ts / handlers/*.ts / boot.ts.
 *
 * One bag avoids long parameter lists and makes adding a new shared
 * dependency a one-line change instead of touching every signature.
 */
import type { Bot } from "grammy";
import type { Bridge } from "./bridge/types.ts";
import type { ChatRegistry } from "./chat.ts";
import type { ChatStore } from "./chat-store.ts";
import type { PendingVoiceStore } from "./pending-voice.ts";

export interface Deps {
	bot: Bot;
	bridge: Bridge;
	registry: ChatRegistry;
	chatStore: ChatStore;
	pendingVoice: PendingVoiceStore;
	/** Effective default cwd when no per-chat / per-topic binding exists.
	 *  Resolved at boot from `OMP_DEFAULT_CWD` env or `~/.omptg/`. */
	defaultCwd: string;
	/** `TELEGRAM_ALLOWED_CHATS` parsed into a Set. Empty = open mode. */
	allowedChats: ReadonlySet<string>;
	stt: {
		model: string;
		language: string;
	};
}
