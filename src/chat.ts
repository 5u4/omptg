/**
 * Per-chat agent runtime. One ChatSession owns:
 *   - the cwd it's bound to
 *   - the live AgentSession (recreated on /new, /dir, /resume)
 *   - the currently-rendering Streamer (one per in-flight turn)
 *   - pending UI requests awaiting a button tap or text reply
 *
 * Keyed by chat_id in ChatRegistry. v1 is single-thread; topic support
 * lands once we observe how Telegram groups behave.
 */
import {
	createAgentSession,
	SessionManager,
} from "@oh-my-pi/pi-coding-agent";
import type {
	AgentSession,
	AgentSessionEvent,
	ExtensionUIContext,
	SessionInfo,
} from "@oh-my-pi/pi-coding-agent";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import type { Bridge, ChatId, InteractiveUI, PendingUiRequest, SessionRoute, SessionTransport, Streamer, Typing } from "./bridge/types.ts";
import { generateSessionTitle } from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import { scoped } from "./logger.ts";
import { ChatStore, type ChatBinding, type TopicBinding } from "./chat-store.ts";
import { renderToolStart, renderToolEnd, renderSubagentProgress } from "./tool-render.ts";
import {
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
} from "@oh-my-pi/pi-coding-agent/task/types";
import type { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

/** Bridge-supplied hook letting a ChatSession persist (and recover) the
 *  OMP session id it's currently attached to, keyed by whatever the
 *  bridge considers "one conversation" (Discord: thread snowflake).
 *
 *  When `get()` returns a non-undefined id, `ensure()` skips the
 *  newest-wins auto-resume and tries to open that specific session
 *  instead. Whenever a session is freshly created (or explicitly
 *  resumed by path), ChatSession calls `set(newId)` so the next bot
 *  restart resumes the same conversation rather than whichever
 *  session happens to be newest on disk for the cwd. */
export interface SessionPin {
	get(): string | undefined;
	set(sessionId: string): void;
}

export interface ChatSessionOptions {
	chatId: ChatId;
	cwd: string;
	transport: SessionTransport;
	/** System-prompt addendum from the bridge (telegram/web rendering rules). */
	systemPromptAddendum: string;
	/** Forum topic id this session is scoped to. undefined = DM / non-forum
	 *  group / forum General topic. Drives both ChatRegistry keying and
	 *  outbound message routing (sendMessage / sendChatAction). */
	threadId?: number | string;
	/** Optional per-thread session pinning hook (see SessionPin). Bridges
	 *  that treat each thread as one conversation (Discord) set this so
	 *  bot restarts resume the right session; bridges that prefer cwd-
	 *  level newest-wins resume (Telegram non-forum) leave it undefined. */
	sessionPin?: SessionPin;
}

/**
 * Pull the visible text out of an assistant message's content array.
 * Assistant content is `(TextContent | ThinkingContent | RedactedThinking |
 * ToolCall)[]` — we keep only `TextContent` so thinking blocks (when the
 * provider exposes them) and tool-call payloads don't leak to the chat.
 */
function extractAssistantText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object"
			&& (part as { type?: unknown }).type === "text"
			&& typeof (part as { text?: unknown }).text === "string"
		) {
			parts.push((part as { text: string }).text);
		}
	}
	return parts.join("").trim();
}

/** Compose the agent's system prompt: SDK defaults + the active bridge's
 *  rendering rules (telegram MarkdownV2 caveats, or web full markdown). */
function withBridgePrompt(addendum: string): (defaults: string[]) => string[] {
	return defaults => addendum ? [...defaults, addendum] : [...defaults];
}

/**
 * First user-typed prompt in a session's history. Used by /retitle (no
 * args) to give the title-generator something to work with after a
 * resume — when `firstUserText` from the in-memory turn loop is undefined
 * because we never replayed the original prompt.
 *
 * User content can be a plain string (older entries) or a `MessageContent[]`
 * with `{type:"text", text}` parts; cover both shapes.
 */
function extractFirstUserText(messages: readonly unknown[]): string | undefined {
	for (const m of messages) {
		if (!m || typeof m !== "object") continue;
		const role = (m as { role?: unknown }).role;
		if (role !== "user") continue;
		const content = (m as { content?: unknown }).content;
		if (typeof content === "string") {
			const trimmed = content.trim();
			if (trimmed) return trimmed;
			continue;
		}
		if (Array.isArray(content)) {
			const text = content
				.filter((p): p is { type: string; text: string } =>
					!!p && typeof p === "object"
					&& (p as { type?: unknown }).type === "text"
					&& typeof (p as { text?: unknown }).text === "string")
				.map(p => p.text)
				.join("")
				.trim();
			if (text) return text;
		}
	}
	return undefined;
}

