/**
 * omptg web UI — Preact + signals single-page client.
 *
 * The store is a flat collection of @preact/signals, mutated on every
 * incoming `session.event` envelope. Components read from the signals
 * directly so token deltas only re-render the live bubble subtree
 * rather than the whole stream.
 *
 * Auto-scroll sticks to the bottom unless the user has scrolled up;
 * a manual scroll-down re-attaches. (No explicit "jump to latest"
 * button — keep this in mind if you find yourself looking for one.)
 * Reconnect uses the protocol's `since`/`earliestSeq` for gap
 * detection.
 */
import { h, render, type VNode } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { batch, computed, effect, signal, type Signal } from "@preact/signals";
import htm from "htm";
import { marked } from "marked";
import DOMPurify from "dompurify";
import ReconnectingWebSocket from "reconnecting-websocket";

import type {
	ClientMsg,
	ServerMsg,
	SessionEvent,
	SessionSummary,
	UiRequestPayload,
} from "../protocol.ts";

// htm.bind is generic over the hyperscript fn; let TS infer the result.
const html = htm.bind(h) as (strings: TemplateStringsArray, ...values: unknown[]) => VNode;

// --- markdown -------------------------------------------------------------

marked.setOptions({ gfm: true, breaks: false });

/** Render markdown to sanitized HTML. Sync (marked.parse), so the live
 *  bubble can re-render on every token delta without await. */
function md(src: string): string {
	const raw = marked.parse(src ?? "", { async: false }) as string;
	return DOMPurify.sanitize(raw);
}

// --- store ----------------------------------------------------------------

/** A pending `ui.request` rendered as an inline form. Carried via the
 *  server's ui.request envelope; cleared on ui.cancel or local resolve. */
type PendingUi = UiRequestPayload & { reqId: string; awaitsText: boolean };

/** Per-tool render state. Mutated in-place; bumpEvents() forces a
 *  re-render of any subscribed components since the Map identity stays
 *  the same. */
interface ToolState {
	toolCallId: string;
	toolName: string;
	line: string;
	args: unknown;
	result: unknown;
	isError: boolean;
	done: boolean;
	expanded: boolean;
	subagents: Map<string, string>;  // slotKey -> rendered line
}

/** Discriminated display row types — what `Stream` actually renders. */
type Row =
	| { kind: "user"; text: string }
	| { kind: "assistant"; text: string }
	| { kind: "preamble"; text: string }
	| { kind: "notice"; text: string }
	| { kind: "replace"; text: string }
	| { kind: "tool"; toolCallId: string };

interface Session {
	key: string;
	title: Signal<string>;
	cwd: Signal<string>;
	modelId: Signal<string>;
	sessionFile: Signal<string>;
	turnActive: Signal<boolean>;
	lastActivity: Signal<number>;
	unread: Signal<number>;
	events: Signal<Row[]>;
	lastSeq: number;
	earliestSeq: number;
	pendingUi: Signal<PendingUi | null>;
	liveText: Signal<string>;
	liveActive: Signal<boolean>;
	tools: Map<string, ToolState>;
}

function makeSession(summary: Partial<SessionSummary> & { key: string }): Session {
	return {
		key: summary.key,
		title: signal(summary.title ?? ""),
		cwd: signal(summary.cwd ?? ""),
		modelId: signal(summary.modelId ?? ""),
		sessionFile: signal(summary.sessionFile ?? ""),
		turnActive: signal(summary.turnActive ?? false),
		lastActivity: signal(summary.lastActivity ?? 0),
		unread: signal(0),
		events: signal<Row[]>([]),
		lastSeq: 0,
		earliestSeq: 0,
		pendingUi: signal<PendingUi | null>(null),
		liveText: signal(""),
		liveActive: signal(false),
		tools: new Map(),
	};
}

const sessions = signal<Session[]>([]);
const activeKey = signal<string | null>(null);
const connState = signal<"live" | "down" | "connecting">("connecting");

