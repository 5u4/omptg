/**
 * Web bridge HTTP + WebSocket server. Each ws connection multiplexes
 * any number of session subscriptions; HTTP routes serve the static
 * frontend (phase 3) plus a JSON health endpoint.
 *
 * Authorization: bind to 127.0.0.1 only; no auth. Phase 2's threat
 * model is "single local user on their workstation". Remote access is
 * explicitly out of scope.
 */
import type { Server, ServerWebSocket } from "bun";
import { join } from "node:path";
import { ChatSession } from "../../chat.ts";
import { scoped } from "../../logger.ts";
import type { ClientMsg, ServerMsg, SessionSummary } from "./protocol.ts";
import { WebBridge } from "./index.ts";

const STATIC_DIR = join(import.meta.dir, "static");

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
};

/**
 * Serve a single static file out of src/bridge/web/static. Returns null
 * for unmatched paths so the caller can 404. Path traversal is rejected
 * by requiring the resolved file to stay under STATIC_DIR.
 */
async function serveStatic(pathname: string): Promise<Response | null> {
	const rel = pathname === "/" ? "/index.html" : pathname;
	// Reject absolute-escape and `..` segments: `Bun.file(join(dir, rel))`
	// would happily walk out of STATIC_DIR otherwise.
	if (rel.includes("..") || rel.includes("\0")) return null;
	const path = join(STATIC_DIR, rel);
	if (!path.startsWith(STATIC_DIR)) return null;
	const file = Bun.file(path);
	if (!(await file.exists())) return null;
	const ext = (rel.match(/\.[a-z0-9]+$/i)?.[0] ?? "").toLowerCase();
	const type = MIME[ext] ?? "application/octet-stream";
	return new Response(file, { headers: { "content-type": type } });
}

const log = scoped("web-server");

interface WsState {
	id: number;
	send(msg: ServerMsg): void;
	subs: Set<string>;
}

let nextWsId = 1;

export interface WebServerOptions {
	host?: string;
	port?: number;
	bridge: WebBridge;
}

export interface RunningServer {
	server: Server<unknown>;
	stop(): Promise<void>;
}

