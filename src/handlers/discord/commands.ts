/**
 * Discord slash-command handler.
 *
 * Routes `ChatInputCommandInteraction` (i.e. `/foo`) through the
 * bridge-agnostic dispatcher in `commands.ts`. Channel/thread routing
 * mirrors `handlers/discord/message.ts`: a command invoked inside a
 * thread binds the thread; invoked on the parent channel binds the
 * channel.
 *
 * Replies use Discord's interaction reply API; we `deferReply` first
 * so handlers that take >3s (model picker, compact, resume) don't hit
 * the interaction-expired window.
 */
import type { ChatInputCommandInteraction, Client } from "discord.js";
import { Events, MessageFlags } from "discord.js";
import type { ChatRegistry } from "../../chat.ts";
import type { CommandContext } from "../../commands.ts";
import { runSlashCommand } from "../../commands.ts";
import { scoped } from "../../logger.ts";

const log = scoped("dc-cmd");

/** Discord caps a single message at 2000 chars; commands occasionally
 *  exceed that (e.g. `/model` with a long available-models list).
 *  Truncate with a trailing marker so the user knows there's more. */
const DISCORD_MAX_MESSAGE = 2000;
function fitForDiscord(text: string): string {
	if (!text) return "(empty)";
	if (text.length <= DISCORD_MAX_MESSAGE) return text;
	return `${text.slice(0, DISCORD_MAX_MESSAGE - 3)}...`;
}

export interface DiscordCommandHandlerOptions {
	client: Client;
	registry: ChatRegistry;
	defaultCwd: string;
	allowedChannels: ReadonlySet<string>;
	allowedGuilds: ReadonlySet<string>;
}