export class ChatSession {
	readonly chatId: ChatId;
	readonly threadId: number | string | undefined;
	cwd: string;
	private readonly transport: SessionTransport;
	private readonly systemPromptAddendum: string;
	private readonly sessionPin: SessionPin | undefined;
	private readonly ui: InteractiveUI;
	private readonly typing: Typing;
	private session: AgentSession | undefined;
	private unsubscribe: (() => void) | undefined;
	private streamer: Streamer | undefined;
	private readonly log;
	/** First user message text in the current session, captured for title gen. */
	private firstUserText: string | undefined;
	/** Set once we've attempted (or completed) title generation for the
	 *  current session; cleared whenever session is recreated. */
	private _titleAttempted = false;
	/** Bridge-supplied callback fired whenever the session's title
	 *  changes — auto-generation after the first turn, manual `setTitle`,
	 *  or `regenerateTitle`. Multi-shot: bridges that want a one-shot
	 *  effect should latch in their own state, or check `titleAttempted`
	 *  to skip installation entirely for sessions that already named.
	 *
	 *  Used by the Discord bridge to rename the thread; other bridges
	 *  leave this unset. Both synchronous throws and rejected promises
	 *  (for `async` callbacks) are caught and logged inside the title
	 *  path — they never crash the turn. */
	onTitleGenerated?: (title: string) => void | Promise<void>;

	/** Has the auto-titler run for this session? `true` after the first
	 *  successful (or skipped/failed) attempt, or immediately when a
	 *  resumed session already had a name. Bridges check this to decide
	 *  whether installing `onTitleGenerated` would do anything. */
	get titleAttempted(): boolean {
		return this._titleAttempted;
	}
	/** Latched on first ensure() call (per chat lifetime, not per session).
	 *  Prevents re-running auto-resume after the user explicitly /new'd
	 *  away from the recovered session — we only try once on cold boot. */
	private autoResumeTried = false;
	/**
	 * Most recent assistant message_end text, NOT yet sent. We delay the
	 * send because the model often emits "I'll read X then edit Y" as a
	 * standalone assistant message right before calling a tool — flushing
	 * that verbatim is the dogfooding complaint. Resolution:
	 *  - tool_execution_start arrives → it was a preamble → truncated heartbeat
	 *  - agent_end arrives          → it was the final reply → full chunked send
	 *  - dispose/endTurn safety net → final send (covers crashed turns)
	 */
	private pendingAssistantText: string | undefined;

	/**
	 * EventBus from the active `createAgentSession`. Used to subscribe to
	 * `task:subagent:*` channels so the streamer can render per-subagent
	 * progress rows under the parent `🤖 task` line. `attach()` populates,
	 * `dispose()` runs the returned unsubscribers. Per-session because
	 * each createAgentSession returns its own bus.
	 */
	private eventBus: EventBus | undefined;
	private busUnsubscribers: Array<() => void> = [];
	/**
	 * State of the currently in-flight `task` tool call. Set on its
	 * `tool_execution_start`, cleared (and its subagent rows collapsed)
	 * on `tool_execution_end`. The main agent serializes tool calls so
	 * at most one parent `task` is active at a time; subagents spawned
	 * by subagents emit on their own bus and never reach this handler.
	 */
	private activeTask: {
		toolCallId: string;
		/** Streamer keys we've registered for collapse on task end. */
		keys: string[];
		/** index → display description from the original `tasks[]` arg,
		 *  used when a progress payload's `task` text is empty. */
		labels: Map<number, { agent: string; description: string }>;
		/** Indexes whose lifecycle reported terminal status — late
		 *  progress events for them are dropped so completed rows don't
		 *  flicker back to a "running" state. */
		done: Set<number>;
	} | undefined;

	/**
	 * Cache of the last `/sessions` listing, so `/resume <n>` resolves
	 * the 1-based index the user saw. Per-ChatSession (not per-chat-id)
	 * so a forum group's topic A and topic B don't share the cache.
	 *
	 * Stale entries are harmless: `/resume` re-validates length and
	 * re-opens by path.
	 */
	recentSessions: SessionInfo[] = [];

	constructor(opts: ChatSessionOptions) {
		this.chatId = opts.chatId;
		this.threadId = opts.threadId;
		this.cwd = opts.cwd;
		this.transport = opts.transport;
		this.systemPromptAddendum = opts.systemPromptAddendum;
		this.ui = opts.transport.ui;
		this.typing = opts.transport.typing;
		const suffix = opts.threadId !== undefined ? `:${opts.threadId}` : "";
		this.log = scoped(`chat:${opts.chatId}${suffix}`);
		this.sessionPin = opts.sessionPin;
	}

	get hasSession(): boolean {
		return this.session !== undefined;
	}

	get sessionId(): string | undefined {
		return this.session?.sessionId;
	}

	get sessionFile(): string | undefined {
		return this.session?.sessionFile;
	}

	get modelId(): string | undefined {
		return this.session?.model?.id;
	}

	get sessionName(): string | undefined {
		return this.session?.sessionName;
	}

	/** {tokens, contextWindow, percent} for the active model, or undefined
	 *  when no session exists yet. `tokens`/`percent` may be null right
	 *  after a compaction, before the next assistant message. */
	get contextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined {
		return this.session?.getContextUsage();
	}

	get isStreaming(): boolean {
		return this.session?.isStreaming ?? false;
	}

