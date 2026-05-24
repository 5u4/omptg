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

// Allow-list guard.
bot.use(async (ctx, next) => {
	const id = ctx.chat?.id?.toString();
	if (!id || (ALLOWED.size && !ALLOWED.has(id))) {
		console.warn(`[auth] rejecting chat_id=${id}`);
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
	if (!parsed) return ctx.answerCallbackQuery();
	const chat = registry.get(ctx.chat?.id ?? 0);
	const ok = chat.resolvePending({
		kind: "callback",
		requestId: parsed.requestId,
		value: parsed.value,
	});
	await ctx.answerCallbackQuery(ok ? undefined : "expired");
	// Strip the keyboard on the original message so the buttons don't linger.
	if (ok && ctx.callbackQuery.message) {
		try {
			await ctx.api.editMessageReplyMarkup(
				ctx.callbackQuery.message.chat.id,
				ctx.callbackQuery.message.message_id,
				{ reply_markup: { inline_keyboard: [] } },
			);
		} catch {
			/* ignore */
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
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

console.log(`[boot] default cwd: ${DEFAULT_CWD}`);
console.log("[boot] starting bot polling…");
bot.start({
	onStart: info => console.log(`[boot] @${info.username} ready`),
});
