<script lang="ts">
  import { workspaceState } from "$lib/state/app.svelte.js";
  import { relativeTime } from "$lib/utils/datetime.js";

  // Wired into the cybo profile's Memory tab. `cyboId` scopes the list to one
  // agent; `wsId` is the workspace it lives in (kept for the future fetch call —
  // see the data-source note below).
  let { cyboId, wsId }: { cyboId: string; wsId: string } = $props();

  // ── Memory entry shape ──
  // Mirrors the row fields MemoryPane.svelte renders (content + source + when),
  // trimmed to what a per-cybo list needs. Defined locally so this component is
  // self-contained and ready to bind to a real source without further edits.
  interface CyboMemory {
    id: string;
    content: string;
    /** Origin label, e.g. "conversation" | "dreaming" | "human". */
    source: string;
    /** ISO string or epoch ms — relativeTime() accepts both. */
    createdAt: string | number;
  }

  // ── Per-cybo scope ──
  // The link that WOULD scope memory to this cybo: the workspace's agent sessions
  // bound to it (Agent.cyboId). Computed now so the wiring is in place the moment
  // a real memory source exists — the fetch below would filter on these ids.
  const boundAgentIds = $derived(
    workspaceState.agents.filter((a) => a.cyboId === cyboId).map((a) => a.agentId),
  );

  let memories = $state<CyboMemory[]>([]);
  let loading = $state(true);

  // ── Data source (current gap) ──
  // There is NO client RPC, state store, protocol message, or DB table for agent
  // memory in this repo — the Memory route (MemoryPane.svelte) renders 100% mock
  // data. So there is nothing real to fetch yet. We deliberately do NOT fabricate
  // entries: we settle to an empty list, which renders the empty state below.
  // When a source lands (e.g. `client.listCyboMemories(wsId, cyboId)` or a
  // `client.listMemories(wsId, { agentIds: boundAgentIds })`), swap the body of
  // this effect for that call and map the result into CyboMemory[].
  $effect(() => {
    // Touch the scope inputs so this re-runs if the cybo/workspace changes.
    void cyboId;
    void wsId;
    void boundAgentIds;
    loading = true;
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        // No real source available — resolve to empty (see note above).
        const result: CyboMemory[] = [];
        if (!cancelled) memories = result;
      } catch {
        // catch: best-effort load; on failure fall back to the empty state
        // rather than surfacing a transient error in a passive profile tab.
        if (!cancelled) memories = [];
      } finally {
        if (!cancelled) loading = false;
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  });

  // Newest first — matches the Memory route's recent ordering.
  const sorted = $derived(
    [...memories].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    ),
  );

  // Real, scope-aware count expression for the tab badge / header.
  const count = $derived(sorted.length);

  // Source → emoji, mirroring MemoryPane.svelte's SRC map (kept minimal).
  const SRC_ICON: Record<string, string> = {
    conversation: "\u{1F4AC}",
    dreaming: "\u{1F9E0}",
    human: "\u{270F}\u{FE0F}",
    "cross-agent": "\u{1F517}",
  };
  function sourceIcon(source: string): string {
    return SRC_ICON[source] ?? "\u{1F4DD}";
  }
</script>

{#if loading}
  <!-- Loading: skeleton rows sized like real memory rows so the layout doesn't jump. -->
  <div class="overflow-hidden rounded-xl border border-edge-light bg-surface-alt" aria-busy="true" aria-label="Loading memories">
    {#each [0, 1, 2] as i (i)}
      <div class="flex items-center gap-3 px-5 py-3.5" class:border-t={i > 0} class:border-edge-dim={i > 0}>
        <span class="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-edge"></span>
        <span class="h-3.5 flex-1 animate-pulse rounded bg-edge"></span>
        <span class="h-3 w-12 shrink-0 animate-pulse rounded bg-edge"></span>
      </div>
    {/each}
  </div>
{:else if count === 0}
  <!-- Empty: mirrors the profile page's emptyState snippet — centered accent
       medallion + confident title + restrained muted copy. -->
  <div class="flex flex-col items-center justify-center gap-4 rounded-xl border border-edge-light bg-surface-alt px-6 py-16 text-center">
    <div
      class="flex h-14 w-14 items-center justify-center rounded-2xl"
      style="background: color-mix(in srgb, var(--agent-accent, var(--color-accent)) 10%, transparent); color: var(--agent-accent, var(--color-accent));"
    >
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
        <line x1="12" y1="22.08" x2="12" y2="12" />
      </svg>
    </div>
    <div>
      <div class="text-[15px] font-semibold tracking-[-0.01em] text-content">No memories yet</div>
      <p class="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-content-muted">
        Facts and context this agent retains between conversations will show up here.
      </p>
    </div>
  </div>
{:else}
  <!-- List: reuses the Memory route's row treatment (source icon · content ·
       relative time) on the profile's card shell. -->
  <ul class="overflow-hidden rounded-xl border border-edge-light bg-surface-alt">
    {#each sorted as m, i (m.id)}
      <li
        class="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-hover-gray"
        class:border-t={i > 0}
        class:border-edge-dim={i > 0}
      >
        <span class="text-[13px]" aria-hidden="true">{sourceIcon(m.source)}</span>
        <span class="flex-1 truncate text-[13px] text-content">{m.content}</span>
        <span class="shrink-0 text-[11px] text-content-muted">{relativeTime(m.createdAt)}</span>
      </li>
    {/each}
  </ul>
{/if}