	/** Currently-attached streamer for the in-flight turn, or undefined
	 *  if no turn is active. Used by the web bridge's runOneTurn error
	 *  path to publish a `replace` envelope when prompt()/steer() itself
	 *  fails after a streamer has already been attached — without it
	 *  subscribers see `finalize` indistinguishable from success. */
	get currentStreamer(): Streamer | undefined {
		return this.streamer;
	}

	/** Forward a bridge-side system line (steered ack, fatal turn
	 *  error) to the bound transport. Kept as a thin forwarder rather
	 *  than exposing the full transport so handlers can't reach in and
	 *  build rogue streamers or dispose the transport mid-turn. */
	postSystemMessage(text: string, opts?: { replyTo?: number | string; silent?: boolean }): Promise<void> {
		return this.transport.postSystemMessage(text, opts);
	}

	/** True from the moment we dispatch a user turn until `agent_end`
	 *  (or abort/endTurn) fires. Reflects "is the user still waiting on
	 *  the LLM?", not the SDK's `isStreaming` — which stays true through
	 *  post-stream deferred work (persistence, mental-models refresh,
	 *  auto-compaction). Using the SDK flag for the "↪ steered" ack
	 *  caused stale acks on the user's next message after the reply
	 *  had already landed. */
	private turnActive = false;
	get isTurnActive(): boolean {
		return this.turnActive;
	}

	/**
	 * Return existing session, or — on the very first ensure() of a chat's
	 * lifetime — try to resume the most recent stored session in this cwd
	 * so a bot restart picks up where the user left off. Falls through to
	 * createFresh() if there's nothing to resume, or if open fails.
	 *
	 * Skipped after /new, /resume, or any other path that explicitly placed
	 * a session via attach() (autoResumeTried gets latched on first call,
	 * and an existing this.session short-circuits before we even look).
	 */
	async ensure(): Promise<AgentSession> {
		if (this.session) return this.session;
		if (!this.autoResumeTried) {
			this.autoResumeTried = true;
			const recovered = await this.tryAutoResume();
			if (recovered) return recovered;
		}
		return this.createFresh();
	}

	private async tryAutoResume(): Promise<AgentSession | undefined> {
		try {
			const pinnedId = this.sessionPin?.get();
			// Pin-enabled bridge (e.g. Discord) with no pin set means
			// "this thread is brand-new, no prior session to attach".
			// Falling through to newest-wins would adopt some other
			// thread's session in the same cwd — exactly the bug pinning
			// exists to prevent.
			if (this.sessionPin && !pinnedId) return undefined;
			const sessions = await SessionManager.list(this.cwd);
			if (sessions.length === 0) return undefined;
			const target = pinnedId
				? sessions.find(s => s.id === pinnedId)
				: sessions.reduce((a, b) =>
					a.modified.getTime() >= b.modified.getTime() ? a : b,
				);
			if (!target) {
				// Pin pointed at a session that no longer exists on disk
				// (deleted, archived, or moved). Don't fall through to
				// newest-wins — that's the bug we added pinning to fix.
				// Returning undefined lets ensure() create a fresh
				// session, and attach() will repoint the pin to the new id.
				if (pinnedId) {
					this.log.info("session.pin_miss", { pinned_id: pinnedId });
				}
				return undefined;
			}
			const manager = await SessionManager.open(target.path);
			const created = await createAgentSession({
				cwd: manager.getCwd(),
				sessionManager: manager,
				hasUI: true,
				systemPrompt: withBridgePrompt(this.systemPromptAddendum),
			});
			this.cwd = manager.getCwd();
			this.attach(created.session, created.setToolUIContext, created.eventBus);
			this.log.info("session.auto_resumed", {
				session_id: created.session.sessionId,
				path: target.path,
				name: created.session.sessionName,
				pinned: pinnedId !== undefined,
			});
			return created.session;
		} catch (err) {
			this.log.warn("session.auto_resume_failed", { err: String(err) });
			return undefined;
		}
	}

	/** Replace the current session with a brand-new one in the same cwd. */
	async newSession(): Promise<AgentSession> {
		await this.dispose();
		return this.createFresh();
	}

	/** Swap cwd + start a fresh session there. */
	async switchCwd(newCwd: string): Promise<AgentSession> {
		await this.dispose();
		this.cwd = newCwd;
		return this.createFresh();
	}

	/** Open a stored session file. */
	async resume(sessionPath: string): Promise<AgentSession> {
		await this.dispose();
		const manager = await SessionManager.open(sessionPath);
		const created = await createAgentSession({
				cwd: manager.getCwd(),
				sessionManager: manager,
				hasUI: true,
				systemPrompt: withBridgePrompt(this.systemPromptAddendum),
			});
		this.cwd = manager.getCwd();
		this.attach(created.session, created.setToolUIContext, created.eventBus);
		return created.session;
	}

