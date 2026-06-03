/**
 * Unit tests for slash-command registration payload generation.
 * Verifies SLASH_COMMANDS → Discord JSON conversion stays in sync:
 * every command becomes a registered top-level command, args are
 * surfaced as STRING options with the right required flag, and
 * Discord's 100-char description cap is enforced defensively.
 */
import { describe, expect, test } from "bun:test";
import { buildSlashCommandPayload } from "../src/bridge/discord/registration.ts";
import { SLASH_COMMAND_SPECS } from "../src/commands.ts";

const payload = buildSlashCommandPayload();
const byName = new Map(payload.map(c => [c.name, c]));

describe("buildSlashCommandPayload", () => {
	test("emits one entry per SLASH_COMMANDS row", () => {
		expect(payload.length).toBe(SLASH_COMMAND_SPECS.length);
		for (const spec of SLASH_COMMAND_SPECS) {
			expect(byName.has(spec.command)).toBe(true);
		}
	});

	test("commands with `arg` get a single STRING option matching the spec", () => {
		const bind = byName.get("bind")!;
		expect(bind.options).toHaveLength(1);
		const opt = bind.options![0]! as { type: number; name: string; required?: boolean };
		expect(opt.type).toBe(3); // ApplicationCommandOptionType.String
		expect(opt.name).toBe("path");
		expect(opt.required).toBe(true);
	});

	test("commands without `arg` declare no options", () => {
		const nu = byName.get("new")!;
		expect(nu.options ?? []).toHaveLength(0);
	});

	test("optional args register with required=false", () => {
		const sessions = byName.get("sessions")!;
		const opt = sessions.options![0]! as { required?: boolean };
		// SlashCommandBuilder omits the `required` field when false.
		expect(opt.required ?? false).toBe(false);
	});

	test("descriptions are clamped to Discord's 100-char limit", () => {
		for (const c of payload) {
			expect(c.description.length).toBeLessThanOrEqual(100);
			for (const o of c.options ?? []) {
				expect((o as { description: string }).description.length).toBeLessThanOrEqual(100);
			}
		}
	});
});

describe("SLASH_COMMANDS / HANDLERS parity", () => {
	test("importing commands.ts succeeds (boot-time HANDLERS coverage assert passes)", async () => {
		// The module-load `for (...) if (!HANDLERS[...]) throw` in
		// commands.ts is the real guarantee; this test just exercises the
		// import so a missing handler shows up as a failing test instead
		// of a bot that crashes on boot.
		const mod = await import("../src/commands.ts");
		// Every spec must have a runSlashCommand dispatch entry. We can't
		// see HANDLERS directly (intentionally module-private), so instead
		// invoke runSlashCommand with a stub context and assert it
		// returns true (handler exists). The stub never actually executes
		// the body because each command would throw on `registry.get` etc.
		// — we only need to prove the dispatch lookup succeeds.
		const stubCtx = {} as Parameters<typeof mod.runSlashCommand>[1];
		for (const spec of mod.SLASH_COMMAND_SPECS) {
			// Swap the handler invocation for a presence-only check: catch
			// any throw from the handler body since the stub ctx is empty.
			const found = await mod.runSlashCommand(spec.command, stubCtx).catch(() => true);
			expect(found).toBe(true);
		}
	});
});
