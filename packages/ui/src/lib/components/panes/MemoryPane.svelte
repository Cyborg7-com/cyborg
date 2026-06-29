<script lang="ts">
  import { cn, nameToColor } from "$lib/utils.js";
  import { relativeTime } from "$lib/utils/datetime.js";
  import EmptyState from "../EmptyState.svelte";

  let { workspaceId }: { workspaceId: string } = $props();

  // ── Types ──
  interface Memory {
    id: string;
    agentId: string;
    content: string;
    topic: string | null;
    source: string;
    confidence: number;
    pinned: boolean;
    createdAt: string;
  }

  interface Agent {
    id: string;
    agentId: string;
    name: string;
    role: string;
    image: string | null;
    online: boolean;
    memoryCount: number;
  }

  interface DreamCycle {
    id: string;
    agentId: string;
    phase: string | null;
    promoted: number;
    pruned: number;
    narrative: string | null;
    durationMs: number | null;
    conceptTags: string[];
    createdAt: string;
  }

  type Section = null | "memories" | "dreams" | "timeline" | "network";

  const SRC: Record<string, { icon: string; label: string; color: string }> = {
    conversation: { icon: "\u{1F4AC}", label: "From chat", color: "#3b82f6" },
    dreaming: { icon: "\u{1F9E0}", label: "Auto-learned", color: "#8b5cf6" },
    human: { icon: "\u{270F}\u{FE0F}", label: "Human edit", color: "#f59e0b" },
    "cross-agent": { icon: "\u{1F517}", label: "Cross-agent", color: "#06b6d4" },
  };

  let selectedAgentId = $state<string | null>(null);
  let activeSection = $state<Section>(null);
  let searchQuery = $state("");
  let expandedTopic = $state<string | null>(null);
  let expandedDream = $state<number | null>(null);
  let editingMemoryId = $state<string | null>(null);
  let editText = $state("");

  // ── Mock data ──
  function buildMockAgents(): Agent[] {
    return [
      { id: "a1", agentId: "agent-atlas", name: "Atlas", role: "Full-stack Engineer", image: null, online: true, memoryCount: 42 },
      { id: "a2", agentId: "agent-rick", name: "Rick", role: "Backend Engineer", image: null, online: true, memoryCount: 28 },
      { id: "a3", agentId: "agent-beth", name: "Beth", role: "Designer", image: null, online: false, memoryCount: 15 },
      { id: "a4", agentId: "agent-caesar", name: "Caesar", role: "DevOps", image: null, online: true, memoryCount: 9 },
    ];
  }

  function buildMockMemories(agentId?: string): Memory[] {
    const all: Memory[] = [
      { id: "m1", agentId: "a1", content: "The project uses Drizzle ORM with PostgreSQL for shared storage", topic: "Architecture", source: "conversation", confidence: 0.95, pinned: true, createdAt: new Date(Date.now() - 3600000).toISOString() },
      { id: "m2", agentId: "a1", content: "JWT auth uses HMAC-SHA256 with a dev-mode secret", topic: "Security", source: "conversation", confidence: 0.9, pinned: false, createdAt: new Date(Date.now() - 7200000).toISOString() },
      { id: "m3", agentId: "a1", content: "Relay broker handles pub/sub per workspace with E2E encryption", topic: "Architecture", source: "dreaming", confidence: 0.85, pinned: false, createdAt: new Date(Date.now() - 10800000).toISOString() },
      { id: "m4", agentId: "a1", content: "Tasks have priority levels: critical, high, medium, low", topic: "Tasks", source: "conversation", confidence: 0.92, pinned: true, createdAt: new Date(Date.now() - 14400000).toISOString() },
      { id: "m5", agentId: "a1", content: "The UI uses Svelte 5 runes ($state, $derived, $props)", topic: "Frontend", source: "conversation", confidence: 0.88, pinned: false, createdAt: new Date(Date.now() - 18000000).toISOString() },
      { id: "m6", agentId: "a1", content: "Tailwind CSS v4 with @theme block for design tokens", topic: "Frontend", source: "dreaming", confidence: 0.82, pinned: false, createdAt: new Date(Date.now() - 21600000).toISOString() },
      { id: "m7", agentId: "a2", content: "Rate limiting uses token bucket algorithm per daemon", topic: "Security", source: "conversation", confidence: 0.91, pinned: false, createdAt: new Date(Date.now() - 25200000).toISOString() },
      { id: "m8", agentId: "a2", content: "Agent processes use stdio for ACP communication", topic: "Architecture", source: "dreaming", confidence: 0.78, pinned: false, createdAt: new Date(Date.now() - 28800000).toISOString() },
      { id: "m9", agentId: "a2", content: "DualStorage auto-detects solo vs connected mode from DATABASE_URL", topic: "Architecture", source: "conversation", confidence: 0.94, pinned: true, createdAt: new Date(Date.now() - 32400000).toISOString() },
      { id: "m10", agentId: "a3", content: "Design system uses 3-tier tokens: primitives -> semantic -> component", topic: "Frontend", source: "conversation", confidence: 0.87, pinned: false, createdAt: new Date(Date.now() - 36000000).toISOString() },
      { id: "m11", agentId: "a3", content: "Dark mode uses [data-theme] attribute switching", topic: "Frontend", source: "dreaming", confidence: 0.83, pinned: false, createdAt: new Date(Date.now() - 39600000).toISOString() },
      { id: "m12", agentId: "a4", content: "Deployment uses adapter-node for Railway/Docker", topic: "DevOps", source: "conversation", confidence: 0.89, pinned: false, createdAt: new Date(Date.now() - 43200000).toISOString() },
      { id: "m13", agentId: "a1", content: "Conventional commits required: feat:, fix:, chore:", topic: null, source: "human", confidence: 0.96, pinned: false, createdAt: new Date(Date.now() - 50000000).toISOString() },
      { id: "m14", agentId: "a2", content: "WebSocket connections persist across page navigations", topic: "Architecture", source: "cross-agent", confidence: 0.75, pinned: false, createdAt: new Date(Date.now() - 60000000).toISOString() },
    ];
    if (agentId) return all.filter((m) => m.agentId === agentId);
    return all;
  }

  function buildMockDreamCycles(): DreamCycle[] {
    return [
      {
        id: "dc1", agentId: "a1", phase: "deep", promoted: 5, pruned: 12,
        narrative: "Consolidated understanding of the distributed daemon architecture. Key insight: relay broker acts as namespace-isolated message bus, not a traditional pub/sub. Each daemon maintains its own SQLite cache for offline resilience.",
        durationMs: 4200, conceptTags: ["architecture", "relay", "storage", "offline"], createdAt: new Date(Date.now() - 86400000).toISOString(),
      },
      {
        id: "dc2", agentId: "a1", phase: "rem", promoted: 3, pruned: 8,
        narrative: "Identified pattern: team prefers extending Paseo's code via hooks rather than direct modification. This minimizes merge conflicts with upstream.",
        durationMs: 2800, conceptTags: ["workflow", "upstream", "patterns"], createdAt: new Date(Date.now() - 172800000).toISOString(),
      },
      {
        id: "dc3", agentId: "a2", phase: "light", promoted: 2, pruned: 15,
        narrative: "Filtered significant noise from debugging sessions. Retained core learning about API endpoint structure and auth flow.",
        durationMs: 1900, conceptTags: ["api", "auth", "debugging"], createdAt: new Date(Date.now() - 259200000).toISOString(),
      },
    ];
  }

  let agents = $state(buildMockAgents());
  let memories = $state<Memory[]>([]);
  let dreamCycles = $state<DreamCycle[]>([]);

  $effect(() => {
    void workspaceId;
    agents = buildMockAgents();
    memories = buildMockMemories(selectedAgentId ?? undefined);
    dreamCycles = buildMockDreamCycles();
  });

  $effect(() => {
    memories = buildMockMemories(selectedAgentId ?? undefined);
  });

  const selectedAgent = $derived(selectedAgentId ? agents.find((a) => a.id === selectedAgentId) ?? null : null);

  const displayMemories = $derived.by(() => {
    if (!searchQuery.trim()) return memories;
    const q = searchQuery.toLowerCase();
    return memories.filter((m) => m.content.toLowerCase().includes(q) || (m.topic && m.topic.toLowerCase().includes(q)));
  });

  const topics = $derived(Array.from(new Set(displayMemories.map((m) => m.topic).filter(Boolean) as string[])));
  const topicCounts = $derived(topics.map((t) => ({ t, c: displayMemories.filter((m) => m.topic === t).length })).sort((a, b) => b.c - a.c));
  const pinnedMemories = $derived(memories.filter((m) => m.pinned));
  const recentMemories = $derived([...memories].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 5));
  const latestDream = $derived(dreamCycles[0] ?? null);

  const totalKnowledge = $derived(memories.length);
  const learnedToday = $derived(memories.filter((m) => m.source === "dreaming").length);
  const noiseFiltered = $derived(dreamCycles.reduce((s, d) => s + d.pruned, 0));
  const healthScore = $derived(85);


  function confidenceColor(v: number): string {
    if (v > 0.8) return "var(--score-healthy)";
    if (v > 0.6) return "var(--score-warning)";
    return "var(--score-critical)";
  }

  function handleSaveEdit(memoryId: string) {
    memories = memories.map((m) => (m.id === memoryId ? { ...m, content: editText } : m));
    editingMemoryId = null;
  }

  function handleTogglePin(memoryId: string) {
    memories = memories.map((m) => (m.id === memoryId ? { ...m, pinned: !m.pinned } : m));
  }

  function handleDelete(memoryId: string) {
    memories = memories.filter((m) => m.id !== memoryId);
  }

  function goBack() {
    if (expandedDream !== null) { expandedDream = null; return; }
    if (activeSection) { activeSection = null; return; }
    selectedAgentId = null;
  }
