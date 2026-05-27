/**
 * Build the web frontend bundle: src/bridge/web/frontend/app.tsx →
 * src/bridge/web/static/app.js. Run `bun run build:web` once, or
 * `bun run watch:web` during development.
 *
 * Keeping it as an explicit script (not inline in start:web) so a
 * production deploy can pre-bake the bundle and skip esbuild at
 * boot time.
 */
import { build, context, type BuildOptions } from "esbuild";

const watch = process.argv.includes("--watch");
const minify = process.argv.includes("--minify") || !watch;

const opts: BuildOptions = {
	entryPoints: ["src/bridge/web/frontend/app.tsx"],
	outfile: "src/bridge/web/static/app.js",
	bundle: true,
	format: "esm",
	target: "es2022",
	minify,
	sourcemap: watch ? "inline" : false,
	jsx: "automatic",
	jsxImportSource: "preact",
	logLevel: "info",
};

if (watch) {
	const ctx = await context(opts);
	await ctx.watch();
	console.log("[build:web] watching src/bridge/web/frontend/");
} else {
	await build(opts);
}