const activeSession = computed(() => sessions.value.find(s => s.key === activeKey.value));
const totalUnread = computed(() => sessions.value.reduce((sum, s) => sum + s.unread.value, 0));

function findSession(key: string): Session | undefined {
	return sessions.value.find(s => s.key === key);
}

function upsertSession(summary: Partial<SessionSummary> & { key: string }): Session {
	const existing = findSession(summary.key);
	if (existing) {
		batch(() => {
			if (summary.title !== undefined && summary.title !== "") existing.title.value = summary.title;
			if (summary.cwd !== undefined) existing.cwd.value = summary.cwd;
			if (summary.modelId !== undefined) existing.modelId.value = summary.modelId;
			if (summary.sessionFile !== undefined) existing.sessionFile.value = summary.sessionFile;
			if (summary.turnActive !== undefined) existing.turnActive.value = summary.turnActive;
			if (summary.lastActivity !== undefined) existing.lastActivity.value = summary.lastActivity;
		});
		return existing;
	}
	const s = makeSession(summary);
	sessions.value = [...sessions.value, s];
	resortSessions();
	return s;
}

function removeSession(key: string): void {
	sessions.value = sessions.value.filter(s => s.key !== key);
	if (activeKey.value === key) activeKey.value = sessions.value[0]?.key ?? null;
}

function resortSessions(): void {
	sessions.value = [...sessions.value].sort((a, b) => b.lastActivity.value - a.lastActivity.value);
}

// --- event → display row reducer -----------------------------------------

/** Event kinds that surface to the user as a discrete "message"
 *  worth counting toward the unread badge. Streaming token deltas and
 *  subagent row updates are excluded — they're sub-message noise. */
const UNREAD_WORTHY = new Set<SessionEvent["kind"]>([
	"assistant", "preamble", "notice", "replace", "tool_start",
]);
function isUnreadWorthy(kind: SessionEvent["kind"]): boolean {
	return UNREAD_WORTHY.has(kind);
}

/** Event kinds that represent real session motion — used for both the
 *  rail's activity sort key and the unread bump. Excludes text_delta
 *  (would resort on every token) and subagent_line/_collapse (sub-tool
 *  noise that doesn't change the rail's top-level state). */
const MOTION = new Set<SessionEvent["kind"]>([
	"assistant", "preamble", "notice", "replace",
	"tool_start", "tool_end", "finalize",
]);
function isMotion(kind: SessionEvent["kind"]): boolean {
	return MOTION.has(kind);
}


/** Apply a SessionEvent to a session. Mutates the session's signals.
 *
 *  `isLive` distinguishes a freshly-arrived event from a backfilled
 *  historical one. Live events bump `lastActivity` (resorts the rail)
 *  and `unread` (drives the badge); backfill replay must NOT, because
 *  a tab-switch reconnect would otherwise reorder the list and flood
 *  every inactive session with a phantom unread count proportional to
 *  its event history. */
