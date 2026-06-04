/**
 * Discord end-to-end smoke. Drives a real bot session against a real
 * guild and asserts the Phase 6 contract end to end:
 *
 *   1. login to the gateway
 *   2. post `<unique nonce>` in the configured test channel
 *   3. observe `ThreadCreate` for the bot spawning a thread off our
 *      starter message (thread id === starter message id)
 *   4. observe a reply by the bot under test inside that thread within
 *      `TIMEOUT_MS`
 *   5. disconnect cleanly
 *
 * This script logs in as a SECOND bot (`DISCORD_SMOKE_TOKEN`) distinct
 * from the bot under test. The handler in `src/handlers/discord/message.ts`
 * normally drops `msg.author.bot === true` messages, so the bot under
 * test MUST be started with `DISCORD_TEST_BOT_AUTHORS=<smoke bot snowflake>`
 * to allow this smoke bot's messages through. Without that env, the smoke
 * times out with no thread spawn.
 *
 * The observer bot does NOT need to appear in `DISCORD_ALLOWED_GUILDS` /
 * `DISCORD_ALLOWED_CHANNELS` — those filter where the bot under test
 * accepts traffic, not who is posting.
 *
 * Env (all required unless noted):
 *   DISCORD_SMOKE_TOKEN          — token for the smoke client (a 2nd bot in the same guild)
 *   DISCORD_SMOKE_GUILD_ID       — guild snowflake
 *   DISCORD_SMOKE_CHANNEL_ID     — text channel snowflake to post into
 *   DISCORD_SMOKE_BOT_ID         — application id of the bot UNDER TEST
 *                                  (so we can identify its replies)
 *   DISCORD_SMOKE_PROMPT         — optional, default "ping (smoke)"
 *   DISCORD_SMOKE_TIMEOUT_MS     — optional, default 120000 (cold start
 *                                  on first OMP call can take 60s+)
 *
 * The bot under test must already be running (e.g. `bun run start:discord`
 * in another terminal, or via PM2) and online in the same guild.
 */
import { ChannelType, Client, Events, GatewayIntentBits, type Message } from "discord.js";

function required(key: string): string {
	const v = process.env[key];
	if (!v) {
		console.error(`missing env: ${key}`);
		process.exit(2);
	}
	return v;
}

const TOKEN = required("DISCORD_SMOKE_TOKEN");
const GUILD_ID = required("DISCORD_SMOKE_GUILD_ID");
const CHANNEL_ID = required("DISCORD_SMOKE_CHANNEL_ID");
const BOT_ID = required("DISCORD_SMOKE_BOT_ID");
const PROMPT = process.env.DISCORD_SMOKE_PROMPT ?? "ping (smoke)";
const TIMEOUT_MS = Number(process.env.DISCORD_SMOKE_TIMEOUT_MS ?? "120000");

const nonce = Math.random().toString(36).slice(2, 8);
const promptText = `${PROMPT} [${nonce}]`;

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
});

function fail(reason: string): never {
	console.error(`✗ smoke failed: ${reason}`);
	void client.destroy().finally(() => process.exit(1));
	throw new Error(reason);
}

const deadline = setTimeout(() => {
	const stage = !state.posted
		? "no message posted"
		: !state.threadSeen
			? "no thread spawned (is DISCORD_TEST_BOT_AUTHORS set on the bot under test?)"
			: "no bot reply observed in spawned thread";
	fail(`timeout after ${TIMEOUT_MS}ms — ${stage}`);
}, TIMEOUT_MS);

interface SmokeState {
	posted: boolean;
	/** Snowflake of the message we posted. Discord uses the starter
	 *  message id as the auto-created thread's id, so this also acts
	 *  as the expected thread id. */
	starterId?: string;
	threadSeen: boolean;
}
const state: SmokeState = { posted: false, threadSeen: false };

client.once(Events.ClientReady, async c => {
	console.log(`smoke client ready as ${c.user.tag}; posting to channel ${CHANNEL_ID}`);
	const guild = await c.guilds.fetch(GUILD_ID).catch(err => fail(`guild fetch: ${err}`));
	const channel = await guild.channels.fetch(CHANNEL_ID).catch(err => fail(`channel fetch: ${err}`));
	if (!channel || channel.type !== ChannelType.GuildText) {
		fail(`channel ${CHANNEL_ID} is not a guild text channel`);
	}
	const sent: Message = await channel.send(promptText);
	state.starterId = sent.id;
	state.posted = true;
	console.log(`  posted message id=${sent.id} content=${JSON.stringify(promptText)}`);
});

client.on(Events.ThreadCreate, thread => {
	if (thread.parentId !== CHANNEL_ID) return;
	if (thread.id !== state.starterId) return;
	state.threadSeen = true;
	console.log(`  thread spawned id=${thread.id} name=${JSON.stringify(thread.name)}`);
});

client.on(Events.MessageCreate, msg => {
	if (!state.posted) return;
	const ch = msg.channel;
	if (!ch.isThread()) return;
	// Discord uses the starter message id as the thread id; exact-match
	// gate eliminates any chance of latching onto a concurrent unrelated
	// thread in the same channel.
	if (ch.id !== state.starterId) return;
	if (msg.author.id !== BOT_ID) return;

	console.log(`  bot replied in thread: ${truncate(msg.content, 200)}`);
	clearTimeout(deadline);
	console.log("✓ smoke passed");
	void client.destroy().finally(() => process.exit(0));
});

function truncate(s: string, n: number): string {
	return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

client.on(Events.Error, err => {
	console.error("client error:", err);
});

await client.login(TOKEN);
