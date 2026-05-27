/**
 * Reactive store for the web UI. Svelte 5 runes outside a component
 * via `.svelte.ts` — same model as the prior @preact/signals store,
 * just with first-class language reactivity.
 *
 * Design notes mirrored from the original:
 *  - Per-session state is a plain class with `$state` fields so
 *    components that read `session.title` re-render only that subtree.
 *  - `applyEvent` reduces a SessionEvent into row pushes + signal
 *    writes. Backfill replay calls with `isLive: false` so historical
 *    events don't bump `unread` or `lastActivity`.
 *  - Unread bumps only on user-perceptible (UNREAD_WORTHY) events;
 *    text_delta firehose would otherwise destroy the badge.
 */
import type {
	ClientMsg,
	ServerMsg,
	SessionEvent,
	SessionSummary,
	UiRequestPayload,
} from "../../../../protocol.ts";
import ReconnectingWebSocket from "reconnecting-websocket";

/** Pending ui.request rendered as an inline form. */
export type PendingUi = UiRequestPayload & { reqId: string; awaitsText: boolean };

/** Per-tool render state (mutated in-place; the containing Map identity
 *  in `Session.tools` doesn't change, components subscribe to
 *  `session.eventsVersion` to know when to re-render). */
export interface ToolState {
	toolCallId: string;
	toolName: string;
	line: string;
	args: unknown;
	result: unknown;
	isError: boolean;
	done: boolean;
	subagents: Map<string, string>;
}

export type Row =
	| { kind: "user"; text: string }
	| { kind: "assistant"; text: string }
	| { kind: "preamble"; text: string }
	| { kind: "notice"; text: string }
	| { kind: "replace"; text: string }
	| { kind: "tool"; toolCallId: string };

const UNREAD_WORTHY = new Set<SessionEvent["kind"]>([
	"assistant", "preamble", "notice", "replace", "tool_start",
]);
const MOTION = new Set<SessionEvent["kind"]>([
	"assistant", "preamble", "notice", "replace",
	"tool_start", "tool_end", "finalize",
]);

export class Session {
	readonly key: string;
	title = $state("");
	cwd = $state("");
	modelId = $state("");
	sessionFile = $state("");
	turnActive = $state(false);
	lastActivity = $state(0);
	unread = $state(0);
	rows = $state<Row[]>([]);
	liveText = $state("");
	liveActive = $state(false);
	pendingUi = $state<PendingUi | null>(null);
	/** Monotonic counter bumped by mutations to in-place structures
	 *  (tools Map) so components depending on derived views can rerun. */
	eventsVersion = $state(0);

	lastSeq = 0;
	earliestSeq = 0;
	readonly tools = new Map<string, ToolState>();
	/** toolCallId of the currently-running `task` tool, if any. The
	 *  main agent serializes tool calls, so at most one `task` is
	 *  active at a time; subagent_line/_collapse target this one.
	 *  Without it we used to scan all tools per subagent event,
	 *  which is O(n) and allocates a copied array each call. */
	activeTaskCallId: string | undefined = undefined;

	constructor(summary: Partial<SessionSummary> & { key: string }) {
		this.key = summary.key;
		this.title = summary.title ?? "";
		this.cwd = summary.cwd ?? "";
		this.modelId = summary.modelId ?? "";
		this.sessionFile = summary.sessionFile ?? "";
		this.turnActive = summary.turnActive ?? false;
		this.lastActivity = summary.lastActivity ?? 0;
	}
}

class Store {
	sessions = $state<Session[]>([]);
	activeKey = $state<string | null>(null);
	connState = $state<"live" | "down" | "connecting">("connecting");

	activeSession = $derived(this.sessions.find(s => s.key === this.activeKey));
	totalUnread = $derived(this.sessions.reduce((sum, s) => sum + s.unread, 0));

	find(key: string): Session | undefined {
		return this.sessions.find(s => s.key === key);
	}

