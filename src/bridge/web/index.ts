/**
 * WebBridge — `Bridge` for the local web UI. Owns the per-route
 * transport cache, the broadcast/subscriber model, and a small on-disk
 * map from route key to session file so restart restores the list.
 *
 * Subscriber model:
 *   - Each ws connection subscribes to a set of route keys.
 *   - Per-route ring buffer (last 500 events) backfills new subscribers
 *     so tab switches don't lose events that arrived while the tab was
 *     unsubscribed. Lost on restart by design — omp's own session
 *     jsonl is the durable record.
 *
 * Persistence:
 *   - `~/.omptg/web-sessions.json` maps `web:<n> → { sessionFile, cwd, title, lastActivity }`.
 *   - Written on every meaningful change (debounced 250ms); read once
 *     on boot. Pure metadata — the actual session content lives in
 *     omp's jsonl.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, type Stats, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import type {
	Bridge,
	ChatId,
	SessionRoute,
	SessionTransport,
	Streamer,
	Typing,
} from "../types.ts";
import type { FolderSummary, ServerMsg, SessionEvent, SessionSummary, UiRequestPayload } from "./protocol.ts";
import { WebStreamer } from "./streamer.ts";
import { WebUI } from "./ui.ts";
import { scoped } from "../../logger.ts";

const log = scoped("web-bridge");

const WEB_SYSTEM_BLOCK = [
	"# Web UI output guidance",
	"",
	"You are talking to the user through a local web UI. Output is",
	"rendered as full GitHub-flavored markdown: headings, tables, fenced",
	"code blocks with syntax highlighting, lists, and links all work as",
	"expected. There is no character cap per message and no rate limit",
	"on streaming tokens.",
	"",
	"Prefer:",
	"  - GFM tables for genuine tabular data (3+ columns).",
	"  - Fenced code blocks with language tags for any code.",
	"  - Headings (`##`, `###`) to structure long responses.",
].join("\n");

const RING_CAP = 500;

interface RingEntry {
	seq: number;
	event: SessionEvent;
}

interface Subscriber {
	send(msg: ServerMsg): void;
	/** Set of route keys this subscriber currently cares about. */
	subs: Set<string>;
}

/** Persisted-to-disk snapshot of a web session's metadata. */
interface PersistedSession {
	key: string;
	cwd: string;
	sessionFile?: string;
	title: string;
	modelId?: string;
	lastActivity: number;
	/** Folder grouping; undefined = ungrouped. Immutable post-create
	 *  in this phase — no UI exists to move sessions between folders. */
	folderId?: string;
}

/** Persisted-to-disk snapshot of a folder. Same shape as the wire
 *  `FolderSummary`; kept separate so a future divergence (e.g. an
 *  internal-only field) doesn't leak into the protocol. */
interface PersistedFolder {
	id: string;
	name: string;
	cwd: string;
	createdAt: number;
}

interface PersistedState {
	version: 2;
	nextId: number;
	nextFolderId: number;
	sessions: PersistedSession[];
	folders: PersistedFolder[];
}

class WebTyping implements Typing {
	constructor(private readonly emit: (active: boolean) => void) {}
	start(): void { this.emit(true); }
	stop(): void { this.emit(false); }
}

class WebTransport implements SessionTransport {
	readonly ui: WebUI;
	readonly typing: WebTyping;

	constructor(
		private readonly route: SessionRoute,
		private readonly publish: (event: SessionEvent) => void,
		private readonly setTurn: (active: boolean) => void,
		private readonly postUiRequest: (reqId: string, req: UiRequestPayload, awaitsText: boolean) => void,
		private readonly cancelUiRequest: (reqId: string) => void,
	) {
		this.ui = new WebUI(route.key, {
			postRequest: this.postUiRequest,
			cancelRequest: this.cancelUiRequest,
			postNotice: (level, text) => this.publish({ kind: "notice", text: `[${level}] ${text}` }),
		});
		this.typing = new WebTyping(this.setTurn);
	}

	newStreamer(_opts: { replyTo?: number | string }): Streamer {
		// `replyTo` is telegram-only; web has no reply anchor concept.
		return new WebStreamer(this.publish);
	}

	async postSystemMessage(text: string, _opts?: { replyTo?: number | string; silent?: boolean }): Promise<void> {
		// Web has no separate "system message" channel — render via the
		// session-level notice event so subscribers see it inline next
		// to the turn it relates to. `replyTo` / `silent` are
		// telegram-only and intentionally ignored.
		this.publish({ kind: "notice", text });
	}

