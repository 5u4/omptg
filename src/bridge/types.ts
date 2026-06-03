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

/**
 * Bridge-agnostic conversation identifier.
 *
 * - Telegram chat ids are 53-bit-safe numbers (kept as `number` to
 *   avoid breaking the existing path).
 * - Discord snowflakes exceed `Number.MAX_SAFE_INTEGER` and MUST be
 *   represented as strings — any numeric coercion silently rounds
 *   high-bit ids together.
 * - Web-bridge synthesizes its own opaque keys via `mintRoute`; the
 *   id arg is ignored, so either flavor passes through.
 *
 * ChatRegistry, ChatSession, and the Bridge contract carry this
 * widened type. Each concrete bridge narrows back to its native
 * shape at its `route()` boundary (telegram coerces to `number`).
 */
export type ChatId = number | string;

/** Opaque routing key for a single conversation. Telegram packs
 *  `${chatId}:${threadId ?? ""}`; web packs `web:<n>`. ChatRegistry uses
 *  this verbatim as its map key and as the ChatStore binding key. */
export interface SessionRoute {
	key: string;
	/** Human-readable label, used in logs. */
	label: string;
}

export interface Bridge {
	readonly kind: "telegram" | "web" | "discord";
	/** Appended to every agent session's system prompt so the model
	 *  knows what rendering rules its output will hit (MarkdownV2 for
	 *  Telegram, full markdown for web). */
	systemPromptAddendum(): string;
	/** Build the SessionRoute for a (chatId, threadId) pair. Telegram
	 *  packs `${chatId}:${threadId ?? ""}` (unchanged from pre-bridge
	 *  for ChatStore binding compatibility); web bridges synthesize
	 *  their own scheme. ChatRegistry uses this so it never has to
	 *  import a concrete bridge module. */
	route(chatId: ChatId, threadId?: number | string): SessionRoute;
	/** Persistent-binding key for `chatId` (used as the ChatStore primary
	 *  key). Discriminates IDs across bridges so a numeric Telegram chat
	 *  id and a numeric-looking Discord snowflake can't collide inside
	 *  `~/.omptg/chats.json`. Telegram: `tg:<id>`; Discord: `dc:<id>`;
	 *  Web: `web:<id>`. The thread/topic dimension is NOT encoded here
	 *  — topics live as nested keys under their group binding. */
	bindingKey(chatId: ChatId): string;
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
	/** Build a fresh per-turn streamer. `replyTo` is the user's
	 *  prompt-message id (telegram: numeric `message_id`; discord:
	 *  snowflake string), used to anchor the first assistant chunk as
	 *  a reply. Ignored by transports without a reply-to primitive
	 *  (web). Kept `number | string` so the contract survives both
	 *  id namespaces. */
	newStreamer(opts: { replyTo?: number | string }): Streamer;
	/** Post a transient bridge-side system line that's NOT part of the
	 *  agent turn — the "↪ steered" ack when a user message lands
	 *  mid-turn (silent), or a fatal turn error (audible). Telegram
	 *  sends a real chat message anchored to `replyTo`; web publishes
	 *  a `notice` SessionEvent. `replyTo` (number | string for parity
	 *  with snowflake ids) and `silent` are bridge-opaque and MAY be
	 *  ignored. */
	postSystemMessage(text: string, opts?: { replyTo?: number | string; silent?: boolean }): Promise<void>;
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
	/** Streaming token from the in-flight assistant message. Telegram
	 *  ignores deltas (the rolling editMessageText churn was untenable);
	 *  web accumulates them into the live bubble. */
	textDelta(text: string): void;
	commitAssistant(text: string): Promise<void>;
	commitPreamble(text: string): Promise<void>;
	/** Tool started. `line` is the pre-rendered header for
	 *  text-rendering transports (telegram). `toolName`/`args` give
	 *  structured transports (web) what they need to render an
	 *  expandable card. */
	toolStart(toolCallId: string, line: string, toolName: string, args: unknown): Promise<void>;
	/** Tool finished. `errorLine` is set only on error (telegram
	 *  rewrites the start line); `result` is the raw output for
	 *  structured renderers. */
	toolEnd(toolCallId: string, isError: boolean, errorLine: string | undefined, toolName: string, result: unknown): Promise<void>;
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