	upsert(summary: Partial<SessionSummary> & { key: string }): Session {
		const existing = this.find(summary.key);
		if (existing) {
			if (summary.title && summary.title !== "") existing.title = summary.title;
			if (summary.cwd !== undefined) existing.cwd = summary.cwd;
			if (summary.modelId !== undefined) existing.modelId = summary.modelId;
			if (summary.sessionFile !== undefined) existing.sessionFile = summary.sessionFile;
			if (summary.turnActive !== undefined) existing.turnActive = summary.turnActive;
			if (summary.lastActivity !== undefined) existing.lastActivity = summary.lastActivity;
			return existing;
		}
		const s = new Session(summary);
		this.sessions = [...this.sessions, s];
		this.resort();
		return s;
	}

	remove(key: string): void {
		this.sessions = this.sessions.filter(s => s.key !== key);
		if (this.activeKey === key) this.activeKey = this.sessions[0]?.key ?? null;
	}

	resort(): void {
		this.sessions = [...this.sessions].sort((a, b) => b.lastActivity - a.lastActivity);
	}

	select(key: string): void {
		this.activeKey = key;
		const s = this.find(key);
		if (s) s.unread = 0;
	}

	apply(session: Session, seq: number, ev: SessionEvent, isLive: boolean): void {
		session.lastSeq = Math.max(session.lastSeq, seq);
		if (isLive && MOTION.has(ev.kind)) {
			session.lastActivity = Date.now();
			this.resort();
			if (this.activeKey !== session.key && UNREAD_WORTHY.has(ev.kind)) {
				session.unread = session.unread + 1;
			}
		}

		switch (ev.kind) {
			case "text_delta":
				session.liveActive = true;
				session.liveText = session.liveText + ev.text;
				break;
			case "assistant":
				session.rows = [...session.rows, { kind: "assistant", text: ev.text }];
				session.liveText = "";
				session.liveActive = false;
				break;
			case "preamble":
				session.rows = [...session.rows, { kind: "preamble", text: ev.text }];
				break;
			case "tool_start":
				session.tools.set(ev.toolCallId, {
					toolCallId: ev.toolCallId,
					toolName: ev.toolName,
					line: ev.line,
					args: ev.args,
					result: undefined,
					isError: false,
					done: false,
					subagents: new Map(),
				});
				if (ev.toolName === "task") session.activeTaskCallId = ev.toolCallId;
				session.rows = [...session.rows, { kind: "tool", toolCallId: ev.toolCallId }];
				break;
			case "tool_end": {
				const t = session.tools.get(ev.toolCallId);
				if (t) {
					t.done = true;
					t.isError = ev.isError;
					t.result = ev.result;
					if (ev.line) t.line = ev.line;
					session.eventsVersion += 1;
				}
				if (session.activeTaskCallId === ev.toolCallId) {
					session.activeTaskCallId = undefined;
				}
				break;
			}
			case "subagent_line": {
				const id = session.activeTaskCallId;
				if (!id) break;
				const task = session.tools.get(id);
				if (task) {
					task.subagents.set(ev.slotKey, ev.line);
					session.eventsVersion += 1;
				}
				break;
			}
			case "subagent_collapse": {
				// `subagent_collapse` typically fires alongside the task's
				// tool_end, so the active id may already be cleared by
				// then; fall back to scanning by slot ownership in that
				// case (still O(n) but rare and bounded).
				const id = session.activeTaskCallId;
				const task = id ? session.tools.get(id)
					: [...session.tools.values()].reverse().find(t => t.toolName === "task");
				if (task) {
					for (const k of ev.slotKeys) task.subagents.delete(k);
					session.eventsVersion += 1;
				}
				break;
			}
			case "notice":
				session.rows = [...session.rows, { kind: "notice", text: ev.text }];
				break;
			case "replace":
				session.rows = [...session.rows, { kind: "replace", text: ev.text }];
				session.liveText = "";
				session.liveActive = false;
				break;
			case "finalize":
				if (session.liveText) {
					session.rows = [...session.rows, { kind: "assistant", text: session.liveText }];
					session.liveText = "";
				}
				session.liveActive = false;
				break;
		}
	}
}

