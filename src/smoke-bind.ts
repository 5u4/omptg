/**
 * Verify chat→cwd binding store + ChatRegistry resolution.
 * Pure logic, no telegram.
 */
import { ChatRegistry, ChatSession } from "./chat.ts";
import { ChatStore, expandHome } from "./chat-store.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";
import type { Bot } from "grammy";

// Isolated store under a temp dir so we don't trash ~/.omp-tg/chats.json
const storeDir = mkdtempSync(`${tmpdir()}/omp-tg-smoke-`);
const storePath = resolvePath(storeDir, "chats.json");
const store = new ChatStore(storePath);
console.log(`store path: ${storePath}`);

// Stub bot
const fakeBot = {
	api: {
		async sendMessage(_c: number, text: string) {
			return { message_id: 1 };
		},
		async editMessageText() {},
		async editMessageReplyMarkup() {},
	},
} as unknown as Bot;

const DEFAULT = "/tmp";
const reg = new ChatRegistry(fakeBot, DEFAULT, store);
const CHAT = 42;

// 1. No binding -> default
console.log("[1] no binding");
console.log(`  cwdFor: ${reg.cwdFor(CHAT)}   expected: ${DEFAULT}`);
if (reg.cwdFor(CHAT) !== DEFAULT) throw new Error("default cwd mismatch");

// 2. First get() materializes ChatSession with default cwd
const c1 = reg.get(CHAT);
console.log(`  ChatSession.cwd: ${c1.cwd}   expected: ${DEFAULT}`);
if (c1.cwd !== DEFAULT) throw new Error("ChatSession cwd mismatch");

// 3. Bind via store
const bound = resolvePath(expandHome("~"));
console.log(`\n[2] bind chat ${CHAT} → ${bound}`);
store.set(CHAT, { cwd: bound, label: "home" });
console.log(`  cwdFor: ${reg.cwdFor(CHAT)}   expected: ${bound}`);
if (reg.cwdFor(CHAT) !== bound) throw new Error("post-bind cwdFor mismatch");

// 4. Existing ChatSession still has old cwd (生效时机=下次 /new)
console.log(`  existing chat.cwd unchanged: ${c1.cwd}`);
if (c1.cwd !== DEFAULT)
	throw new Error("existing ChatSession should not reactively switch");

// 5. Reload store: persisted across processes
const store2 = new ChatStore(storePath);
const b = store2.get(CHAT);
console.log(`\n[3] reload store`);
console.log(`  loaded: ${JSON.stringify(b)}`);
if (!b || b.cwd !== bound || b.label !== "home")
	throw new Error("store didn't persist");

// 6. Unbind
console.log(`\n[4] unbind`);
const removed = store.delete(CHAT);
console.log(`  delete returned: ${removed}`);
if (!removed) throw new Error("unbind should return true");
console.log(`  cwdFor: ${reg.cwdFor(CHAT)}   expected: ${DEFAULT}`);
if (reg.cwdFor(CHAT) !== DEFAULT)
	throw new Error("post-unbind should fall back to default");

// 7. expandHome
console.log(`\n[5] expandHome`);
const cases: [string, string][] = [
	["~", expandHome("~")],
	["~/foo", expandHome("~/foo")],
	["/abs", "/abs"],
	["./rel", "./rel"],
];
for (const [input, expanded] of cases) {
	console.log(`  ${input}  →  ${expandHome(input)}`);
}

console.log("\n✓ binding round-trip OK");
