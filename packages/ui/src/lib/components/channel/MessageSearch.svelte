<script lang="ts">
  import { goto } from "$app/navigation";
  import { workspaceState, searchMessages } from "$lib/state/app.svelte.js";
  import type { Message } from "$lib/core/types.js";
  import { formatMessageTimestamp } from "$lib/utils.js";
  import ChannelGlyph from "./ChannelGlyph.svelte";

  let query = $state("");
  let open = $state(false);
  let loading = $state(false);
  let results = $state<Message[]>([]);
  let containerEl = $state<HTMLDivElement | null>(null);
  let seq = 0; // guards against out-of-order async responses

  const wsId = $derived(workspaceState.current?.id ?? null);
  const channelName = $derived(
    new Map(workspaceState.channels.map((c) => [c.id, c.name])),
  );

  async function run(): Promise<void> {
    const q = query.trim();
    if (q.length < 2) {
      results = [];
      return;
    }
    const mine = ++seq;
    loading = true;
    const r = await searchMessages(q);
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

  function pick(m: Message): void {
    if (!wsId || !m.channelId) return;
    open = false;
    query = "";
    results = [];
    goto(`/workspace/${wsId}/channel/${m.channelId}`);
  }

  function clear(): void {
    query = "";
    results = [];
    open = false;
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") clear();
  }

  function onDocClick(e: MouseEvent): void {
    if (containerEl && !containerEl.contains(e.target as Node)) open = false;
  }

  // Split a body into [before, match, after] around the first case-insensitive
  // hit so the matched run can be wrapped in a highlight <mark>.
  function highlightParts(text: string, q: string): [string, string, string] {
    if (!q || q.length < 2) return [text, "", ""];
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return [text, "", ""];
    return [text.slice(0, idx), text.slice(idx, idx + q.length), text.slice(idx + q.length)];
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
      placeholder="Search messages…"
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
      {#if loading}
        <div class="px-4 py-3 text-[13px] text-content-dim">Searching…</div>
      {:else if results.length === 0}
        <div class="px-4 py-3 text-[13px] text-content-dim">No messages found for "{query.trim()}"</div>
      {:else}
        {#each results as m (m.id)}
          {@const parts = highlightParts(typeof m.text === "string" ? m.text : "", query.trim())}
          <button
            type="button"
            onclick={() => pick(m)}
            class="block w-full border-b border-edge px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-raised cursor-pointer"
          >
            <div class="mb-1 flex items-center gap-2">
              <span class="flex items-center gap-1 text-[12px] text-content-dim">
                <ChannelGlyph kind="hash" class="w-3 h-3 shrink-0 text-content-muted" />
                {channelName.get(m.channelId ?? "") ?? "channel"}
              </span>
              <span class="text-[11px] text-content-muted">·</span>
              <span class="text-[12px] font-medium text-content-dim">{m.fromName ?? m.fromId}</span>
              {#if m.fromType === "agent"}
                <span class="rounded bg-accent/15 px-1 text-[10px] font-medium text-accent">Agent</span>
              {/if}
              <span class="ml-auto shrink-0 text-[11px] text-content-muted">{formatMessageTimestamp(m.createdAt)}</span>
            </div>
            <div class="line-clamp-2 text-[13px] text-content">
              {parts[0]}{#if parts[1]}<mark class="rounded-sm bg-warning/30 px-0.5 text-content">{parts[1]}</mark>{/if}{parts[2]}
            </div>
          </button>
        {/each}
      {/if}
    </div>
  {/if}
</div>
