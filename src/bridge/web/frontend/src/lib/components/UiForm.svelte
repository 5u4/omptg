<script lang="ts">
import type { Session, PendingUi } from "$lib/store/index.svelte";
import { respondUi } from "$lib/store/index.svelte";
import Button from "$lib/components/ui/Button.svelte";
import InputForm from "./InputForm.svelte";

let { session, req }: { session: Session; req: PendingUi } = $props();

function respond(value: unknown): void { respondUi(session.key, req.reqId, value); }
</script>

<div class="rounded-md border border-ring/40 bg-card p-3">
	{#if req.kind === "select"}
		<div class="mb-2 text-sm font-medium">❓ {req.title}</div>
		<div class="flex flex-wrap gap-1.5">
			{#each req.options as opt}
				<Button variant="secondary" size="sm" onclick={() => respond(opt)}>{opt}</Button>
			{/each}
			<Button variant="ghost" size="sm" onclick={() => respond(null)}>cancel</Button>
		</div>
	{:else if req.kind === "confirm"}
		<div class="mb-1 text-sm font-medium">❓ {req.title}</div>
		<div class="mb-2 whitespace-pre-wrap text-sm text-muted-foreground">{req.message}</div>
		<div class="flex gap-1.5">
			<Button variant="default" size="sm" onclick={() => respond(true)}>yes</Button>
			<Button variant="outline" size="sm" onclick={() => respond(false)}>no</Button>
		</div>
	{:else if req.kind === "input" || req.kind === "editor"}
		<InputForm {req} {respond} />
	{/if}
</div>