	async dispose(): Promise<void> {
		this.unsubscribe?.();
		this.typing.stop();
		this.unsubscribe = undefined;
		for (const unsub of this.busUnsubscribers) {
			try { unsub(); } catch (err) {
				this.log.warn("dispose.bus_unsubscribe_failed", { err: String(err) });
			}
		}
		this.busUnsubscribers = [];
		this.eventBus = undefined;
		this.activeTask = undefined;
		if (this.session) {
			try {
				await this.session.dispose();
			} catch (err) {
				this.log.warn("dispose.failed", { err: String(err) });
			}
			this.session = undefined;
		}
		// Drain any in-flight tool edits / final assistant chunk that
		// handleEvent scheduled before we unsubscribed. finalize() awaits
		// the chain tail and is idempotent — safe if endTurn already ran.
		// Doing this BEFORE clearing `streamer` ensures the chain settles
		// against the live instance; otherwise a stray `[send] failed:`
		// log shows up on shutdown after `bot.stop()` invalidates the api.
		if (this.streamer) {
			try {
				await this.streamer.finalize();
			} catch (err) {
				this.log.warn("dispose.streamer_finalize_failed", { err: String(err) });
			}
		}
		this.streamer = undefined;
		this.firstUserText = undefined;
		this.pendingAssistantText = undefined;
		this._titleAttempted = false;
	}

	private async createFresh(): Promise<AgentSession> {
		const manager = SessionManager.create(
			this.cwd,
			SessionManager.getDefaultSessionDir(this.cwd),
		);
		const created = await createAgentSession({
				cwd: this.cwd,
				sessionManager: manager,
				hasUI: true,
				systemPrompt: withBridgePrompt(this.systemPromptAddendum),
			});
		if (created.modelFallbackMessage) {
			console.warn(
				`[chat ${this.chatId}] ${created.modelFallbackMessage}`,
			);
		}
		this.attach(created.session, created.setToolUIContext, created.eventBus);
		return created.session;
	}

