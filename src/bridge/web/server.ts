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
import { ChatSession } from "../../chat.ts";
import { ChatStore } from "../../chat-store.ts";
import { scoped } from "../../logger.ts";
import type { ClientMsg, ServerMsg, SessionSummary } from "./protocol.ts";
import { WebBridge } from "./index.ts";

const log = scoped("web-server");

interface WsState {
	id: number;
	send(msg: ServerMsg): void;
	subs: Map<string, number>;
}

let nextWsId = 1;

export interface WebServerOptions {
	host?: string;
	port?: number;
	bridge: WebBridge;
	chatStore: ChatStore;
}

export interface RunningServer {
	server: Server<unknown>;
	stop(): Promise<void>;
}

export function startWebServer(opts: WebServerOptions): RunningServer {
	const host = opts.host ?? "127.0.0.1";
	const port = opts.port ?? 7878;
	const { bridge, chatStore } = opts;

	/** Per-route ChatSession. Web routes are minted; ChatRegistry's
	 *  telegram-shaped (chatId:threadId) keying doesn't apply, so we
	 *  keep a direct map here. */
	const chats = new Map<string, ChatSession>();

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
				const route = bridge.mintRoute();
				const cwd = msg.cwd ?? bridge.defaultCwdValue();
				const chat = getOrCreateChat(route.key, cwd);
				// Eagerly ensure so session file exists for the summary.
				try { await chat.ensure(); } catch (err) {
					state.send({ type: "error", message: "failed to open session", cause: String(err) });
					return;
				}
				bridge.patchSession(route.key, {
					cwd,
					sessionFile: chat.sessionFile,
					title: chat.sessionName ?? "",
				});
				const s = summaryFor(route.key);
				if (s) state.send({ type: "session.created", session: s });
				break;
			}
			case "session.resume": {
				const route = bridge.mintRoute();
				const cwd = msg.cwd ?? bridge.defaultCwdValue();
				const chat = getOrCreateChat(route.key, cwd);
				try { await chat.resume(msg.sessionFile); } catch (err) {
					state.send({ type: "error", message: "resume failed", cause: String(err) });
					return;
				}
				bridge.patchSession(route.key, {
					cwd: chat.cwd,
					sessionFile: chat.sessionFile,
					title: chat.sessionName ?? "",
				});
				const s = summaryFor(route.key);
				if (s) state.send({ type: "session.created", session: s });
				break;
			}
			case "session.send": {
				const chat = chats.get(msg.key);
				if (!chat) { state.send({ type: "error", message: `unknown session ${msg.key}` }); return; }
				try {
					await chat.prompt(msg.text);
					const s = await chat.ensure();
					await s.waitForIdle();
				} catch (err) {
					log.error("turn.failed", { key: msg.key, err: String(err) });
				} finally {
					await chat.endTurn();
					// Title may have been generated post-turn.
					bridge.patchSession(msg.key, { title: chat.sessionName ?? "" });
				}
				break;
			}
			case "session.abort": {
				const chat = chats.get(msg.key);
				if (chat) await chat.abort();
				break;
			}
			case "session.subscribe": {
				bridge.applySubscription(state, msg.subs);
				break;
			}
			case "session.close": {
				const chat = chats.get(msg.key);
				if (chat) await chat.dispose();
				chats.delete(msg.key);
				bridge.removeSession(msg.key);
				break;
			}
			case "ui.response": {
				const chat = chats.get(msg.key);
				if (!chat) return;
				chat.resolvePending({ kind: "callback", requestId: msg.reqId, value: msg.value });
				break;
			}
			default:
				state.send({ type: "error", message: `unknown type: ${(msg as { type?: string }).type}` });
		}
	}

	const server = Bun.serve<WsState>({
		hostname: host,
		port,
		fetch(req, server) {
			const url = new URL(req.url);
			if (url.pathname === "/ws") {
				const state: WsState = {
					id: nextWsId++,
					subs: new Map(),
					// `send` patched after upgrade
					send: () => {},
				};
				if (server.upgrade(req, { data: state })) return;
				return new Response("upgrade failed", { status: 400 });
			}
			if (url.pathname === "/health") {
				return Response.json({ ok: true, sessions: bridge.listSessions().length });
			}
			// Phase 3 will serve static frontend here.
			return new Response("omptg web bridge\n", {
				headers: { "content-type": "text/plain" },
			});
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
	void chatStore;

	return {
		server,
		async stop(): Promise<void> {
			server.stop(true);
			await Promise.allSettled([...chats.values()].map(c => c.dispose()));
			chats.clear();
		},
	};
}
