/**
 * Transport abstraction. `ChatSession` interacts with the outside world
 * (Telegram today, web UI next) exclusively through these interfaces, so
 * the per-turn rendering / IO layer can be swapped without touching the
 * agent-session glue.
 *
 * Method shapes mirror the existing `TelegramStreamer` / `TelegramUI` /
 * `TypingIndicator` public surface 1:1 — the telegram wrap is a thin
 * delegation, and any future transport (web, etc.) just implements the
 * same contract.
 */
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";

/** Shape of a pending UI request — a question posed by the agent that
 *  awaits a button tap (callback) or text reply. Mirrors the original
 *  TelegramUI.PendingUiRequest 1:1. */
export interface PendingUiRequest {
	requestId: string;
	kind: "select" | "confirm" | "input" | "editor";
	awaitsText: boolean;
}

/** ExtensionUIContext augmented with the inbound-resolution surface
 *  ChatSession uses to forward callback taps / text replies into the
 *  awaiting promise. Both telegram and web bridges satisfy this. */
export interface InteractiveUI extends ExtensionUIContext {
	pending(): PendingUiRequest | undefined;
	resolve(payload:
		| { kind: "callback"; requestId: string; value: unknown }
		| { kind: "text"; text: string }): boolean;
}

/** Opaque routing key for a single conversation. Telegram packs
 *  `${chatId}:${threadId ?? ""}`; web packs `web:<n>`. ChatRegistry uses
 *  this verbatim as its map key and as the ChatStore binding key. */
export interface SessionRoute {
	key: string;
	/** Human-readable label, used in logs. */
	label: string;
}

export interface Bridge {
	readonly kind: "telegram" | "web";
	/** Appended to every agent session's system prompt so the model
	 *  knows what rendering rules its output will hit (MarkdownV2 for
	 *  Telegram, full markdown for web). */
	systemPromptAddendum(): string;
	/** Build the SessionRoute for a (chatId, threadId) pair. Telegram
	 *  packs `${chatId}:${threadId ?? ""}` (unchanged from pre-bridge
	 *  for ChatStore binding compatibility); web bridges synthesize
	 *  their own scheme. ChatRegistry uses this so it never has to
	 *  import a concrete bridge module. */
	route(chatId: number, threadId?: number): SessionRoute;
	/** Lazily build / fetch the transport for `route`. Same route key
	 *  MUST return the same transport instance across calls — callbacks
	 *  / text-reply resolution depend on the per-route `pending()` slot
	 *  surviving between turns. */
	open(route: SessionRoute): SessionTransport;
	dispose(): Promise<void>;
}

export interface SessionTransport {
	readonly ui: InteractiveUI;
	readonly typing: Typing;
	/** Build a fresh per-turn streamer. `replyTo` is the telegram
	 *  message_id of the user's prompt (used as `reply_parameters` on
	 *  the first assistant chunk); ignored by transports that don't
	 *  have a notion of reply-to. */
	newStreamer(opts: { replyTo?: number }): Streamer;
	dispose(): Promise<void>;
}

/**
 * Per-turn rendering surface. ChatSession enqueues commits as agent
 * events arrive; the streamer is responsible for ordering, batching,
 * and delivering them to the user-facing surface.
 *
 * Lifecycle: one streamer per call to `ChatSession.prompt()`. Caller
 * invokes `finalize()` once `waitForIdle()` returns (or in the error
 * path) — the streamer flushes any remaining work and seals itself.
 */
export interface Streamer {
	/** Append a fire-and-forget commit to the serialization chain.
	 *  Tasks run sequentially in submission order; finalize() awaits
	 *  the tail before sealing. */
	enqueue(task: () => Promise<void>): void;
	commitAssistant(text: string): Promise<void>;
	commitPreamble(text: string): Promise<void>;
	toolStart(toolCallId: string, line: string): Promise<void>;
	toolEnd(toolCallId: string, isError: boolean, errorLine?: string): Promise<void>;
	notice(line: string): Promise<void>;
	subagentLine(key: string, line: string): Promise<void>;
	subagentCollapse(keys: readonly string[]): void;
	finalize(): Promise<void>;
	/** Surface a fatal error in place of the in-progress turn. */
	replaceWith(text: string): Promise<void>;
}

export interface Typing {
	start(): void;
	stop(): void;
}
