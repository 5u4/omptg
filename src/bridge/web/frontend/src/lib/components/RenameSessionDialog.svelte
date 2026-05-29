<script lang="ts">
import Button from "$lib/components/ui/Button.svelte";

let {
	initial,
	onSubmit,
	onCancel,
}: {
	initial: string;
	onSubmit: (title: string) => void;
	onCancel: () => void;
} = $props();

let title = $state(initial);
const canSubmit = $derived(title.trim().length > 0 && title.trim() !== initial);

function submit(): void {
	if (!canSubmit) return;
	onSubmit(title.trim());
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
	aria-labelledby="rename-session-dialog-title"
	tabindex="-1"
>
	<div
		class="w-[360px] max-w-[90vw] rounded-lg border border-border bg-card p-4 shadow-lg"
		onclick={(e) => e.stopPropagation()}
		role="document"
	>
		<div id="rename-session-dialog-title" class="mb-3 text-base font-semibold">Rename session</div>

		<form
			onsubmit={(e) => { e.preventDefault(); submit(); }}
			class="flex flex-col gap-3"
		>
			<input
				bind:value={title}
				maxlength={80}
				autofocus
				aria-label="Session title"
				class="rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
			/>
			<div class="mt-1 flex justify-end gap-2">
				<Button type="button" variant="ghost" size="sm" onclick={onCancel}>Cancel</Button>
				<Button type="submit" variant="default" size="sm" disabled={!canSubmit}>Rename</Button>
			</div>
		</form>
	</div>
</div>
