<script lang="ts">
import Button from "$lib/components/ui/Button.svelte";

let {
	initial,
	onSubmit,
	onCancel,
}: {
	initial: string;
	onSubmit: (name: string) => void;
	onCancel: () => void;
} = $props();

let name = $state(initial);
const canSubmit = $derived(name.trim().length > 0 && name.trim() !== initial);

function submit(): void {
	if (!canSubmit) return;
	onSubmit(name.trim());
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
	tabindex="-1"
>
	<div
		class="w-[360px] max-w-[90vw] rounded-lg border border-border bg-card p-4 shadow-lg"
		onclick={(e) => e.stopPropagation()}
		role="document"
	>
		<div class="mb-3 text-base font-semibold">Rename folder</div>

		<form
			onsubmit={(e) => { e.preventDefault(); submit(); }}
			class="flex flex-col gap-3"
		>
			<input
				bind:value={name}
				maxlength={80}
				autofocus
				aria-label="Folder name"
				class="rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
			/>
			<div class="mt-1 flex justify-end gap-2">
				<Button type="button" variant="ghost" size="sm" onclick={onCancel}>Cancel</Button>
				<Button type="submit" variant="default" size="sm" disabled={!canSubmit}>Rename</Button>
			</div>
		</form>
	</div>
</div>
