<script lang="ts" module>
import type { Snippet } from "svelte";
import type { HTMLAttributes } from "svelte/elements";

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, "class"> {
	class?: string;
	children?: Snippet;
}
</script>

<script lang="ts">
import { cn } from "$lib/utils";

let { class: className, children, ...rest }: CardProps = $props();
</script>

<div
	class={cn(
		"rounded-lg border bg-card text-card-foreground shadow-sm",
		className,
	)}
	{...rest}
>
	{@render children?.()}
</div>
