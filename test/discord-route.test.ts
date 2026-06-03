/**
 * Unit tests for the Discord bridge's pure route/key plumbing. These
 * cover the spec's Open Question #1 resolution (the `dc:` keyspace
 * prefix), the round-trip between `discordRouteKey` and
 * `parseDiscordRoute`, and the snowflake-normalization boundary that
 * `DiscordBridge.route()` enforces against unsafe-integer ids and
 * non-numeric strings.
 *
 * No `discord.js` Client is needed: `route()` is pure; we never call
 * `open()`, so the Client is only typed-through.
 */
import { describe, expect, test } from "bun:test";
import { Client, GatewayIntentBits } from "discord.js";
import {
	DiscordBridge,
	discordRoute,
	discordRouteKey,
	parseDiscordRoute,
} from "../src/bridge/discord/index.ts";

const CHANNEL = "123456789012345678"; // 18-digit channel snowflake
const THREAD = "987654321098765432";

function makeBridge(): DiscordBridge {
	// Construct but never log in — `route()` doesn't touch the gateway.
	const client = new Client({ intents: [GatewayIntentBits.Guilds] });
	return new DiscordBridge(client);
}

describe("discordRouteKey / parseDiscordRoute", () => {
	test("key uses dc: prefix so Discord routes can't collide with telegram ids", () => {
		expect(discordRouteKey(CHANNEL)).toBe(`dc:${CHANNEL}:`);
		expect(discordRouteKey(CHANNEL, THREAD)).toBe(`dc:${CHANNEL}:${THREAD}`);
	});

	test("discordRoute emits a dc: label and a dc: key", () => {
		const r = discordRoute(CHANNEL, THREAD);
		expect(r.key).toBe(`dc:${CHANNEL}:${THREAD}`);
		expect(r.label).toBe(`dc:${CHANNEL}:${THREAD}`);
		const r2 = discordRoute(CHANNEL);
		expect(r2.key).toBe(`dc:${CHANNEL}:`);
		expect(r2.label).toBe(`dc:${CHANNEL}`);
	});

	test("round-trips channel-only and channel+thread", () => {
		expect(parseDiscordRoute(discordRouteKey(CHANNEL))).toEqual({
			channelId: CHANNEL,
			threadId: undefined,
		});
		expect(parseDiscordRoute(discordRouteKey(CHANNEL, THREAD))).toEqual({
			channelId: CHANNEL,
			threadId: THREAD,
		});
	});

	test("rejects telegram-shaped keys (no dc: prefix)", () => {
		// This is the keyspace-collision guard: a key minted by the
		// telegram bridge must not parse as discord.
		expect(parseDiscordRoute(`${CHANNEL}:${THREAD}`)).toBeUndefined();
		expect(parseDiscordRoute(`123456:`)).toBeUndefined();
	});

	test("rejects malformed keys", () => {
		expect(parseDiscordRoute("dc:")).toBeUndefined();         // no channel
		expect(parseDiscordRoute("dc:abc")).toBeUndefined();      // no second colon
		expect(parseDiscordRoute("dc::123")).toBeUndefined();     // empty channel
	});
});

describe("DiscordBridge.route snowflake normalization", () => {
	const bridge = makeBridge();

	test("accepts string snowflakes verbatim, including ones past safe-integer range", () => {
		const huge = "9999999999999999999"; // > Number.MAX_SAFE_INTEGER
		const r = bridge.route(huge, THREAD);
		expect(r.key).toBe(`dc:${huge}:${THREAD}`);
	});

	test("accepts numbers within safe-integer range and stringifies them", () => {
		const r = bridge.route(123, 456);
		expect(r.key).toBe("dc:123:456");
	});

	test("rejects non-numeric string ids", () => {
		expect(() => bridge.route("not-a-snowflake")).toThrow(/numeric snowflake/);
		expect(() => bridge.route(CHANNEL, "thread-1")).toThrow(/numeric snowflake/);
	});

	test("rejects number ids past safe-integer range", () => {
		// 2^53 is the first unsafe integer; passing it as a `number` means
		// precision was already lost upstream — refuse so we don't store a
		// corrupted id under a misleading key.
		expect(() => bridge.route(2 ** 53)).toThrow(/safe-integer/);
		expect(() => bridge.route(CHANNEL, 2 ** 53)).toThrow(/safe-integer/);
	});

	test("undefined threadId yields the channel-only key", () => {
		const r = bridge.route(CHANNEL);
		expect(r.key).toBe(`dc:${CHANNEL}:`);
		expect(parseDiscordRoute(r.key)).toEqual({
			channelId: CHANNEL,
			threadId: undefined,
		});
	});
});
