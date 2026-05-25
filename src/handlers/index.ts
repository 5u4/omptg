/**
 * Single entry point for installing every message / callback handler.
 * Order is not critical (grammY routes by content type), but we list
 * callback first since it's the highest-priority interactive path.
 */
import type { Deps } from "../deps.ts";
import { installCallbackHandler } from "./callback.ts";
import { installVoiceHandlers } from "./voice.ts";
import { installPhotoHandler } from "./photo.ts";
import { installTextHandler } from "./text.ts";

export function installHandlers(deps: Deps): void {
	installCallbackHandler(deps);
	installVoiceHandlers(deps);
	installPhotoHandler(deps);
	installTextHandler(deps);
}
