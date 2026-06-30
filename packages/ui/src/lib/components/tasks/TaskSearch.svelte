<script lang="ts">
  import { searchTasks } from "$lib/state/app.svelte.js";
  import type { TaskSearchResult } from "$lib/core/types.js";
  import TaskSearchResults from "./TaskSearchResults.svelte";

  let { workspaceId }: { workspaceId: string } = $props();

  let query = $state("");
  let open = $state(false);
  let loading = $state(false);
  let results = $state<TaskSearchResult[]>([]);
  let containerEl = $state<HTMLDivElement | null>(null);
  let seq = 0; // guards against out-of-order async responses

  async function run(): Promise<void> {
    const q = query.trim();
    if (q.length < 2) {
      results = [];
      return;
    }
    const mine = ++seq;
    loading = true;
    const r = await searchTasks(q);
    if (mine !== seq) return; // a newer search superseded this one
    results = r;
    loading = false;
  }

  let debounce: ReturnType<typeof setTimeout> | null = null;
  function onInput(): void {
    open = true;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void run(), 250);
  }

  function clear(): void {
    query = "";
    results = [];
    open = false;
  }

  function onSelect(): void {
    open = false;
    query = "";
    results = [];
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") clear();
  }

  function onDocClick(e: MouseEvent): void {
    if (containerEl && !containerEl.contains(e.target as Node)) open = false;
  }
</script>

<svelte:document onclick={onDocClick} />

<div bind:this={containerEl} class="relative">
  <div class="flex h-7 items-center gap-2 rounded-md border border-edge bg-[var(--surface-alt,rgba(127,127,127,0.08))] px-2 w-full min-w-0 sm:w-[40vw] sm:min-w-[18rem] sm:max-w-[40rem]">
    <svg class="shrink-0 text-content-muted" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
    <input
      type="text"
      bind:value={query}
      oninput={onInput}
      onfocus={() => { if (query.trim().length >= 2) open = true; }}
      onkeydown={onKeyDown}
      autocomplete="off"
      maxlength={60}
      placeholder="Search tasks…"
      class="h-full w-full bg-transparent text-[13px] text-content outline-none placeholder:text-content-muted"
    />
    {#if query}
      <button
        type="button"
        onclick={clear}
        aria-label="Clear search"
        class="shrink-0 rounded p-0.5 text-content-muted hover:bg-edge hover:text-content cursor-pointer"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    {/if}
  </div>

  {#if open && query.trim().length >= 2}
    <div
      class="absolute left-0 right-0 top-8 z-[var(--z-overlay-backdrop)] max-h-[400px] overflow-y-auto rounded-lg border border-edge bg-surface-alt shadow-2xl"
    >
      <TaskSearchResults {results} query={query.trim()} {workspaceId} {loading} onselect={onSelect} />
    </div>
  {/if}
</div>