</script>

{#snippet backButton()}
  <button type="button" onclick={goBack} class="cursor-pointer p-1 text-content-dim transition-colors hover:text-content" aria-label="Go back">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
  </button>
{/snippet}

{#snippet confidenceDot(v: number)}
  <span class="h-2 w-2 shrink-0 rounded-full" style="background-color: {confidenceColor(v)};" title="{(v * 100).toFixed(0)}%"></span>
{/snippet}

{#snippet sparkline(data: number[], color: string, height: number)}
  {@const max = Math.max(...data, 1)}
  {@const w = 100}
  {@const points = data.map((v, i) => `${(data.length > 1 ? i / (data.length - 1) : 0) * w},${height - (v / max) * (height - 4)}`).join(" ")}
  <svg viewBox="0 0 {w} {height}" class="w-full" style="height: {height}px;" preserveAspectRatio="none">
    <polyline points="0,{height} {points} {w},{height}" fill="{color}15" stroke="none" />
    <polyline points={points} fill="none" stroke={color} stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
{/snippet}

{#snippet memoryRow(m: Memory, showActions: boolean)}
  {@const isEditing = editingMemoryId === m.id}
  {#if isEditing}
    <div class="space-y-2 px-5 py-3" style="background-color: var(--bg-raised);">
      <textarea bind:value={editText} class="w-full resize-none rounded-md px-3 py-2 text-[13px] text-content outline-none" rows={2} style="background-color: var(--bg-base); border: 1px solid var(--border-edge);"></textarea>
      <div class="flex justify-end gap-2">
        <button type="button" onclick={() => (editingMemoryId = null)} class="cursor-pointer px-2 py-1 text-[12px] text-content-dim">Cancel</button>
        <button type="button" onclick={() => handleSaveEdit(m.id)} class="cursor-pointer rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-accent-foreground">Save</button>
      </div>
    </div>
  {:else}
    <div class="group flex items-center gap-3 px-6 py-2.5" style="background-color: var(--bg-raised);">
      <span class="text-[13px]">{SRC[m.source]?.icon ?? "\u{1F4DD}"}</span>
      {@render confidenceDot(m.confidence)}
      {#if m.pinned}<span class="text-[10px]">{"\u{1F4CC}"}</span>{/if}
      <span class="flex-1 truncate text-[13px] text-content">{m.content}</span>
      <span class="text-[11px] text-content-muted">{relativeTime(m.createdAt)}</span>
      {#if showActions}
        <div class="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button type="button" onclick={() => { editingMemoryId = m.id; editText = m.content; }} class="cursor-pointer rounded p-1 text-content-dim hover:bg-edge hover:text-content" aria-label="Edit">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button type="button" onclick={() => handleTogglePin(m.id)} class={cn("cursor-pointer rounded p-1 hover:bg-edge", m.pinned ? "text-amber-400" : "text-content-dim hover:text-amber-400")} aria-label="Toggle pin">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M8 1v1.5M5.5 4.5L4 9.5 8 12l4-2.5L10.5 4.5M8 12v3M5 4.5h6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button type="button" onclick={() => handleDelete(m.id)} class="cursor-pointer rounded p-1 text-content-dim hover:bg-edge hover:text-red-400" aria-label="Delete">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M5 4V3a1 1 0 011-1h4a1 1 0 011 1v1M6 7v5M10 7v5M3 4l1 9a1 1 0 001 1h6a1 1 0 001-1l1-9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      {/if}
    </div>
  {/if}
{/snippet}

<div class="flex h-full flex-col text-content" style="background-color: var(--audit-page-bg);">

  <!-- ═══ AGENT DETAIL: All Memories ═══ -->
  {#if selectedAgent && activeSection === "memories"}
    <div class="flex shrink-0 items-center gap-2 border-b border-edge px-5 py-3">
      {@render backButton()}
      <span class="text-[15px] font-semibold text-content">{selectedAgent.name} — All Memories</span>
    </div>
    <div class="flex-1 overflow-y-auto">
      <div class="mx-auto max-w-[var(--content-max)] space-y-4 p-5">
      <input type="text" bind:value={searchQuery} placeholder="Search memories..." class="w-full rounded-lg px-3 py-2 text-[13px] text-content outline-none" style="background-color: var(--bg-raised); border: 1px solid var(--border-edge);" />
      {#if displayMemories.length === 0}
        <EmptyState
          iconWrap={false}
          title={searchQuery ? "No memories match your search" : "No memories yet"}
          description={searchQuery
            ? undefined
            : "Memories will appear here as your agent learns from conversations"}
          class="py-16"
          titleClass="text-[14px] font-medium text-content-dim"
          descriptionClass="mt-1 text-[12px] text-content-muted"
        >
          {#snippet icon()}
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" class="text-edge">
              {#if searchQuery}
                <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              {:else}
                <path d="M12 2a7 7 0 017 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 01-2 2h-4a2 2 0 01-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 017-7z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 21h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              {/if}
            </svg>
          {/snippet}
        </EmptyState>
      {/if}
      {#each topicCounts as { t: topic, c: count }}
        {@const isExp = expandedTopic === topic}
        <div class="audit-card overflow-hidden rounded-lg">
          <button type="button" class="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--audit-row-hover)]" onclick={() => (expandedTopic = isExp ? null : topic)}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" class={cn("shrink-0 text-content-muted transition-transform", isExp && "rotate-90")}><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span class="flex-1 text-[14px] font-semibold text-content">{topic}</span>
            <span class="text-[12px] text-content-dim">{count}</span>
          </button>
          {#if isExp}
            {#each displayMemories.filter((m) => m.topic === topic) as m (m.id)}
              <div style="border-top: 1px solid var(--audit-row-border);">
                {@render memoryRow(m, true)}
              </div>
            {/each}
          {/if}
        </div>
      {/each}
      <!-- Uncategorized -->
      {#if displayMemories.filter((m) => !m.topic).length > 0}
        {@const isExp = expandedTopic === "__none"}
        <div class="audit-card overflow-hidden rounded-lg">
          <button type="button" class="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--audit-row-hover)]" onclick={() => (expandedTopic = isExp ? null : "__none")}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" class={cn("shrink-0 text-content-muted transition-transform", isExp && "rotate-90")}><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span class="flex-1 text-[14px] font-semibold text-content">Uncategorized</span>
            <span class="text-[12px] text-content-dim">{displayMemories.filter((m) => !m.topic).length}</span>
          </button>
          {#if isExp}
            {#each displayMemories.filter((m) => !m.topic) as m (m.id)}
              <div style="border-top: 1px solid var(--audit-row-border);">
                {@render memoryRow(m, true)}
              </div>
            {/each}
          {/if}
        </div>
      {/if}
      </div>
    </div>

  <!-- ═══ AGENT DETAIL: Dream Detail ═══ -->
  {:else if selectedAgent && activeSection === "dreams" && expandedDream !== null && dreamCycles[expandedDream]}
    {@const cycle = dreamCycles[expandedDream]}
    {@const durationStr = cycle.durationMs ? `${(cycle.durationMs / 1000).toFixed(1)}s` : "N/A"}
    <div class="flex shrink-0 items-center gap-2 border-b border-edge px-5 py-3">
      {@render backButton()}
      <span class="text-[15px] font-semibold text-content">Analysis — {new Date(cycle.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
    </div>
    <div class="flex-1 overflow-y-auto">
      <div class="mx-auto max-w-[var(--content-max)] space-y-6 p-5">
      {#if cycle.narrative}
        <div class="audit-card rounded-xl px-6 py-5" style="box-shadow: var(--audit-card-shadow);">
          <p class="text-[15px] italic leading-[1.8] text-content">&ldquo;{cycle.narrative}&rdquo;</p>
          <div class="mt-4 flex items-center gap-6 pt-4" style="border-top: 1px solid var(--border-edge);">
            <div><span class="text-[24px] font-bold text-online">+{cycle.promoted}</span><span class="ml-2 text-[12px] text-content-dim">facts learned</span></div>
            <div><span class="text-[24px] font-bold text-content-dim">{cycle.pruned}</span><span class="ml-2 text-[12px] text-content-dim">noise filtered</span></div>
            <span class="ml-auto text-[11px] text-content-muted">{durationStr} total</span>
          </div>
        </div>
      {/if}
      <div class="grid grid-cols-3 gap-4">
        <div class="audit-card rounded-lg px-5 py-4">
          <p class="mb-2 text-[10px] font-semibold uppercase tracking-widest text-content-dim">Stage 1 · Scan</p>
          <p class="text-[20px] font-bold text-content">{cycle.promoted + cycle.pruned}</p>
          <p class="mt-1 text-[12px] text-content-dim">candidates evaluated</p>
          <p class="mt-2 text-[12px] text-content">{cycle.promoted} contained learnable facts</p>
          <div class="mt-2 h-1.5 w-full overflow-hidden rounded-full" style="background-color: var(--bg-raised);">
            <div class="h-full rounded-full bg-content-dim" style="width: {(cycle.promoted + cycle.pruned) > 0 ? (cycle.promoted / (cycle.promoted + cycle.pruned)) * 100 : 0}%;"></div>
          </div>
        </div>
        <div class="audit-card rounded-lg px-5 py-4">
          <p class="mb-2 text-[10px] font-semibold uppercase tracking-widest text-content-dim">Stage 2 · Patterns</p>
          <p class="text-[20px] font-bold text-content">{cycle.conceptTags.length}</p>
          <p class="mt-1 text-[12px] text-content-dim">recurring themes recognized</p>
          <div class="mt-3 flex flex-wrap gap-1">
            {#each cycle.conceptTags as tag}
              <span class="rounded-full bg-surface-alt px-2 py-0.5 text-[10px] font-medium text-content-dim">{tag}</span>
            {/each}
          </div>
        </div>
        <div class="audit-card rounded-lg px-5 py-4">
          <p class="mb-2 text-[10px] font-semibold uppercase tracking-widest text-content-dim">Stage 3 · Decision</p>
          <p class="text-[20px] font-bold text-online">+{cycle.promoted}</p>
          <p class="mt-1 text-[12px] text-content-dim">important enough to remember</p>
          <p class="mt-2 text-[12px] text-content">Phase: {cycle.phase ?? "N/A"}</p>
        </div>
      </div>
      </div>
    </div>

  <!-- ═══ AGENT DETAIL: Dream List ═══ -->
  {:else if selectedAgent && activeSection === "dreams"}
    <div class="flex shrink-0 items-center gap-2 border-b border-edge px-5 py-3">
      {@render backButton()}
      <span class="text-[15px] font-semibold text-content">{selectedAgent.name} — Overnight Analysis</span>
    </div>
    <div class="flex-1 overflow-y-auto">
      <div class="mx-auto max-w-[var(--content-max)] space-y-4 p-5">
      {#if dreamCycles.length === 0}
        <div class="py-12 text-center">
          <p class="text-[15px] text-content-dim">No dream cycles recorded yet</p>
          <p class="mt-1 text-[12px] text-content-muted">Enable Dreaming in OpenClaw to see overnight analysis here</p>
        </div>
      {:else}
        {#each dreamCycles as cycle, i (cycle.id)}
          <button type="button" class="audit-card w-full cursor-pointer overflow-hidden rounded-lg text-left transition-colors hover:bg-[var(--audit-row-hover)]" onclick={() => (expandedDream = i)}>
            <div class="px-5 py-4">
              <div class="mb-2 flex items-center gap-3">
                <span class="text-[14px]">{"\u{1F319}"}</span>
                <span class="flex-1 text-[14px] font-semibold text-content">{new Date(cycle.createdAt).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                <span class="text-[12px] font-medium text-online">+{cycle.promoted} learned</span>
                <span class="text-[12px] text-content-dim">{cycle.pruned} filtered</span>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" class="text-content-muted"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </div>
              {#if cycle.narrative}<p class="truncate text-[13px] leading-relaxed text-content-dim">{cycle.narrative}</p>{/if}
            </div>
          </button>
        {/each}
      {/if}
      </div>
    </div>

  <!-- ═══ AGENT DETAIL: Activity Log ═══ -->
  {:else if selectedAgent && activeSection === "timeline"}
    <div class="flex shrink-0 items-center gap-2 border-b border-edge px-5 py-3">
      {@render backButton()}
      <span class="text-[15px] font-semibold text-content">{selectedAgent.name} — Activity Log</span>
    </div>
    <div class="flex-1 overflow-y-auto">
      <div class="mx-auto max-w-[var(--content-max)] p-5">
      <div class="audit-card overflow-hidden rounded-lg">
        {#if memories.length === 0}
          <div class="py-12 text-center"><p class="text-[13px] text-content-dim">No activity yet</p></div>
        {:else}
          {#each memories.slice(0, 20) as m (m.id)}
            <div class="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-[var(--audit-row-hover)]" style="border-bottom: 1px solid var(--audit-row-border);">
              <span class="mt-0.5 shrink-0 text-[14px]">{SRC[m.source]?.icon ?? "\u{1F4DD}"}</span>
              <span class="flex-1 text-[13px] text-content">{m.content}</span>
              <span class="shrink-0 text-[11px] text-content-muted">{relativeTime(m.createdAt)}</span>
            </div>
          {/each}
        {/if}
      </div>
      </div>
    </div>

  <!-- ═══ AGENT DETAIL: Memory Network ═══ -->
  {:else if selectedAgent && activeSection === "network"}
    <div class="flex shrink-0 items-center gap-2 border-b border-edge px-5 py-3">
      {@render backButton()}
      <span class="text-[15px] font-semibold text-content">{selectedAgent.name} — Memory Network</span>
    </div>
    <div class="flex flex-1 items-center justify-center">
      <div class="text-center">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" class="mx-auto mb-3 text-edge">
          <circle cx="6" cy="6" r="2" stroke="currentColor" stroke-width="1.5" />
          <circle cx="18" cy="6" r="2" stroke="currentColor" stroke-width="1.5" />
          <circle cx="12" cy="18" r="2" stroke="currentColor" stroke-width="1.5" />
          <path d="M7.5 7.5L10.5 16.5M16.5 7.5L13.5 16.5M8 6h8" stroke="currentColor" stroke-width="1" stroke-linecap="round" />
        </svg>
        <p class="text-[14px] font-medium text-content-dim">Memory Network</p>
        <p class="mt-1 text-[12px] text-content-muted">Graph visualization requires a live workspace connection</p>
      </div>
    </div>

  <!-- ═══ AGENT DASHBOARD ═══ -->
  {:else if selectedAgent}
    {@const agentMemories = memories}
    {@const agentTotal = agentMemories.length}
    {@const agentLearned = agentMemories.filter((m) => m.source === "dreaming").length}
    {@const agentFiltered = dreamCycles.filter((d) => d.agentId === selectedAgent.id).reduce((s, d) => s + d.pruned, 0)}
    <div class="flex shrink-0 items-center gap-2.5 border-b border-edge px-5 py-3">
      {@render backButton()}
      <div class="flex h-[22px] w-[22px] items-center justify-center rounded-md text-[11px] font-bold text-white" style="background-color: {nameToColor(selectedAgent.name)};">
        {selectedAgent.name.charAt(0)}
      </div>
      <span class="text-base font-bold text-content">{selectedAgent.name}</span>
      <span class="rounded-full bg-surface-alt px-2 py-0.5 text-[10px] font-medium text-content-dim">{selectedAgent.role}</span>
    </div>
    <div class="flex-1 overflow-y-auto">
      <div class="mx-auto max-w-[var(--content-max)] space-y-6 p-5">
      {#if agentTotal === 0}
        <div class="flex flex-col items-center justify-center gap-4 py-20">
          <div class="flex h-16 w-16 items-center justify-center rounded-2xl border border-edge bg-surface-alt">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" class="text-content-muted"><path d="M12 2a7 7 0 017 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 01-2 2h-4a2 2 0 01-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 017-7z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 21h4M12 17v-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </div>
          <div class="text-center">
            <p class="text-[15px] font-semibold text-content">No memories yet</p>
            <p class="mt-1.5 max-w-sm text-[13px] text-content-muted">Memories will appear as this agent interacts in channels or when Dreaming processes conversations.</p>
          </div>
        </div>
      {:else}
        <!-- Metric cards -->
        <div class="grid grid-cols-4 gap-4">
          {#each [{ label: "Knows", value: agentTotal, change: agentLearned > 0 ? `+${agentLearned}` : "", color: "#8b5cf6" }, { label: "Learned Today", value: agentLearned, change: agentLearned > 0 ? `+${agentLearned}` : "", color: "#10b981" }, { label: "Noise Filtered", value: agentFiltered, change: "", color: "#9b9c9e" }, { label: "Patterns Found", value: topics.length, change: "", color: "#f59e0b" }] as m}
            <div class="audit-card overflow-hidden rounded-lg px-4 pb-0 pt-4">
              <p class="text-[11px] font-medium text-content-dim">{m.label}</p>
              <div class="mt-1 flex items-baseline gap-2">
                <span class="text-[22px] font-bold tabular-nums text-content">{m.value}</span>
                {#if m.change}<span class="text-[11px] text-online">{m.change}</span>{/if}
              </div>
              <div class="-mx-4 -mb-px mt-2">
                {@render sparkline([0, 0, 0, 0, 0, 0, 0, 0, 0, m.value], m.color, 32)}
              </div>
            </div>
          {/each}
        </div>

        <!-- Deep dive cards -->
        <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {#each [{ title: "All Memories", sub: `${agentMemories.length} facts \u{00B7} Edit, pin, or delete`, icon: "\u{1F4DA}", section: "memories" as Section }, { title: "Overnight Analysis", sub: `${dreamCycles.length} sessions \u{00B7} What happened while you slept`, icon: "\u{1F319}", section: "dreams" as Section }, { title: "Activity Log", sub: `${agentMemories.length} events \u{00B7} Full history`, icon: "\u{1F4CA}", section: "timeline" as Section }, { title: "Memory Network", sub: "Graph visualization", icon: "\u{1F578}\u{FE0F}", section: "network" as Section }] as card}
            <button type="button" onclick={() => (activeSection = card.section)} class="audit-card cursor-pointer rounded-lg px-5 py-4 text-left transition-colors hover:bg-[var(--audit-row-hover)]">
              <div class="mb-1 flex items-center gap-2">
                <span class="text-[18px]">{card.icon}</span>
                <span class="text-[14px] font-semibold text-content">{card.title}</span>
              </div>
              <p class="text-[12px] text-content-dim">{card.sub}</p>
            </button>
          {/each}
        </div>

        <!-- Recent memories -->
        {#if recentMemories.length > 0}
          <div>
            <h3 class="mb-3 text-[11px] font-semibold uppercase tracking-widest text-content-dim">What {selectedAgent.name} learned recently</h3>
            <div class="audit-card overflow-hidden rounded-lg">
              {#each recentMemories as item (item.id)}
                <div class="px-4 py-3 transition-colors hover:bg-[var(--audit-row-hover)]" style="border-bottom: 1px solid var(--audit-row-border);">
                  <div class="flex items-center gap-2">
                    <span class="text-[13px]">{SRC[item.source]?.icon ?? "\u{1F4DD}"}</span>
                    <span class="flex-1 text-[13px] text-content">&ldquo;{item.content}&rdquo;</span>
                    <span class="shrink-0 text-[11px] text-content-muted">{relativeTime(item.createdAt)}</span>
                  </div>
                  <p class="mt-0.5 text-[11px] text-content-dim">{SRC[item.source]?.label ?? item.source}{item.topic ? ` \u{00B7} ${item.topic}` : ""}</p>
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Patterns + Noise -->
        <div class="grid grid-cols-2 gap-5">
          <div>
            <h3 class="mb-3 text-[11px] font-semibold uppercase tracking-widest text-content-dim">Patterns detected</h3>
            <div class="audit-card overflow-hidden rounded-lg">
              {#if topicCounts.length === 0}
                <div class="px-4 py-6 text-center text-[13px] text-content-dim">No patterns detected yet</div>
              {:else}
                {#each topicCounts.slice(0, 4) as p}
                  <div class="px-4 py-3" style="border-bottom: 1px solid var(--audit-row-border);">
                    <div class="flex items-center gap-2">
                      <span class="flex-1 text-[13px] font-medium text-content">{p.t}</span>
                      <span class="text-[11px] text-content-dim">{p.c} mentions</span>
                    </div>
                    <p class="mt-0.5 text-[11px] text-content-muted">Recurring topic across {p.c} memories</p>
                  </div>
                {/each}
              {/if}
            </div>
          </div>
          <div>
            <h3 class="mb-3 text-[11px] font-semibold uppercase tracking-widest text-content-dim">Smartly ignored</h3>
            <div class="audit-card overflow-hidden rounded-lg">
              {#if agentFiltered === 0}
                <div class="px-4 py-6 text-center text-[13px] text-content-dim">Nothing filtered yet</div>
              {:else}
                <div class="px-4 py-3">
                  <span class="text-[13px] text-content-muted">{agentFiltered} items filtered as noise</span>
                  <p class="mt-0.5 text-[11px] text-content-dim">Superseded or expired memories removed to keep knowledge clean</p>
                </div>
              {/if}
            </div>
          </div>
        </div>

        <!-- Pinned knowledge -->
        {#if pinnedMemories.length > 0}
          <div>
            <h3 class="mb-3 text-[11px] font-semibold uppercase tracking-widest text-content-dim">{"\u{1F4CC}"} Pinned by your team</h3>
            <div class="audit-card overflow-hidden rounded-lg">
              {#each pinnedMemories as m (m.id)}
                <div class="flex items-center gap-3 px-4 py-3" style="border-bottom: 1px solid var(--audit-row-border);">
                  {@render confidenceDot(m.confidence)}
                  <span class="flex-1 text-[13px] text-content">{m.content}</span>
                  {#if m.topic}<span class="text-[11px] text-content-muted">{m.topic}</span>{/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}
      {/if}
      </div>
    </div>

  <!-- ═══ MAIN DASHBOARD ═══ -->
  {:else}
    <div class="flex shrink-0 items-center border-b border-edge px-5 py-3">
      <h1 class="text-base font-bold text-content">Memory</h1>
    </div>
    <div class="flex-1 overflow-y-auto">
      <div class="mx-auto max-w-[var(--content-max)] space-y-6 p-5">
      {#if totalKnowledge === 0 && agents.length === 0}
        <!-- Empty state -->
        <div class="flex min-h-[480px] flex-1 items-center justify-center px-6 py-16">
          <div class="max-w-md text-center">
            <div class="relative mx-auto mb-6 flex h-20 w-20 items-center justify-center">
              <span class="absolute inset-0 animate-ping rounded-full" style="background-color: color-mix(in srgb, var(--color-link, #3b82f6) 18%, transparent);"></span>
              <span class="relative flex h-16 w-16 items-center justify-center rounded-full" style="background-color: color-mix(in srgb, var(--color-link, #3b82f6) 12%, var(--bg-surface)); border: 1px solid color-mix(in srgb, var(--color-link, #3b82f6) 35%, var(--border-edge));">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--color-link, #3b82f6)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a7 7 0 017 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 01-2 2h-4a2 2 0 01-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 017-7z"/><path d="M10 21h4M12 17v-3"/></svg>
              </span>
            </div>
            <span class="text-[10px] font-semibold uppercase tracking-wider text-content-muted">Memory</span>
            <h2 class="mt-2 text-[20px] font-semibold text-content" style="letter-spacing: -0.01em;">Compound your team&apos;s knowledge</h2>
            <p class="mt-2 text-[13px] leading-relaxed text-content-dim">Cyborg captures what every agent learns — facts, patterns, and decisions — so your team builds a shared brain that gets sharper over time.</p>
          </div>
        </div>
      {:else}
        <!-- KPI cards -->
        <div class="grid grid-cols-4 gap-4">
          {#each [{ value: totalKnowledge, label: "Total Knowledge", sub: "Facts across all agents" }, { value: learnedToday, label: "Learned Today", sub: "Auto-discovered" }, { value: noiseFiltered, label: "Noise Filtered", sub: "Correctly ignored" }, { value: `${healthScore}%`, label: "Health", sub: "Knowledge quality" }] as kpi}
            <div class="rounded-xl border border-edge p-5">
              <p class="text-[28px] font-bold tabular-nums text-content">{kpi.value}</p>
              <p class="mt-2 text-[13px] font-medium text-content">{kpi.label}</p>
              <p class="mt-0.5 text-[11px] text-content-muted">{kpi.sub}</p>
            </div>
          {/each}
        </div>

        <div class="grid grid-cols-2 gap-5">
          <!-- Left: Agents bar chart + topic donut -->
          <div class="flex flex-col gap-5">
            <!-- Agent bar chart -->
            <div class="flex flex-1 flex-col">
              <h3 class="mb-3 text-sm font-semibold text-content">Your Agents are learning</h3>
              <div class="flex flex-1 flex-col justify-center rounded-xl border border-edge p-5">
                {#if agents.length === 0}
                  <div class="py-6 text-center text-[13px] text-content-muted">No agents connected</div>
                {:else}
                  {@const maxCount = Math.max(...agents.map((a) => a.memoryCount), 1)}
                  <div class="space-y-3">
                    {#each agents as agent, i}
                      <button type="button" class="flex w-full cursor-pointer items-center gap-3" title="{agent.name}: {agent.memoryCount} memories" onclick={() => (selectedAgentId = agent.id)}>
                        <span class="w-16 shrink-0 truncate text-right text-[12px] text-content-muted">{agent.name}</span>
                        <div class="h-8 flex-1 overflow-hidden rounded bg-edge/30">
                          {#if agent.memoryCount > 0}
                            <div class="h-full rounded transition-all" style="width: {(agent.memoryCount / maxCount) * 100}%; background-color: #8b5cf6; opacity: {0.4 + (agent.memoryCount / maxCount) * 0.6};"></div>
                          {/if}
                        </div>
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>
            </div>

            <!-- Topic donut -->
            <div class="flex flex-1 flex-col">
              <h3 class="mb-3 text-sm font-semibold text-content">Top Topics across workspace</h3>
              <div class="flex flex-1 flex-col justify-center rounded-xl border border-edge p-5">
                {#if topicCounts.length === 0}
                  <div class="py-6 text-center text-[13px] text-content-muted">No topics detected yet</div>
                {:else}
                  {@const topicColors = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#06b6d4", "#ec4899"]}
                  {@const total = topicCounts.reduce((s, t) => s + t.c, 0)}
                  {@const radius = 58}
                  {@const circumference = 2 * Math.PI * radius}
                  <div class="flex items-center gap-10">
                    <div class="relative shrink-0">
                      <svg width="150" height="150" viewBox="0 0 150 150">
                        {#each topicCounts as seg, i}
                          {@const pct = (seg.c / total) * 100}
                          {@const offset = topicCounts.slice(0, i).reduce((s, t) => s + (t.c / total) * 100, 0)}
                          <circle cx="75" cy="75" r={radius} fill="none" stroke={topicColors[i % topicColors.length]} stroke-width="18"
                            stroke-dasharray="{(pct / 100) * circumference} {circumference}"
                            stroke-dashoffset="{-(offset / 100) * circumference}"
                            transform="rotate(-90 75 75)" class="cursor-pointer" style="transition: opacity 0.2s;">
                            <title>{seg.t}: {seg.c} ({Math.round(pct)}%)</title>
                          </circle>
                        {/each}
                      </svg>
                      <div class="absolute inset-0 flex flex-col items-center justify-center">
                        <span class="text-[22px] font-bold tabular-nums text-content">{total}</span>
                        <span class="text-[11px] text-content-muted">Topics</span>
                      </div>
                    </div>
                    <div class="max-w-[300px] flex-1 space-y-2.5">
                      {#each topicCounts as seg, i}
                        <div class="flex w-full items-center gap-2.5" title="{seg.t}: {seg.c}">
                          <span class="h-2.5 w-2.5 shrink-0 rounded-full" style="background-color: {topicColors[i % topicColors.length]};"></span>
                          <span class="flex-1 truncate text-[13px] text-content">{seg.t}</span>
                          <span class="shrink-0 tabular-nums text-[13px] text-content-muted">{seg.c}</span>
                        </div>
                      {/each}
                    </div>
                  </div>
                {/if}
              </div>
            </div>
          </div>

          <!-- Right: Latest Overnight Analysis -->
          <div class="flex flex-col">
            <h3 class="mb-3 text-sm font-semibold text-content">Latest Overnight Analysis</h3>
            <div class="flex-1 overflow-hidden rounded-xl border border-edge">
              {#if latestDream}
                <div class="flex items-center gap-2 border-b border-edge bg-surface-alt px-5 py-3">
                  <span class="flex-1 text-[13px] font-medium text-content">{new Date(latestDream.createdAt).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                  <span class="rounded-full bg-online/10 px-2 py-0.5 text-[11px] font-semibold text-online">+{latestDream.promoted} Learned</span>
                  <span class="text-[11px] text-content-muted">{latestDream.pruned} Filtered</span>
                </div>
                {#if latestDream.narrative}
                  <div class="divide-y divide-edge">
                    {#each latestDream.narrative.split("\n").filter((l) => l.trim()).slice(0, 4) as line, i}
                      <div class="px-5 py-3">
                        <p class="mb-1 text-[11px] uppercase tracking-wide text-content-muted">{new Date(latestDream.createdAt).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}</p>
                        <p class="border-l-2 border-edge pl-3 text-[13px] leading-[1.6] text-content">{line}</p>
                      </div>
                    {/each}
                  </div>
                {:else}
                  <div class="px-5 py-4"><p class="text-[13px] text-content-muted">Analysis completed — no narrative generated</p></div>
                {/if}
              {:else}
                <div class="flex flex-1 flex-col items-center justify-center gap-2 py-10">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" class="text-edge"><path d="M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                  <p class="text-[13px] text-content-dim">No dream cycles yet</p>
                  <p class="text-[11px] text-content-muted">Enable Dreaming in OpenClaw to see analysis</p>
                </div>
              {/if}
            </div>
          </div>
        </div>
      {/if}
      </div>
    </div>
  {/if}
</div>
