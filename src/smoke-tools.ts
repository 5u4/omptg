/**
 * Verify tool-execution rendering: ask the agent to read a file and run
 * bash. Watch every TG.send / TG.edit so we can see the status tail with
 * tool descriptions appearing as the turn progresses.
 *
 * Pure render verification is also done unit-style at the bottom.
 */
import { ChatSession } from "./chat.ts";
import { initTheme } from "@oh-my-pi/pi-coding-agent";
import { renderToolStart, renderToolEnd } from "./tool-render.ts";
import type { Bot } from "grammy";

await initTheme();

// 1. Unit-style: deterministic check that each renderer produces a useful line.
console.log("=== unit checks ===");
const cases: Array<{ name: string; args: unknown; expect: string }> = [
	{ name: "read",   args: { path: "src/foo.ts" },                       expect: "📖 read" },
	{ name: "write",  args: { path: "src/foo.ts", content: "abc" },        expect: "📝 write" },
	{ name: "edit",   args: { input: "§src/foo.ts\n≔1aa\nfoo\n§src/bar.ts\n≔2bb\nbar" }, expect: "✏️ edit 2 files" },
	{ name: "bash",   args: { command: "pytest tests/foo.py -v" },         expect: "💻 bash:" },
	{ name: "search", args: { pattern: "TODO", paths: ["src"] },           expect: "🔍 search" },
	{ name: "find",   args: { paths: ["src/**/*.ts", "tests/**"] },        expect: "🔎 find" },
	{ name: "task",   args: { agent: "explore", tasks: [{}, {}] },         expect: "🤖 task" },
	{ name: "todo_write", args: { ops: [{}, {}, {}] },                     expect: "✅ todos" },
	{ name: "eval",   args: { cells: [{}] },                               expect: "🧮 eval" },
	{ name: "ask",    args: { question: "Pick one" },                      expect: "❓ ask" },
	{ name: "weird_tool", args: {},                                        expect: "🔧 weird_tool" },
];
for (const c of cases) {
	const line = renderToolStart(c.name, c.args);
	const ok = line.includes(c.expect);
	console.log(`  ${ok ? "✓" : "✗"} ${c.name.padEnd(12)} -> ${line}`);
	if (!ok) throw new Error(`render mismatch for ${c.name}`);
}
const err = renderToolEnd("bash", { content: [{ type: "text", text: "command exited with code 1" }] }, true);
console.log(`  ✓ end-error    -> ${err}`);
if (!err.startsWith("❌ bash failed")) throw new Error("error render mismatch");

// 2. Live: drive a real turn and watch the status sequence.
console.log("\n=== live agent turn ===");
const sent: { id: number; text: string }[] = [];
let nextId = 1;
const fakeBot = {
	api: {
		async sendMessage(_c: number, text: string) {
			const id = nextId++;
			sent.push({ id, text });
			console.log(`  TG.send[${id}] ${text.replace(/\n/g, " | ")}`);
			return { message_id: id };
		},
		async editMessageText(_c: number, id: number, text: string) {
			console.log(`  TG.edit[${id}]  ${text.replace(/\n/g, " | ")}`);
		},
		async editMessageReplyMarkup() {},
	},
} as unknown as Bot;

const chat = new ChatSession({ chatId: 7, cwd: "/tmp", bot: fakeBot });
const streamer = await chat.prompt(
	"Use bash to run `echo hello` and then read /etc/hostname. Tell me what you saw.",
);
const s = await chat.ensure();
await s.waitForIdle();
await streamer.finalize();
await chat.dispose();

console.log("\n✓ tool-render smoke OK");