	async dispose(): Promise<void> {
		// Nothing to release locally — ws subscribers are owned by the bridge.
	}
}

export interface WebBridgeOptions {
	/** Default cwd for newly-created sessions when the client doesn't
	 *  specify one. Mirrors main.ts's DEFAULT_CWD resolution. */
	defaultCwd: string;
	/** Override the persistence path (tests). */
	stateFile?: string;
}

export class WebBridge implements Bridge {
	readonly kind = "web" as const;

	private readonly defaultCwd: string;
	private readonly stateFile: string;
	private nextId: number;
	/** routeKey → metadata. Mirrored to disk via `persist()`. */
	private readonly sessions = new Map<string, PersistedSession>();
	/** folderId → folder record. Mirrored to disk via `persist()`. */
	private readonly folders = new Map<string, PersistedFolder>();
	private nextFolderId = 1;
	/** routeKey → ring buffer of recent events. */
	private readonly rings = new Map<string, RingEntry[]>();
	/** routeKey → monotonic sequence number for events. */
	private readonly seqs = new Map<string, number>();
	/** routeKey → last-known turn-active state. Mirrored to subscribers
	 *  via `session.turn` events AND included in `listSessions()` so a
	 *  late subscriber sees the current state. */
	private readonly turnState = new Map<string, boolean>();
	/** routeKey → transport (idempotent open). */
	private readonly transports = new Map<string, WebTransport>();
	/** Active subscribers. */
	private readonly subscribers = new Set<Subscriber>();
	private persistTimer: ReturnType<typeof setTimeout> | undefined;
	/** Realpath'd `defaultCwd`. Used as the fallback for client cwd
	 *  requests that omit one. Resolved via realpathSync so a default
	 *  placed at a symlink (e.g. `~/.omptg → /var/data/omptg`) lands
	 *  on the canonical target. */
	private readonly canonicalDefaultCwd: string;

	constructor(opts: WebBridgeOptions) {
		this.defaultCwd = opts.defaultCwd;
		this.stateFile = opts.stateFile ?? defaultStateFile();
		const loaded = loadState(this.stateFile);
		this.nextId = loaded.nextId;
		this.nextFolderId = loaded.nextFolderId;
		for (const f of loaded.folders) this.folders.set(f.id, f);
		for (const s of loaded.sessions) this.sessions.set(s.key, s);
		this.canonicalDefaultCwd = canonicalize(opts.defaultCwd);
	}

	systemPromptAddendum(): string {
		return WEB_SYSTEM_BLOCK;
	}

	/** Web routes are minted, not derived from any external identifier.
	 *  Phase-1 contract still requires `route(chatId, threadId)`; we
	 *  ignore the args and either reuse an existing route by some
	 *  caller-side mapping (today: none) or mint a new one. ChatRegistry
	 *  is currently telegram-shaped so this signature stays compatible. */
	route(_chatId: ChatId, _threadId?: number | string): SessionRoute {
		return this.mintRoute();
	}

	/** Web ids are minted as `web:<n>` route keys; the persistent
	 *  binding key is just the route key verbatim. We don't currently
	 *  expose /bind on the web bridge — every web session starts in
	 *  its own route — but the method is required by the Bridge
	 *  contract and lets the shared ChatRegistry/ChatStore plumbing
	 *  treat all three bridges uniformly. */
	bindingKey(chatId: ChatId): string {
		const k = String(chatId);
		return k.startsWith("web:") ? k : `web:${k}`;
	}

	mintRoute(): SessionRoute {
		const id = this.nextId++;
		const key = `web:${id}`;
		const label = `web:${id}`;
		this.schedulePersist();
		return { key, label };
	}

	open(route: SessionRoute): SessionTransport {
		let t = this.transports.get(route.key);
		if (!t) {
			t = new WebTransport(
				route,
				event => this.recordAndBroadcast(route.key, event),
				active => this.broadcastTurn(route.key, active),
				(reqId, req, awaitsText) => this.broadcastUiRequest(route.key, reqId, req, awaitsText),
				reqId => this.broadcastUiCancel(route.key, reqId),
			);
			this.transports.set(route.key, t);
			if (!this.sessions.has(route.key)) {
				this.sessions.set(route.key, {
					key: route.key,
					cwd: this.defaultCwd,
					title: "",
					lastActivity: Date.now(),
				});
				this.schedulePersist();
			}
		}
		return t;
	}

