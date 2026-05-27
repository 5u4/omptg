<script lang="ts">
import type { PendingUi } from "$lib/store/index.svelte";
import { untrack } from "svelte";
import Button from "$lib/components/ui/Button.svelte";
import Textarea from "$lib/components/ui/Textarea.svelte";

let { req, respond }: { req: PendingUi; respond: (v: unknown) => void } = $props();

let value = $state(untrack(() => req.kind === "editor" ? (req.prefill ?? "") : ""));
let textareaEl: HTMLTextAreaElement | null = $state(null);

$effect(() => { textareaEl?.focus(); });

function submit(): void { respond(value); }

function onKeydown(e: KeyboardEvent): void {
	if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
}

const placeholder = $derived(req.kind === "input" ? req.placeholder : undefined);
</script>

<div class="mb-2 text-sm font-medium">
	❓ {req.title}{placeholder ? ` (${placeholder})` : ""}
</div>
<Textarea
	bind:ref={textareaEl}
	bind:value
	onkeydown={onKeydown}
	class="min-h-[80px]"
/>
<div class="mt-2 flex gap-1.5">
	<Button variant="default" size="sm" onclick={submit}>submit (⌘↵)</Button>
	<Button variant="ghost" size="sm" onclick={() => respond(null)}>cancel</Button>
</div>