export function installDiscordCommandHandler(opts: DiscordCommandHandlerOptions): void {
	const { client, registry, defaultCwd, allowedChannels, allowedGuilds } = opts;

	client.on(Events.InteractionCreate, async interaction => {
		if (!interaction.isChatInputCommand()) return;
		try {
			await handle(interaction, { registry, defaultCwd, allowedChannels, allowedGuilds });
		} catch (err) {
			log.error("command.error", { name: interaction.commandName, err: String(err) });
			await safeReply(interaction, `❌ command failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	});
}

interface HandleDeps {
	registry: ChatRegistry;
	defaultCwd: string;
	allowedChannels: ReadonlySet<string>;
	allowedGuilds: ReadonlySet<string>;
}

async function handle(interaction: ChatInputCommandInteraction, deps: HandleDeps): Promise<void> {
	if (!interaction.guildId) {
		await interaction.reply({ content: "DMs are not supported", flags: MessageFlags.Ephemeral });
		return;
	}
	if (deps.allowedGuilds.size > 0 && !deps.allowedGuilds.has(interaction.guildId)) {
		// Ephemeral ack: silently returning would make Discord show the
		// invoking user a red "interaction failed" toast after 3s.
		await interaction.reply({ content: "⊘ this bot isn't enabled in this server", flags: MessageFlags.Ephemeral });
		return;
	}

	const ch = interaction.channel;
	if (!ch) {
		await interaction.reply({ content: "no channel context", flags: MessageFlags.Ephemeral });
		return;
	}

	// Mirror handlers/discord/message.ts:
	//   inside a thread → bind the thread (parent channel is the chatId)
	//   on the channel  → bind the channel itself
	// Three-level cwd resolution (thread → channel → default) then falls
	// out of ChatRegistry.cwdFor unchanged.
	let channelId: string;
	let threadId: string | undefined;
	if (ch.isThread()) {
		if (!ch.parentId) {
			// Defensive: discord.js threads always carry parentId, but the
			// type is optional and the parent could in theory be deleted
			// mid-flight. Ack ephemerally so the user sees a real message
			// instead of Discord's red "interaction failed" toast.
			await interaction.reply({ content: "⊘ thread has no parent channel", flags: MessageFlags.Ephemeral });
			return;
		}
		channelId = ch.parentId;
		threadId = ch.id;
	} else {
		channelId = ch.id;
		threadId = undefined;
	}
	if (deps.allowedChannels.size > 0 && !deps.allowedChannels.has(channelId)) {
		await interaction.reply({ content: "⊘ this bot isn't enabled in this channel", flags: MessageFlags.Ephemeral });
		return;
	}

	// /bind, /compact, /model, /resume, /retitle can exceed Discord's
	// 3s ack window. Defer once up-front so every command can take its
	// time; first ctx.reply() consumes the ack via editReply, later
	// replies use followUp. The interaction token itself is valid for
	// 15 minutes; past that, editReply/followUp reject with "Unknown
	// Webhook" and we fall back to plain channel.send() so the user
	// isn't stuck watching "Bot is thinking..." forever.
	await interaction.deferReply();

	let replyCount = 0;
	const ctx: CommandContext = {
		chatId: channelId,
		threadId,
		chatType: ch.isThread() ? "thread" : "channel",
		// In a thread, `ch.name` is the thread name — but `chatId` is the
		// PARENT channel snowflake, so report the parent's name to keep
		// title and id in sync (matches Telegram, where ctx.chat.title is
		// the group title even when the message lives in a topic).
		chatTitle: ch.isThread()
			? (ch.parent?.name ?? undefined)
			: ("name" in ch && typeof ch.name === "string" ? ch.name : undefined),
		arg: collectArgString(interaction),
		registry: deps.registry,
		defaultCwd: deps.defaultCwd,
		reply: async text => {
			const fitted = fitForDiscord(text);
			const isFirst = replyCount === 0;
			try {
				if (isFirst) {
					await interaction.editReply(fitted);
				} else {
					await interaction.followUp(fitted);
				}
				// Increment AFTER success so a failed first reply doesn't
				// strand subsequent replies on the followUp branch with no
				// successful initial reply to follow.
				replyCount++;
			} catch (err) {
				log.warn("interaction.reply_failed", {
					command: interaction.commandName,
					first: isFirst,
					err: String(err),
				});
				// Token likely expired (>15 min) or webhook revoked. Fall
				// back to a plain channel.send so the user sees the output
				// instead of a stuck spinner.
				if (ch.isTextBased() && "send" in ch) {
					try {
						await (ch as { send: (m: string) => Promise<unknown> }).send(fitted);
						replyCount++;
					} catch (err2) {
						log.error("interaction.fallback_send_failed", { err: String(err2) });
					}
				}
			}
		},
	};

	const known = await runSlashCommand(interaction.commandName, ctx);
	if (!known) {
		await interaction.editReply(`unknown command: /${interaction.commandName}`);
	}
}

/** Concatenate every STRING option Discord delivered into a single
 *  space-joined arg string. Today every command declares at most one
 *  option; future multi-option commands would need a stricter contract,
 *  but this keeps the dispatcher's "arg is a string" shape intact. */
function collectArgString(interaction: ChatInputCommandInteraction): string {
	const parts: string[] = [];
	for (const opt of interaction.options.data) {
		if (typeof opt.value === "string") parts.push(opt.value);
	}
	return parts.join(" ").trim();
}

async function safeReply(interaction: ChatInputCommandInteraction, text: string): Promise<void> {
	const body = { content: text.slice(0, DISCORD_MAX_MESSAGE), flags: MessageFlags.Ephemeral } as const;
	try {
		// Deferred-but-not-replied: the deferReply() already promised a
		// public response. Using followUp() here would leave that public
		// promise stuck on "Bot is thinking…" forever and post the error
		// as a separate ephemeral message only the invoker sees. editReply
		// resolves the deferred ack with the error text instead.
		if (interaction.replied) {
			await interaction.followUp(body);
		} else if (interaction.deferred) {
			await interaction.editReply({ content: body.content });
		} else {
			await interaction.reply(body);
		}
	} catch (err) {
		log.warn("safeReply.failed", { err: String(err) });
	}
}
