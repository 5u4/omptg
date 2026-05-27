/**
 * omptg web bridge entrypoint.
 *
 * Run: `bun run start:web`
 * Loads OMP_DEFAULT_CWD / OMPTG_WEB_HOST / OMPTG_WEB_PORT from env.
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

/** Parse `OMPTG_WEB_ALLOWED_CWDS`: colon-separated path prefixes that
 *  clients may use on `session.open` / `session.resume` in addition to
 *  `DEFAULT_CWD`. Unset/empty means "DEFAULT_CWD subtree only". */
function parseAllowedPrefixes(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw.split(":").map(p => p.trim()).filter(Boolean).map(resolveDir);
}

const DEFAULT_CWD = resolveDefaultCwd();
const HOST = Bun.env.OMPTG_WEB_HOST ?? "127.0.0.1";
const PORT = Number(Bun.env.OMPTG_WEB_PORT ?? 7878);

await runLogRotation();
await initOmpTheme();

const bridge = new WebBridge({
	defaultCwd: DEFAULT_CWD,
	allowedCwdPrefixes: parseAllowedPrefixes(Bun.env.OMPTG_WEB_ALLOWED_CWDS),
});
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
