/**
 * Discord `interactionCreate` handler — routes button taps, select-menu
 * submits, and modal submits with the `omp:` customId prefix into the
 * per-route `DiscordUI.handleInteraction`.
 *
 * Interactions carry their own channel/thread context, so we re-derive
 * the route key the same way `message.ts` does (parent channel for
 * threads, channel itself otherwise) and look up the existing session
 * via `ChatRegistry.get`. Other interaction kinds (slash commands —
 * phase 5) fall through untouched.
 */
import type { Client, Interaction } from "discord.js";
import { Events, MessageFlags } from "discord.js";
import type { ChatRegistry } from "../../chat.ts";
import { DiscordUI } from "../../bridge/discord/ui.ts";
import { scoped } from "../../logger.ts";

const log = scoped("dc-interaction");

export interface DiscordInteractionHandlerOptions {
	client: Client;
	registry: ChatRegistry;
	allowedChannels: ReadonlySet<string>;
	allowedGuilds: ReadonlySet<string>;
}

export function installDiscordInteractionHandler(
	opts: DiscordInteractionHandlerOptions,
): void {
	const { client, registry, allowedChannels, allowedGuilds } = opts;

	client.on(Events.InteractionCreate, async (interaction: Interaction) => {
		try {
			if (!interaction.isButton()
				&& !interaction.isStringSelectMenu()
				&& !interaction.isModalSubmit()
			) return;
			if (!interaction.customId.startsWith("omp:")) return;
			if (!interaction.guildId) return;
			if (allowedGuilds.size > 0 && !allowedGuilds.has(interaction.guildId)) return;

			const ch = interaction.channel;
			if (!ch) {
				log.warn("interaction.no_channel", { id: interaction.id });
				return;
			}

			let channelId: string;
			let threadId: string | undefined;
			if (ch.isThread()) {
				if (!ch.parentId) return;
				channelId = ch.parentId;
				threadId = ch.id;
			} else {
				channelId = ch.id;
				threadId = undefined;
			}
			if (allowedChannels.size > 0 && !allowedChannels.has(channelId)) return;

			// Use `peek` rather than `get`: an interaction implies the
			// session was created when we posted the carrier. After a bot
			// restart, users may still tap leftover buttons in old
			// channels — bail with an ephemeral "expired" instead of
			// spinning up a fresh ChatSession + AgentSession per stale tap
			// (which would be a per-click DoS in long-lived channels).
			const chat = registry.peek(channelId, threadId);
			if (!chat) {
				await interaction.reply({
					content: "⊘ expired — bot restarted; try the latest prompt",
					flags: MessageFlags.Ephemeral,
				}).catch(err => log.warn("expired_reply.failed", { err: String(err) }));
				return;
			}
			const ui = chat.uiBridge();
			if (!(ui instanceof DiscordUI)) {
				log.warn("interaction.ui_mismatch", { type: ui.constructor.name });
				return;
			}
			await ui.handleInteraction(interaction);
		} catch (err) {
			log.error("interaction.error", { err: String(err) });
		}
	});
}
