<script lang="ts" module>
	// Shared input/textarea/select-trigger class so every form control matches the
	// dialog style (border + visible focus ring). Import and apply to plain
	// `<input>`/`<textarea>` controls, or to a Select.Trigger's `class`.
	export const fieldInputClass =
		"h-9 w-full rounded-md border border-edge bg-transparent px-3 text-sm text-content outline-none placeholder:text-content-muted focus:border-edge-light focus:ring-[3px] focus:ring-edge/30 transition-shadow";
</script>

<script lang="ts">
	import type { Snippet } from "svelte";

	let {
		label,
		forId,
		hint,
		optional = false,
		error = null,
		children,
	}: {
		label: string;
		forId?: string;
		hint?: string;
		optional?: boolean;
		error?: string | null;
		children: Snippet;
	} = $props();
</script>

<div class="flex flex-col gap-1.5">
	<label for={forId} class="text-[13px] font-medium text-content">
		{label}{#if optional}<span class="text-content-dim"> (optional)</span>{/if}
	</label>
	{@render children()}
	{#if error}
		<p class="text-xs text-error">{error}</p>
	{:else if hint}
		<p class="text-xs text-content-muted">{hint}</p>
	{/if}
</div>