export function startWebServer(opts: WebServerOptions): RunningServer {
	const host = opts.host ?? "127.0.0.1";
	const port = opts.port ?? 7878;
	const { bridge } = opts;

	/** Per-route ChatSession. Web routes are minted; ChatRegistry's
	 *  telegram-shaped (chatId:threadId) keying doesn't apply, so we
	 *  keep a direct map here. */
	const chats = new Map<string, ChatSession>();

	/** Per-route serialization tail for user-driven turns. Two concurrent
	 *  ws clients firing session.send for the same route used to race
	 *  inside ChatSession.prompt() — the second call overwrote the first
	 *  turn's WebStreamer, leaving the first turn without a `finalize`
	 *  envelope (subscribers waited forever). Chaining sends per route
	 *  preserves the one-streamer-per-turn invariant and naturally lets
	 *  the second send appear as a steer of the next turn rather than
	 *  silently clobbering the in-flight one. */
	const turnTails = new Map<string, Promise<void>>();

	function getOrCreateChat(routeKey: string, cwd: string): ChatSession {
		let chat = chats.get(routeKey);
		if (!chat) {
			// chatId is purely for logger scoping in ChatSession; extract
			// the numeric tail of `web:<n>` so logs are readable.
			const idStr = routeKey.startsWith("web:") ? routeKey.slice(4) : "0";
			const chatId = Number(idStr) || 0;
			chat = new ChatSession({
				chatId,
				cwd,
				transport: bridge.open({ key: routeKey, label: routeKey }),
				systemPromptAddendum: bridge.systemPromptAddendum(),
			});
			chats.set(routeKey, chat);
		}
		return chat;
	}


	/**
	 * Get a live ChatSession for `routeKey`, rehydrating from disk if
	 * the server was restarted and the session is only known via the
	 * persisted summary (cwd + sessionFile). Returns undefined when no
	 * such session exists at all. Resume failures (e.g. the jsonl was
	 * moved) drop the persisted entry and return undefined — the
	 * client will see `session.removed` next subscribe.
	 */
	async function getOrRehydrate(routeKey: string): Promise<ChatSession | undefined> {
		const live = chats.get(routeKey);
		if (live) return live;
		const summary = summaryFor(routeKey);
		if (!summary) return undefined;
		const cwdCheck = bridge.resolveCwd(summary.cwd);
		if (!cwdCheck.ok) {
			// Persisted cwd is no longer valid (allowlist changed,
			// directory deleted, etc.). Don't silently fall back to the
			// recorded string — that would bypass the allowlist or
			// rehydrate into a missing path. Drop the ghost entry so
			// the client sees session.removed on the next subscribe.
			log.warn("rehydrate.cwd_rejected", {
				key: routeKey,
				cwd: summary.cwd,
				reason: cwdCheck.reason,
			});
			bridge.removeSession(routeKey);
			return undefined;
		}
		const chat = getOrCreateChat(routeKey, cwdCheck.cwd);
		if (summary.sessionFile) {
			try {
				await chat.resume(summary.sessionFile);
			} catch (err) {
				log.warn("rehydrate.resume_failed", { key: routeKey, err: String(err) });
				chats.delete(routeKey);
				await chat.dispose().catch(() => {});
				bridge.removeSession(routeKey);
				return undefined;
			}
		}
		return chat;
	}

	/** Tear down a route that failed before we ever broadcast a
	 *  session.created — without this, a failed open/resume leaves a
	 *  ghost entry in session.list that the client can't drive. */
	async function cleanupRoute(routeKey: string): Promise<void> {
		const chat = chats.get(routeKey);
		chats.delete(routeKey);
		if (chat) {
			try { await chat.dispose(); } catch { /* already failing */ }
		}
		bridge.removeSession(routeKey);
	}
	function summaryFor(routeKey: string): SessionSummary | undefined {
		const all = bridge.listSessions();
		return all.find(s => s.key === routeKey);
	}

	async function handleClient(state: WsState, raw: string): Promise<void> {
		let msg: ClientMsg;
		try { msg = JSON.parse(raw) as ClientMsg; }
		catch { state.send({ type: "error", message: "invalid json" }); return; }

		switch (msg.type) {
			case "session.open": {
				const r = bridge.resolveCwd(msg.cwd);
				if (!r.ok) {
					state.send({ type: "error", message: `cwd ${r.reason}: ${msg.cwd ?? "<default>"}` });
					return;
				}
				const cwd = r.cwd;
				const route = bridge.mintRoute();
				const chat = getOrCreateChat(route.key, cwd);
				try { await chat.newSession(); } catch (err) {
					state.send({ type: "error", message: "failed to open session", cause: String(err) });
					await cleanupRoute(route.key);
					return;
				}
				bridge.patchSession(route.key, {
					cwd,
					sessionFile: chat.sessionFile,
					title: chat.sessionName ?? "",
					modelId: chat.modelId,
				});
				const s = summaryFor(route.key);
				if (s) state.send({ type: "session.created", session: s });
				break;
			}
			case "session.resume": {
				const r = bridge.resolveCwd(msg.cwd);
				if (!r.ok) {
					state.send({ type: "error", message: `cwd ${r.reason}: ${msg.cwd ?? "<default>"}` });
					return;
				}
				const cwd = r.cwd;
				const route = bridge.mintRoute();
				const chat = getOrCreateChat(route.key, cwd);
				try { await chat.resume(msg.sessionFile); } catch (err) {
					state.send({ type: "error", message: "resume failed", cause: String(err) });
					await cleanupRoute(route.key);
					return;
				}
				bridge.patchSession(route.key, {
					cwd: chat.cwd,
					sessionFile: chat.sessionFile,
					title: chat.sessionName ?? "",
					modelId: chat.modelId,
				});
				const s = summaryFor(route.key);
				if (s) state.send({ type: "session.created", session: s });
				break;
			}
			case "session.send": {
				const chat = await getOrRehydrate(msg.key);
				if (!chat) { state.send({ type: "error", message: `unknown session ${msg.key}` }); return; }
				// Chain after any in-flight turn for this route so two
				// concurrent sends don't race inside ChatSession.prompt().
				const prior = turnTails.get(msg.key) ?? Promise.resolve();
				const next = prior.then(async () => {
					await runOneTurn(chat, msg.key, msg.text);
					// Title / modelId may have changed during the turn
					// (auto title-gen, /model command from a future
					// slash-command layer). Patch so the session list
					// stays in sync.
					bridge.patchSession(msg.key, {
						title: chat.sessionName ?? "",
						modelId: chat.modelId,
					});
				});
				turnTails.set(msg.key, next.finally(() => {
					// Drop the tail entry only if no newer send has
					// already replaced it.
					if (turnTails.get(msg.key) === next) turnTails.delete(msg.key);
				}));
				// Don't await — handler returns immediately so the next
				// ws message (e.g. an abort or ui.response) flows through.
				break;
			}
			case "session.abort": {
				const chat = await getOrRehydrate(msg.key);
				if (chat) await chat.abort();
				break;
			}
			case "session.subscribe": {
				bridge.applySubscription(state, msg.subs);
				break;
			}
			case "session.close": {
				const chat = chats.get(msg.key);
				if (chat) {
					// Cancel any in-flight turn and drain queued sends so
					// they don't race the dispose. abort() returns once
					// the agent's stream stops; awaiting the tail then
					// catches the trailing `endTurn` + post-turn patch.
					try { await chat.abort(); } catch (err) {
						log.warn("close.abort_failed", { key: msg.key, err: String(err) });
					}
					const tail = turnTails.get(msg.key);
					if (tail) {
						try { await tail; } catch { /* errors already logged */ }
					}
					await chat.dispose();
				}
				turnTails.delete(msg.key);
				chats.delete(msg.key);
				bridge.removeSession(msg.key);
				break;
			}
			case "ui.response": {
				const chat = await getOrRehydrate(msg.key);
				if (!chat) return;
				const ok = chat.resolvePending({ kind: "callback", requestId: msg.reqId, value: msg.value });
				// Tell sibling subscribers the dialog is gone so they
				// don't keep rendering the now-stale form.
				if (ok) bridge.broadcastUiCancelFor(msg.key, msg.reqId);
				break;
			}
			default:
				state.send({ type: "error", message: `unknown type: ${(msg as { type?: string }).type}` });
		}
	}

	const server = Bun.serve<WsState>({
		hostname: host,
		port,
		async fetch(req, server) {
			const url = new URL(req.url);
			if (url.pathname === "/ws") {
				if (!isOriginAllowed(req.headers.get("origin"), host, port)) {
					return new Response("forbidden origin", { status: 403 });
				}
				const state: WsState = {
					id: nextWsId++,
					subs: new Set(),
					// `send` patched after upgrade
					send: () => {},
				};
				if (server.upgrade(req, { data: state })) return;
				return new Response("upgrade failed", { status: 400 });
			}
			if (url.pathname === "/health") {
				return Response.json({ ok: true, sessions: bridge.listSessions().length });
			}
			const staticResp = await serveStatic(url.pathname);
			if (staticResp) return staticResp;
			return new Response("not found", { status: 404 });
		},
		websocket: {
			open(ws: ServerWebSocket<WsState>) {
				const state = ws.data;
				state.send = (msg: ServerMsg) => {
					try { ws.send(JSON.stringify(msg)); } catch (err) {
						log.warn("ws.send_failed", { id: state.id, err: String(err) });
					}
				};
				bridge.addSubscriber(state);
				// Send the initial session list so the client can render.
				state.send({ type: "session.list", sessions: bridge.listSessions() });
				log.info("ws.open", { id: state.id });
			},
			async message(ws: ServerWebSocket<WsState>, raw: string | Buffer) {
				const text = typeof raw === "string" ? raw : raw.toString("utf8");
				await handleClient(ws.data, text);
			},
			close(ws: ServerWebSocket<WsState>) {
				bridge.removeSubscriber(ws.data);
				log.info("ws.close", { id: ws.data.id });
			},
		},
	});

	log.info("listen", { host, port });

	return {
		server,
		async stop(): Promise<void> {
			server.stop(true);
			await Promise.allSettled([...chats.values()].map(c => c.dispose()));
			chats.clear();
		},
	};
}

