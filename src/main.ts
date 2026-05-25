/**
 * omptg entrypoint.
 *
 * Wires telegram (grammY) to per-chat ChatSession instances. See chat.ts
 * for the per-chat runtime and ui-bridge.ts for the inline-keyboard /
 * text-reply bridge that lets the agent ask the user questions.
 *
 * Run: `bun run start` (loads .env via Bun).
 */
import { Bot, GrammyError, HttpError } from "grammy";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { ChatRegistry, listStoredSessions } from "./chat.ts";
import { ChatStore, expandHome } from "./chat-store.ts";
import { parseCallback } from "./ui-bridge.ts";
import { extractThreadId } from "./topic.ts";
import { formatReplyPrompt, formatForwardPrompt, type ReplyContext, type ForwardContext } from "./quote.ts";
import { downloadPhotoToCache } from "./media.ts";
import { downloadVoiceToCache, transcribeAudio } from "./voice.ts";
import {
	PendingVoiceStore,
	encodeVoiceCallback,
	parseVoiceCallback,
	freshVoiceId,
} from "./pending-voice.ts";

import { initTheme } from "@oh-my-pi/pi-coding-agent";
import { scoped, logPath, logDir } from "./logger.ts";
import { rotateLogs } from "./log-rotate.ts";

const log = scoped("main");

const TOKEN = required("TELEGRAM_BOT_TOKEN");
// OMP_DEFAULT_CWD is optional. Resolution order:
//   1. env OMP_DEFAULT_CWD (must exist on disk if set)
//   2. ~/.omptg/ (auto-created if missing)
// Per-chat /bind values still override on a per-chat basis. The effective
// path + source is logged at boot.start so it's never a mystery.
const DEFAULT_CWD = resolveDefaultCwd();
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