	private attach(
		session: AgentSession,
		setToolUIContext: (ctx: ExtensionUIContext, hasUI: boolean) => void,
		eventBus: EventBus | undefined,
	): void {
		this.session = session;
		// Inject our telegram-backed UI before any tool can call into it.
		setToolUIContext(this.ui, true);
		this.unsubscribe = session.subscribe(e => this.handleEvent(e));
		this.eventBus = eventBus;
		if (eventBus) {
			// Two channels are enough:
			//   - lifecycle: terminal status (so we stop pushing progress)
			//   - progress: 150ms-coalesced snapshot; everything we render
			//               comes from `AgentProgress` directly
			// We deliberately skip TASK_SUBAGENT_EVENT_CHANNEL (raw per-event
			// firehose): it's noisy, every visible field is already in
			// `AgentProgress.currentTool*` / `lastIntent` / `toolCount`.
			this.busUnsubscribers.push(
				eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => {
					this.handleSubagentProgress(data as SubagentProgressPayload);
				}),
				eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
					this.handleSubagentLifecycle(data as SubagentLifecyclePayload);
				}),
			);
		}
		// Resuming a session preloads sessionName; don't try to generate again.
		this._titleAttempted = Boolean(session.sessionName);
		this.firstUserText = undefined;
		this.pendingAssistantText = undefined;
		this.log.info("session.attached", {
			session_id: session.sessionId,
			cwd: this.cwd,
			name: session.sessionName,
		});
		// Repoint the per-thread pin to the now-attached session id (no-op
		// for bridges that didn't supply a pin). Centralized here so
		// createFresh, resume, and tryAutoResume all keep the pin in sync
		// without each having to remember to call it. Skip the write when
		// the pin already matches — cold-boot pin-hit resumes would
		// otherwise re-fsync the chats.json file once per thread for a
		// value that didn't change.
		if (this.sessionPin && session.sessionId
			&& this.sessionPin.get() !== session.sessionId) {
			try {
				this.sessionPin.set(session.sessionId);
			} catch (err) {
				this.log.warn("session.pin_set_failed", { err: String(err) });
			}
		}
	}

	/** Send a user turn. Caller must wait via waitForIdle separately.
	 *  Starts the typing indicator; the caller must invoke
	 *  `streamer.finalize()` after `waitForIdle()` returns so it can be
	 *  stopped via the `agent_end` path (or the finalize fallback). */
	async prompt(
		text: string,
		opts?: { replyTo?: number | string; images?: ImageContent[] },
	): Promise<Streamer> {
		const s = await this.ensure();
		if (this.firstUserText === undefined) this.firstUserText = text;
		this.streamer = this.transport.newStreamer({ replyTo: opts?.replyTo });
		this.typing.start();
		this.turnActive = true;
		if (s.isStreaming) {
			await s.steer(text, opts?.images);
		} else {
			await s.prompt(text, opts?.images ? { images: opts.images } : undefined);
		}
		return this.streamer;
	}

	async abort(): Promise<boolean> {
		if (!this.session?.isStreaming) return false;
		await this.session.abort();
		this.typing.stop();
		this.turnActive = false;
		return true;
	}

	/** Finish the current turn: stop the typing bubble and finalize the
	 *  streamer (clears the status message and ensures the user sees a
	 *  reply even if the agent produced none). Idempotent. */
	async endTurn(): Promise<void> {
		this.typing.stop();
		this.turnActive = false;
		// Belt + suspenders: if agent_end never fired (crash, abort, etc.)
		// the pending assistant text would otherwise be lost. Flush it via
		// the same chain so order is preserved relative to any tool events
		// still queued. `finalize()` then awaits the chain tail before
		// flipping `finalized` and clearing `toolMsgs`.
		const final = this.pendingAssistantText;
		this.pendingAssistantText = undefined;
		const s = this.streamer;
		if (s && final) s.enqueue(() => s.commitAssistant(final));
		await s?.finalize();
		// Clear the slot so `currentStreamer` actually means
		// "in-flight turn" instead of leaving the finalized instance
		// around for the next observer. dispose() clears it too, but
		// endTurn is the normal-path exit and runs first.
		if (this.streamer === s) this.streamer = undefined;
	}

	/** Forward UI pending-request resolution from callback or text reply. */
	resolvePending(payload:
		| { kind: "callback"; requestId: string; value: unknown }
		| { kind: "text"; text: string }): boolean {
		return this.ui.resolve(payload);
	}

	pendingUi(): PendingUiRequest | undefined {
		return this.ui.pending();
	}

	/** Direct access to the bridge-side `InteractiveUI`. Discord needs this
	 *  to invoke `showModal` on the originating interaction (modals can
	 *  only open in response to an interaction, not unilaterally). Other
	 *  call sites SHOULD prefer `resolvePending` / `pendingUi`. */
	uiBridge(): InteractiveUI {
		return this.ui;
	}

	private handleEvent(event: AgentSessionEvent): void {
		const s = this.streamer;
		switch (event.type) {
			// Text deltas are forwarded to the streamer's `textDelta`,
			// which the telegram adapter no-ops (rolling editMessageText
			// can't keep up with token streams) and the web streamer
			// turns into a `text_delta` envelope. Thinking and toolcall
			// deltas are skipped here — they have dedicated UI elsewhere.
			//
			// `message_end` text is BUFFERED (not committed) because OMP fires
			// one message_end per assistant message, and a turn typically
			// looks like: assistant prose → tool → tool → assistant prose →
			// tool → … → final assistant prose → agent_end. The non-final
			// prose blocks are "preambles" the user doesn't need verbatim.
			// We flush at the next tool_execution_start (as a one-line
			// heartbeat) or at agent_end (as the full reply).
			case "message_update": {
				// Streaming token. Telegram's adapter drops it; web's
				// streamer emits a `text_delta` envelope so the live
				// bubble updates token-by-token. The SDK nests its
				// AssistantMessageEvent under `assistantMessageEvent`;
				// we only forward `text_delta` (skip thinking/toolcall
				// deltas — those have dedicated UI elsewhere).
				const ev = event as { assistantMessageEvent?: { type?: unknown; delta?: unknown } };
				const inner = ev.assistantMessageEvent;
				if (s && inner?.type === "text_delta" && typeof inner.delta === "string" && inner.delta.length > 0) {
					s.textDelta(inner.delta);
				}
				break;
			}
			case "message_end": {
				const msg = (event as { message?: { role?: string; content?: unknown } }).message;
				if (!msg || msg.role !== "assistant") break;
				const text = extractAssistantText(msg.content);
				if (text) {
					this.pendingAssistantText = text;
				} else if (Array.isArray(msg.content) && msg.content.length > 0) {
					// Non-empty content array that yielded zero visible text:
					// either it's pure tool-calls / thinking blocks (benign,
					// the next tool_execution_start handles it) OR the SDK
					// changed its content shape and our extractor missed it
					// (catastrophic — the user's reply silently vanishes).
					// Surface enough to diagnose without flooding logs.
					this.log.warn("message_end.empty_text", {
						content_types: msg.content
							.map(c => (c as { type?: unknown })?.type ?? typeof c)
							.slice(0, 8),
					});
				}
				break;
			}
			case "tool_execution_start": {
				const ev = event as { toolCallId?: string; toolName?: string; args?: unknown };
				if (!s || !ev.toolCallId || !ev.toolName) break;
				const pre = this.pendingAssistantText;
				this.pendingAssistantText = undefined;
				const line = renderToolStart(ev.toolName, ev.args);
				const id = ev.toolCallId;
				const toolName = ev.toolName;
				const args = ev.args;
				// Serialize preamble→tool so order is deterministic in chat,
				// AND so endTurn's finalize() drains them before clearing
				// toolMsgs / flipping `finalized`.
				s.enqueue(async () => {
					if (pre) await s.commitPreamble(pre);
					await s.toolStart(id, line, toolName, args);
				});
				if (ev.toolName === "task") {
					// Capture the tasks[] array so subagent progress can be
					// labeled with the user-visible description even when the
					// progress payload's `task` text is empty.
					const args = (ev.args ?? {}) as { agent?: string; tasks?: unknown };
					const items = Array.isArray(args.tasks) ? args.tasks : [];
					const agent = typeof args.agent === "string" ? args.agent : "agent";
					const labels = new Map<number, { agent: string; description: string }>();
					items.forEach((t, i) => {
						const desc = t && typeof t === "object" && typeof (t as { description?: unknown }).description === "string"
							? (t as { description: string }).description
							: "";
						labels.set(i, { agent, description: desc });
					});
					this.activeTask = { toolCallId: id, keys: [], labels, done: new Set() };
				}
				break;
			}
			case "tool_execution_end": {
				const ev = event as {
					toolCallId?: string;
					toolName?: string;
					result?: unknown;
					isError?: boolean;
				};
				if (!s || !ev.toolCallId || !ev.toolName) break;
				const isError = ev.isError === true;
				const errorLine = isError
					? renderToolEnd(ev.toolName, ev.result, true) || undefined
					: undefined;
				const toolCallId = ev.toolCallId;
				const toolName = ev.toolName;
				const result = ev.result;
				s.enqueue(() => s.toolEnd(toolCallId, isError, errorLine, toolName, result));
				if (ev.toolName === "task" && this.activeTask?.toolCallId === toolCallId) {
					const keys = this.activeTask.keys.slice();
					this.activeTask = undefined;
					if (keys.length > 0) {
						// Enqueued AFTER `s.toolEnd` above so the parent
						// task's toolEnd settles before the subagent
						// rows tombstone. On success the `🤖 task → N`
						// line stays as-is; the user just sees the
						// subagent block clear out underneath it.
						s.enqueue(async () => { s.subagentCollapse(keys); });
					}
				}
				break;
			}
			case "notice": {
				const n = event as { level: string; message: string };
				this.log.info("notice", { level: n.level, message: n.message });
				break;
			}
			case "auto_retry_start": {
				const ev = event as { attempt: number; maxAttempts: number };
				s?.enqueue(() => s.notice(`🔄 retry ${ev.attempt}/${ev.maxAttempts}`));
				break;
			}
			case "agent_end": {
				this.typing.stop();
				this.turnActive = false;
				// Whatever's still pending is the final assistant reply.
				const final = this.pendingAssistantText;
				this.pendingAssistantText = undefined;
				if (s && final) s.enqueue(() => s.commitAssistant(final));
				this.maybeGenerateTitle();
				break;
			}
			default:
				break;
		}
	}

	/**
	 * Stream a subagent's progress snapshot into the activity message as a
	 * keyed row. Called from the EventBus subscription; harness already
	 * coalesces at 150ms so the firehose is manageable. The streamer's
	 * own 250ms debounce further collapses concurrent subagents into a
	 * single editMessageText.
	 *
	 * Drops events when:
	 *   - no active task call captured (event from a stale session, or
	 *     racy emit after we collapsed)
	 *   - the slot already reached a terminal lifecycle state (avoids
	 *     resurrecting a completed row with a late progress snapshot)
	 *   - the streamer has been finalized
	 */
	private handleSubagentProgress(payload: SubagentProgressPayload): void {
		const active = this.activeTask;
		const s = this.streamer;
		if (!active || !s) return;
		const { index, progress } = payload;
		if (active.done.has(index)) return;
		const label = active.labels.get(index);
		const description = label?.description || payload.task || "";
		const agent = label?.agent || payload.agent;
		const line = renderSubagentProgress(
			index,
			agent,
			description,
			progress.currentTool,
			progress.currentToolArgs,
			progress.lastIntent,
			progress.toolCount,
			progress.resolvedModel,
		);
		const key = `${active.toolCallId}#${index}`;
		if (!active.keys.includes(key)) active.keys.push(key);
		s.enqueue(() => s.subagentLine(key, line));
	}

	/**
	 * Terminal-state notifier. We don't render a final row (A-mode: the
	 * whole block collapses when the parent task ends), but we DO mark
	 * the slot as done so any in-flight late `progress` events can't
	 * write back to it after `subagentDone` fires.
	 */
	private handleSubagentLifecycle(payload: SubagentLifecyclePayload): void {
		if (payload.status === "started") return;
		const active = this.activeTask;
		if (!active) return;
		active.done.add(payload.index);
	}

	/** Fire-and-forget title generation after the first agent turn.
	 *  Uses OMP's built-in title-generator which picks `commit` or `smol`
	 *  role automatically and writes back via `session.setSessionName`. */
	private maybeGenerateTitle(): void {
		if (this.titleAttempted) return;
		const session = this.session;
		const first = this.firstUserText;
		if (!session || !first) return;
		// Don't overwrite a name that already exists (loaded from a resumed
		// session or set by `/name` if we add that later).
		if (session.sessionName) {
			this._titleAttempted = true;
			return;
		}
		this._titleAttempted = true;
		const log = this.log;
		void (async () => {
			try {
				const title = await generateSessionTitle(
					first,
					session.modelRegistry,
					session.settings,
					session.sessionId,
					session.model,
				);
				if (!title) {
					log.info("title.skipped", { reason: "generator_returned_null" });
					return;
				}
				const ok = await session.setSessionName(title, "auto");
				log.info("title.set", { title, ok });
				if (ok) this.fireOnTitleGenerated(title);
			} catch (err) {
				log.warn("title.failed", { err: String(err) });
			}
		})();
	}

	/** Invoke the bridge-supplied `onTitleGenerated` callback. Catches
	 *  both synchronous throws and rejected promises (the type allows
	 *  `async` callbacks via `Promise<void>` return) so a misbehaving
	 *  bridge can't escape the title path — which runs inside fire-and-
	 *  forget IIFEs and async setters whose rejections would otherwise
	 *  be unhandled. */
	private fireOnTitleGenerated(title: string): void {
		const cb = this.onTitleGenerated;
		if (!cb) return;
		const log = this.log;
		try {
			const ret = cb(title);
			if (ret && typeof (ret as Promise<unknown>).catch === "function") {
				(ret as Promise<unknown>).catch(err => {
					log.warn("title.callback_failed", { err: String(err) });
				});
			}
		} catch (err) {
			log.warn("title.callback_failed", { err: String(err) });
		}
	}

	/** Explicit user-supplied title. Persists to the session file as
	 *  source="user". Returns false if there's no active session or the
	 *  underlying setSessionName rejected. */
	async setTitle(name: string): Promise<boolean> {
		const session = this.session;
		if (!session) return false;
		const ok = await session.setSessionName(name, "user");
		this.log.info("title.user_set", { title: name, ok });
		// Treat a successful manual title as "we have a name now" so the
		// auto-generator won't try to clobber it on the next turn.
		if (ok) {
			this._titleAttempted = true;
			this.fireOnTitleGenerated(name);
		}
		return ok;
	}

	/** Force a fresh LLM-generated title regardless of prior state. Returns
	 *  the new title or undefined if no session, no first-message context,
	 *  or the generator returned null. */
	async regenerateTitle(): Promise<string | undefined> {
		const session = this.session;
		if (!session) return undefined;
		const first = this.firstUserText ?? extractFirstUserText(session.messages);
		if (!first) return undefined;
		try {
			const title = await generateSessionTitle(
				first,
				session.modelRegistry,
				session.settings,
				session.sessionId,
				session.model,
			);
			if (!title) {
				this.log.info("title.regen_skipped", { reason: "generator_returned_null" });
				return undefined;
			}
			const ok = await session.setSessionName(title, "auto");
			this.log.info("title.regen_set", { title, ok });
			this._titleAttempted = true;
			if (!ok) return undefined;
			this.fireOnTitleGenerated(title);
			return title;
		} catch (err) {
			this.log.warn("title.regen_failed", { err: String(err) });
			return undefined;
		}
	}

	/** Available models (with valid API keys) for the active session.
	 *  Lazily ensures a session so /model works on a cold chat too. */
	async getAvailableModels(): Promise<readonly Model[]> {
		const s = await this.ensure();
		return s.getAvailableModels();
	}

	/** Temporarily switch the default-role model for the active session.
	 *  Does NOT persist to global settings (Telegram-side choice shouldn't
	 *  leak into CLI default). Returns the model on success, undefined if
	 *  `id` isn't in the available list. */
	async setModelById(id: string): Promise<Model | undefined> {
		const s = await this.ensure();
		const model = s.getAvailableModels().find(m => m.id === id);
		if (!model) return undefined;
		await s.setModelTemporary(model);
		this.log.info("model.set", { id });
		return model;
	}

	/** Open an inline-keyboard picker listing available model ids and
	 *  apply the choice via setModelTemporary. Returns the chosen model,
	 *  or undefined on cancel / no models. */
	async promptModelSelection(): Promise<Model | undefined> {
		const s = await this.ensure();
		const models = s.getAvailableModels();
		if (models.length === 0) return undefined;
		const ids = models.map(m => m.id);
		const picked = await this.ui.select("pick model", ids);
		if (!picked) return undefined;
		const model = models.find(m => m.id === picked);
		if (!model) return undefined;
		await s.setModelTemporary(model);
		this.log.info("model.set", { id: model.id });
		return model;
	}

	/** Manually compact the active session's context.
	 *
	 *  Returns a discriminated result so the caller can render specific
	 *  user-facing messages without leaking errors. We refuse while the
	 *  agent is streaming — OMP's auto-compaction handles in-flight
	 *  overflow, and `session.compact()` would abort the live turn. */
	async compact(
		instructions?: string,
	): Promise<
		| { status: "no-session" }
		| { status: "busy" }
		| { status: "ok"; summary: string; tokensBefore: number; tokensAfter: number | null; contextWindow: number }
		| { status: "error"; message: string }
	> {
		const session = this.session;
		if (!session) return { status: "no-session" };
		if (session.isStreaming) return { status: "busy" };
		try {
			const result = await session.compact(instructions);
			const after = session.getContextUsage();
			const summary = result.shortSummary?.trim() || result.summary.trim();
			this.log.info("compact.ok", {
				tokens_before: result.tokensBefore,
				tokens_after: after?.tokens ?? null,
				instructions: instructions ?? null,
			});
			return {
				status: "ok",
				summary,
				tokensBefore: result.tokensBefore,
				tokensAfter: after?.tokens ?? null,
				contextWindow: after?.contextWindow ?? 0,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.log.warn("compact.failed", { err: message });
			return { status: "error", message };
		}
	}
}

