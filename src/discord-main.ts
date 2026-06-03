/**
 * omptg Discord bridge entrypoint.
 *
 * Connects discord.js, mounts the bridge + ChatRegistry, installs the
 * messageCreate / interactionCreate / slash-command handlers, and
 * registers slash commands with Discord on ClientReady (guild-scoped
 * when DISCORD_DEV_GUILDS is set, otherwise global).
 *
 * The messageCreate handler still echoes (agent dispatch from inbound
 * messages lands in a later phase); slash commands route through the
 * shared bridge-agnostic dispatcher in src/commands.ts.
 */
import { Client, GatewayIntentBits, Events } from "discord.js";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { DiscordBridge } from "./bridge/discord/index.ts";
import { ChatRegistry } from "./chat.ts";
import { ChatStore } from "./chat-store.ts";
import { installDiscordMessageHandler } from "./handlers/discord/message.ts";
import { installDiscordInteractionHandler } from "./handlers/discord/interaction.ts";
import { installDiscordCommandHandler } from "./handlers/discord/commands.ts";
import { registerSlashCommands } from "./bridge/discord/registration.ts";
import { scoped } from "./logger.ts";

const log = scoped("discord-main");

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

function resolveDefaultCwd(): string {
	const env = Bun.env.OMP_DEFAULT_CWD;
	if (env) return resolveDir(env);
	const fallback = resolvePath(homedir(), ".omptg");
	mkdirSync(fallback, { recursive: true });
	return fallback;
}

function csvSet(name: string): Set<string> {
	const raw = Bun.env[name] ?? "";
	return new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
}

const TOKEN = required("DISCORD_BOT_TOKEN");
const DEFAULT_CWD = resolveDefaultCwd();
const ALLOWED_GUILDS = csvSet("DISCORD_ALLOWED_GUILDS");
const ALLOWED_CHANNELS = csvSet("DISCORD_ALLOWED_CHANNELS");
const DEV_GUILDS = csvSet("DISCORD_DEV_GUILDS");

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
		GatewayIntentBits.GuildMessageReactions,
	],
});

const chatStore = new ChatStore();
const bridge = new DiscordBridge(client);
const registry = new ChatRegistry(bridge, DEFAULT_CWD, chatStore);

installDiscordMessageHandler({
	client,
	registry,
	allowedChannels: ALLOWED_CHANNELS,
	allowedGuilds: ALLOWED_GUILDS,
});

installDiscordInteractionHandler({
	client,
	registry,
	allowedChannels: ALLOWED_CHANNELS,
	allowedGuilds: ALLOWED_GUILDS,
});

installDiscordCommandHandler({
	client,
	registry,
	defaultCwd: DEFAULT_CWD,
	allowedChannels: ALLOWED_CHANNELS,
	allowedGuilds: ALLOWED_GUILDS,
});

client.once(Events.ClientReady, c => {
	log.info("ready", {
		user: c.user.tag,
		default_cwd: DEFAULT_CWD,
		allowed_guilds: [...ALLOWED_GUILDS],
		allowed_channels: [...ALLOWED_CHANNELS],
		dev_guilds: [...DEV_GUILDS],
	});
	// Register slash commands after login so client.application.id resolves.
	// Guild-scoped (instant) when DISCORD_DEV_GUILDS is set, otherwise
	// global (up to 1h propagation). Failure here is non-fatal: existing
	// commands keep working with the previously-registered definitions.
	void registerSlashCommands(client, DEV_GUILDS).catch(err => {
		log.error("register.failed", { err: String(err) });
	});
});

client.on(Events.Error, err => {
	log.error("client.error", { err: String(err) });
});

process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

async function shutdown(signal: string): Promise<void> {
	log.info("shutdown.start", { signal });
	try { await registry.disposeAll(); } catch (err) { log.warn("dispose.registry", { err: String(err) }); }
	try { await bridge.dispose(); } catch (err) { log.warn("dispose.bridge", { err: String(err) }); }
	try { await client.destroy(); } catch (err) { log.warn("dispose.client", { err: String(err) }); }
	process.exit(0);
}

await client.login(TOKEN);