	async dispose(): Promise<void> {
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = undefined;
		}
		this.persistNow();
		this.subscribers.clear();
		this.transports.clear();
	}

	// --- bridge ↔ server glue ----------------------------------------------

	defaultCwdValue(): string {
		return this.defaultCwd;
	}

	/** Snapshot for `session.list`. */
	listSessions(): SessionSummary[] {
		return [...this.sessions.values()]
			.sort((a, b) => b.lastActivity - a.lastActivity)
			.map(s => ({
				key: s.key,
				title: s.title,
				cwd: s.cwd,
				modelId: s.modelId,
				lastActivity: s.lastActivity,
				turnActive: this.turnState.get(s.key) ?? false,
				sessionFile: s.sessionFile,
				folderId: s.folderId,
			}));
	}

	/** Snapshot for `folder.list`. Ascending by `createdAt` per
	 *  Phase 5 §6.1; ties broken by id to keep order deterministic
	 *  when two folders land in the same millisecond. */
	listFolders(): FolderSummary[] {
		return [...this.folders.values()]
			.sort(compareFolders)
			.map(f => ({ id: f.id, name: f.name, cwd: f.cwd, createdAt: f.createdAt }));
	}

	/** Resolve a folder id to its recorded cwd. Server uses this to
	 *  force `session.open({folderId})` to land in the folder's cwd
	 *  regardless of what the client supplied. */
	folderCwd(id: string): string | undefined {
		return this.folders.get(id)?.cwd;
	}

	/** Create a folder. Caller is responsible for cwd validation
	 *  (same checks as session.open); the bridge stores whatever
	 *  it's handed. cwd uniqueness across folders is NOT enforced. */
	createFolder(input: { name: string; cwd: string }): { ok: true; folder: FolderSummary } | { ok: false; reason: "empty-name" | "name-too-long" } {
		// `input` lands here straight from the wire; coerce defensively
		// so a malformed payload (missing/non-string name) returns a
		// clean error envelope instead of throwing TypeError out of an
		// async ws message handler as an unhandled rejection.
		const name = typeof input.name === "string" ? input.name.trim() : "";
		if (!name) return { ok: false, reason: "empty-name" };
		if (name.length > 80) return { ok: false, reason: "name-too-long" };
		const id = `f:${this.nextFolderId++}`;
		const folder: PersistedFolder = { id, name, cwd: input.cwd, createdAt: Date.now() };
		this.folders.set(id, folder);
		this.schedulePersist();
		const summary: FolderSummary = { id, name, cwd: folder.cwd, createdAt: folder.createdAt };
		this.broadcast({ type: "folder.created", folder: summary });
		return { ok: true, folder: summary };
	}

	renameFolder(id: string, name: string): { ok: true } | { ok: false; reason: "unknown" | "empty-name" | "name-too-long" } {
		const cur = this.folders.get(id);
		if (!cur) return { ok: false, reason: "unknown" };
		const trimmed = typeof name === "string" ? name.trim() : "";
		if (!trimmed) return { ok: false, reason: "empty-name" };
		if (trimmed.length > 80) return { ok: false, reason: "name-too-long" };
		cur.name = trimmed;
		this.schedulePersist();
		this.broadcast({ type: "folder.updated", id, patch: { name: trimmed } });
		return { ok: true };
	}

	/** Apply a metadata patch — called by the server when ChatSession
	 *  fires `session.attached` / title generation / model change.
	 *  `touch` (default true) bumps `lastActivity` so the session
	 *  floats to the top of the rail; pass `false` for pure metadata
	 *  edits (e.g. user rename) that shouldn't change sort order. */
	patchSession(key: string, patch: Partial<PersistedSession>, opts: { touch?: boolean } = {}): void {
		const cur = this.sessions.get(key);
		if (!cur) return;
		// Filter empty-string `title` so a post-turn patch that runs
		// BEFORE title generation completes doesn't clobber an
		// existing title with "".
		const clean: Partial<PersistedSession> = { ...patch };
		if (clean.title === "") delete clean.title;
		const touch = opts.touch ?? true;
		Object.assign(cur, clean, touch ? { lastActivity: Date.now() } : {});
		this.schedulePersist();
		this.broadcast({ type: "session.updated", key, patch: {
			title: cur.title,
			cwd: cur.cwd,
			sessionFile: cur.sessionFile,
			modelId: cur.modelId,
			lastActivity: cur.lastActivity,
			folderId: cur.folderId,
		} });
	}

	removeSession(key: string): void {
		if (!this.sessions.delete(key)) return;
		this.transports.delete(key);
		this.rings.delete(key);
		this.seqs.delete(key);
		this.turnState.delete(key);
		this.schedulePersist();
		this.broadcast({ type: "session.removed", key });
	}

	addSubscriber(sub: Subscriber): void {
		this.subscribers.add(sub);
	}
	removeSubscriber(sub: Subscriber): void {
		this.subscribers.delete(sub);
	}

	/** Replace a subscriber's interest set; for each newly-added key,
	 *  send a backfill of events with seq > the supplied `since`. */
	applySubscription(sub: Subscriber, subs: Array<{ key: string; since?: number }>): void {
		const nextSubs = new Set<string>();
		for (const s of subs) {
			const since = s.since ?? 0;
			nextSubs.add(s.key);
			const ring = this.rings.get(s.key) ?? [];
			const tail = ring.filter(e => e.seq > since);
			// Always emit a backfill envelope (even with empty events)
			// so the client receives `earliestSeq` and can compute the
			// gap predicate `earliestSeq > since + 1`. For an empty
			// ring `earliestSeq = nextSeq` — i.e. the next event the
			// server will assign — which the client treats as "no
			// history, no gap".
			const earliestSeq = ring.length > 0 ? ring[0]!.seq : (this.seqs.get(s.key) ?? 0) + 1;
			sub.send({
				type: "session.backfill",
				key: s.key,
				from: since,
				earliestSeq,
				events: tail,
			});
			// Bring late subscribers up to date on turn-active state
			// — otherwise tab-switch mid-turn shows a stale idle UI.
			const active = this.turnState.get(s.key);
			if (active !== undefined) {
				sub.send({ type: "session.turn", key: s.key, active });
			}
		}
		sub.subs = nextSubs;
	}

	// --- internals ---------------------------------------------------------

	private nextSeq(key: string): number {
		const n = (this.seqs.get(key) ?? 0) + 1;
		this.seqs.set(key, n);
		return n;
	}

	private recordAndBroadcast(key: string, event: SessionEvent): void {
		const seq = this.nextSeq(key);
		const entry: RingEntry = { seq, event };
		const ring = this.rings.get(key) ?? [];
		ring.push(entry);
		if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);
		this.rings.set(key, ring);
		this.touch(key);
		this.fanout(key, { type: "session.event", key, seq, event });
	}

	private broadcastTurn(key: string, active: boolean): void {
		this.turnState.set(key, active);
		this.fanout(key, { type: "session.turn", key, active });
	}

	private broadcastUiRequest(key: string, reqId: string, req: UiRequestPayload, awaitsText: boolean): void {
		this.fanout(key, { type: "ui.request", key, reqId, req: { ...req, awaitsText } });
	}

	private broadcastUiCancel(key: string, reqId: string): void {
		this.fanout(key, { type: "ui.cancel", key, reqId });
	}

	/** Public form of broadcastUiCancel for server-side resolution paths
	 *  (when one ws client answers a ui.request, siblings need a cancel
	 *  envelope so they stop rendering the stale form). */
	broadcastUiCancelFor(key: string, reqId: string): void {
		this.broadcastUiCancel(key, reqId);
	}

	private fanout(key: string, msg: ServerMsg): void {
		for (const sub of this.subscribers) {
			if (sub.subs.has(key)) sub.send(msg);
		}
	}

	private broadcast(msg: ServerMsg): void {
		for (const sub of this.subscribers) sub.send(msg);
	}

	private touch(key: string): void {
		const cur = this.sessions.get(key);
		if (!cur) return;
		cur.lastActivity = Date.now();
		this.schedulePersist();
	}

	private schedulePersist(): void {
		if (this.persistTimer) return;
		this.persistTimer = setTimeout(() => {
			this.persistTimer = undefined;
			this.persistNow();
		}, 250);
	}

	private persistNow(): void {
		try {
			const state: PersistedState = {
				version: 2,
				nextId: this.nextId,
				nextFolderId: this.nextFolderId,
				sessions: [...this.sessions.values()],
				folders: [...this.folders.values()],
			};
			// Atomic: write to a sibling tmp then rename. A torn write
			// or SIGKILL between the writeFileSync and renameSync
			// leaves the previous good state on disk; without this a
			// crash mid-write empties the file and loadState resets
			// every session.
			const tmp = `${this.stateFile}.tmp`;
			writeFileSync(tmp, JSON.stringify(state, null, 2));
			renameSync(tmp, this.stateFile);
		} catch (err) {
			log.warn("persist_failed", { err: String(err) });
		}
	}

	/** Validate a client-supplied cwd. Empty / undefined falls back to
	 *  `defaultCwd`. Any absolute path is accepted; relative paths are
	 *  rejected so a malformed client can't accidentally rebase onto
	 *  process.cwd(). The result is realpath-canonicalized so two
	 *  routes to the same directory (symlink, trailing slash, etc.)
	 *  collapse to a single session/folder entry. */
	validateCwd(cwd: string | undefined): string | undefined {
		if (!cwd) return this.canonicalDefaultCwd;
		if (!isAbsolute(cwd)) return undefined;
		return canonicalize(resolvePath(cwd));
	}
	/** Stricter form of validateCwd: also stat-checks the resolved path
	 *  so the server can surface a specific reason instead of a generic
	 *  chat.ensure() failure several layers down.
	 *  - `denied`    — relative cwd, or stat hit EACCES/EPERM
	 *  - `missing`   — ENOENT (or any other stat failure besides EACCES)
	 *  - `not-a-directory` — exists but is a file/socket/etc. */
	resolveCwd(cwd: string | undefined): { ok: true; cwd: string } | { ok: false; reason: "denied" | "missing" | "not-a-directory" } {
		const allowed = this.validateCwd(cwd);
		if (!allowed) return { ok: false, reason: "denied" };
		let st: Stats;
		try {
			st = statSync(allowed);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "EACCES" || code === "EPERM") return { ok: false, reason: "denied" };
			return { ok: false, reason: "missing" };
		}
		if (!st.isDirectory()) return { ok: false, reason: "not-a-directory" };
		return { ok: true, cwd: allowed };
	}
}

