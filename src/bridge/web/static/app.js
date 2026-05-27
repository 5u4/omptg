/**
 * omptg web UI — Preact + signals single-page client.
 *
 * The store is a flat collection of @preact/signals, mutated on every
 * incoming `session.event` envelope. Components read from the signals
 * directly so token deltas only re-render the live bubble subtree
 * rather than the whole stream.
 *
 * Auto-scroll follows the standard chat-app pattern: stick to bottom
 * unless the user has scrolled up, then surface a "jump to latest"
 * affordance. Reconnect uses the protocol's `since`/`earliestSeq` for
 * gap detection.
 */
import { h, render } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { signal, computed, effect, batch } from "@preact/signals";
import htm from "htm";
import { marked } from "marked";
import DOMPurify from "dompurify";
import ReconnectingWebSocket from "reconnecting-websocket";

const html = htm.bind(h);

// --- markdown -------------------------------------------------------------

marked.setOptions({ gfm: true, breaks: false });

/** Render markdown to sanitized HTML. Sync (marked.parse), so the live
 *  bubble can re-render on every token delta without await. */
function md(src) {
	const raw = marked.parse(src ?? "");
	return DOMPurify.sanitize(raw);
}

// --- store ----------------------------------------------------------------

/** Flat session record. `events` is an array of typed display rows,
 *  built from incoming SessionEvent envelopes. */
function makeSession(summary) {
	return {
		key: summary.key,
		title: signal(summary.title || ""),
		cwd: signal(summary.cwd || ""),
		modelId: signal(summary.modelId || ""),
		sessionFile: signal(summary.sessionFile || ""),
		turnActive: signal(summary.turnActive ?? false),
		lastActivity: signal(summary.lastActivity ?? 0),
		unread: signal(0),
		events: signal([]),              // ordered display rows
		lastSeq: 0,                       // last seq we processed
		earliestSeq: 0,                   // server-reported earliest
		pendingUi: signal(null),          // active ui.request, if any
		// Live-bubble buffer: streaming token deltas accumulate here.
		// Cleared on `assistant` commit (final text replaces it).
		liveText: signal(""),
		liveActive: signal(false),
		// Per-tool state: id → { line, toolName, args, isError, result, done, expanded, subagents }
		tools: new Map(),
	};
}

const sessions = signal([]); // array of session records, sorted by lastActivity desc
const activeKey = signal(null);
const connState = signal("connecting"); // "live" | "down" | "connecting"

const activeSession = computed(() => sessions.value.find(s => s.key === activeKey.value));
const totalUnread = computed(() => sessions.value.reduce((sum, s) => sum + s.unread.value, 0));

function findSession(key) {
	return sessions.value.find(s => s.key === key);
}