function resolveDefaultCwd(): string {
	const env = Bun.env.OMP_DEFAULT_CWD;
	if (env) return resolveDir(env);
	const fallback = resolvePath(homedir(), ".omptg");
	// mkdirSync({recursive:true}) is a no-op if it already exists.
	mkdirSync(fallback, { recursive: true });
	return fallback;
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
const chatStore = new ChatStore();
const registry = new ChatRegistry(bot, DEFAULT_CWD, chatStore);
const pendingVoice = new PendingVoiceStore();
const STT_MODEL = Bun.env.OMPTG_STT_MODEL || "base";
const STT_LANGUAGE = Bun.env.OMPTG_STT_LANG || "en";

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

// Auth: an update is allowed if EITHER the sender's user id OR the chat id
// is in the allow list. This lets you talk to the bot in a group where you
// are listed as an allowed user without having to also enumerate the group
// id — but the bot still ignores anyone else in the same group.
bot.use(async (ctx, next) => {
	if (ALLOWED.size === 0) {
		// No allowlist configured: open mode (still authenticated by token).
		await next();
		return;
	}
	const chatId = (ctx.chat?.id ?? ctx.chatId)?.toString();
	const fromId = ctx.from?.id?.toString();
	const ok =
		(chatId !== undefined && ALLOWED.has(chatId)) ||
		(fromId !== undefined && ALLOWED.has(fromId));
	if (!ok) {
		log.warn("auth.reject", {
			chat_id: chatId,
			from_id: fromId,
			allowed: [...ALLOWED],
		});
		return;
	}
	await next();
});

// Forwarded messages MUST NOT trigger slash commands. Telegram preserves
// the original entities (including bot_command at offset 0) when a user
// forwards a message into our chat, so grammY's bot.command() would
// happily run /unbind/etc. against the new chat just because the original
// message text started with a slash. Strip bot_command entities on any
// forwarded message before downstream handlers see them — the text still
// flows through message:text and gets wrapped as a [forwarded from …]
// quote, which is what the user actually meant.
bot.use(async (ctx, next) => {
	const msg = ctx.message;
	if (msg?.forward_origin && msg.entities?.some(e => e.type === "bot_command")) {
		(msg as { entities?: typeof msg.entities }).entities =
			msg.entities.filter(e => e.type !== "bot_command");
		log.info("forward.command_stripped", {
			chat_id: ctx.chat?.id,
			text: msg.text?.slice(0, 80),
		});
	}
	await next();
});

bot.command("start", ctx =>
	ctx.reply(
		[
			"omptg up.",
			`cwd: ${DEFAULT_CWD}`,
			"",
			"send any text to chat with the agent",
			"/cancel  abort current turn (keeps session)",
			"/new     start a fresh session in the current cwd",
			"/sessions [n]  list recent stored sessions (default 8, max 50)",
			"/resume [n]  reopen session by 1-based index (default: most recent)",
			"/status  show session id, model, cwd",
			"/model [id]  switch model — no arg = pick from list (temporary, not persisted)",
			"/compact [instructions]  manually compact context now",
			"",
			"chat → cwd binding",
			"/whoami   show this chat's id, type, and binding",
			"/bind <path> [|label]   bind to a cwd — in a topic: topic-only; in General/DM: group default (effect: next /new)",
			"/unbind   remove binding for this scope (topic or group)",
			"/binding  show topic + group bindings",
			"/retitle [name]  rename session, or LLM-regen if no name",
		].join("\n"),
	),
);

bot.command("status", async ctx => {
	const chat = registry.get(ctx.chat.id, extractThreadId(ctx.message));
	const lines = [
		`cwd: ${chat.cwd}`,
		`session: ${chat.sessionId ?? "(not yet created)"}`,
		`title: ${chat.sessionName ?? "-"}`,
		`model: ${chat.modelId ?? "?"}`,
		`streaming: ${chat.isStreaming}`,
		`file: ${chat.sessionFile ?? "-"}`,
	];
	const usage = chat.contextUsage;
	if (usage) {
		const pct = usage.percent;
		const tok = usage.tokens;
		const win = usage.contextWindow;
		const pctStr = pct === null ? "?" : `${pct.toFixed(1)}%`;
		const tokStr = tok === null ? "?" : tok.toLocaleString("en-US");
		lines.push(`context: ${pctStr} (${tokStr} / ${win.toLocaleString("en-US")})`);
	}
	await ctx.reply(lines.join("\n"));
});

bot.command("model", async ctx => {
	const chat = registry.get(ctx.chat.id, extractThreadId(ctx.message));
	const arg = ctx.match?.trim();
	if (arg) {
		const model = await chat.setModelById(arg);
		if (!model) {
			const available = (await chat.getAvailableModels()).map(m => m.id);
			await ctx.reply(
				`unknown model "${arg}"\navailable:\n  ${available.join("\n  ")}`,
			);
			return;
		}
		await ctx.reply(`model: ${model.id}`);
		return;
	}
	const picked = await chat.promptModelSelection();
	if (!picked) {
		await ctx.reply("model unchanged");
		return;
	}
	await ctx.reply(`model: ${picked.id}`);
});

bot.command("compact", async ctx => {
	const chat = registry.get(ctx.chat.id, extractThreadId(ctx.message));
	const instructions = ctx.match?.trim() || undefined;
	const res = await chat.compact(instructions);
	switch (res.status) {
		case "no-session":
			await ctx.reply("no active session — nothing to compact");
			return;
		case "busy":
			await ctx.reply("agent is streaming — /cancel first, then /compact");
			return;
		case "error":
			await ctx.reply(`compact failed: ${res.message}`);
			return;
		case "ok": {
			const before = res.tokensBefore.toLocaleString("en-US");
			const after = res.tokensAfter === null ? "?" : res.tokensAfter.toLocaleString("en-US");
			const win = res.contextWindow.toLocaleString("en-US");
			const head = `✅ compacted: ${before} → ${after} tokens (window ${win})`;
			// Telegram caps at 4096; summary can be long. Trim to keep the
			// reply readable — full summary lives in the session file.
			const SUMMARY_MAX = 1200;
			const summary = res.summary.length > SUMMARY_MAX
				? `${res.summary.slice(0, SUMMARY_MAX)}…`
				: res.summary;
			await ctx.reply(`${head}\n\n${summary}`);
			return;
		}
	}
});

bot.command("cancel", async ctx => {
	const chat = registry.get(ctx.chat.id, extractThreadId(ctx.message));
	const cancelled = await chat.abort();
	await ctx.reply(cancelled ? "aborted" : "nothing to cancel");
});

bot.command("whoami", async ctx => {
	const chatId = ctx.chat.id;
	const threadId = extractThreadId(ctx.message);
	const binding = registry.bindings.get(chatId);
	const topicBinding = threadId !== undefined
		? registry.bindings.getTopic(chatId, threadId)
		: undefined;
	const lines = [
		`chat_id: ${chatId}`,
		`chat_type: ${ctx.chat.type}`,
	];
	const title = "title" in ctx.chat ? ctx.chat.title : undefined;
	if (title) lines.push(`chat_title: ${title}`);
	if (threadId !== undefined) lines.push(`thread_id: ${threadId}`);
	lines.push("");
	if (topicBinding) {
		lines.push(`bound to (topic): ${topicBinding.cwd}`);
		if (topicBinding.label) lines.push(`label: ${topicBinding.label}`);
		lines.push(`since: ${topicBinding.added_at}`);
	}
	if (binding && binding.cwd) {
		const tag = topicBinding ? "group default" : "bound to (group)";
		lines.push(`${tag}: ${binding.cwd}`);
		if (binding.label) lines.push(`label: ${binding.label}`);
		if (!topicBinding) lines.push(`since: ${binding.added_at}`);
	}
	if (!topicBinding && !(binding && binding.cwd)) {
		lines.push(`no binding — uses default cwd: ${DEFAULT_CWD}`);
		lines.push(threadId !== undefined
			? `bind this topic: /bind <path>`
			: `bind with: /bind <path>`);
	}
	await ctx.reply(lines.join("\n"));
});

bot.command("binding", async ctx => {
	const chatId = ctx.chat.id;
	const threadId = extractThreadId(ctx.message);
	const binding = registry.bindings.get(chatId);
	const topicBinding = threadId !== undefined
		? registry.bindings.getTopic(chatId, threadId)
		: undefined;
	const hasGroup = !!(binding && binding.cwd);
	const topicIds = registry.bindings.topicIds(chatId);
	if (!topicBinding && !hasGroup && topicIds.length === 0) {
		await ctx.reply(
			`no binding for chat ${chatId}${threadId !== undefined ? ` topic ${threadId}` : ""}\nfalls back to default: ${DEFAULT_CWD}`,
		);
		return;
	}
	const lines = [`chat_id: ${chatId}`];
	if (threadId !== undefined) lines.push(`thread_id: ${threadId}`);
	lines.push("");
	if (topicBinding) {
		lines.push(`topic ${threadId} cwd: ${topicBinding.cwd}`);
		if (topicBinding.label) lines.push(`  label: ${topicBinding.label}`);
		lines.push(`  added: ${topicBinding.added_at}`);
	}
	if (hasGroup) {
		lines.push(`group cwd: ${binding!.cwd}`);
		if (binding!.label) lines.push(`  label: ${binding!.label}`);
		lines.push(`  added: ${binding!.added_at}`);
	}
	if (topicIds.length > 0) {
		lines.push("", "configured topics:");
		for (const tid of topicIds.sort((a, b) => Number(a) - Number(b))) {
			const t = registry.bindings.getTopic(chatId, tid)!;
			const mark = String(threadId) === tid ? " ←" : "";
			lines.push(`  ${tid}: ${t.cwd}${mark}`);
		}
	}
	await ctx.reply(lines.join("\n"));
});

bot.command("bind", async ctx => {
	const raw = ctx.match?.trim();
	if (!raw) {
		await ctx.reply(
			[
				"usage: /bind <path> [|label]",
				"  e.g. /bind ~/Workspaces/omptg",
				"  e.g. /bind ~/Workspaces/foo|foo dev",
				"",
				"the new cwd takes effect on the next /new — the current session keeps its cwd",
			].join("\n"),
		);
		return;
	}
	// Optional `|label` suffix, split on first `|` only.
	const sep = raw.indexOf("|");
	const pathPart = (sep >= 0 ? raw.slice(0, sep) : raw).trim();
	const label = sep >= 0 ? raw.slice(sep + 1).trim() : undefined;
	const expanded = expandHome(pathPart);
	const abs = resolvePath(expanded);
	if (!existsSync(abs)) {
		await ctx.reply(`❌ not found: ${abs}`);
		return;
	}
	const fs = await import("node:fs");
	if (!fs.statSync(abs).isDirectory()) {
		await ctx.reply(`❌ not a directory: ${abs}`);
		return;
	}
	const threadId = extractThreadId(ctx.message);
	if (threadId !== undefined) {
		registry.bindings.setTopic(ctx.chat.id, threadId, { cwd: abs, label });
	} else {
		registry.bindings.set(ctx.chat.id, { cwd: abs, label });
	}
	const chat = registry.get(ctx.chat.id, threadId);
	const scope = threadId !== undefined ? `topic ${threadId}` : "group";
	const lines = [
		`✓ bound ${scope} to ${abs}`,
		label ? `label: ${label}` : undefined,
		"",
		chat.cwd === abs
			? "(already current cwd — nothing to switch)"
			: "/new to apply (current session keeps cwd: " + chat.cwd + ")",
	].filter(Boolean) as string[];
	await ctx.reply(lines.join("\n"));
	log.info("bind.set", { chat_id: ctx.chat.id, thread_id: threadId, cwd: abs, label });
});

bot.command("unbind", async ctx => {
	const threadId = extractThreadId(ctx.message);
	const removed = threadId !== undefined
		? registry.bindings.deleteTopic(ctx.chat.id, threadId)
		: registry.bindings.delete(ctx.chat.id);
	if (!removed) {
		await ctx.reply(`no binding to remove (already using default: ${DEFAULT_CWD})`);
		return;
	}
	const scope = threadId !== undefined ? `topic ${threadId}` : "group";
	await ctx.reply(
		[
			`✓ unbound ${scope} — fallback applies on next /new`,
			`(current session keeps its cwd)`,
		].join("\n"),
	);
	log.info("bind.removed", { chat_id: ctx.chat.id, thread_id: threadId });
});

bot.command("new", async ctx => {
	const threadId = extractThreadId(ctx.message);
	const chat = registry.get(ctx.chat.id, threadId);
	const desiredCwd = registry.cwdFor(ctx.chat.id, threadId);
	if (chat.isStreaming) {
		await chat.abort();
	}
	// If the binding changed since this chat's session was created, the
	// fresh session should land in the new cwd. switchCwd disposes the
	// old session and creates a new one in the target cwd.
	if (chat.cwd !== desiredCwd) {
		await chat.switchCwd(desiredCwd);
	} else {
		await chat.newSession();
	}
	await ctx.reply(`✨ fresh session in ${chat.cwd}\nid: ${chat.sessionId}`);
});

const SESSIONS_DEFAULT_LIMIT = 8;
const SESSIONS_MAX_LIMIT = 50;

bot.command("sessions", async ctx => {
	const chat = registry.get(ctx.chat.id, extractThreadId(ctx.message));
	const arg = ctx.match?.trim();
	let limit = SESSIONS_DEFAULT_LIMIT;
	if (arg) {
		const n = Number.parseInt(arg, 10);
		if (!Number.isFinite(n) || n < 1) {
			await ctx.reply(
				`usage: /sessions [n]   1..${SESSIONS_MAX_LIMIT}, default ${SESSIONS_DEFAULT_LIMIT}`,
			);
			return;
		}
		limit = Math.min(n, SESSIONS_MAX_LIMIT);
	}
	const sessions = await listStoredSessions(chat.cwd, limit);
	if (sessions.length === 0) {
		await ctx.reply(`no stored sessions in ${chat.cwd}`);
		return;
	}
	storedSessionsByChat.set(ctx.chat.id, sessions);
	const lines = sessions.map((s, i) => {
		const ts = s.modified.toISOString().slice(5, 16).replace("T", " ");
		// Prefer the LLM-generated title; fall back to the first user message;
		// last resort the placeholder.
		const raw = s.title || s.firstMessage || "(no message)";
		const preview = (raw.split("\n")[0] ?? "").slice(0, 70);
		return `${i + 1}. [${ts}] ${preview}`;
	});
	const footer = sessions.length >= limit && limit < SESSIONS_MAX_LIMIT
		? `…showing ${limit}; pass a larger number e.g. /sessions ${Math.min(limit * 2, SESSIONS_MAX_LIMIT)}`
		: "use /resume <n> to reopen";
	await ctx.reply(
		[`recent sessions in ${chat.cwd}`, "", ...lines, "", footer].join("\n"),
	);
});

const storedSessionsByChat = new Map<
	number,
	Awaited<ReturnType<typeof listStoredSessions>>
>();

bot.command("resume", async ctx => {
	const arg = ctx.match?.trim();
	const chat = registry.get(ctx.chat.id, extractThreadId(ctx.message));
	let targetPath: string;
	let targetIndex: number;
	if (!arg) {
		// No index: resume the most recent stored session in this cwd.
		// Independent of /sessions cache so it works on a cold chat.
		const latest = await listStoredSessions(chat.cwd, 1);
		if (latest.length === 0) {
			await ctx.reply(`no stored sessions in ${chat.cwd}`);
			return;
		}
		targetPath = latest[0]!.path;
		targetIndex = 1;
	} else {
		const n = Number.parseInt(arg, 10);
		const cached = storedSessionsByChat.get(ctx.chat.id);
		if (!cached || !Number.isFinite(n) || n < 1 || n > cached.length) {
			await ctx.reply("invalid index; run /sessions first");
			return;
		}
		targetPath = cached[n - 1]!.path;
		targetIndex = n;
	}
	if (chat.isStreaming) await chat.abort();
	try {
		await chat.resume(targetPath);
		await ctx.reply(
			`📜 resumed #${targetIndex} ${chat.sessionId}\ncwd: ${chat.cwd}`,
		);
	} catch (err) {
		await ctx.reply(`failed to resume: ${err instanceof Error ? err.message : err}`);
	}
});

bot.command("retitle", async ctx => {
	const chat = registry.get(ctx.chat.id, extractThreadId(ctx.message));
	if (!chat.hasSession) {
		await ctx.reply("no active session — send a message or /new first");
		return;
	}
	const arg = ctx.match?.trim();
	if (arg) {
		const ok = await chat.setTitle(arg);
		await ctx.reply(ok ? `✓ renamed to: ${arg}` : "failed to rename");
		return;
	}
	// No arg: regenerate via LLM. Show a placeholder so the user knows
	// something is happening — the call takes a beat (one LLM round-trip).
	await ctx.reply("regenerating title…");
	const newTitle = await chat.regenerateTitle();
	await ctx.reply(
		newTitle
			? `✓ renamed to: ${newTitle}`
			: "couldn't regenerate (no user prompt in history, or generator returned null)",
	);
});

async function dispatchVoiceText(
	chatId: number,
	threadId: number | undefined,
	text: string,
	replyTo: number,
): Promise<void> {
	const chat = registry.get(chatId, threadId);
	try {
		if (chat.isTurnActive) {
			await bot.api.sendMessage(chatId, "↪ steered (/cancel to abort)", {
				disable_notification: true,
				reply_parameters: { message_id: replyTo },
				...(threadId !== undefined ? { message_thread_id: threadId } : {}),
			});
		}
		await chat.prompt(text, { replyTo });
		const s = await chat.ensure();
		await s.waitForIdle();
	} catch (err) {
		log.error("voice_turn.failed", { chat_id: chatId, err: String(err) });
		try {
			await bot.api.sendMessage(
				chatId,
				`❌ ${err instanceof Error ? err.message : String(err)}`,
				{
					reply_parameters: { message_id: replyTo },
					...(threadId !== undefined ? { message_thread_id: threadId } : {}),
				},
			);
		} catch (replyErr) {
			log.error("voice_turn.error_reply_failed", { err: String(replyErr) });
		}
	} finally {
		await chat.endTurn();
	}
}

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
	// Voice approval shortcut — own prefix, independent of TelegramUI state.
	const voice = parseVoiceCallback(data);
	if (voice) {
		const chatId = ctx.chatId ?? ctx.callbackQuery.message?.chat.id;
		if (chatId === undefined) {
			await ctx.answerCallbackQuery("no chat context");
			return;
		}
		const entry = pendingVoice.take(voice.id);
		if (!entry) {
			await ctx.answerCallbackQuery("expired");
		} else {
			await ctx.answerCallbackQuery(voice.action === "send" ? "sent" : "discarded");
		}
		if (ctx.callbackQuery.message) {
			try {
				await ctx.api.editMessageReplyMarkup(
					ctx.callbackQuery.message.chat.id,
					ctx.callbackQuery.message.message_id,
					{ reply_markup: { inline_keyboard: [] } },
				);
			} catch (err) {
				log.warn("voice.strip_keyboard_failed", { err: String(err) });
			}
		}
		if (entry && voice.action === "send") {
			void dispatchVoiceText(entry.chatId, entry.threadId, entry.text, entry.replyTo);
		}
		return;
	}
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
	const threadId = extractThreadId(ctx.callbackQuery.message);
	const chat = registry.get(chatId, threadId);
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

let _knownCommands: Set<string> | undefined;
function knownCommands(): Set<string> {
	if (!_knownCommands) {
		_knownCommands = new Set(SLASH_COMMANDS.map(c => c.command));
	}
	return _knownCommands;
}
// Image input — Hermes-style indirect vision.
//
// We DO NOT pass the image bytes directly to session.prompt({ images }).
// That route gets stripped by SDK's vision-guard whenever the active
// model's catalog entry lacks "image" input — and the user's preferred
// long-context default (e.g. claude-opus-4.7-1m-internal) is text-only
// even when claude-opus-4.7 base is multimodal.
//
// Instead: download the photo to ~/.omptg/image-cache/<uuid>.<ext> and
// hand the main agent a *text* prompt referencing the local path. The
// main agent already has the `inspect_image` tool (OMP built-in), which
// resolves modelRoles.vision and runs an out-of-band vision call with a
// focused question. The default model stays in charge of context
// (history + caption + when to look), the vision model only sees one
// image at a time, and history stays text-only so subsequent turns
// don't need vision-capable models.
// Voice input — transcribe locally with whisper, show the text with
// [send / cancel] buttons before dispatching. Editing the transcription
// is done by replying to the bot's transcription message with a corrected
// version (see message:text handler below). Telegram voice notes are
// OGG Opus; Audio attachments may be mp3/m4a/etc — both routed here.
async function handleVoiceMessage(
	chatId: number,
	threadId: number | undefined,
	replyTo: number,
	fileId: string,
	sendInitial: (text: string, opts: Record<string, unknown>) => Promise<{ message_id: number }>,
): Promise<void> {
	const topicOpts = threadId !== undefined ? { message_thread_id: threadId } : {};
	const heartbeat = await sendInitial("🎤 transcribing…", {
		reply_parameters: { message_id: replyTo },
		...topicOpts,
	});
	try {
		const { path, bytes } = await downloadVoiceToCache(bot, fileId);
		log.info("voice.cached", { chat_id: chatId, path, bytes });
		const text = await transcribeAudio(path, {
			modelName: STT_MODEL,
			language: STT_LANGUAGE,
		});
		if (!text) {
		await bot.api.editMessageText(
				chatId,
				heartbeat.message_id,
				"🎤 (empty transcription)",
			);
			return;
		}
		const id = freshVoiceId();
		const body = [
			"🎤 transcription:",
			text,
			"",
			"↳ tap ✅ to send · reply to this message to edit · ❌ to discard",
		].join("\n");
		await bot.api.editMessageText(chatId, heartbeat.message_id, body, {
			reply_markup: {
				inline_keyboard: [[
					{ text: "✅ send", callback_data: encodeVoiceCallback("send", id) },
					{ text: "❌ cancel", callback_data: encodeVoiceCallback("cancel", id) },
				]],
			},
		});
		pendingVoice.put({
			id,
			chatId,
			threadId,
			replyTo,
			transcriptMessageId: heartbeat.message_id,
			text,
		});
		log.info("voice.transcribed", { chat_id: chatId, id, chars: text.length });
	} catch (err) {
		log.error("voice.failed", { chat_id: chatId, err: String(err) });
		const msg = err instanceof Error ? err.message : String(err);
		try {
			await bot.api.editMessageText(chatId, heartbeat.message_id, `❌ ${msg}`);
		} catch {
			await bot.api.sendMessage(chatId, `❌ ${msg}`, {
				reply_parameters: { message_id: replyTo },
				...topicOpts,
			});
		}
	}
}

bot.on("message:voice", async ctx => {
	await handleVoiceMessage(
		ctx.chat.id,
		extractThreadId(ctx.message),
		ctx.message.message_id,
		ctx.message.voice.file_id,
		(text, opts) => ctx.reply(text, opts),
	);
});

bot.on("message:audio", async ctx => {
	await handleVoiceMessage(
		ctx.chat.id,
		extractThreadId(ctx.message),
		ctx.message.message_id,
		ctx.message.audio.file_id,
		(text, opts) => ctx.reply(text, opts),
	);
});

bot.on("message:photo", async ctx => {
	const photos = ctx.message.photo;
	const largest = photos[photos.length - 1];
	if (!largest) return; // telegram always sends ≥1, defensive
	const caption = ctx.message.caption?.trim() ?? "";
	const chat = registry.get(ctx.chat.id, extractThreadId(ctx.message));
	const replyTo = ctx.message.message_id;

	void (async () => {
		try {
			const { path, bytes } = await downloadPhotoToCache(bot, largest.file_id);
			log.info("photo.cached", { chat_id: ctx.chat.id, path, bytes });

			// Prompt format: the local path on its own line so the agent
			// can lift it verbatim into inspect_image(path=...), followed
			// by the user's caption (or an explicit "no caption" sentinel
			// so the agent doesn't think we forgot to forward it).
			const promptText = [
				`[user attached image: ${path}]`,
				"",
				caption || "(no caption — describe or ask what they want)",
			].join("\n");

			if (chat.isTurnActive) {
				await ctx.reply("↪ steered (/cancel to abort)", {
					disable_notification: true,
					reply_parameters: { message_id: replyTo },
				});
			}
			await chat.prompt(promptText, { replyTo });
			const s = await chat.ensure();
			await s.waitForIdle();
		} catch (err) {
			log.error("photo_turn.failed", {
				chat_id: ctx.chat.id,
				err: String(err),
			});
			try {
				await ctx.reply(`❌ ${err instanceof Error ? err.message : String(err)}`, {
					reply_parameters: { message_id: replyTo },
				});
			} catch (replyErr) {
				log.error("photo_turn.error_reply_failed", { err: String(replyErr) });
			}
		} finally {
			await chat.endTurn();
		}
	})();
});

bot.on("message:text", async ctx => {
	// Voice transcription override: if the user replied to one of our
	// "🎤 transcription:" messages with a corrected version, swap that
	// in and dispatch as if they tapped ✅. The original keyboard is
	// stripped so the buttons can't be re-used.
	const replyToId = ctx.message.reply_to_message?.message_id;
	if (replyToId !== undefined) {
		const edited = pendingVoice.takeByTranscriptMessage(ctx.chat.id, replyToId);
		if (edited) {
			try {
				await ctx.api.editMessageReplyMarkup(
					ctx.chat.id,
					edited.transcriptMessageId,
					{ reply_markup: { inline_keyboard: [] } },
				);
			} catch (err) {
				log.warn("voice.edit.strip_keyboard_failed", { err: String(err) });
			}
			await ctx.reply("↪ using edited transcription");
			void dispatchVoiceText(edited.chatId, edited.threadId, ctx.message.text, edited.replyTo);
			return;
		}
	}
	const rawText = ctx.message.text;
	// Detect telegram's native reply (long-press → reply). The replied-to
	// message is in `reply_to_message`; we wrap it as a markdown blockquote
	// so the agent can read what the user is referring back to. We do this
	// for non-command, non-pendingUi-text replies — the awaitsText path
	// already handles the "answering my own /ask" case below.
	const replyMsg = ctx.message.reply_to_message;
	let reply: ReplyContext | undefined;
	if (replyMsg) {
		const author = replyMsg.from;
		const fromBot = author?.id === ctx.me.id;
		reply = {
			author: fromBot
				? "you"
				: author?.first_name || author?.username || "someone",
			fromBot,
			text: replyMsg.text ?? replyMsg.caption ?? "",
		};
	}
	// Detect telegram forward (any message with forward_origin). We wrap
	// the forwarded body the same way as a reply, tagging the original
	// source kind (user / hidden_user / chat / channel) and name. For
	// plain text forwards, the user can't add inline text in the same
	// message, so the prompt becomes just the quote block.
	const fwdOrigin = ctx.message.forward_origin;
	let forward: ForwardContext | undefined;
	if (fwdOrigin) {
		let kind: ForwardContext["kind"];
		let name: string;
		switch (fwdOrigin.type) {
			case "user":
				kind = "user";
				name = fwdOrigin.sender_user.first_name
					|| fwdOrigin.sender_user.username
					|| "user";
				break;
			case "hidden_user":
				kind = "hidden_user";
				name = fwdOrigin.sender_user_name || "hidden user";
				break;
			case "chat":
				kind = "chat";
				name = ("title" in fwdOrigin.sender_chat && fwdOrigin.sender_chat.title)
					|| "chat";
				break;
			case "channel":
				kind = "channel";
				name = fwdOrigin.chat.title || fwdOrigin.chat.username || "channel";
				break;
		}
		forward = { kind, name, date: fwdOrigin.date, text: rawText };
	}
	const text = rawText;
	// Forwarded messages: the text might literally start with "/something"
	// but it's the forwarded body, not a command. Skip the slash-command
	// branch entirely so the body falls through to the normal agent turn
	// (where it gets wrapped as [forwarded from …]).
	if (text.startsWith("/") && !forward) {
		// First bot_command entity at offset 0 is the command. Strip an
		// optional `@bot` suffix that telegram clients add in groups.
		const entities = ctx.message.entities ?? [];
		const cmdEntity = entities.find(
			e => e.type === "bot_command" && e.offset === 0,
		);
		if (!cmdEntity) return; // not actually a command, just text starting with /
		const raw = text.slice(1, cmdEntity.length);
		const atIdx = raw.indexOf("@");
		const cmd = atIdx >= 0 ? raw.slice(0, atIdx) : raw;
		// `@bot` suffix targeting another bot: not for us, ignore.
		if (atIdx >= 0) {
			const target = raw.slice(atIdx + 1).toLowerCase();
			const me = ctx.me.username.toLowerCase();
			if (target !== me) return;
		}
		if (knownCommands().has(cmd)) return; // real handler already ran
		await ctx.reply(
			`unknown command: /${cmd}\ntype /start for the list`,
		);
		return;
	}

	const chat = registry.get(ctx.chat.id, extractThreadId(ctx.message));

	// If a UI prompt is awaiting a text reply, route this message there.
	const pending = chat.pendingUi();
	if (pending?.awaitsText) {
		const handled = chat.resolvePending({ kind: "text", text });
		if (handled) {
			await ctx.reply("↪ sent to agent");
			return;
		}
	}

	// CRITICAL: grammY processes updates SEQUENTIALLY by default, and only
	// advances to the next update after this handler returns. The agent
	// turn can call ui.select / ui.confirm and then block waiting for the
	// user's button tap — but that tap is the very next telegram update,
	// which grammY can't deliver until we return. So we'd deadlock.
	//
	// Fire-and-forget the turn. Errors are captured + reported back into
	// the chat asynchronously so we don't lose them.
	void (async () => {
		try {
			// If a turn is already running, sending another message routes
			// through session.steer() (LLM sees it mid-turn). Ack so the
			// user knows it landed — silent push, with the escape hatch.
			if (chat.isTurnActive) {
				await ctx.reply("↪ steered (/cancel to abort)", {
					disable_notification: true,
					reply_parameters: { message_id: ctx.message.message_id },
				});
			}
			// Wrap order: forward first (the message itself is the quoted
			// thing), then reply (annotates relationship to a prior message).
			// If both are set on the same telegram message the user replied
			// while forwarding, which is rare — handle by stacking.
			let promptText = text;
			if (forward) promptText = formatForwardPrompt(forward, "");
			if (reply) promptText = formatReplyPrompt(reply, promptText);
			await chat.prompt(promptText, { replyTo: ctx.message.message_id });
			const s = await chat.ensure();
			await s.waitForIdle();
		} catch (err) {
			log.error("turn.failed", {
				chat_id: ctx.chat.id,
				err: String(err),
				stack: err instanceof Error ? err.stack : undefined,
			});
			try {
				await ctx.reply(`❌ ${err instanceof Error ? err.message : String(err)}`);
			} catch (replyErr) {
				log.error("turn.error_reply_failed", { err: String(replyErr) });
			}
		} finally {
			await chat.endTurn();
		}
	})();
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
	default_cwd: DEFAULT_CWD,
	default_cwd_source: Bun.env.OMP_DEFAULT_CWD ? "env" : "fallback:~/.omptg",
	allowed_chats: [...ALLOWED],
	log_file: logPath(),
});

// Prune old structured logs. Cheap; runs once per boot. The active
// file (today's) is always skipped — see log-rotate.ts.
const LOG_RETAIN_DAYS = Number(Bun.env.OMPTG_LOG_RETAIN_DAYS ?? 30);
const LOG_COMPRESS_AFTER_DAYS = Number(Bun.env.OMPTG_LOG_COMPRESS_AFTER_DAYS ?? 7);
try {
	const result = await rotateLogs(logDir(), logPath(), {
		retainDays: LOG_RETAIN_DAYS,
		compressAfterDays: LOG_COMPRESS_AFTER_DAYS,
	});
	if (result.planned.length > 0) {
		log.info("boot.log_rotated", {
			planned: result.planned.length,
			done: result.done.length,
			failed: result.failed.length,
			retain_days: LOG_RETAIN_DAYS,
			compress_after_days: LOG_COMPRESS_AFTER_DAYS,
			details: result.done,
			errors: result.failed,
		});
	}
} catch (err) {
	log.warn("boot.log_rotate_failed", { err: String(err) });
}
await initTheme();
log.info("boot.theme_ready");

// Register slash commands with Telegram so they show up in the chat
// autocomplete and the menu button. Best-effort: a network blip here is
// not fatal — the bot can still receive /commands without registration.
// Register slash commands. Telegram scopes the command menu separately
// per surface: the default scope only covers private chats, so groups
// won't see autocomplete unless we also push to all_group_chats (and
// all_chat_administrators so admin-only groups still see them).
const SLASH_COMMANDS = [
	{ command: "new",      description: "Start a fresh session in the current cwd" },
	{ command: "sessions", description: "List recent stored sessions (default 8)" },
	{ command: "resume",   description: "Reopen session — no arg = most recent" },
	{ command: "cancel",   description: "Abort the current turn (keeps session)" },
	{ command: "status",   description: "Show session id, model, cwd" },
	{ command: "model",    description: "Switch model — no arg opens picker" },
	{ command: "compact",  description: "Manually compact session context" },
	{ command: "whoami",   description: "Show this chat's id + binding" },
	{ command: "bind",     description: "/bind <path> — pin chat or topic to a cwd" },
	{ command: "unbind",   description: "Remove binding for this scope" },
	{ command: "binding",  description: "Show topic + group bindings" },
	{ command: "retitle",  description: "/retitle [name] — rename current session, or regen via LLM if no name" },
	{ command: "start",    description: "Show help" },
] as const;
const COMMAND_SCOPES = [
	{ type: "default" },
	{ type: "all_private_chats" },
	{ type: "all_group_chats" },
	{ type: "all_chat_administrators" },
] as const;
const registered: Array<{ scope: string; ok: boolean; err?: string }> = [];
for (const scope of COMMAND_SCOPES) {
	try {
		await bot.api.setMyCommands([...SLASH_COMMANDS], { scope });
		registered.push({ scope: scope.type, ok: true });
	} catch (err) {
		registered.push({ scope: scope.type, ok: false, err: String(err) });
	}
}
log.info("boot.commands_registered", { results: registered });

// `chat` scope overrides all the broader scopes. If the bot was ever used
// by a different codebase (or earlier version) that pushed a chat-specific
// command list to a chat we now control, telegram clients in that chat will
// keep showing the stale list. Wipe overrides for every chat we know
// about so they fall through to our all_group_chats / all_private_chats
// registration.
const overrideChats = new Set<string>();
for (const id of ALLOWED) overrideChats.add(id);
for (const id of chatStore.chatIds()) overrideChats.add(id);
const wiped: Array<{ chat_id: string; ok: boolean; err?: string }> = [];
for (const id of overrideChats) {
	try {
		await bot.api.deleteMyCommands({
			scope: { type: "chat", chat_id: Number(id) },
		});
		wiped.push({ chat_id: id, ok: true });
	} catch (err) {
		// Most likely error: bot is not a member of that chat (private chat
		// the bot was never in, or a group we left). Not fatal.
		wiped.push({ chat_id: id, ok: false, err: String(err) });
	}
}
if (wiped.length > 0) log.info("boot.chat_overrides_wiped", { results: wiped });

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