function applyEvent(session: Session, seq: number, ev: SessionEvent, isLive: boolean): void {
	session.lastSeq = Math.max(session.lastSeq, seq);
	if (isLive && isMotion(ev.kind)) {
		// Update lastActivity (rail sort key) only on motion-level
		// events. text_delta would otherwise resort the rail on every
		// token, hammering the DOM during streaming.
		session.lastActivity.value = Date.now();
		resortSessions();
		// Bump unread only on user-perceptible events for inactive
		// tabs. Counting every text_delta would let one streaming reply
		// land hundreds of "unread" on an inactive tab.
		if (activeKey.value !== session.key && isUnreadWorthy(ev.kind)) {
			session.unread.value = session.unread.value + 1;
		}
	}

	switch (ev.kind) {
		case "text_delta":
			session.liveActive.value = true;
			session.liveText.value = session.liveText.value + ev.text;
			break;

		case "assistant":
			pushRow(session, { kind: "assistant", text: ev.text });
			session.liveText.value = "";
			session.liveActive.value = false;
			break;

		case "preamble":
			pushRow(session, { kind: "preamble", text: ev.text });
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
				expanded: false,
				subagents: new Map(),
			});
			pushRow(session, { kind: "tool", toolCallId: ev.toolCallId });
			break;

		case "tool_end": {
			const t = session.tools.get(ev.toolCallId);
			if (t) {
				t.done = true;
				t.isError = ev.isError;
				t.result = ev.result;
				if (ev.line) t.line = ev.line;
				bumpEvents(session);
			}
			break;
		}

		case "subagent_line": {
			// Subagent rows always belong to the most recent active task.
			const lastTask = [...session.tools.values()].reverse().find(t => !t.done && t.toolName === "task");
			if (lastTask) {
				lastTask.subagents.set(ev.slotKey, ev.line);
				bumpEvents(session);
			}
			break;
		}

		case "subagent_collapse": {
			const lastTask = [...session.tools.values()].reverse().find(t => t.toolName === "task");
			if (lastTask) {
				for (const k of ev.slotKeys) lastTask.subagents.delete(k);
				bumpEvents(session);
			}
			break;
		}

		case "notice":
			pushRow(session, { kind: "notice", text: ev.text });
			break;

		case "replace":
			pushRow(session, { kind: "replace", text: ev.text });
			session.liveText.value = "";
			session.liveActive.value = false;
			break;

		case "finalize":
			if (session.liveText.value) {
				pushRow(session, { kind: "assistant", text: session.liveText.value });
				session.liveText.value = "";
			}
			session.liveActive.value = false;
			break;
	}
}

function pushRow(session: Session, row: Row): void {
	session.events.value = [...session.events.value, row];
}

/** Force a re-read of `events` for components that depend on it without
 *  pushing a new row (e.g. tool result update mutates the existing card
 *  in place via its Map entry). */
function bumpEvents(session: Session): void {
	session.events.value = [...session.events.value];
}

// --- ws client -----------------------------------------------------------

