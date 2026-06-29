<script lang="ts">
  export interface FileEntry {
    path: string;
    kind: "file" | "directory";
  }

  let {
    entries,
    loading,
    onselect,
  }: {
    entries: FileEntry[];
    loading: boolean;
    onselect: (entry: FileEntry) => void;
  } = $props();

  let selectedIndex = $state(0);
  let container: HTMLDivElement | undefined = $state();

  // Reset the highlight whenever the result set changes so the keyboard cursor
  // never points past the end of a freshly-fetched (shorter) list.
  $effect(() => {
    if (selectedIndex >= entries.length) {
      selectedIndex = Math.max(0, entries.length - 1);
    }
  });

  // Keep the keyboard-highlighted row visible when the list overflows its
  // max-height container (Arrow nav can move the selection off-screen).
  $effect(() => {
    const index = selectedIndex;
    container?.querySelectorAll("button")[index]?.scrollIntoView({ block: "nearest" });
  });

  // Returns true when it consumed the key (so the composer doesn't also act on
  // it, e.g. Enter inserting a newline / sending). Mirrors SlashCommandPalette.
  export function handleKeydown(e: KeyboardEvent): boolean {
    if (e.key === "Escape") {
      e.preventDefault();
      return true;
    }
    if (entries.length === 0) return false;
    if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = (selectedIndex - 1 + entries.length) % entries.length;
      return true;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % entries.length;
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      onselect(entries[selectedIndex]);
      return true;
    }
    return false;
  }
</script>

{#if loading || entries.length > 0}
  <div
    bind:this={container}
    class="absolute bottom-full left-0 right-0 mb-1 max-h-48 overflow-y-auto rounded-lg border border-edge bg-surface shadow-lg"
  >
    {#if entries.length === 0}
      <div class="px-3 py-2 text-xs text-content-muted">Searching files…</div>
    {:else}
      {#each entries as entry, i (entry.path)}
        <button
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors {i ===
          selectedIndex
            ? 'bg-hover-gray'
            : 'hover:bg-hover-gray/50'}"
          onmouseenter={() => (selectedIndex = i)}
          onclick={() => onselect(entry)}
        >
          {#if entry.kind === "directory"}
            <!-- Folder icon -->
            <svg
              class="h-3.5 w-3.5 shrink-0 text-content-muted"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z" />
            </svg>
          {:else}
            <!-- File icon -->
            <svg
              class="h-3.5 w-3.5 shrink-0 text-content-muted"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          {/if}
          <span class="truncate font-mono text-xs text-content"
            >{entry.path}{entry.kind === "directory" ? "/" : ""}</span
          >
        </button>
      {/each}
    {/if}
  </div>
{/if}
