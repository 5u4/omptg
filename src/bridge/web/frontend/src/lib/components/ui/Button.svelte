<script lang="ts" module>
import type { Snippet } from "svelte";
import type { HTMLButtonAttributes } from "svelte/elements";
import { tv, type VariantProps } from "tailwind-variants";

export const buttonVariants = tv({
	base: "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background [&_svg]:size-4 [&_svg]:shrink-0",
	variants: {
		variant: {
			default: "bg-primary text-primary-foreground hover:bg-primary/90",
			destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
			outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
			secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
			ghost: "hover:bg-accent hover:text-accent-foreground",
			link: "text-primary underline-offset-4 hover:underline",
		},
		size: {
			default: "h-9 px-4 py-2",
			sm: "h-8 rounded-md px-3 text-xs",
			lg: "h-10 rounded-md px-6",
			icon: "size-9",
		},
	},
	defaultVariants: { variant: "default", size: "default" },
});

export type ButtonVariant = VariantProps<typeof buttonVariants>["variant"];
export type ButtonSize = VariantProps<typeof buttonVariants>["size"];

export interface ButtonProps extends Omit<HTMLButtonAttributes, "class"> {
	variant?: ButtonVariant;
	size?: ButtonSize;
	class?: string;
	children?: Snippet;
}
</script>

<script lang="ts">
import { cn } from "$lib/utils";

let {
	variant = "default",
	size = "default",
	class: className,
	children,
	type = "button",
	...rest
}: ButtonProps = $props();
</script>

<button class={cn(buttonVariants({ variant, size }), className)} {type} {...rest}>
	{@render children?.()}
</button>
