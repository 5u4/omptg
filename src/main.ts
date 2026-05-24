/**
 * omp-tg-sdk entrypoint.
 *
 * Wires telegram (grammY) to per-chat ChatSession instances. See chat.ts
 * for the per-chat runtime and ui-bridge.ts for the inline-keyboard /
 * text-reply bridge that lets the agent ask the user questions.
 *
 * Run: `bun run start` (loads .env via Bun).
 */
import { Bot, GrammyError, HttpError } from "grammy";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { ChatRegistry, listStoredSessions } from "./chat.ts";
import { parseCallback } from "./ui-bridge.ts";
import { initTheme } from "@oh-my-pi/pi-coding-agent";
import { scoped, logPath } from "./logger.ts";

const log = scoped("main");

const TOKEN = required("TELEGRAM_BOT_TOKEN");
const DEFAULT_CWD = resolveDir(required("OMP_DEFAULT_CWD"));
const ALLOWED = new Set(
	(Bun.env.TELEGRAM_ALLOWED_CHATS ?? "")
		.split(",")
		.map(s => s.trim())
		.filter(Boolean),
);

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

const bot = new Bot(TOKEN);
const registry = new ChatRegistry(bot, DEFAULT_CWD);

// Log every inbound update before any guards so we can see callback_query
// updates even when the allow-list later drops them.
bot.use(async (ctx, next) => {
	const u = ctx.update;
	const kind = u.callback_query
		? "callback_query"
		: u.message
			? "message"
			: Object.keys(u).filter(k => k !== "update_id")[0] ?? "unknown";
	log.info("update", {
		update_id: u.update_id,
		kind,
		chat_id: ctx.chat?.id,
		chat_id_alias: ctx.chatId,
		from: ctx.from?.id,
		text: ctx.message?.text?.slice(0, 80),
		cb_data: u.callback_query?.data,
		cb_msg_chat_id: u.callback_query?.message?.chat?.id,
		// Full raw on any non-message update so we don't lose data on
		// surprises (channel_post, chat_member, inline_query, etc).
		raw: kind === "message" ? undefined : u,
	});
	await next();
});

// Allow-list guard.
bot.use(async (ctx, next) => {
	const id = (ctx.chat?.id ?? ctx.chatId)?.toString();
	if (!id || (ALLOWED.size && !ALLOWED.has(id))) {
		log.warn("auth.reject", { chat_id: id, allowed: [...ALLOWED] });
		return;
	}
	await next();
});

bot.command("start", ctx =>
	ctx.reply(
		[
			"omp-tg up.",
			`cwd: ${DEFAULT_CWD}`,
			"",
			"send any text to chat with the agent",
			"/cancel  abort current turn (keeps session)",
			"/new     start a fresh session in the current cwd",
			"/dir <path>  switch this chat to a different cwd",
			"/dirs    list recent stored sessions for current cwd",
			"/resume <n>  reopen session by 1-based index from /dirs",
			"/status  show session id, model, cwd",
		].join("\n"),
	),
);

bot.command("status", async ctx => {
	const chat = registry.get(ctx.chat.id);
	const lines = [
		`cwd: ${chat.cwd}`,
		`session: ${chat.sessionId ?? "(not yet created)"}`,
		`model: ${chat.modelId ?? "?"}`,
		`streaming: ${chat.isStreaming}`,
		`file: ${chat.sessionFile ?? "-"}`,
	];
	await ctx.reply(lines.join("\n"));
});

bot.command("cancel", async ctx => {
	const chat = registry.get(ctx.chat.id);
	const cancelled = await chat.abort();
	await ctx.reply(cancelled ? "aborted" : "nothing to cancel");
});

bot.command("new", async ctx => {
	const chat = registry.get(ctx.chat.id);
	if (chat.isStreaming) {
		await chat.abort();
	}
	await chat.newSession();
	await ctx.reply(`✨ fresh session in ${chat.cwd}\nid: ${chat.sessionId}`);
});

bot.command("dir", async ctx => {
	const raw = ctx.match?.trim();
	if (!raw) {
		await ctx.reply(
			`current cwd: ${registry.get(ctx.chat.id).cwd}\nusage: /dir <absolute path>`,
		);
		return;
	}
	const abs = resolvePath(raw.replace(/^~(?=$|\/)/, Bun.env.HOME ?? ""));
	if (!existsSync(abs)) {
		await ctx.reply(`not found: ${abs}`);
		return;
	}
	const chat = registry.get(ctx.chat.id);
	if (chat.isStreaming) await chat.abort();
	await chat.switchCwd(abs);
	await ctx.reply(`📂 switched to ${abs}\nid: ${chat.sessionId}`);
});

bot.command("dirs", async ctx => {
	const chat = registry.get(ctx.chat.id);
	const sessions = await listStoredSessions(chat.cwd, 8);
	if (sessions.length === 0) {
		await ctx.reply(`no stored sessions in ${chat.cwd}`);
		return;
	}
	// Cache the list on the chat so /resume <n> can index into it.
	storedSessionsByChat.set(ctx.chat.id, sessions);
	const lines = sessions.map((s, i) => {
		const ts = s.modified.toISOString().slice(5, 16).replace("T", " ");
		const preview = ((s.firstMessage || s.title || "(no message)")
			.split("\n")[0] ?? "")
			.slice(0, 70);
		return `${i + 1}. [${ts}] ${preview}`;
	});
	await ctx.reply(
		[`recent sessions in ${chat.cwd}`, "", ...lines, "", "use /resume <n> to reopen"].join("\n"),
	);
});

