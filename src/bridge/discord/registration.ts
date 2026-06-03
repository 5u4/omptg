/**
 * Slash-command registration with Discord's REST API.
 *
 * Derives the registration payload from `SLASH_COMMANDS` (the same
 * source of truth Telegram's `setMyCommands` uses) and pushes it once
 * at boot.
 *
 * Scope:
 * - guild-scoped when `guildIds` is non-empty — propagates instantly,
 *   used during development so iteration isn't gated on Discord's
 *   global-command cache.
 * - global otherwise — up to one hour of propagation, but visible in
 *   every guild the bot joins.
 *
 * Idempotent: `put` replaces the full command set on Discord's side,
 * so re-running on boot with the same payload is a no-op.
 */
import type { Client } from "discord.js";
import {
	REST,
	Routes,
	SlashCommandBuilder,
	type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { SLASH_COMMAND_SPECS } from "../../commands.ts";
import { scoped } from "../../logger.ts";

const log = scoped("dc-register");

/** Discord caps slash-command descriptions at 100 chars. Truncate
 *  defensively so a long Telegram-style description doesn't reject the
 *  whole registration. */
function clamp(desc: string, max = 100): string {
	return desc.length <= max ? desc : `${desc.slice(0, max - 1)}…`;
}

/** Build the JSON payload for Discord's bulk-overwrite endpoint from
 *  the shared `SLASH_COMMANDS` table. Exposed for testing. */
export function buildSlashCommandPayload(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
	return SLASH_COMMAND_SPECS.map(spec => {
		const b = new SlashCommandBuilder()
			.setName(spec.command)
			.setDescription(clamp(spec.description));
		if (spec.arg) {
			b.addStringOption(opt =>
				opt
					.setName(spec.arg!.name)
					.setDescription(clamp(spec.arg!.description))
					.setRequired(!!spec.arg!.required),
			);
		}
		return b.toJSON();
	});
}

/** Register slash commands with Discord. `client` must be logged in
 *  (so `client.application.id` resolves); call from the `ClientReady`
 *  handler. */
export async function registerSlashCommands(
	client: Client,
	guildIds?: ReadonlySet<string>,
): Promise<void> {
	const appId = client.application?.id;
	const token = client.token;
	if (!appId || !token) {
		throw new Error("registerSlashCommands: client not ready (missing application.id or token)");
	}
	const rest = new REST({ version: "10" }).setToken(token);
	const body = buildSlashCommandPayload();

	if (guildIds && guildIds.size > 0) {
		await Promise.all([...guildIds].map(async gid => {
			await rest.put(Routes.applicationGuildCommands(appId, gid), { body });
			log.info("slash.registered", { scope: "guild", guild_id: gid, count: body.length });
		}));
		return;
	}
	await rest.put(Routes.applicationCommands(appId), { body });
	log.info("slash.registered", { scope: "global", count: body.length });
}