const ws = new ReconnectingWebSocket(
	`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
	[],
	{ maxEnqueuedMessages: 10, maxRetries: Infinity },
);

ws.addEventListener("open", () => {
	connState.value = "live";
	// session.list will arrive shortly; subscribe inside that handler so
	// per-session `since` is set to lastSeq (drives backfill correctly).
});
ws.addEventListener("close", () => { connState.value = "down"; });
ws.addEventListener("error", () => { connState.value = "down"; });

ws.addEventListener("message", (e: MessageEvent<string>) => {
	let msg: ServerMsg;
	try { msg = JSON.parse(e.data) as ServerMsg; }
	catch { return; }
	handleServer(msg);
});

function send(msg: ClientMsg): void { ws.send(JSON.stringify(msg)); }

function handleServer(msg: ServerMsg): void {
	switch (msg.type) {
		case "session.list":
			batch(() => {
				const next: Session[] = [];
				for (const summary of msg.sessions) {
					const existing = findSession(summary.key);
					if (existing) {
						if (summary.title) existing.title.value = summary.title;
						existing.cwd.value = summary.cwd;
						existing.modelId.value = summary.modelId ?? "";
						existing.sessionFile.value = summary.sessionFile ?? "";
						existing.turnActive.value = summary.turnActive;
						existing.lastActivity.value = summary.lastActivity;
						next.push(existing);
					} else {
						next.push(makeSession(summary));
					}
				}
				sessions.value = next.sort((a, b) => b.lastActivity.value - a.lastActivity.value);
				if (!activeKey.value && next.length > 0) activeKey.value = next[0]!.key;
			});
			resubscribe();
			break;

		case "session.created":
			upsertSession(msg.session);
			activeKey.value = msg.session.key;
			resubscribe();
			break;

		case "session.updated":
			upsertSession({ key: msg.key, ...msg.patch });
			break;

		case "session.removed":
			removeSession(msg.key);
			break;

		case "session.event": {
			const s = findSession(msg.key);
			if (s) applyEvent(s, msg.seq, msg.event, true);
			break;
		}

		case "session.backfill": {
			const s = findSession(msg.key);
			if (!s) break;
			s.earliestSeq = msg.earliestSeq;
			// Detect a ring-overflow gap: server's earliestSeq is greater
			// than the first seq we'd need to be contiguous with.
			if (msg.from > 0 && msg.earliestSeq > msg.from + 1) {
				pushRow(s, {
					kind: "notice",
					text: `⚠ history gap: ${msg.earliestSeq - msg.from - 1} events dropped`,
				});
			}
			for (const e of msg.events) applyEvent(s, e.seq, e.event, false);
			break;
		}

		case "session.turn": {
			const s = findSession(msg.key);
			if (s) s.turnActive.value = msg.active;
			break;
		}

		case "ui.request": {
			const s = findSession(msg.key);
			if (s) s.pendingUi.value = { reqId: msg.reqId, ...msg.req };
			break;
		}

		case "ui.cancel": {
			const s = findSession(msg.key);
			if (s && s.pendingUi.value?.reqId === msg.reqId) s.pendingUi.value = null;
			break;
		}

		case "error":
			console.warn("[server error]", msg.message, msg.cause);
			break;
	}
}

function resubscribe(): void {
	const subs = sessions.value.map(s => ({ key: s.key, since: s.lastSeq }));
	if (subs.length > 0) send({ type: "session.subscribe", subs });
}

// --- session ops ---------------------------------------------------------

function openNewSession(): void { send({ type: "session.open" }); }

function sendPrompt(key: string, text: string): void {
	const trimmed = text.trim();
	if (!trimmed) return;
	send({ type: "session.send", key, text: trimmed });
	// Optimistically render the user's bubble; server doesn't echo it.
	const s = findSession(key);
	if (s) pushRow(s, { kind: "user", text: trimmed });
}

function abortTurn(key: string): void { send({ type: "session.abort", key }); }

function closeSession(key: string): void {
	if (!confirm("Close this session? (omp keeps the jsonl on disk.)")) return;
	send({ type: "session.close", key });
}

function respondUi(key: string, reqId: string, value: unknown): void {
	send({ type: "ui.response", key, reqId, value });
	const s = findSession(key);
	if (s) s.pendingUi.value = null;
}

function selectSession(key: string): void {
	activeKey.value = key;
	const s = findSession(key);
	if (s) s.unread.value = 0;
}

// --- window title --------------------------------------------------------

effect(() => {
	const n = totalUnread.value;
	const a = activeSession.value;
	const base = a ? (a.title.value || a.key) : "omptg";
	document.title = (n > 0 ? `(${n}) ` : "") + base;
});

// --- components ----------------------------------------------------------

function Rail(): VNode {
	return html`
		<div class="rail">
			<div class="rail-header">
				<div class="brand">omptg</div>
				<div class="status ${connState.value}">${connState.value}</div>
			</div>
			<div class="rail-actions">
				<button onClick=${openNewSession}>+ new session</button>
			</div>
			<div class="session-list">
				${sessions.value.length === 0
					? html`<div class="empty" style="padding: 24px;">no sessions yet</div>`
					: sessions.value.map(s => html`<${SessionItem} key=${s.key} session=${s} />`)}
		</div>
		</div>
	`;
}

function SessionItem({ session }: { session: Session }): VNode {
	const active = activeKey.value === session.key;
	const unread = session.unread.value;
	const turn = session.turnActive.value;
	const title = session.title.value || session.key;
	// Split on both POSIX and Windows separators so the rail label
	// reads sensibly regardless of which OS the server runs on.
	const cwdParts = session.cwd.value.split(/[/\\]/).filter(Boolean);
	const cwd = cwdParts.slice(-2).join("/") || session.cwd.value;
	return html`
		<button
			type="button"
			class="session-item ${active ? "active" : ""}"
			aria-current=${active ? "true" : "false"}
			onClick=${() => selectSession(session.key)}
		>
			<div class="meta">
				<div class="title">${title}</div>
				<div class="cwd">${cwd}</div>
			</div>
			${unread > 0 && !active ? html`<div class="unread" aria-label=${`${unread} unread`}>${unread}</div>` : null}
			${turn ? html`<div class="turn-pulse" aria-label="turn active" title="turn active"></div>` : null}
		</button>
	`;
}

function Pane(): VNode {
	const session = activeSession.value;
	if (!session) {
		return html`<div class="pane"><div class="empty">
			<div>Open a session to get started.</div>
			<button onClick=${openNewSession}>+ new session</button>
		</div></div>`;
	}
	return html`
		<div class="pane">
			<${PaneHeader} session=${session} />
			<${Stream} session=${session} />
			<${Composer} session=${session} />
		</div>
	`;
}

function PaneHeader({ session }: { session: Session }): VNode {
	return html`
		<div class="pane-header">
			<div>
				<div class="title">${session.title.value || session.key}</div>
				<div class="subtitle">${session.cwd.value}${session.modelId.value ? ` · ${session.modelId.value}` : ""}</div>
			</div>
			<div class="actions">
				${session.turnActive.value ? html`<button onClick=${() => abortTurn(session.key)}>abort</button>` : null}
				<button onClick=${() => closeSession(session.key)}>close</button>
			</div>
		</div>
	`;
}

function Stream({ session }: { session: Session }): VNode {
	const ref = useRef<HTMLDivElement>(null);
	const stickRef = useRef(true);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const onScroll = (): void => {
			const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
			stickRef.current = atBottom;
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => el.removeEventListener("scroll", onScroll);
	}, []);

	// Re-runs whenever events/liveText change (signal access).
	useEffect(() => {
		void session.events.value;
		void session.liveText.value;
		const el = ref.current;
		if (el && stickRef.current) {
			el.scrollTop = el.scrollHeight;
		}
	});

	const rows = session.events.value;
	const live = session.liveText.value;
	const liveActive = session.liveActive.value;
	const pending = session.pendingUi.value;

	return html`
		<div class="stream" ref=${ref}>
			${rows.length === 0 && !live && !liveActive
				? html`<div class="empty">No messages yet. Say something.</div>`
				: null}
			${rows.map((row, i) => html`<${RowView} key=${i} row=${row} session=${session} />`)}
			${liveActive || live
				? html`<div class="msg-assistant streaming" dangerouslySetInnerHTML=${{ __html: md(live || " ") }}></div>`
				: null}
			${pending ? html`<${UiForm} session=${session} req=${pending} />` : null}
		</div>
	`;
}

function RowView({ row, session }: { row: Row; session: Session }): VNode | null {
	switch (row.kind) {
		case "user":
			return html`<div class="msg-user">${row.text}</div>`;
		case "assistant":
			return html`<div class="msg-assistant" dangerouslySetInnerHTML=${{ __html: md(row.text) }}></div>`;
		case "preamble":
			return html`<div class="notice">💭 ${row.text}</div>`;
		case "notice":
			return html`<div class="notice ${row.text.startsWith("[error]") ? "error" : ""}">${row.text}</div>`;
		case "replace":
			return html`<div class="notice replace">${row.text}</div>`;
		case "tool":
			return html`<${ToolCard} toolCallId=${row.toolCallId} session=${session} />`;
	}
}

function ToolCard({ toolCallId, session }: { toolCallId: string; session: Session }): VNode | null {
	// Subscribe to events.value so bumpEvents triggers re-render.
	void session.events.value;
	const t = session.tools.get(toolCallId);
	if (!t) return null;
	const status = !t.done ? "running" : t.isError ? "error" : "ok";
	const toggle = (): void => { t.expanded = !t.expanded; bumpEvents(session); };
	return html`
		<div class="tool ${status}">
			<button
				type="button"
				class="tool-header ${t.expanded ? "open" : ""}"
				aria-expanded=${t.expanded ? "true" : "false"}
				onClick=${toggle}
			>
				${!t.done
					? html`<span class="spinner"></span>`
					: html`<span class="icon">${t.isError ? "❌" : "✓"}</span>`}
				<div class="label">${t.line}</div>
				<span class="chevron">▶</span>
			</button>
			${t.subagents.size > 0 ? html`
				<div class="subagents">
					${[...t.subagents.entries()].map(([k, line]) => html`<div class="subagent-row" key=${k}>${line}</div>`)}
				</div>
			` : null}
			${t.expanded ? html`
				<div class="tool-body">
					${t.args !== undefined ? html`
						<div class="section-label">args</div>
						${fmt(t.args)}
					` : null}
					${t.done && t.result !== undefined ? html`
						<div class="section-label">result</div>
						${fmt(t.result)}
					` : null}
				</div>
			` : null}
		</div>
	`;
}

function fmt(v: unknown): string {
	if (typeof v === "string") return v;
	try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function UiForm({ session, req }: { session: Session; req: PendingUi }): VNode | null {
	const respond = (value: unknown): void => respondUi(session.key, req.reqId, value);
	switch (req.kind) {
		case "select":
			return html`
				<div class="ui-form">
					<div class="title">❓ ${req.title}</div>
					<div class="options">
						${req.options.map(opt => html`<button onClick=${() => respond(opt)}>${opt}</button>`)}
						<button onClick=${() => respond(null)}>cancel</button>
					</div>
				</div>
			`;
		case "confirm":
			return html`
				<div class="ui-form">
					<div class="title">❓ ${req.title}</div>
					<div class="message">${req.message}</div>
					<div class="row">
						<button onClick=${() => respond(true)}>yes</button>
						<button onClick=${() => respond(false)}>no</button>
					</div>
				</div>
			`;
		case "input":
		case "editor":
			return html`<${InputForm} req=${req} respond=${respond} />`;
	}
}

function InputForm({ req, respond }: {
	req: PendingUi & { kind: "input" | "editor" };
	respond: (value: unknown) => void;
}): VNode {
	const ref = useRef<HTMLTextAreaElement>(null);
	useEffect(() => { ref.current?.focus(); }, []);
	const submit = (): void => {
		respond(ref.current?.value ?? "");
	};
	const placeholder = req.kind === "input" ? req.placeholder : undefined;
	const prefill = req.kind === "editor" ? req.prefill : undefined;
	return html`
		<div class="ui-form">
			<div class="title">❓ ${req.title}${placeholder ? ` (${placeholder})` : ""}</div>
			<textarea ref=${ref} defaultValue=${prefill ?? ""}
				onKeyDown=${(e: KeyboardEvent) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }}
			></textarea>
			<div class="row">
				<button onClick=${submit}>submit (⌘↵)</button>
				<button onClick=${() => respond(null)}>cancel</button>
			</div>
		</div>
	`;
}

function Composer({ session }: { session: Session }): VNode {
	const ref = useRef<HTMLTextAreaElement>(null);
	const submit = (): void => {
		const v = ref.current?.value ?? "";
		if (!v.trim()) return;
		sendPrompt(session.key, v);
		if (ref.current) {
			ref.current.value = "";
			ref.current.style.height = "auto";
		}
	};
	const onKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			submit();
		}
	};
	const onInput = (e: Event): void => {
		// Auto-grow up to 200px.
		const ta = e.currentTarget as HTMLTextAreaElement;
		ta.style.height = "auto";
		ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
	};
	return html`
		<div class="composer">
			<textarea ref=${ref} placeholder="Send a message (Enter to send, Shift+Enter for newline)"
				onKeyDown=${onKeyDown} onInput=${onInput}
			></textarea>
			<button class="send" onClick=${submit}>send</button>
		</div>
	`;
}

function App(): VNode {
	return html`
		<div class="shell">
			<${Rail} />
			<${Pane} />
		</div>
	`;
}

const root = document.getElementById("app");
if (!root) throw new Error("missing #app");
render(html`<${App} />`, root);
