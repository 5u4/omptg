import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Conditionally compose Tailwind class strings; later utilities win
 *  conflicts (e.g. `px-2 px-4` collapses to `px-4`). Standard
 *  shadcn-svelte helper. */
export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}