export const store = new Store();

// --- ws client -----------------------------------------------------------

const ws = new ReconnectingWebSocket(
	`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
	[],
	{ maxEnqueuedMessages: 10, maxRetries: Infinity },
);

ws.addEventListener("open", () => { store.connState = "live"; });
ws.addEventListener("close", () => { store.connState = "down"; });
ws.addEventListener("error", () => { store.connState = "down"; });

ws.addEventListener("message", (e: MessageEvent<string>) => {
	let msg: ServerMsg;
	try { msg = JSON.parse(e.data) as ServerMsg; } catch { return; }
	handle(msg);
});

function send(msg: ClientMsg): void { ws.send(JSON.stringify(msg)); }

function handle(msg: ServerMsg): void {
	switch (msg.type) {
		case "session.list": {
			const next: Session[] = [];
			for (const summary of msg.sessions) {
				const existing = store.find(summary.key);
				if (existing) {
					if (summary.title) existing.title = summary.title;
					existing.cwd = summary.cwd;
					existing.modelId = summary.modelId ?? "";
					existing.sessionFile = summary.sessionFile ?? "";
					existing.turnActive = summary.turnActive;
					existing.lastActivity = summary.lastActivity;
					next.push(existing);
				} else {
					next.push(new Session(summary));
				}
			}
			store.sessions = next.sort((a, b) => b.lastActivity - a.lastActivity);
			if (!store.activeKey && next.length > 0) store.activeKey = next[0]!.key;
			resubscribe();
			break;
		}
		case "session.created":
			store.upsert(msg.session);
			store.activeKey = msg.session.key;
			resubscribe();
			break;
		case "session.updated":
			store.upsert({ key: msg.key, ...msg.patch });
			break;
		case "session.removed":
			store.remove(msg.key);
			break;
		case "session.event": {
			const s = store.find(msg.key);
			if (s) store.apply(s, msg.seq, msg.event, true);
			break;
		}
		case "session.backfill": {
			const s = store.find(msg.key);
			if (!s) break;
			s.earliestSeq = msg.earliestSeq;
			if (msg.from > 0 && msg.earliestSeq > msg.from + 1) {
				s.rows = [...s.rows, {
					kind: "notice",
					text: `⚠ history gap: ${msg.earliestSeq - msg.from - 1} events dropped`,
				}];
			}
			for (const e of msg.events) store.apply(s, e.seq, e.event, false);
			break;
		}
		case "session.turn": {
			const s = store.find(msg.key);
			if (s) s.turnActive = msg.active;
			break;
		}
		case "ui.request": {
			const s = store.find(msg.key);
			if (s) s.pendingUi = { reqId: msg.reqId, ...msg.req };
			break;
		}
		case "ui.cancel": {
			const s = store.find(msg.key);
			if (s && s.pendingUi?.reqId === msg.reqId) s.pendingUi = null;
			break;
		}
		case "error":
			console.warn("[server error]", msg.message, msg.cause);
			break;
	}
}

function resubscribe(): void {
	const subs = store.sessions.map(s => ({ key: s.key, since: s.lastSeq }));
	if (subs.length > 0) send({ type: "session.subscribe", subs });
}

// --- session ops ---------------------------------------------------------

export function openNewSession(): void { send({ type: "session.open" }); }

export function sendPrompt(key: string, text: string): void {
	const trimmed = text.trim();
	if (!trimmed) return;
	send({ type: "session.send", key, text: trimmed });
	const s = store.find(key);
	if (s) s.rows = [...s.rows, { kind: "user", text: trimmed }];
}

export function abortTurn(key: string): void { send({ type: "session.abort", key }); }

export function closeSession(key: string): void {
	if (!confirm("Close this session? (omp keeps the jsonl on disk.)")) return;
	send({ type: "session.close", key });
}

export function respondUi(key: string, reqId: string, value: unknown): void {
	send({ type: "ui.response", key, reqId, value });
	const s = store.find(key);
	if (s) s.pendingUi = null;
}
