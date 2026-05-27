/**
 * Web bridge end-to-end smoke. Boots the server on an ephemeral port,
 * connects a ws client, drives one round trip (session.open →
 * session.send → wait for finalize → close), and exits non-zero on
 * any timeout or assertion failure.
 *
 * Run: `bun run scripts/web-smoke.ts`
 */
import { WebBridge } from "../src/bridge/web/index.ts";
import { startWebServer } from "../src/bridge/web/server.ts";
import { initTheme } from "@oh-my-pi/pi-coding-agent";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMsg } from "../src/bridge/web/protocol.ts";

await initTheme();

const cwd = mkdtempSync(join(tmpdir(), "omptg-web-smoke-"));
const stateFile = join(cwd, "web-sessions.json");
const bridge = new WebBridge({ defaultCwd: cwd, stateFile });
const running = startWebServer({ host: "127.0.0.1", port: 0, bridge });
const addr = running.server.url;
console.log("smoke: server at", addr.toString());

const wsUrl = `ws://${addr.hostname}:${addr.port}/ws`;
const ws = new WebSocket(wsUrl);

const events: ServerMsg[] = [];
const finalized = new Promise<void>((resolve, reject) => {
	const timer = setTimeout(() => reject(new Error("timeout waiting for finalize")), 120_000);
	ws.addEventListener("message", ev => {
		const msg = JSON.parse(String(ev.data)) as ServerMsg;
		events.push(msg);
		if (msg.type === "session.event" && msg.event.kind === "finalize") {
			clearTimeout(timer);
			resolve();
		}
	});
	ws.addEventListener("error", e => reject(new Error(`ws error: ${e}`)));
});

await new Promise<void>(resolve => ws.addEventListener("open", () => resolve()));
console.log("smoke: ws open");

// Open a session, subscribe to it, send a prompt.
let createdKey: string | undefined;
const createdMsg = await new Promise<ServerMsg>(resolve => {
	const handler = (ev: MessageEvent): void => {
		const msg = JSON.parse(String(ev.data)) as ServerMsg;
		if (msg.type === "session.created") {
			ws.removeEventListener("message", handler);
			resolve(msg);
		}
	};
	ws.addEventListener("message", handler);
	ws.send(JSON.stringify({ type: "session.open", cwd }));
});
if (createdMsg.type !== "session.created") throw new Error("no session.created");
createdKey = createdMsg.session.key;
console.log("smoke: session created", createdKey);

ws.send(JSON.stringify({ type: "session.subscribe", subs: [{ key: createdKey }] }));
ws.send(JSON.stringify({ type: "session.send", key: createdKey, text: "Say pong." }));
console.log("smoke: prompt sent, awaiting finalize");

await finalized;
console.log("smoke: finalized");

const assistant = events
	.filter(m => m.type === "session.event")
	.map(m => (m as { event: { kind: string; text?: string } }).event)
	.filter(e => e.kind === "assistant");
console.log("smoke: assistant messages:", assistant.map(a => a.text).join(" | "));

ws.close();
await running.stop();
await bridge.dispose();
process.exit(0);
