/**
 * omptg web bridge entrypoint.
 *
 * Run: `bun run start:web`
 * Env vars consumed:
 *   OMP_DEFAULT_CWD          default cwd for fresh sessions (~/.omptg if unset)
 *   OMPTG_WEB_HOST           bind host; non-loopback warns loudly (default 127.0.0.1)
 *   OMPTG_WEB_PORT           listen port; rejects NaN/out-of-range (default 7878)
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { initOmpTheme, runLogRotation } from "./boot.ts";
import { WebBridge } from "./bridge/web/index.ts";
import { startWebServer } from "./bridge/web/server.ts";
import { scoped, logPath } from "./logger.ts";

const log = scoped("web-main");

function resolveDir(path: string): string {
	const expanded = path.startsWith("~/") ? resolvePath(homedir(), path.slice(2)) : resolvePath(path);
	return expanded;
}

function resolveDefaultCwd(): string {
	const fromEnv = Bun.env.OMP_DEFAULT_CWD;
	if (fromEnv) {
		const resolved = resolveDir(fromEnv);
		if (!existsSync(resolved)) {
			throw new Error(`OMP_DEFAULT_CWD does not exist: ${resolved}`);
		}
		return resolved;
	}
	const fallback = resolvePath(homedir(), ".omptg");
	if (!existsSync(fallback)) mkdirSync(fallback, { recursive: true });
	return fallback;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** Default 127.0.0.1; allow override but loudly warn when the user
 *  picks a non-loopback interface — phase 2 has no auth, so binding
 *  to 0.0.0.0 / a LAN IP exposes the agent to anyone on the network. */
function resolveHost(raw: string | undefined): string {
	if (!raw) return "127.0.0.1";
	if (!LOOPBACK_HOSTS.has(raw)) {
		console.warn(
			`[omptg-web] OMPTG_WEB_HOST=${raw} is NOT a loopback address; ` +
			`the web bridge has no auth and will be reachable by anyone ` +
			`who can connect to ${raw}:<port>. Set OMPTG_WEB_HOST=127.0.0.1 ` +
			`(default) for local-only use.`,
		);
	}
	return raw;
}

/** Reject NaN / out-of-range ports so the user gets a clear error
 *  instead of `Bun.serve` failing with an opaque "invalid port". */
function resolvePort(raw: string | undefined): number {
	if (!raw) return 7878;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 1 || n > 65535) {
		throw new Error(`OMPTG_WEB_PORT must be an integer in [1, 65535]; got "${raw}"`);
	}
	return n;
}


const DEFAULT_CWD = resolveDefaultCwd();
const HOST = resolveHost(Bun.env.OMPTG_WEB_HOST);
const PORT = resolvePort(Bun.env.OMPTG_WEB_PORT);

await runLogRotation();
await initOmpTheme();

const bridge = new WebBridge({ defaultCwd: DEFAULT_CWD });
const running = startWebServer({ host: HOST, port: PORT, bridge });

log.info("boot.ready", { host: HOST, port: PORT, cwd: DEFAULT_CWD, log: logPath() });

const shutdown = async (signal: string): Promise<void> => {
	console.log(`\n[shutdown] ${signal}`);
	try { await running.stop(); } catch (err) { log.warn("server_stop_failed", { err: String(err) }); }
	try { await bridge.dispose(); } catch (err) { log.warn("bridge_dispose_failed", { err: String(err) }); }
	process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
