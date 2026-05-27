<script lang="ts" module>
import type { HTMLAttributes } from "svelte/elements";

export interface SeparatorProps extends Omit<HTMLAttributes<HTMLDivElement>, "class"> {
	orientation?: "horizontal" | "vertical";
	class?: string;
}
</script>

<script lang="ts">
import { cn } from "$lib/utils";

let { orientation = "horizontal", class: className, ...rest }: SeparatorProps = $props();
</script>

<div
	role="separator"
	aria-orientation={orientation}
	class={cn(
		"shrink-0 bg-border",
		orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
		className,
	)}
	{...rest}
></div>
