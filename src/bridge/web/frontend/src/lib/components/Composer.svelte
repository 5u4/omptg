<script lang="ts">
import type { Session } from "$lib/store/index.svelte";
import { sendPrompt } from "$lib/store/index.svelte";
import Button from "$lib/components/ui/Button.svelte";
import Textarea from "$lib/components/ui/Textarea.svelte";

let { session }: { session: Session } = $props();

let value = $state("");
let textareaEl: HTMLTextAreaElement | null = $state(null);

function submit(): void {
	const v = value.trim();
	if (!v) return;
	sendPrompt(session.key, v);
	value = "";
	if (textareaEl) textareaEl.style.height = "auto";
}

function onKeydown(e: KeyboardEvent): void {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		submit();
	}
}
</script>

<div class="flex items-end gap-2 border-t border-border px-5 py-3">
	<Textarea
		bind:ref={textareaEl}
		bind:value
		placeholder="Send a message (Enter to send, Shift+Enter for newline)"
		autosize
		onkeydown={onKeydown}
		class="flex-1"
	/>
	<Button variant="default" onclick={submit} disabled={!value.trim()}>send</Button>
</div>
