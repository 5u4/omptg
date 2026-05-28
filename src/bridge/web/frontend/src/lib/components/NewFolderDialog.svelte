<script lang="ts">
import Button from "$lib/components/ui/Button.svelte";

/**
 * Modal for creating a new folder OR opening a new ungrouped session.
 * - `mode: "folder"` collects both name and cwd → `onSubmit(name, cwd)`.
 * - `mode: "cwd"`    collects only cwd (used by top-level "+ new session"
 *                    so the user can override the default cwd) →
 *                    `onSubmit("", cwd)`.
 *
 * Closes optimistically on submit. Server-side failures (e.g. cwd
 * missing or not a directory) currently surface only as a console.warn
 * from the store's `error` handler — the user sees the dialog close
 * with no folder appearing in the rail. A real toast/inline-error pass
 * is tracked for a later UX phase.
 */
let {
	mode,
	defaultCwd,
	onSubmit,
	onCancel,
}: {
	mode: "folder" | "cwd";
	defaultCwd: string;
	onSubmit: (name: string, cwd: string) => void;
	onCancel: () => void;
} = $props();

let name = $state("");
let cwd = $state(defaultCwd);

const title = $derived(mode === "folder" ? "New folder" : "New session");
const canSubmit = $derived.by(() => {
	const c = cwd.trim();
	if (!c) return false;
	if (mode === "folder" && !name.trim()) return false;
	return true;
});

function submit(): void {
	if (!canSubmit) return;
	onSubmit(name.trim(), cwd.trim());
}

function onKeydown(e: KeyboardEvent): void {
	if (e.key === "Escape") onCancel();
}
</script>

<svelte:window onkeydown={onKeydown} />

<div
	class="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm"
	onclick={onCancel}
	role="dialog"
	aria-modal="true"
	aria-labelledby="new-folder-dialog-title"
	tabindex="-1"
>
	<div
		class="w-[420px] max-w-[90vw] rounded-lg border border-border bg-card p-4 shadow-lg"
		onclick={(e) => e.stopPropagation()}
		role="document"
	>
		<div id="new-folder-dialog-title" class="mb-3 text-base font-semibold">{title}</div>

		<form
			onsubmit={(e) => { e.preventDefault(); submit(); }}
			class="flex flex-col gap-3"
		>
			{#if mode === "folder"}
				<label class="flex flex-col gap-1 text-sm">
					<span class="text-muted-foreground">Name</span>
					<input
						bind:value={name}
						maxlength={80}
						autofocus
						class="rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
					/>
				</label>
			{/if}
			<label class="flex flex-col gap-1 text-sm">
				<span class="text-muted-foreground">Working directory</span>
				<input
					bind:value={cwd}
					autofocus={mode === "cwd"}
					class="rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-ring"
				/>
			</label>

			<div class="mt-1 flex justify-end gap-2">
				<Button type="button" variant="ghost" size="sm" onclick={onCancel}>Cancel</Button>
				<Button type="submit" variant="default" size="sm" disabled={!canSubmit}>
					{mode === "folder" ? "Create" : "Open"}
				</Button>
			</div>
		</form>
	</div>
</div>
