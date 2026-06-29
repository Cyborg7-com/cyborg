<script lang="ts">
  import type { AgentSlashCommand } from "$lib/types.js";

  let {
    commands,
    filter,
    onselect,
  }: {
    commands: AgentSlashCommand[];
    filter: string;
    onselect: (command: AgentSlashCommand) => void;
  } = $props();

  let selectedIndex = $state(0);

  const filtered = $derived(
    filter
      ? commands.filter((c) =>
          c.name.toLowerCase().includes(filter.toLowerCase()),
        )
      : commands,
  );

  $effect(() => {
    if (selectedIndex >= filtered.length) {
      selectedIndex = Math.max(0, filtered.length - 1);
    }
  });

  export function handleKeydown(e: KeyboardEvent): boolean {
    if (filtered.length === 0) return false;
    if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = (selectedIndex - 1 + filtered.length) % filtered.length;
      return true;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % filtered.length;
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      onselect(filtered[selectedIndex]);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      return true;
    }
    return false;
  }
</script>

{#if filtered.length > 0}
  <div class="absolute bottom-full left-0 right-0 mb-1 max-h-48 overflow-y-auto rounded-lg border border-edge bg-surface shadow-lg">
    {#each filtered as cmd, i (cmd.name)}
      <button
        class="flex w-full items-start gap-3 px-3 py-2 text-left text-sm transition-colors {i === selectedIndex ? 'bg-hover-gray' : 'hover:bg-hover-gray/50'}"
        onmouseenter={() => selectedIndex = i}
        onclick={() => onselect(cmd)}
      >
        <span class="shrink-0 font-mono text-btn-primary-bg">/{cmd.name}</span>
        <span class="text-content-muted text-xs leading-5">{cmd.description}</span>
      </button>
    {/each}
  </div>
{/if}
