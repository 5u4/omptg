<script lang="ts" module>
import type { Snippet } from "svelte";
import type { HTMLAttributes } from "svelte/elements";
import { tv, type VariantProps } from "tailwind-variants";

export const badgeVariants = tv({
	base: "inline-flex items-center justify-center rounded-full border px-2 py-0.5 text-[10px] font-semibold leading-none transition-colors focus:outline-none",
	variants: {
		variant: {
			default: "border-transparent bg-primary text-primary-foreground",
			secondary: "border-transparent bg-secondary text-secondary-foreground",
			destructive: "border-transparent bg-destructive text-destructive-foreground",
			outline: "text-foreground",
		},
	},
	defaultVariants: { variant: "default" },
});

export type BadgeVariant = VariantProps<typeof badgeVariants>["variant"];

export interface BadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, "class"> {
	variant?: BadgeVariant;
	class?: string;
	children?: Snippet;
}
</script>

<script lang="ts">
import { cn } from "$lib/utils";

let { variant = "default", class: className, children, ...rest }: BadgeProps = $props();
</script>

<span class={cn(badgeVariants({ variant }), className)} {...rest}>
	{@render children?.()}
</span>
