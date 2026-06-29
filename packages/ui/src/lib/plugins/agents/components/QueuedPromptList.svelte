<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import type { QueuedPrompt } from "$lib/plugins/agents/state.svelte.js";

  let {
    queued,
    onEdit,
    onCancel,
  }: {
    queued: QueuedPrompt[];
    onEdit: (id: string) => void;
    onCancel: (id: string) => void;
  } = $props();
</script>

{#if queued.length > 0}
  <div class="mb-2 flex flex-col gap-1">
    <div class="px-1 text-[11px] font-medium text-content-muted">
      Queued {queued.length === 1 ? "prompt" : "prompts"} · sends when the agent finishes
    </div>
    {#each queued as item, i (item.id)}
      <div
        class="flex items-center gap-2 rounded-lg border border-edge bg-surface-alt px-2.5 py-1.5"
      >
        <span
          class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-hover-gray text-[10px] font-semibold text-content-muted"
        >
          {i + 1}
        </span>
        <span class="min-w-0 flex-1 truncate text-xs text-content" title={item.text}>
          {item.text}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          title="Edit queued prompt"
          aria-label="Edit queued prompt"
          onclick={() => onEdit(item.id)}
        >
          <svg
            class="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
          </svg>
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title="Remove from queue"
          aria-label="Remove from queue"
          onclick={() => onCancel(item.id)}
        >
          <svg
            class="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </Button>
      </div>
    {/each}
  </div>
{/if}
