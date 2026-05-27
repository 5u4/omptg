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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	Bridge,
	SessionRoute,
	SessionTransport,
	Streamer,
	Typing,
} from "../types.ts";
import type { ServerMsg, SessionEvent, SessionSummary, UiRequestPayload } from "./protocol.ts";
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
	subs: Map<string, number>; // routeKey -> last-seen seq
}

/** Persisted-to-disk snapshot of a web session's metadata. */
interface PersistedSession {
	key: string;
	cwd: string;
	sessionFile?: string;
	title: string;
	lastActivity: number;
}

interface PersistedState {
	version: 1;
	nextId: number;
	sessions: PersistedSession[];
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
		});
		this.typing = new WebTyping(this.setTurn);
	}

	newStreamer(_opts: { replyTo?: number }): Streamer {
		// `replyTo` is telegram-only; web has no reply anchor concept.
		return new WebStreamer(this.publish);
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
	/** routeKey → ring buffer of recent events. */
	private readonly rings = new Map<string, RingEntry[]>();
	/** routeKey → monotonic sequence number for events. */
	private readonly seqs = new Map<string, number>();
	/** routeKey → transport (idempotent open). */
	private readonly transports = new Map<string, WebTransport>();
	/** Active subscribers. */
	private readonly subscribers = new Set<Subscriber>();
	private persistTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(opts: WebBridgeOptions) {
		this.defaultCwd = opts.defaultCwd;
		this.stateFile = opts.stateFile ?? defaultStateFile();
		const loaded = loadState(this.stateFile);
		this.nextId = loaded.nextId;
		for (const s of loaded.sessions) this.sessions.set(s.key, s);
	}

	systemPromptAddendum(): string {
		return WEB_SYSTEM_BLOCK;
	}

	/** Web routes are minted, not derived from any external identifier.
	 *  Phase-1 contract still requires `route(chatId, threadId)`; we
	 *  ignore the args and either reuse an existing route by some
	 *  caller-side mapping (today: none) or mint a new one. ChatRegistry
	 *  is currently telegram-shaped so this signature stays compatible. */
	route(_chatId: number, _threadId?: number): SessionRoute {
		return this.mintRoute();
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
				lastActivity: s.lastActivity,
				turnActive: false, // server tracks live; ring doesn't
				sessionFile: s.sessionFile,
			}));
	}

	/** Apply a metadata patch — called by the server when ChatSession
	 *  fires `session.attached` / title generation / model change. */
	patchSession(key: string, patch: Partial<PersistedSession>): void {
		const cur = this.sessions.get(key);
		if (!cur) return;
		Object.assign(cur, patch, { lastActivity: Date.now() });
		this.schedulePersist();
		this.broadcast({ type: "session.updated", key, patch: {
			title: cur.title,
			cwd: cur.cwd,
			sessionFile: cur.sessionFile,
			lastActivity: cur.lastActivity,
		} });
	}

	removeSession(key: string): void {
		if (!this.sessions.delete(key)) return;
		this.transports.delete(key);
		this.rings.delete(key);
		this.seqs.delete(key);
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
		const nextSubs = new Map<string, number>();
		for (const s of subs) {
			nextSubs.set(s.key, s.since ?? 0);
			const ring = this.rings.get(s.key) ?? [];
			const tail = ring.filter(e => e.seq > (s.since ?? 0));
			if (tail.length > 0) {
				sub.send({
					type: "session.backfill",
					key: s.key,
					from: s.since ?? 0,
					events: tail,
				});
				nextSubs.set(s.key, tail[tail.length - 1]!.seq);
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
		this.fanout(key, { type: "session.turn", key, active });
	}

	private broadcastUiRequest(key: string, reqId: string, req: UiRequestPayload, awaitsText: boolean): void {
		this.fanout(key, { type: "ui.request", key, reqId, req: { ...req, awaitsText } });
	}

	private broadcastUiCancel(key: string, reqId: string): void {
		this.fanout(key, { type: "ui.cancel", key, reqId });
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
				version: 1,
				nextId: this.nextId,
				sessions: [...this.sessions.values()],
			};
			writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
		} catch (err) {
			log.warn("persist_failed", { err: String(err) });
		}
	}
}

function defaultStateFile(): string {
	const dir = join(homedir(), ".omptg");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return join(dir, "web-sessions.json");
}

function loadState(path: string): PersistedState {
	if (!existsSync(path)) return { version: 1, nextId: 1, sessions: [] };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedState>;
		if (parsed && parsed.version === 1 && Array.isArray(parsed.sessions) && typeof parsed.nextId === "number") {
			return { version: 1, nextId: parsed.nextId, sessions: parsed.sessions as PersistedSession[] };
		}
	} catch (err) {
		log.warn("load_failed", { err: String(err), path });
	}
	return { version: 1, nextId: 1, sessions: [] };
}