function defaultStateFile(): string {
	const dir = join(homedir(), ".omptg");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return join(dir, "web-sessions.json");
}

function loadState(path: string): PersistedState {
	const empty: PersistedState = { version: 2, nextId: 1, nextFolderId: 1, sessions: [], folders: [] };
	if (!existsSync(path)) return empty;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as {
			version?: number;
			nextId?: number;
			nextFolderId?: number;
			sessions?: unknown;
			folders?: unknown;
		};
		if (!parsed || typeof parsed.nextId !== "number" || !Array.isArray(parsed.sessions)) return empty;
		const sessions = parsed.sessions as PersistedSession[];
		if (parsed.version === 2) {
			const folders = Array.isArray(parsed.folders) ? (parsed.folders as PersistedFolder[]) : [];
			const nextFolderId = reconcileNext(parsed.nextFolderId, folders, f => f.id);
			return { version: 2, nextId: parsed.nextId, nextFolderId, sessions, folders };
		}
		if (parsed.version === 1) {
			// v1 → v2: no folders existed; sessions land in Ungrouped
			// (folderId stays undefined — the new optional field on
			// PersistedSession simply isn't present in legacy JSON,
			// which JSON.parse leaves as `undefined`).
			return { version: 2, nextId: parsed.nextId, nextFolderId: 1, sessions, folders: [] };
		}
	} catch (err) {
		log.warn("load_failed", { err: String(err), path });
	}
	return empty;
}