export class ChatRegistry {
	/** Key: `${chatId}:${threadId ?? ""}`. Empty thread segment for DMs /
	 *  non-forum groups / forum General — same key as before forum
	 *  support, so non-forum behavior is unchanged. */
	private readonly chats = new Map<string, ChatSession>();

	constructor(
		private readonly bridge: Bridge,
		private readonly defaultCwd: string,
		private readonly store: ChatStore,
	) {}

	/** Build the per-route SessionRoute. Delegates to the active bridge
	 *  so ChatRegistry stays transport-neutral; the bridge picks the
	 *  scheme (telegram packs chatId:threadId, web mints `web:<n>`). */
	private route(chatId: ChatId, threadId?: number | string): SessionRoute {
		return this.bridge.route(chatId, threadId);
	}

	/** Resolve raw `chatId` into its bridge-prefixed ChatStore key.
	 *  Centralised here so command handlers never have to know which
	 *  bridge they're running under. */
	private bkey(chatId: ChatId): string {
		return this.bridge.bindingKey(chatId);
	}

	/** Three-level resolution: topic binding → group binding → defaultCwd. */
	cwdFor(chatId: ChatId, threadId?: number | string): string {
		return this.store.resolveCwd(this.bkey(chatId), threadId) ?? this.defaultCwd;
	}

