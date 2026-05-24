/**
 * Per-chat agent runtime. One ChatSession owns:
 *   - the cwd it's bound to
 *   - the live AgentSession (recreated on /new, /dir, /resume)
 *   - the currently-rendering TelegramStreamer (one per in-flight turn)
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
	SessionInfo,
} from "@oh-my-pi/pi-coding-agent";
import type { Bot } from "grammy";
import { TelegramStreamer } from "./streamer.ts";
import { TelegramUI, type PendingUiRequest } from "./ui-bridge.ts";

export interface ChatSessionOptions {
	chatId: number;
	cwd: string;
	bot: Bot;
}

export class ChatSession {
	readonly chatId: number;
	cwd: string;
	private readonly bot: Bot;
	private session: AgentSession | undefined;
	private unsubscribe: (() => void) | undefined;
	private streamer: TelegramStreamer | undefined;
	private readonly ui: TelegramUI;

	constructor(opts: ChatSessionOptions) {
		this.chatId = opts.chatId;
		this.cwd = opts.cwd;
		this.bot = opts.bot;
		this.ui = new TelegramUI(opts.bot, opts.chatId);
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

	get isStreaming(): boolean {
		return this.session?.isStreaming ?? false;
	}

	/** Return existing session or create a fresh one in this chat's cwd. */
	async ensure(): Promise<AgentSession> {
		if (this.session) return this.session;
		return this.createFresh();
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
		});
		this.cwd = manager.getCwd();
		this.attach(created.session, created.setToolUIContext);
		return created.session;
	}

	async dispose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		if (this.session) {
			try {
				await this.session.dispose();
			} catch (err) {
				console.warn(`[chat ${this.chatId}] dispose failed:`, err);
			}
			this.session = undefined;
		}
		this.streamer = undefined;
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
		});
		if (created.modelFallbackMessage) {
			console.warn(
				`[chat ${this.chatId}] ${created.modelFallbackMessage}`,
			);
		}
		this.attach(created.session, created.setToolUIContext);
		return created.session;
	}

	private attach(
		session: AgentSession,
		setToolUIContext: (ctx: TelegramUI, hasUI: boolean) => void,
	): void {
		this.session = session;
		// Inject our telegram-backed UI before any tool can call into it.
		setToolUIContext(this.ui, true);
		this.unsubscribe = session.subscribe(e => this.handleEvent(e));
		console.log(
			`[chat ${this.chatId}] session ${session.sessionId} (cwd=${this.cwd})`,
		);
	}

	/** Send a user turn. Caller must wait via waitForIdle separately. */
	async prompt(text: string): Promise<TelegramStreamer> {
		const s = await this.ensure();
		const status = await this.bot.api.sendMessage(
			this.chatId,
			"✨ thinking…",
		);
		this.streamer = new TelegramStreamer(
			this.bot,
			this.chatId,
			status.message_id,
		);
		if (s.isStreaming) {
			await s.steer(text);
		} else {
			await s.prompt(text);
		}
		return this.streamer;
	}

	async abort(): Promise<boolean> {
		if (!this.session?.isStreaming) return false;
		await this.session.abort();
		return true;
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

	private handleEvent(event: AgentSessionEvent): void {
		const s = this.streamer;
		switch (event.type) {
			case "message_update": {
				const ame = event.assistantMessageEvent;
				if (ame.type === "text_delta") s?.pushDelta(ame.delta);
				break;
			}
			case "tool_execution_start": {
				const ev = event as { toolName?: string };
				if (ev.toolName) s?.pushStatus(`🔧 ${ev.toolName}`);
				break;
			}
			case "tool_execution_end": {
				s?.pushStatus("");
				break;
			}
			case "notice": {
				const n = event as { level: string; message: string };
				console.log(
					`[chat ${this.chatId}] notice/${n.level}: ${n.message}`,
				);
				break;
			}
			case "auto_retry_start": {
				const ev = event as { attempt: number; maxAttempts: number };
				s?.pushStatus(`🔄 retry ${ev.attempt}/${ev.maxAttempts}`);
				break;
			}
			default:
				break;
		}
	}
}

export class ChatRegistry {
	private readonly chats = new Map<number, ChatSession>();

	constructor(
		private readonly bot: Bot,
		private readonly defaultCwd: string,
	) {}

	get(chatId: number): ChatSession {
		let chat = this.chats.get(chatId);
		if (!chat) {
			chat = new ChatSession({
				chatId,
				cwd: this.defaultCwd,
				bot: this.bot,
			});
			this.chats.set(chatId, chat);
		}
		return chat;
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
