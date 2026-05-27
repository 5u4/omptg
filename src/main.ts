/**
 * omptg entrypoint.
 *
 *   1. Parse env + resolve default cwd + build Deps
 *   2. Install global middleware, slash commands, message/callback handlers
 *   3. Run one-shot boot tasks (theme, log rotation, commands registration,
 *      webhook probe, chat-override wipe)
 *   4. Start the bot
 *
 * Every interactive surface lives in the modules under src/{middleware,
 * commands,handlers,boot}.ts — main.ts is intentionally just wiring.
 *
 * Run: `bun run start` (loads .env via Bun).
 */
import { Bot, GrammyError, HttpError } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { ChatRegistry } from "./chat.ts";
import { ChatStore } from "./chat-store.ts";
import { PendingVoiceStore } from "./pending-voice.ts";
import type { Deps } from "./deps.ts";
import { TelegramBridge } from "./bridge/telegram/index.ts";
import { installMiddleware } from "./middleware.ts";
import { installCommands } from "./commands.ts";
import { installHandlers } from "./handlers/index.ts";
import {
	initOmpTheme,
	installProcessHooks,
	probeWebhook,
	registerSlashCommands,
	runLogRotation,
	wipeChatCommandOverrides,
} from "./boot.ts";
import { scoped, logPath } from "./logger.ts";

const log = scoped("main");

// --- env --------------------------------------------------------------------

function required(key: string): string {
	const v = Bun.env[key];
	if (!v) {
		console.error(`missing required env: ${key}`);
		process.exit(1);
	}
	return v;
}

function resolveDir(path: string): string {
	const abs = resolvePath(path.replace(/^~(?=$|\/)/, Bun.env.HOME ?? ""));
	if (!existsSync(abs)) {
		console.error(`cwd does not exist: ${abs}`);
		process.exit(1);
	}
	return abs;
}

// OMP_DEFAULT_CWD is optional. Resolution order:
//   1. env OMP_DEFAULT_CWD (must exist on disk if set)
//   2. ~/.omptg/ (auto-created if missing)
// Per-chat /bind values still override on a per-chat basis. The effective
// path + source is logged at boot.start so it's never a mystery.
function resolveDefaultCwd(): string {
	const env = Bun.env.OMP_DEFAULT_CWD;
	if (env) return resolveDir(env);
	const fallback = resolvePath(homedir(), ".omptg");
	mkdirSync(fallback, { recursive: true });
	return fallback;
}

const TOKEN = required("TELEGRAM_BOT_TOKEN");
const DEFAULT_CWD = resolveDefaultCwd();
const ALLOWED = new Set(
	(Bun.env.TELEGRAM_ALLOWED_CHATS ?? "")
		.split(",")
		.map(s => s.trim())
		.filter(Boolean),
);

// --- wiring -----------------------------------------------------------------

const bot = new Bot(TOKEN);
// Auto-handle telegram 429 (rate limit) and 5xx by waiting `retry_after`
// and retrying the same request. Without this, edits/sends in the
// rolling activity message would throw and be silently logged-and-lost
// — the ✅/❌ result line would stay pinned at 📖, or a chunk of the
// assistant reply would vanish. Cap is defensive: a single request
// shouldn't tie up the chain for more than ~30s, and we'd rather log a
// drop than wedge a turn behind a multi-minute backoff.
bot.api.config.use(autoRetry({
	maxRetryAttempts: 5,
	maxDelaySeconds: 30,
	rethrowInternalServerErrors: false,
}));
const chatStore = new ChatStore();
const bridge = new TelegramBridge(bot);
const registry = new ChatRegistry(bridge, DEFAULT_CWD, chatStore);
const pendingVoice = new PendingVoiceStore();

const deps: Deps = {
	bot,
	bridge,
	registry,
	chatStore,
	pendingVoice,
	defaultCwd: DEFAULT_CWD,
	allowedChats: ALLOWED,
	stt: {
		model: Bun.env.OMPTG_STT_MODEL || "base",
		language: Bun.env.OMPTG_STT_LANG || "en",
	},
};

installMiddleware(deps);
installCommands(deps);
installHandlers(deps);
installProcessHooks(deps);

bot.catch(err => {
	const e = err.error;
	if (e instanceof GrammyError) {
		console.error("[grammy api]", e.description);
	} else if (e instanceof HttpError) {
		console.error("[grammy http]", e.message);
	} else {
		console.error("[grammy]", e);
	}
});

// --- boot -------------------------------------------------------------------

log.info("boot.start", {
	default_cwd: DEFAULT_CWD,
	default_cwd_source: Bun.env.OMP_DEFAULT_CWD ? "env" : "fallback:~/.omptg",
	allowed_chats: [...ALLOWED],
	log_file: logPath(),
});

await runLogRotation();
await initOmpTheme();
await registerSlashCommands(deps);
await wipeChatCommandOverrides(deps);
await probeWebhook(deps);

// IMPORTANT: telegram's getUpdates DEFAULT allowed_updates EXCLUDES
// callback_query. Pass it explicitly so the new list takes effect.
//
// DO NOT pass drop_pending_updates here — that would discard any
// callback_query tapped while the bot was momentarily down (e.g.
// between two `bun start` runs), which is exactly the window when
// users are most likely to be clicking. Old taps in the queue still
// matter; the in-memory pending UI request that was created in the
// prior process is gone, so the resolve will just answer "expired"
// — fine, much better than silently swallowing the click forever.
await bot.start({
	allowed_updates: ["message", "edited_message", "callback_query"],
	onStart: info => log.info("boot.ready", { username: info.username }),
});
