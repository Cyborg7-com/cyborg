<script lang="ts">
  import { cn } from "$lib/utils.js";
  import { relativeTime } from "$lib/utils/datetime.js";
  import { logState, workspaceState } from "$lib/state/app.svelte.js";
  import type { LogLevel, LogCategory } from "$lib/state/app.svelte.js";
  import { filterAudit } from "$lib/plugins/agents/audit-filter.js";
  import EmptyState from "../EmptyState.svelte";
  import FilterDropdown from "../FilterDropdown.svelte";

  let { workspaceId: _ }: { workspaceId: string } = $props();

  type TimeRange = "today" | "yesterday" | "week" | "month" | "all";
  type LevelFilter = LogLevel | "all";

  const TIME_LABELS: Record<TimeRange, string> = {
    today: "Today",
    yesterday: "Yesterday",
    week: "This Week",
    month: "This Month",
    all: "All Time",
  };

  const CATEGORY_LABELS: Record<string, string> = {
    agent: "Agent",
    task: "Task",
    channel: "Channel",
    system: "System",
    tool_use: "Tool calls",
    permission: "Permissions",
    dm: "DM",
    // #995 audit-trace categories.
    context_injection: "Context",
    tool_injection: "Tools",
    spawn_lifecycle: "Spawn",
    invocation_decision: "Invocation",
    daemon_operation: "Daemon ops",
    failure: "Failures",
  };

  const LEVEL_OPTIONS: LevelFilter[] = ["all", "error", "warn", "info", "debug"];

  let levelFilter = $state<LevelFilter>("all");
  let categoryFilter = $state("all");
  let agentFilter = $state("all");
  // #995 audit-stream slices (session == agentId / cybo / daemon / kind).
  let sessionFilter = $state("all");
  let cyboFilter = $state("all");
  let daemonFilter = $state("all");
  let kindFilter = $state("all");
  let searchQuery = $state("");
  let timeRange = $state<TimeRange>("all");
  let autoScroll = $state(true);
  let expandedRow = $state<string | null>(null);
  let showExportModal = $state(false);

  let scrollContainer: HTMLDivElement | undefined = $state();


  const timeFilteredLogs = $derived.by(() => {
    const logs = logState.entries;
    if (timeRange === "all") return logs;
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let since: Date;
    if (timeRange === "today") since = startOfToday;
    else if (timeRange === "yesterday") since = new Date(startOfToday.getTime() - 86400000);
    else if (timeRange === "week") since = new Date(startOfToday.getTime() - 7 * 86400000);
    else since = new Date(startOfToday.getTime() - 30 * 86400000);
    const until = timeRange === "yesterday" ? startOfToday : new Date();
    return logs.filter((l) => {
      const t = new Date(l.timestamp).getTime();
      return t >= since.getTime() && t <= until.getTime();
    });
  });

  const filtered = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    // #995: the audit-stream slices (session/cybo/daemon/kind) run first via the
    // pure filterAudit helper (proven headless), then the existing level/category/
    // agent/search filters narrow what's left.
    const sliced = filterAudit(timeFilteredLogs, {
      session: sessionFilter,
      cybo: cyboFilter,
      daemon: daemonFilter,
      kind: kindFilter,
    });
    const result = sliced.filter((l) => {
      // #995: the default level filter EXCLUDES debug (high-frequency low-signal
      // audit events). Picking an explicit level — including "debug" — overrides.
      if (levelFilter === "all" && l.level === "debug") return false;
      if (levelFilter !== "all" && l.level !== levelFilter) return false;
      if (categoryFilter !== "all" && l.category !== categoryFilter) return false;
      if (agentFilter !== "all" && l.source !== agentFilter) return false;
      if (q) {
        const haystack = `${l.message} ${l.source}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
    return result.toReversed();
  });

  const categories = $derived(
    Array.from(new Set(logState.entries.map((l) => l.category).filter(Boolean) as LogCategory[])),
  );

  // #995: distinct audit-stream slice values (only audit entries carry these ids).
  function distinct(pick: (l: (typeof logState.entries)[number]) => string | null | undefined) {
    return Array.from(
      new Set(logState.entries.map(pick).filter((v): v is string => Boolean(v))),
    );
  }
  const sessionValues = $derived(distinct((l) => l.agentId));
  const cyboValues = $derived(distinct((l) => l.cyboId));
  const daemonValues = $derived(distinct((l) => l.daemonId));
  const kindValues = $derived(distinct((l) => l.kind));

  const agentSources = $derived(
    Array.from(new Set(
      logState.entries
        .filter((l) => l.category === "agent" || l.category === "tool_use")
        .map((l) => l.source),
    )),
  );

  $effect(() => {
    // oxlint-disable-next-line eslint/no-unused-expressions -- track filtered changes for auto-scroll
    filtered;
    if (autoScroll && scrollContainer) {
      scrollContainer.scrollTo({ top: 0, behavior: "smooth" });
    }
  });

  function clearLogs() {
    logState.clear();
  }

  function exportLogs() {
    const lines = filtered
      .map(
        (l) =>
          `[${l.timestamp}] [${l.level.toUpperCase()}] [${l.category ?? "-"}] [${l.source}] ${l.message}`,
      )
      .join("\n");
    const blob = new Blob([lines], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `logs-${new Date().toISOString().split("T")[0]}.log`;
    a.click();
    URL.revokeObjectURL(url);
    showExportModal = false;
  }

  // Option lists for the shared <FilterDropdown> (open-state + outside-click now
  // live in that component). The trigger shows the selected option's label.
  const TIME_ORDER: TimeRange[] = ["today", "yesterday", "week", "month", "all"];
  const timeOptions = $derived(TIME_ORDER.map((tr) => ({ value: tr, label: TIME_LABELS[tr] })));
  const categoryOptions = $derived([
    { value: "all", label: "All categories" },
    ...categories.map((c) => ({ value: c, label: CATEGORY_LABELS[c] ?? c })),
  ]);
  const agentOptions = $derived([
    { value: "all", label: "All agents" },
    ...agentSources.map((a) => ({ value: a, label: a })),
  ]);

  // #995 audit-stream slice dropdowns. A short id label keeps the trigger compact.
  function shortId(id: string): string {
    return id.length > 10 ? `${id.slice(0, 8)}…` : id;
  }
  const sessionOptions = $derived([
    { value: "all", label: "All sessions" },
    ...sessionValues.map((s) => ({ value: s, label: shortId(s) })),
  ]);
  const cyboOptions = $derived([
    { value: "all", label: "All cybos" },
    ...cyboValues.map((c) => ({ value: c, label: shortId(c) })),
  ]);
  const daemonOptions = $derived([
    { value: "all", label: "All daemons" },
    ...daemonValues.map((d) => ({ value: d, label: shortId(d) })),
  ]);
  const kindOptions = $derived([
    { value: "all", label: "All kinds" },
    ...kindValues.map((k) => ({ value: k, label: k })),
  ]);
</script>

<div class="flex h-full flex-col bg-surface-alt text-content">
  <!-- Header -->
  <div class="shrink-0 border-b border-edge bg-surface">
    <div class="mx-auto w-full max-w-[var(--content-max)] px-6">
      <div class="flex items-center gap-3 py-3">
        <h1 class="flex-1 text-[17px] font-bold text-content">Logs</h1>
        <button
          type="button"
          onclick={clearLogs}
          disabled={logState.entries.length === 0}
          aria-label="Clear logs"
          class="cursor-pointer rounded-lg border border-edge px-3 py-1.5 text-xs font-medium text-content-dim transition-colors hover:bg-raised hover:text-content disabled:cursor-not-allowed disabled:opacity-50"
        >
          Clear
        </button>
        <button
          type="button"
          onclick={() => (showExportModal = true)}
          disabled={filtered.length === 0}
          class="cursor-pointer rounded-lg border border-edge px-3 py-1.5 text-xs font-medium text-content-dim transition-colors hover:bg-raised hover:text-content disabled:cursor-not-allowed disabled:opacity-50"
        >
          Export
        </button>
      </div>
    </div>
  </div>

  <!-- Filter bar -->
  <div class="shrink-0 border-b border-edge bg-surface">
    <div class="mx-auto w-full max-w-[var(--content-max)] px-6">
      <div class="flex flex-wrap items-center gap-3 py-2">
        <!-- Time range dropdown -->
        <FilterDropdown
          value={timeRange}
          options={timeOptions}
          onSelect={(v) => (timeRange = v as TimeRange)}
          menuWidth="140px"
          ariaLabel="Filter by time range"
        >
          {#snippet icon()}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          {/snippet}
        </FilterDropdown>

        <!-- Level filter pills -->
        <div class="flex items-center overflow-hidden rounded-xl border border-edge">
          {#each LEVEL_OPTIONS as lv}
            <button
              type="button"
              onclick={() => (levelFilter = lv)}
              class={cn(
                "cursor-pointer px-3 py-1.5 text-xs font-medium transition-colors",
                levelFilter === lv ? "text-content" : "text-content-muted hover:text-content",
              )}
              style={levelFilter === lv ? "background-color: var(--bg-surface-alt);" : ""}
            >
              {lv === "all" ? "All" : lv.charAt(0).toUpperCase() + lv.slice(1)}
            </button>
          {/each}
        </div>

        <!-- Category dropdown -->
        {#if categories.length > 1}
          <FilterDropdown
            value={categoryFilter}
            options={categoryOptions}
            onSelect={(v) => (categoryFilter = v)}
            menuWidth="150px"
            ariaLabel="Filter by category"
          />
        {/if}

        <!-- Agent filter dropdown -->
        {#if agentSources.length > 0}
          <FilterDropdown
            value={agentFilter}
            options={agentOptions}
            onSelect={(v) => (agentFilter = v)}
            menuWidth="160px"
            ariaLabel="Filter by agent"
          >
            {#snippet icon()}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
            {/snippet}
          </FilterDropdown>
        {/if}

        <!-- #995 audit-stream slice dropdowns (only shown when audit data exists) -->
        {#if sessionValues.length > 0}
          <FilterDropdown
            value={sessionFilter}
            options={sessionOptions}
            onSelect={(v) => (sessionFilter = v)}
            menuWidth="170px"
            ariaLabel="Filter by session"
          />
        {/if}
        {#if cyboValues.length > 0}
          <FilterDropdown
            value={cyboFilter}
            options={cyboOptions}
            onSelect={(v) => (cyboFilter = v)}
            menuWidth="150px"
            ariaLabel="Filter by cybo"
          />
        {/if}
        {#if daemonValues.length > 0}
          <FilterDropdown
            value={daemonFilter}
            options={daemonOptions}
            onSelect={(v) => (daemonFilter = v)}
            menuWidth="150px"
            ariaLabel="Filter by daemon"
          />
        {/if}
        {#if kindValues.length > 0}
          <FilterDropdown
            value={kindFilter}
            options={kindOptions}
            onSelect={(v) => (kindFilter = v)}
            menuWidth="160px"
            ariaLabel="Filter by kind"
          />
        {/if}

        <!-- Search -->
        <div class="relative">
          <input
            type="text"
            bind:value={searchQuery}
            placeholder="Search messages..."
            class="w-[180px] rounded-lg border border-edge bg-surface-alt py-1.5 pl-7 pr-2 text-[12px] text-content placeholder-content-muted focus:border-edge-light focus:outline-none focus:ring-1 focus:ring-edge-light"
          />
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-content-muted" aria-hidden="true">
            <circle cx="7" cy="7" r="4" stroke="currentColor" stroke-width="1.4" />
            <path d="M10.5 10.5l3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
          {#if searchQuery}
            <button
              type="button"
              onclick={() => (searchQuery = "")}
              class="absolute right-1.5 top-1/2 -translate-y-1/2 cursor-pointer rounded p-0.5 text-content-muted hover:text-content"
              aria-label="Clear search"
            >
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            </button>
          {/if}
        </div>

        <!-- Right side -->
        <div class="ml-auto flex items-center gap-3">
          <label class="flex cursor-pointer select-none items-center gap-2">
            <span class="text-[11px] text-content-muted">Auto-scroll</span>
            <button
              type="button"
              onclick={() => (autoScroll = !autoScroll)}
              class={cn(
                "relative h-[18px] w-8 rounded-full transition-colors",
                autoScroll ? "bg-[var(--toggle-on-bg)]" : "bg-[var(--toggle-off-bg)]",
              )}
              role="switch"
              aria-checked={autoScroll}
              aria-label="Toggle auto-scroll"
            >
              <span
                class={cn(
                  "absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow-sm transition-transform",
                  autoScroll ? "left-[15px]" : "left-[2px]",
                )}
              ></span>
            </button>
          </label>
          <span class="text-[11px] text-content-muted">{filtered.length} entries</span>
        </div>
      </div>
    </div>
  </div>

  <!-- Log table -->
  <div bind:this={scrollContainer} class="flex-1 overflow-auto">
    <div class="mx-auto w-full max-w-[var(--content-max)] px-6 py-4">
      {#if filtered.length === 0}
        {#if logState.entries.length === 0}
          <EmptyState
            iconWrap={false}
            title="No events yet"
            description="Activity from agents and channels will appear here in real-time"
            class="py-20"
            titleClass="text-[14px] font-medium text-content"
            descriptionClass="mt-1 text-[12px] text-content-muted"
          >
            {#snippet icon()}
              <div class="flex h-12 w-12 items-center justify-center rounded-full bg-raised text-content-muted">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" stroke-width="1.5"/>
                  <path d="M8 8h8M8 12h6M8 16h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                </svg>
              </div>
            {/snippet}
          </EmptyState>
        {:else}
          <EmptyState
            noIcon
            title="No matching entries"
            description="Try adjusting your filters"
            class="py-20"
            titleClass="text-[14px] font-medium text-content-dim"
            descriptionClass="mt-1 text-[12px] text-content-muted"
          />
        {/if}
      {:else}
        <div class="overflow-hidden rounded-xl border border-edge">
          <!-- Column headers -->
          <div class="flex items-center gap-3 px-4 py-2" style="background-color: var(--bg-surface-alt);">
            <span class="w-[70px] shrink-0 text-[12px] font-medium text-content-muted">Time</span>
            <span class="w-[60px] shrink-0 text-[12px] font-medium text-content-muted">Level</span>
            <span class="w-[100px] shrink-0 text-[12px] font-medium text-content-muted">Source</span>
            <span class="flex-1 text-[12px] font-medium text-content-muted">Message</span>
          </div>
          <!-- Rows -->
          <div class="divide-y divide-edge">
            {#each filtered as log (log.id)}
              {@const isExpanded = expandedRow === log.id}
              <button
                type="button"
                class="flex w-full cursor-pointer items-start gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
                onclick={() => (expandedRow = isExpanded ? null : log.id)}
              >
                <!-- Timestamp -->
                <span class="w-[70px] shrink-0 pt-0.5 text-[13px] text-content-muted">
                  {relativeTime(log.timestamp)}
                </span>

                <!-- Level badge -->
                <span
                  class="w-[60px] shrink-0 rounded px-2 py-0.5 text-center text-[11px] font-medium uppercase"
                  style="background-color: var(--log-{log.level}-bg); color: var(--log-{log.level}-text);"
                >
                  {log.level}
                </span>

                <!-- Source -->
                <span class="w-[100px] shrink-0 truncate pt-0.5 text-[13px] text-content-muted">
                  {log.source}
                </span>

                <!-- Message (+ #995 redacted audit payload when expanded) -->
                <span class="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span class={cn(
                    "text-[13px] font-medium text-content",
                    isExpanded ? "whitespace-pre-wrap break-all" : "truncate",
                  )}>
                    {log.message}
                  </span>
                  {#if isExpanded && log.payload && Object.keys(log.payload).length > 0}
                    <pre class="overflow-x-auto rounded-md border border-edge bg-surface-alt px-3 py-2 text-[11px] leading-relaxed text-content-muted whitespace-pre-wrap break-all">{JSON.stringify(log.payload, null, 2)}</pre>
                  {/if}
                </span>
              </button>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  </div>

  <!-- Export modal -->
  {#if showExportModal}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onclick={() => (showExportModal = false)}
      onkeydown={(e) => { if (e.key === "Escape") showExportModal = false; }}
      role="dialog"
      aria-modal="true"
      aria-label="Export Logs"
      tabindex="-1"
    >
      <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
      <div
        class="w-[400px] rounded-xl border border-edge bg-surface-alt shadow-2xl"
        onclick={(e) => e.stopPropagation()}
      >
        <div class="flex items-center justify-between border-b border-edge px-5 py-4">
          <h3 class="text-base font-semibold text-content">Export Logs</h3>
          <button
            type="button"
            onclick={() => (showExportModal = false)}
            class="cursor-pointer text-content-dim hover:text-content"
            aria-label="Close"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
        </div>
        <div class="space-y-4 p-5">
          <div class="text-[12px] text-content-muted">
            {filtered.length} log entries will be exported
          </div>
        </div>
        <div class="flex justify-end gap-2 border-t border-edge px-5 py-4">
          <button
            type="button"
            onclick={() => (showExportModal = false)}
            class="cursor-pointer px-4 py-2 text-[13px] text-content-dim hover:text-content"
          >
            Cancel
          </button>
          <button
            type="button"
            onclick={exportLogs}
            class="cursor-pointer rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-accent-foreground hover:bg-accent-hover"
          >
            Export .log
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>