/** Recover a monotonic-id counter from disk. Trusting `parsed.next`
 *  alone is fragile: a hand-edited or partially-restored state file
 *  with `next: 1` and existing `f:5` would re-mint `f:1` on the
 *  next create, silently overwriting the older entry in the Map.
 *  Reconcile by taking the max of the persisted counter and one past
 *  the highest existing numeric suffix. */
function reconcileNext<T>(persisted: unknown, items: readonly T[], idOf: (item: T) => string): number {
	let max = typeof persisted === "number" && Number.isFinite(persisted) ? persisted : 1;
	for (const item of items) {
		const tail = idOf(item).split(":")[1];
		const n = tail !== undefined ? Number(tail) : NaN;
		if (Number.isFinite(n) && n + 1 > max) max = n + 1;
	}
	return max;
}

/** Stable folder sort: ascending by `createdAt`, ties broken by the
 *  numeric suffix of `id`. Naive string compare would put `f:10`
 *  before `f:2`, which only bites when two folders land in the same
 *  millisecond but visibly diverges from the monotonic mint order. */
export function compareFolders(a: { createdAt: number; id: string }, b: { createdAt: number; id: string }): number {
	if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
	const an = Number(a.id.split(":")[1]);
	const bn = Number(b.id.split(":")[1]);
	if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
	// Fallback for non-`f:N` ids (shouldn't happen, but keep the
	// comparator total so sort is deterministic).
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Best-effort realpath: returns the canonical absolute path, or the
 *  input unchanged when the path doesn't exist on disk yet (caller
 *  surfaces a `missing` reason via resolveCwd's stat check). */
function canonicalize(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}