	/** Get the group-level binding for a chat (no topic resolution). */
	getBinding(chatId: ChatId): ChatBinding | undefined {
		return this.store.get(this.bkey(chatId));
	}

	/** Get the topic-level binding, or undefined. */
	getTopicBinding(chatId: ChatId, threadId: number | string): TopicBinding | undefined {
		return this.store.getTopic(this.bkey(chatId), threadId);
	}

	/** Set a binding. `threadId` defined → topic-scope; else group-scope. */
	setBinding(
		chatId: ChatId,
		binding: { cwd: string; label?: string },
		opts: { threadId?: number | string } = {},
	): void {
		const k = this.bkey(chatId);
		if (opts.threadId !== undefined) {
			this.store.setTopic(k, opts.threadId, binding);
		} else {
			this.store.set(k, binding);
		}
	}

	/** Delete a binding. Returns false when nothing existed at that scope. */
	deleteBinding(chatId: ChatId, threadId?: number | string): boolean {
		const k = this.bkey(chatId);
		return threadId !== undefined
			? this.store.deleteTopic(k, threadId)
			: this.store.delete(k);
	}

	/** Topic ids configured under this chat's group binding. Strings are
	 *  the bridge-native id (Telegram numeric, Discord snowflake). */
	topicBindingIds(chatId: ChatId): string[] {
		return this.store.topicIds(this.bkey(chatId));
	}

