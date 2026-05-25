/**
 * Offline smoke: spin up an AgentSession, run one prompt, dispose.
 * No telegram, no bot token needed. Validates SDK wiring before we hit the wire.
 */
import {
	createAgentSession,
	SessionManager,
} from "@oh-my-pi/pi-coding-agent";

const cwd = Bun.argv[2] ?? "/tmp";
console.log(`spawning AgentSession in ${cwd}`);

const { session, modelFallbackMessage } = await createAgentSession({
	cwd,
	sessionManager: SessionManager.create(
		cwd,
		SessionManager.getDefaultSessionDir(cwd),
	),
	hasUI: false,
});

if (modelFallbackMessage) console.log("[fallback]", modelFallbackMessage);
console.log(`session: id=${session.sessionId} model=${session.model?.id ?? "?"}`);

let buf = "";
const unsub = session.subscribe(e => {
	if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") {
		buf += e.assistantMessageEvent.delta;
		process.stdout.write(e.assistantMessageEvent.delta);
	}
});

await session.prompt("Reply with exactly one word: pong");
await session.waitForIdle();
unsub();

console.log(`\n---\nfinal text: ${JSON.stringify(buf)}`);
console.log(`sessionFile: ${session.sessionFile}`);

await session.dispose();
console.log("disposed");
