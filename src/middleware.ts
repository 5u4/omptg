/**
 * Global bot.use() middleware: inbound update logging, allow-list auth,
 * and a bot_command-stripper for forwarded messages so a forwarded slash
 * command can't trigger our command handlers.
 *
 * Install order matters: logging → auth → strip-forward-cmd, so the log
 * captures every update (including rejected ones), and forwarded
 * /commands are sanitized before bot.command() handlers run.
 */
import type { Deps } from "./deps.ts";
import { scoped } from "./logger.ts";

const log = scoped("middleware");

/** Log every inbound update before any other guard runs, so we can see
 *  callback_query updates even when the allow-list later drops them. */
export function installLogging(deps: Deps): void {
	deps.bot.use(async (ctx, next) => {
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
}

/**
 * Allow an update through if EITHER the sender's user id OR the chat id
 * is in the allow list. This lets a user talk to the bot in a group
 * where they (but not the group) are listed — while still ignoring
 * anyone else in the same group.
 *
 * Empty allow-list = open mode (still token-authenticated).
 */
export function installAuth(deps: Deps): void {
	const { allowedChats } = deps;
	deps.bot.use(async (ctx, next) => {
		if (allowedChats.size === 0) {
			await next();
			return;
		}
		const chatId = (ctx.chat?.id ?? ctx.chatId)?.toString();
		const fromId = ctx.from?.id?.toString();
		const ok =
			(chatId !== undefined && allowedChats.has(chatId)) ||
			(fromId !== undefined && allowedChats.has(fromId));
		if (!ok) {
			log.warn("auth.reject", {
				chat_id: chatId,
				from_id: fromId,
				allowed: [...allowedChats],
			});
			return;
		}
		await next();
	});
}

/**
 * Forwarded messages MUST NOT trigger slash commands. Telegram preserves
 * the original message entities (including `bot_command` at offset 0)
 * when a user forwards a message, so grammY's bot.command() would happily
 * run /unbind/etc. against the new chat just because the forwarded body
 * started with a slash. Strip bot_command entities on any forwarded
 * message before downstream handlers see them — the text still flows
 * through message:text and gets wrapped as a [forwarded from …] quote,
 * which is what the user actually meant.
 */
export function installStripForwardCmd(deps: Deps): void {
	deps.bot.use(async (ctx, next) => {
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
}

/** Install all global middleware in the correct order. */
export function installMiddleware(deps: Deps): void {
	installLogging(deps);
	installAuth(deps);
	installStripForwardCmd(deps);
}
