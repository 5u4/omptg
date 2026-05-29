/**
 * WebSocket wire protocol between the web bridge server and browser
 * clients. Envelopes are JSON-serialized; every message carries a
 * discriminating `type` field. `key` is a SessionRoute key (the web
 * bridge mints `web:<n>`), opaque to the client.
 *
 * Design notes:
 *  - Single ws connection multiplexes every session the client cares
 *    about; subscribe/unsubscribe is explicit so the server only fans
 *    out events for active tabs.
 *  - Server keeps a per-session ring buffer of recent events so a fresh
 *    subscribe gets backfill (avoids losing events that arrived between
 *    tab switches). Buffer is in-memory only; on restart we resume the
 *    omp session from its jsonl file.
 *  - `session.event` envelopes carry typed payloads, NOT raw SDK
 *    AgentSessionEvent. ChatSession's Streamer methods are the single
 *    source of truth for what the user sees; WebStreamer emits one
 *    envelope per Streamer call. This keeps the two transport
 *    implementations (telegram, web) in parity on the rendering
 *    boundary and avoids exposing SDK internals over the wire.
 */
import type { PendingUiRequest } from "../types.ts";

/** High-level snapshot of a session, used by `session.list`. */
export interface SessionSummary {
	key: string;
	title: string;
	cwd: string;
	modelId?: string;
	/** Last server-side activity timestamp (ms epoch). Drives sort order
	 *  in the session list and the per-session "last seen" line. */
	lastActivity: number;
	turnActive: boolean;
	/** Session file path on disk (for resume / inspection). undefined
	 *  before the first prompt has run on a fresh session. */
	sessionFile?: string;
	/** Folder grouping; undefined = ungrouped. */
	folderId?: string;
}

/** Folder grouping for the session rail. A folder is a thin UI
 *  pointer: a name + a default cwd. The server does NOT enforce cwd
 *  uniqueness across folders — multiple folders may point at the
 *  same working directory, and ungrouped sessions may share a cwd
 *  with a folder. Folder is purely a grouping label. */
export interface FolderSummary {
	id: string;          // "f:<n>", monotonic
	name: string;        // user-supplied; trimmed; non-empty; length ≤ 80
	cwd: string;         // canonicalized absolute path
	createdAt: number;
}

/** UI dialog the agent posted; client renders an inline form and answers
 *  with `ui.response`. Mirrors the four ExtensionUIContext.* dialogs. */
export type UiRequestPayload =
	| { kind: "select"; title: string; options: string[] }
	| { kind: "confirm"; title: string; message: string }
	| { kind: "input"; title: string; placeholder?: string }
	| { kind: "editor"; title: string; prefill?: string };

/** Per-session events the streamer emits. One envelope per Streamer call
 *  so the client renders incrementally without parsing prose. */
export type SessionEvent =
	/** Streaming token from the active assistant message. Concatenate
	 *  into the current "live" bubble until `assistant` arrives with the
	 *  finalized text (which may differ — model retries, etc.). */
	| { kind: "text_delta"; text: string }
	/** Final assistant text for one message-end. Replaces any
	 *  accumulated deltas for the live bubble and seals it. */
	| { kind: "assistant"; text: string }
	/** Mid-turn preamble heartbeat (short truncation). Telegram shows
	 *  this as a one-line `💭` row; web renders as a faint inline note. */
	| { kind: "preamble"; text: string }
	/** Tool started. `line` is the pre-rendered header (emoji + tool +
	 *  one-line args). `args` is the raw JSON for the expandable body. */
	| { kind: "tool_start"; toolCallId: string; line: string; toolName: string; args: unknown }
	/** Tool finished. `line` is set when there's a new render to show
	 *  (errors); on success it's undefined and the start line stays. */
	| { kind: "tool_end"; toolCallId: string; isError: boolean; line?: string; result?: unknown }
	/** Informational line (retries, notices). */
	| { kind: "notice"; text: string }
	/** Subagent row inside an active `task` tool. `key` is the slot id;
	 *  successive emits with the same key overwrite the row. */
	| { kind: "subagent_line"; slotKey: string; line: string }
	/** Collapse a group of subagent rows when the parent task ends. */
	| { kind: "subagent_collapse"; slotKeys: readonly string[] }
	/** Fatal: replace the in-progress turn with this verbatim text. */
	| { kind: "replace"; text: string }
	/** Streamer reached `finalize()`. Frontend marks the turn done. */
	| { kind: "finalize" };

// --- Server → Client --------------------------------------------------------

export type ServerMsg =
	| { type: "session.list"; sessions: SessionSummary[] }
	| { type: "session.created"; session: SessionSummary }
	| { type: "session.updated"; key: string; patch: Partial<SessionSummary> }
	| { type: "session.removed"; key: string }
	| { type: "folder.list"; folders: FolderSummary[] }
	| { type: "folder.created"; folder: FolderSummary }
	| { type: "folder.updated"; id: string; patch: Partial<Pick<FolderSummary, "name">> }
	| { type: "session.event"; key: string; seq: number; event: SessionEvent }
	| { type: "session.turn"; key: string; active: boolean }
	| { type: "session.backfill"; key: string; from: number; earliestSeq: number; events: Array<{ seq: number; event: SessionEvent }> }
	| { type: "ui.request"; key: string; reqId: string; req: UiRequestPayload & { awaitsText: boolean } }
	| { type: "ui.cancel"; key: string; reqId: string }
	| { type: "error"; message: string; cause?: string };

// --- Client → Server --------------------------------------------------------

export type ClientMsg =
	/** Create a fresh session bound to `cwd` (default cwd if omitted).
	 *  When `folderId` is set the server resolves the folder, uses
	 *  the folder's recorded cwd, and tags the new session with
	 *  `folderId`. A client-supplied `cwd` is ignored in that case. */
	| { type: "session.open"; cwd?: string; folderId?: string }
	/** Resume an existing omp session file as a new web session. */
	| { type: "session.resume"; sessionFile: string; cwd?: string }
	| { type: "folder.create"; name: string; cwd: string }
	| { type: "folder.rename"; id: string; name: string }
	| { type: "session.rename"; key: string; title: string }
	/** Send a user turn. */
	| { type: "session.send"; key: string; text: string }
	/** Abort the in-flight turn. */
	| { type: "session.abort"; key: string }
	/** Replace this connection's subscription set. Server fans out
	 *  `session.event` only for keys in the current set, and sends
	 *  `session.backfill` for keys newly added (events with seq > the
	 *  client-supplied `since` for that key). */
	| { type: "session.subscribe"; subs: Array<{ key: string; since?: number }> }
	/** Dispose a session (close the omp session, drop from the list). */
	| { type: "session.close"; key: string }
	/** Answer a pending ui.request. */
	| { type: "ui.response"; key: string; reqId: string; value: unknown };

/** Re-export so consumers don't need a second import for the dialog
 *  metadata shape that ui.request carries. */
export type { PendingUiRequest };