const storedSessionsByChat = new Map<
	number,
	Awaited<ReturnType<typeof listStoredSessions>>
>();

bot.command("resume", async ctx => {
	const arg = ctx.match?.trim();
	if (!arg) {
		await ctx.reply("usage: /resume <n>   (run /dirs first to see the list)");
		return;
	}
	const n = Number.parseInt(arg, 10);
	const cached = storedSessionsByChat.get(ctx.chat.id);
	if (!cached || !Number.isFinite(n) || n < 1 || n > cached.length) {
		await ctx.reply("invalid index; run /dirs first");
		return;
	}
	const target = cached[n - 1]!;
	const chat = registry.get(ctx.chat.id);
	if (chat.isStreaming) await chat.abort();
	try {
		await chat.resume(target.path);
		await ctx.reply(
			`📜 resumed session ${chat.sessionId}\ncwd: ${chat.cwd}`,
		);
	} catch (err) {
		await ctx.reply(`failed to resume: ${err instanceof Error ? err.message : err}`);
	}
});

// Inline-keyboard callbacks: route to the per-chat UI bridge.
bot.on("callback_query:data", async ctx => {
	const data = ctx.callbackQuery.data;
	const parsed = parseCallback(data);
	log.info("callback.recv", {
		raw: data,
		parsed,
		ctx_chat_id: ctx.chat?.id,
		ctx_chat_id_alias: ctx.chatId,
		msg_chat_id: ctx.callbackQuery.message?.chat.id,
	});
	if (!parsed) {
		await ctx.answerCallbackQuery();
		return;
	}
	const chatId = ctx.chatId ?? ctx.callbackQuery.message?.chat.id;
	if (chatId === undefined) {
		log.warn("callback.no_chat_id", { raw: data });
		await ctx.answerCallbackQuery("no chat context");
		return;
	}
	const chat = registry.get(chatId);
	const pending = chat.pendingUi();
	log.info("callback.resolve_attempt", {
		chat_id: chatId,
		req_id: parsed.requestId,
		value: parsed.value,
		pending_kind: pending?.kind,
		pending_req_id: pending?.requestId,
		pending_awaits_text: pending?.awaitsText,
	});
	const ok = chat.resolvePending({
		kind: "callback",
		requestId: parsed.requestId,
		value: parsed.value,
	});
	log.info("callback.resolved", { ok, chat_id: chatId, req_id: parsed.requestId });
	await ctx.answerCallbackQuery(ok ? undefined : "expired");
	if (ok && ctx.callbackQuery.message) {
		try {
			await ctx.api.editMessageReplyMarkup(
				ctx.callbackQuery.message.chat.id,
				ctx.callbackQuery.message.message_id,
				{ reply_markup: { inline_keyboard: [] } },
			);
		} catch (err) {
			log.warn("callback.strip_keyboard_failed", { err: String(err) });
		}
	}
});

bot.on("message:text", async ctx => {
	const text = ctx.message.text;
	if (text.startsWith("/")) return;

	const chat = registry.get(ctx.chat.id);

	// If a UI prompt is awaiting a text reply, route this message there.
	const pending = chat.pendingUi();
	if (pending?.awaitsText) {
		const handled = chat.resolvePending({ kind: "text", text });
		if (handled) {
			await ctx.reply("↪ sent to agent");
			return;
		}
	}

	try {
		const streamer = await chat.prompt(text);
		const s = await chat.ensure();
		await s.waitForIdle();
		await streamer.finalize();
	} catch (err) {
		console.error(`[chat ${ctx.chat.id}] turn failed:`, err);
		await ctx.reply(`❌ ${err instanceof Error ? err.message : String(err)}`);
	}
});

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

async function shutdown(signal: string) {
	console.log(`\n[shutdown] ${signal}`);
	try {
		await bot.stop();
	} catch {
		/* ignore */
	}
	await registry.disposeAll();
	process.exit(0);
}
process.on("uncaughtException", err => {
	log.error("uncaughtException", {
		err: String(err),
		stack: err instanceof Error ? err.stack : undefined,
	});
});
process.on("unhandledRejection", reason => {
	log.error("unhandledRejection", {
		reason: String(reason),
		stack: reason instanceof Error ? reason.stack : undefined,
	});
});
process.on("exit", code => {
	log.warn("process.exit", { code });
});

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

log.info("boot.start", {
	cwd: DEFAULT_CWD,
	allowed_chats: [...ALLOWED],
	log_file: logPath(),
});
await initTheme();
log.info("boot.theme_ready");

// Telegram caches the LAST allowed_updates value per bot token. If a
// previous run (or any other client using this token) called getUpdates
// without callback_query, telegram will keep filtering them out until we
// explicitly re-set the list. We also drop pending updates so an old
// queued message can't shadow a fresh callback_query.
try {
	const info = await bot.api.getWebhookInfo();
	log.info("boot.webhook_info", {
		url: info.url,
		pending_update_count: info.pending_update_count,
		allowed_updates: info.allowed_updates,
		last_error_message: info.last_error_message,
	});
	if (info.url) {
		// We have a stale webhook stealing our updates. Delete it but
		// PRESERVE pending updates — a callback_query the user tapped
		// while the webhook was active should still be delivered to us
		// via polling once it's gone.
		await bot.api.deleteWebhook({ drop_pending_updates: false });
		log.info("boot.webhook_deleted");
	}
} catch (err) {
	log.warn("boot.webhook_probe_failed", { err: String(err) });
}

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
