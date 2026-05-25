/**
 * PM2 process config.
 *
 * Usage (from this directory):
 *   pm2 start ecosystem.config.cjs
 *   pm2 save               # remember the running set
 *   pm2 startup            # generate OS-level startup hook
 *   pm2 logs omptg        # tail logs
 *   pm2 restart omptg     # pick up new code
 *   pm2 stop omptg
 *   pm2 delete omptg
 *
 * PM2's `pm2 startup` writes a launchd plist on macOS, a systemd
 * service on Linux, and registers a service on Windows — one config,
 * all platforms.
 */
module.exports = {
	apps: [
		{
			name: "omptg",
			script: "src/main.ts",
			interpreter: "bun",
			// Run from the directory holding this config so relative `src/`
			// resolves and `.env` / `logs/` land alongside the code.
			cwd: __dirname,

			// Bun handles --watch itself; PM2 just supervises. Keep restart
			// behavior simple: restart on crash, back off after repeated
			// failures so a broken commit doesn't hammer the bot loop.
			autorestart: true,
			max_restarts: 10,
			min_uptime: "10s",
			restart_delay: 2000,

			// Restart if memory blows past this. Long-lived AgentSession +
			// streaming buffers shouldn't exceed this in normal use; if it
			// does we'd rather restart than swap.
			max_memory_restart: "1G",

			// PM2 captures stdout/stderr separately. Our app already writes
			// JSONL to ./logs/<date>.log, but mirror raw stdout/stderr too
			// so `pm2 logs omptg` shows live tail without us re-reading
			// the structured log file.
			out_file: "logs/pm2-out.log",
			error_file: "logs/pm2-err.log",
			merge_logs: true,
			log_date_format: "YYYY-MM-DD HH:mm:ss",

			env: {
				NODE_ENV: "production",
			},
		},
	],
};
