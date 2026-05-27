/**
 * Vite config for the omptg web frontend.
 *
 * Builds the Svelte SPA at src/bridge/web/frontend/ → emits
 * src/bridge/web/static/ so the existing Bun.serve static handler
 * picks it up unchanged.
 *
 * In dev (`bun run dev:web`), Vite serves the SPA on its own port and
 * proxies /ws + /health to the Bun backend on 7878. This decouples
 * HMR-fast frontend edits from the backend restart cycle.
 */
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
	root: ".",
	plugins: [tailwindcss(), svelte()],
	resolve: {
		alias: {
			$lib: path.resolve(__dirname, "src/lib"),
		},
	},
	build: {
		outDir: "../static",
		emptyOutDir: false,                // preserve hand-edited assets if any
		assetsDir: ".",
		rollupOptions: {
			output: {
				entryFileNames: "app.js",
				assetFileNames: assetInfo => {
					if (assetInfo.name?.endsWith(".css")) return "app.css";
					return "[name][extname]";
				},
			},
		},
	},
	server: {
		port: 5173,
		proxy: {
			"/ws": { target: "ws://127.0.0.1:7878", ws: true },
			"/health": { target: "http://127.0.0.1:7878" },
		},
	},
});