function upsertSession(summary) {
	const existing = findSession(summary.key);
	if (existing) {
		batch(() => {
			if (summary.title !== undefined) existing.title.value = summary.title || existing.title.value;
			if (summary.cwd !== undefined) existing.cwd.value = summary.cwd;
			if (summary.modelId !== undefined) existing.modelId.value = summary.modelId || "";
			if (summary.sessionFile !== undefined) existing.sessionFile.value = summary.sessionFile || "";
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

function removeSession(key) {
	sessions.value = sessions.value.filter(s => s.key !== key);
	if (activeKey.value === key) activeKey.value = sessions.value[0]?.key ?? null;
}

function resortSessions() {
	sessions.value = [...sessions.value].sort((a, b) => b.lastActivity.value - a.lastActivity.value);
}

// --- event → display row reducer -----------------------------------------

/** Apply a SessionEvent to a session. Mutates the session's signals. */
function applyEvent(session, seq, ev) {
	session.lastSeq = Math.max(session.lastSeq, seq);
	// Always bump activity so list ordering follows real motion.
	session.lastActivity.value = Date.now();
	// Bump unread for the inactive sessions only.
	if (activeKey.value !== session.key) {
		session.unread.value = session.unread.value + 1;
	}

	switch (ev.kind) {
		case "text_delta":
			session.liveActive.value = true;
			session.liveText.value = session.liveText.value + ev.text;
			break;

		case "assistant":
			// Commit: flush the live bubble to a finalized assistant row,
			// then clear the live text so the next message can start fresh.
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
				subagents: new Map(),  // slotKey -> line
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
			// We thread them onto whichever tool entry is still running.
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
			// Live bubble seal: if there's accumulated text that never
			// got a matching `assistant` envelope (shouldn't happen but
			// belt + suspenders), commit it now.
			if (session.liveText.value) {
				pushRow(session, { kind: "assistant", text: session.liveText.value });
				session.liveText.value = "";
			}
			session.liveActive.value = false;
			break;
	}
}

function pushRow(session, row) {
	session.events.value = [...session.events.value, row];
}

/** Force a re-read of `events` for components that depend on it without
 *  pushing a new row (e.g. tool result arriving updates the existing
 *  tool card's state but doesn't add a row). */
function bumpEvents(session) {
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
	// On (re)open the server sends session.list; subscriptions get
	// re-issued in the session.list handler so backfill flows.
});
ws.addEventListener("close", () => { connState.value = "down"; });
ws.addEventListener("error", () => { connState.value = "down"; });

ws.addEventListener("message", e => {
	let msg;
	try { msg = JSON.parse(e.data); } catch { return; }
	handleServer(msg);
});

function send(msg) { ws.send(JSON.stringify(msg)); }

function handleServer(msg) {
	switch (msg.type) {
		case "session.list":
			batch(() => {
				const incoming = new Map(msg.sessions.map(s => [s.key, s]));
				// Reuse existing records (preserve unread / events) when
				// the key still exists; drop any not in the list.
				const next = [];
				for (const summary of msg.sessions) {
					const existing = findSession(summary.key);
					if (existing) {
						existing.title.value = summary.title || existing.title.value;
						existing.cwd.value = summary.cwd;
						existing.modelId.value = summary.modelId || "";
						existing.sessionFile.value = summary.sessionFile || "";
						existing.turnActive.value = summary.turnActive;
						existing.lastActivity.value = summary.lastActivity;
						next.push(existing);
					} else {
						next.push(makeSession(summary));
					}
				}
				sessions.value = next.sort((a, b) => b.lastActivity.value - a.lastActivity.value);
				if (!activeKey.value && next.length > 0) activeKey.value = next[0].key;
			});
			// Re-subscribe to whatever the active tab cares about.
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
			if (s) applyEvent(s, msg.seq, msg.event);
			break;
		}

		case "session.backfill": {
			const s = findSession(msg.key);
			if (!s) break;
			// Detect a ring-overflow gap: server's earliestSeq is greater
			// than the first seq we'd need to be contiguous with.
			s.earliestSeq = msg.earliestSeq;
			if (msg.from > 0 && msg.earliestSeq > msg.from + 1) {
				pushRow(s, {
					kind: "notice",
					text: `⚠ history gap: ${msg.earliestSeq - msg.from - 1} events dropped`,
				});
			}
			for (const e of msg.events) applyEvent(s, e.seq, e.event);
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

function resubscribe() {
	const subs = sessions.value.map(s => ({ key: s.key, since: s.lastSeq }));
	if (subs.length > 0) send({ type: "session.subscribe", subs });
}

// --- session ops ---------------------------------------------------------

function openNewSession() { send({ type: "session.open" }); }
function sendPrompt(key, text) {
	const trimmed = text.trim();
	if (!trimmed) return;
	send({ type: "session.send", key, text: trimmed });
	// Optimistically render the user's message; the server doesn't echo it.
	const s = findSession(key);
	if (s) pushRow(s, { kind: "user", text: trimmed });
}
function abortTurn(key) { send({ type: "session.abort", key }); }
function closeSession(key) {
	if (!confirm("Close this session? (omp keeps the jsonl on disk.)")) return;
	send({ type: "session.close", key });
}
function respondUi(key, reqId, value) {
	send({ type: "ui.response", key, reqId, value });
	const s = findSession(key);
	if (s) s.pendingUi.value = null;
}

// Clear unread + switch active session.
function selectSession(key) {
	activeKey.value = key;
	const s = findSession(key);
	if (s) s.unread.value = 0;
}

// --- window title -------------------------------------------------------

effect(() => {
	const n = totalUnread.value;
	const a = activeSession.value;
	const base = a ? (a.title.value || a.key) : "omptg";
	document.title = (n > 0 ? `(${n}) ` : "") + base;
});

// --- components ---------------------------------------------------------

function Rail() {
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

function SessionItem({ session }) {
	const active = activeKey.value === session.key;
	const unread = session.unread.value;
	const turn = session.turnActive.value;
	const title = session.title.value || session.key;
	const cwd = session.cwd.value.split("/").slice(-2).join("/") || session.cwd.value;
	return html`
		<div class="session-item ${active ? "active" : ""}" onClick=${() => selectSession(session.key)}>
			<div class="meta">
				<div class="title">${title}</div>
				<div class="cwd">${cwd}</div>
			</div>
			${unread > 0 && !active ? html`<div class="unread">${unread}</div>` : null}
			${turn ? html`<div class="turn-pulse" title="turn active"></div>` : null}
		</div>
	`;
}

function Pane() {
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

function PaneHeader({ session }) {
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

function Stream({ session }) {
	const ref = useRef(null);
	const stickRef = useRef(true);
	const hasUnreadBelow = useRef(false);

	// Auto-scroll: stick to bottom unless the user scrolled up. We only
	// scroll on the events-changed tick (not every signal write) to avoid
	// thrashing on every token delta — `liveText` updates produce a single
	// reflow per delta via the bubble's innerHTML update, and we
	// scroll-to-bottom after by reading scroll geometry post-render.
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const onScroll = () => {
			const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
			stickRef.current = atBottom;
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => el.removeEventListener("scroll", onScroll);
	}, []);

	// Effect re-runs whenever events/liveText change (signal access).
	useEffect(() => {
		// Touch the signals so this effect subscribes to them.
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
			${rows.map((row, i) => html`<${Row} key=${i} row=${row} session=${session} />`)}
			${liveActive || live
				? html`<div class="msg-assistant streaming" dangerouslySetInnerHTML=${{ __html: md(live || " ") }}></div>`
				: null}
			${pending ? html`<${UiForm} session=${session} req=${pending} />` : null}
		</div>
	`;
}

function Row({ row, session }) {
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
		default:
			return null;
	}
}

function ToolCard({ toolCallId, session }) {
	// Read events.value so we re-render when bumpEvents fires.
	void session.events.value;
	const t = session.tools.get(toolCallId);
	if (!t) return null;
	const status = !t.done ? "running" : t.isError ? "error" : "ok";
	const icon = !t.done ? html`<span class="spinner"></span>` : t.isError ? "❌" : "✓";
	const toggle = () => { t.expanded = !t.expanded; bumpEvents(session); };
	return html`
		<div class="tool ${status}">
			<div class="tool-header ${t.expanded ? "open" : ""}" onClick=${toggle}>
				${typeof icon === "string" ? html`<span class="icon">${icon}</span>` : icon}
				<div class="label">${t.line}</div>
				<span class="chevron">▶</span>
			</div>
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

function fmt(v) {
	if (typeof v === "string") return v;
	try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function UiForm({ session, req }) {
	const respond = value => respondUi(session.key, req.reqId, value);
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
		default:
			return null;
	}
}

function InputForm({ req, respond }) {
	const ref = useRef(null);
	useEffect(() => { ref.current?.focus(); }, []);
	const submit = () => {
		const v = ref.current?.value ?? "";
		respond(v);
	};
	return html`
		<div class="ui-form">
			<div class="title">❓ ${req.title}${req.placeholder ? ` (${req.placeholder})` : ""}</div>
			<textarea ref=${ref} defaultValue=${req.prefill ?? ""}
				onKeyDown=${e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }}
			></textarea>
			<div class="row">
				<button onClick=${submit}>submit (⌘↵)</button>
				<button onClick=${() => respond(null)}>cancel</button>
			</div>
		</div>
	`;
}

function Composer({ session }) {
	const ref = useRef(null);
	const submit = () => {
		const v = ref.current?.value ?? "";
		if (!v.trim()) return;
		sendPrompt(session.key, v);
		ref.current.value = "";
		// Reset textarea height after clearing.
		if (ref.current) ref.current.style.height = "auto";
	};
	const onKeyDown = e => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			submit();
		}
	};
	const onInput = e => {
		// Auto-grow up to 200px.
		const ta = e.currentTarget;
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

function App() {
	return html`
		<div class="shell">
			<${Rail} />
			<${Pane} />
		</div>
	`;
}

render(html`<${App} />`, document.getElementById("app"));