	private key(chatId: ChatId, threadId?: number | string): string {
		return this.route(chatId, threadId).key;
	}

	get(chatId: ChatId, threadId?: number | string): ChatSession {
		const k = this.key(chatId, threadId);
		let chat = this.chats.get(k);
		if (!chat) {
			const route = this.route(chatId, threadId);
			chat = new ChatSession({
				chatId,
				threadId,
				cwd: this.cwdFor(chatId, threadId),
				transport: this.bridge.open(route),
				systemPromptAddendum: this.bridge.systemPromptAddendum(),
				sessionPin: this.makeSessionPin(chatId, threadId),
			});
			this.chats.set(k, chat);
		}
		return chat;
	}

	/** Build a SessionPin backed by the ChatStore topic binding for
	 *  bridges that opt into per-thread session pinning. Returns
	 *  undefined when pinning isn't applicable (bridge doesn't opt in,
	 *  or this is a group-level / non-threaded chat) — ChatSession
	 *  then falls back to its cwd-level newest-wins auto-resume. */
	private makeSessionPin(
		chatId: ChatId,
		threadId: number | string | undefined,
	): SessionPin | undefined {
		if (!this.bridge.pinsSessions) return undefined;
		if (threadId === undefined) return undefined;
		const bindingKey = this.bkey(chatId);
		const store = this.store;
		return {
			get: () => store.getTopic(bindingKey, threadId)?.sessionId,
			set: id => store.setTopicSession(bindingKey, threadId, id),
		};
	}

	/** Lookup without lazy-creating. Discord's interactionCreate uses
	 *  this to bail on stale taps (leftover buttons after a bot restart)
	 *  without paying the cost of constructing a fresh ChatSession +
	 *  AgentSession just to reply "expired". */
	peek(chatId: ChatId, threadId?: number | string): ChatSession | undefined {
		return this.chats.get(this.key(chatId, threadId));
	}

	all(): ChatSession[] {
		return [...this.chats.values()];
	}

	async disposeAll(): Promise<void> {
		await Promise.allSettled([...this.chats.values()].map(c => c.dispose()));
		this.chats.clear();
	}
}

/** Helper: list stored sessions for a cwd. */
export async function listStoredSessions(
	cwd: string,
	limit = 8,
): Promise<SessionInfo[]> {
	const sessions = await SessionManager.list(cwd);
	return sessions
		.sort((a, b) => b.modified.getTime() - a.modified.getTime())
		.slice(0, limit);
}