/**
 * Run one user turn end-to-end, surfacing a `replace` envelope on
 * fatal failure. Without this, errors were only console-logged and
 * subscribers saw `finalize` indistinguishable from success.
 */
async function runOneTurn(chat: ChatSession, key: string, text: string): Promise<void> {
	try {
		await chat.prompt(text);
		const s = await chat.ensure();
		await s.waitForIdle();
	} catch (err) {
		// Cover both `chat.prompt()` failing (streamer may or may not
		// be attached yet) and `waitForIdle()` failing (streamer is
		// definitely attached). If we got a streamer, publish a
		// `replace` envelope so subscribers distinguish failure from a
		// clean finalize; otherwise nothing to publish to — log only.
		log.error("turn.failed", { key, err: String(err) });
		const streamer = chat.currentStreamer;
		if (streamer) {
			try {
				await streamer.replaceWith(`❌ turn failed: ${errMsg(err)}`);
			} catch (replaceErr) {
				log.warn("turn.replace_failed", { key, err: String(replaceErr) });
			}
		}
	} finally {
		await chat.endTurn();
	}
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Allow ws upgrades only from same-origin pages (and tools that don't
 * send an Origin header at all — wscat, our own smoke). Binding to
 * 127.0.0.1 doesn't prevent CSWSH: WebSocket connections are exempt
 * from the same-origin policy, so any web page the user happens to
 * visit could otherwise open ws://127.0.0.1:<port>/ws and drive the
 * coding agent.
 */
export function isOriginAllowed(origin: string | null, host: string, port: number): boolean {
	if (!origin) return true; // non-browser client
	let parsed: URL;
	try { parsed = new URL(origin); } catch { return false; }
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
	const originPort = parsed.port
		? Number(parsed.port)
		: (parsed.protocol === "https:" ? 443 : 80);
	if (originPort !== port) return false;
	// Strip IPv6 brackets if the URL parser left them on `hostname`
	// (Bun does; Node does not) so we can compare against the canonical
	// host form regardless of how the browser formatted the Origin.
	const hostname = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
	const allowedHosts = new Set([host, "localhost", "127.0.0.1", "::1"]);
	return allowedHosts.has(hostname);
}
