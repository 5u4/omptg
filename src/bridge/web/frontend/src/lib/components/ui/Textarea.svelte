<script lang="ts" module>
import type { HTMLTextareaAttributes } from "svelte/elements";

export interface TextareaProps extends Omit<HTMLTextareaAttributes, "class" | "value"> {
	class?: string;
	autosize?: boolean;
	value?: string;
	ref?: HTMLTextAreaElement | null;
}
</script>

<script lang="ts">
import { cn } from "$lib/utils";

let {
	class: className,
	autosize = false,
	value = $bindable(""),
	ref = $bindable(null),
	oninput,
	...rest
}: TextareaProps = $props();

function handleInput(e: Event & { currentTarget: EventTarget & HTMLTextAreaElement }): void {
	if (autosize) {
		const ta = e.currentTarget;
		ta.style.height = "auto";
		ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
	}
	oninput?.(e);
}
</script>

<textarea
	bind:this={ref}
	bind:value
	class={cn(
		"flex min-h-[40px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
		autosize && "resize-none overflow-hidden",
		className,
	)}
	oninput={handleInput}
	{...rest}
></textarea>
