<script lang="ts">
  // ─── Mission Control Home — REAL DATA ─────────────────────────────────────
  // Fleet + header come from live client state (daemons + agents). The "This
  // week" tiles, activity heatmap, and top agents come from the workspace-wide
  // server aggregate (cyborg:workspace_stats → PgSync.getWorkspaceHomeStats),
  // which is empty until session history accumulates — hence the empty states.
  import { goto } from "$app/navigation";
  import ProviderIcon from "$lib/plugins/agents/components/ProviderIcon.svelte";
  import Avatar from "$lib/components/Avatar.svelte";
  import CreateAgentDialog from "$lib/components/agent/CreateAgentDialog.svelte";
  import RequestDaemonAccessButton from "$lib/components/daemon/RequestDaemonAccessButton.svelte";
  import { providerBrandColor } from "$lib/agent-display.js";
  import {
    workspaceState,
    daemonState,
    daemonStatusState,
    cyboState,
    authState,
    client,
  } from "$lib/state/app.svelte.js";
  import type { WorkspaceHomeStats } from "$lib/ws-client.js";

  let { userName = "there", workspaceId }: { userName?: string; workspaceId?: string } = $props();

  function today(): string {
    return new Date().toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  }
  function brand(provider: string | null | undefined): string {
    return providerBrandColor(provider ?? undefined) ?? "var(--color-accent)";
  }
  function fmtTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }
  function providerLabel(p: string | null): string {
    if (!p) return "Agent";
    return p.charAt(0).toUpperCase() + p.slice(1);
  }

  function openFleet() {
    if (workspaceId) void goto(`/workspace/${workspaceId}/daemons`);
  }

  // ── Workspace-wide stats (server aggregate) ────────────────────────
  // Range filter for the scalar tiles + top agents (heatmap is always a year).
  type StatsRange = "today" | "week" | "month" | "year";
  const RANGE_OPTIONS: { value: StatsRange; label: string; heading: string }[] = [
    { value: "today", label: "Today", heading: "Today" },
    { value: "week", label: "Week", heading: "This week" },
    { value: "month", label: "Month", heading: "This month" },
    { value: "year", label: "Year", heading: "This year" },
  ];
  let statsRange = $state<StatsRange>("month");
  const rangeHeading = $derived(
    RANGE_OPTIONS.find((o) => o.value === statsRange)?.heading ?? "This month",
  );

  let stats = $state<WorkspaceHomeStats | null>(null);
  let statsLoading = $state(false);
  $effect(() => {
    const wsId = workspaceId;
    const range = statsRange;
    if (!wsId) {
      stats = null;
      statsLoading = false;
      return;
    }
    let cancelled = false;
    statsLoading = true;
    client
      .getWorkspaceHomeStats(wsId, range)
      .then((s) => {
        if (!cancelled) {
          stats = s;
          statsLoading = false;
        }
      })
      .catch(() => {
        if (!cancelled) statsLoading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  // ── Fleet (live daemons + agents) ──────────────────────────────────
  const daemons = $derived(
    daemonState.list
      .map((d) => {
        const online = daemonStatusState.get(d.id) === "online";
        const running = workspaceState.agents.filter(
          (a) => a.daemonId === d.id && a.lifecycle === "running",
        ).length;
        const platform = d.meta?.platform
          ? `${d.meta.platform}${d.meta.arch ? `/${d.meta.arch}` : ""}`
          : null;
        const owner = workspaceState.members.find((m) => m.userId === d.ownerId);
        return {
          id: d.id,
          host: d.meta?.host ?? d.label,
          platform,
          online,
          cybo: !!d.meta?.cyboInstalled,
          you: d.ownerId === authState.user?.id,
          // #705: can the current user already run on this daemon (owner OR an
          // existing access grant)? Drives whether to show the "Request access"
          // affordance (only for daemons they CAN'T access yet).
          canAccess: daemonState.canAccess(d.id, authState.user?.id),
          ownerName: owner?.name ?? owner?.email ?? null,
          members: Math.max(1, daemonState.accessUserIds(d.id).length),
          running,
        };
      })
      .sort((a, b) => Number(b.online) - Number(a.online) || b.running - a.running),
  );
  const daemonsOnline = $derived(daemons.filter((d) => d.online).length);
  const sessionsRunning = $derived(
    workspaceState.agents.filter((a) => a.lifecycle === "running").length,
  );
  // Cap the Home preview so a big fleet doesn't dominate the page; the rest live
  // behind the "see all" modal (full list) + the daemons page.
  const FLEET_PREVIEW = 6;
  const visibleDaemons = $derived(daemons.slice(0, FLEET_PREVIEW));
  const hiddenCount = $derived(Math.max(0, daemons.length - FLEET_PREVIEW));
  let fleetModalOpen = $state(false);
  // "New session" opens the provider-CLI session dialog (Terminal/Claude/Codex/…)
  // — NOT the cybo/agent creation flow at /agent/new.
  let newSessionOpen = $state(false);

  // ── This week tiles ────────────────────────────────────────────────
  const weekStats = $derived(
    stats
      ? [
          { label: "Sessions", value: String(stats.sessionsThisWeek) },
          { label: "Agent-hours", value: `${stats.agentHoursThisWeek.toFixed(1)}h` },
          { label: "Tasks shipped", value: String(stats.tasksShippedThisWeek) },
          { label: "Tokens", value: fmtTokens(stats.tokensThisWeek) },
        ]
      : [],
  );
  const hasWeekData = $derived(
    !!stats &&
      (stats.sessionsThisWeek > 0 || stats.tokensThisWeek > 0 || stats.tasksShippedThisWeek > 0),
  );

  // ── Top agents ─────────────────────────────────────────────────────
  // A named cybo (Rick, Atlas, …) must show ITS OWN profile avatar — the same
  // photo/emoji/initials the rest of the app renders via <Avatar avatar> — not a
  // generic provider/harness glyph. We resolve the cybo from the roster by
  // cyboId and pass its raw avatar string through; only the generic dispatcher
  // ("Agent", no cyboId) keeps the provider-tinted glyph.
  const topAgents = $derived(
    (stats?.topAgents ?? []).map((t) => {
      const cybo = t.cyboId ? cyboState.list.find((c) => c.id === t.cyboId) : null;
      return {
        name: cybo?.name ?? providerLabel(t.provider),
        provider: t.provider ?? "cybo",
        // When this row is a real cybo we render <Avatar> (image | emoji |
        // initials of its own name). `avatar` may be null (cybo with no photo) —
        // Avatar then falls back to the cybo's initials, never the provider glyph.
        isCybo: !!cybo,
        avatar: cybo?.avatar ?? null,
        sessions: t.sessions,
      };
    }),
  );
  const topMax = $derived(Math.max(1, ...topAgents.map((a) => a.sessions)));

  // ── Activity heatmap (last ~53 weeks, GitHub-style weekday-aligned grid) ──
  // GitHub shows ~1 year; we render the full grid client-side regardless of how
  // much data the server returns — days with no data render as a visible empty
  // cell (heatColorFor(0)), so the graph reads as a real GitHub-style grid even
  // when there's no activity yet (never a blank box).
  const WEEKS = 53;
  const DAYS = WEEKS * 7;
  // Buckets are UTC day-keys on the server (to_char(... AT TIME ZONE 'UTC')), so
  // generate, format, and weekday-align the grid in UTC too — otherwise cells
  // shift/duplicate/vanish across the viewer's timezone and DST boundaries.
  function fmtDay(d: Date): string {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }
  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  // weeks: array of columns; each column is 7 day-cells by weekday. A cell is
  // { value: tokens, date } for real days, or null for padding before the range.
  // firstDays: the leading date of each column, used to place month labels.
  type HeatCell = { value: number; date: string } | null;
  const heatGrid = $derived.by(() => {
    const map = new Map<string, number>();
    for (const a of stats?.dailyActivity ?? []) map.set(a.day, a.count);
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - (DAYS - 1));
    const weeks: HeatCell[][] = [];
    const firstDays: (Date | null)[] = [];
    let col: HeatCell[] = new Array(7).fill(null);
    let colFirst: Date | null = null;
    for (let i = 0; i < DAYS; i++) {
      const d = new Date(start.getTime() + i * 24 * 60 * 60 * 1000);
      if (colFirst === null) colFirst = d;
      const key = fmtDay(d);
      col[d.getUTCDay()] = { value: map.get(key) ?? 0, date: key };
      if (d.getUTCDay() === 6) {
        weeks.push(col);
        firstDays.push(colFirst);
        col = new Array(7).fill(null);
        colFirst = null;
      }
    }
    if (col.some((c) => c !== null)) {
      weeks.push(col);
      firstDays.push(colFirst);
    }
    return { weeks, firstDays };
  });
  const heatWeeks = $derived(heatGrid.weeks);
  // Month labels aligned to week columns: label a column when its month differs
  // from the previously labeled column (GitHub puts the month over its first week).
  const monthLabels = $derived.by(() => {
    const out: { col: number; name: string }[] = [];
    let prevMonth = -1;
    heatGrid.firstDays.forEach((d, col) => {
      if (!d) return;
      const m = d.getUTCMonth();
      if (m !== prevMonth) {
        out.push({ col, name: MONTH_NAMES[m] });
        prevMonth = m;
      }
    });
    return out;
  });
  // ABSOLUTE token/day thresholds (not relative to the busiest day) — a fixed
  // legend: a given color always means the same token volume, GitHub-style. Tune
  // these three boundaries to define what counts as a little vs. a lot.
  //   0           → empty
  //   1 … 100k    → tier 1 (lightest)
  //   100k … 500k → tier 2
  //   500k … 2M   → tier 3
  //   2M+         → tier 4 (darkest)
  const HEAT_THRESHOLDS = [100_000, 500_000, 2_000_000];
  // 0-count cells must stay clearly visible (GitHub's empty grid) — a content
  // tint over the card reads on both light & dark themes. null = padding outside
  // the date range (no cell).
  const HEAT_EMPTY = "color-mix(in oklch, var(--color-content) 12%, var(--color-surface-alt))";
  function heatColorFor(count: number | null): string {
    if (count === null) return "transparent";
    if (count <= 0) return HEAT_EMPTY;
    if (count < HEAT_THRESHOLDS[0]) return "color-mix(in oklch, var(--color-accent) 32%, transparent)";
    if (count < HEAT_THRESHOLDS[1]) return "color-mix(in oklch, var(--color-accent) 55%, transparent)";
    if (count < HEAT_THRESHOLDS[2]) return "color-mix(in oklch, var(--color-accent) 78%, transparent)";
    return "var(--color-accent)";
  }
  // Legend swatches mirror heatColorFor's scale (0 → low → … → high).
  const legendSwatches = [
    HEAT_EMPTY,
    "color-mix(in oklch, var(--color-accent) 32%, transparent)",
    "color-mix(in oklch, var(--color-accent) 55%, transparent)",
    "color-mix(in oklch, var(--color-accent) 78%, transparent)",
    "var(--color-accent)",
  ];
  const dayLabels = ["", "Mon", "", "Wed", "", "Fri", ""];

  // ── Heatmap tooltip (instant, GitHub-style — the native `title` attr lags ~1s) ──
  let heatTip = $state<{ text: string; x: number; y: number } | null>(null);
  // "YYYY-MM-DD" (UTC day-key) → "Jun 23, 2026". Parsed straight from the string
  // (the key is already UTC) — no Date/Intl per cell, since aria-label runs this
  // for every cell on each render.
  function fmtCellDate(iso: string): string {
    const [y, m, d] = iso.split("-").map(Number);
    return `${MONTH_NAMES[m - 1]} ${d}, ${y}`;
  }
  function cellTooltip(cell: { value: number; date: string }): string {
    const label = cell.value > 0 ? `${fmtTokens(cell.value)} tokens` : "No tokens";
    return `${label} · ${fmtCellDate(cell.date)}`;
  }
  // Event (not MouseEvent) so it serves both onmouseenter and onfocus.
  function showHeatTip(e: Event, cell: { value: number; date: string }): void {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    heatTip = { text: cellTooltip(cell), x: r.left + r.width / 2, y: r.top };
  }

  const cardCls = "rounded-lg border border-edge bg-surface-alt";
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape" && fleetModalOpen) fleetModalOpen = false;
  }}
/>

<!-- One daemon card, reused by the Fleet preview grid and the "see all" modal. -->
{#snippet daemonCard(d: (typeof daemons)[number])}
  <div class="{cardCls} flex items-center gap-3 px-4 py-3 {d.online ? '' : 'opacity-60'}">
    <span
      class="h-2.5 w-2.5 shrink-0 rounded-full"
      style="background: {d.online ? 'var(--color-success)' : 'var(--color-content-muted)'};"
    ></span>
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-1.5">
        <span class="truncate text-[13px] font-semibold text-content">{d.host}</span>
        {#if d.you}
          <span class="shrink-0 rounded bg-content/10 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-content-dim">You</span>
        {/if}
      </div>
      {#if d.ownerName}
        <div class="truncate text-[11px] text-content-muted">{d.ownerName}</div>
      {/if}
      <div class="flex items-center gap-1.5 text-[11px] text-content-muted">
        {#if d.platform}<span class="truncate font-mono">{d.platform}</span><span>·</span>{/if}
        <span class="inline-flex shrink-0 items-center gap-0.5">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          {d.members}
        </span>
        {#if d.cybo}<span class="shrink-0 text-content-dim">· cybo</span>{/if}
      </div>
    </div>
    {#if d.canAccess}
      {#if d.running > 0}
        <span
          class="flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-semibold text-online"
          style="background: color-mix(in srgb, var(--color-success) 14%, transparent);"
        >
          <span class="relative flex h-1.5 w-1.5">
            <span class="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style="background: var(--color-success);"></span>
            <span class="relative inline-flex h-1.5 w-1.5 rounded-full" style="background: var(--color-success);"></span>
          </span>
          {d.running} running
        </span>
      {:else if d.you}
        <!-- You own this machine ("You" badge already shown) — just liveness. -->
        <span class="shrink-0 text-[11px] text-content-muted">{d.online ? "Idle" : "Offline"}</span>
      {:else}
        <!-- #705: access already granted on a machine you don't own → a calm,
             non-button success status (NOT a Request-access affordance), so it
             reads clearly distinct from the request flow. Liveness stays below. -->
        <span class="flex shrink-0 flex-col items-end gap-0.5 text-[11px]">
          <span
            class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold"
            style="background: color-mix(in srgb, var(--color-success) 14%, transparent); color: var(--color-success);"
          >
            <svg aria-hidden="true" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
            Access granted
          </span>
          <span class="text-content-muted">{d.online ? "Idle" : "Offline"}</span>
        </span>
      {/if}
    {:else}
      <!-- #705: a daemon the user can't access yet → request access (or show the
           disabled "Requested" state if a request is already pending). -->
      <RequestDaemonAccessButton {workspaceId} daemonId={d.id} daemonLabel={d.host} variant="card" />
    {/if}
  </div>
{/snippet}

<div class="mx-auto flex max-w-[var(--content-max)] flex-col gap-6 px-6 py-6">
  <!-- Header + launchpad -->
  <header class="flex flex-wrap items-end justify-between gap-4">
    <div>
      <h1 class="text-[22px] font-bold leading-tight text-content">Welcome back, {userName}</h1>
      <p class="mt-0.5 text-[13px] text-content-dim">
        {daemonsOnline} of {daemons.length} daemons online · {sessionsRunning} sessions running · {today()}
      </p>
    </div>
    <div class="flex items-center gap-2">
      <button
        type="button"
        onclick={() => workspaceId && (newSessionOpen = true)}
        class="rounded-md bg-accent px-3.5 py-2 text-[13px] font-semibold text-accent-foreground transition-colors hover:bg-accent-hover"
      >
        New session
      </button>
    </div>
  </header>

  <!-- Stats on top, with a range filter (default month) -->
  <section class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="text-[16px] font-bold text-content">{rangeHeading}</h2>
      <!-- range filter: minimal text toggles (active = accent) -->
      <div class="flex items-center gap-3 text-[12px]">
        {#each RANGE_OPTIONS as opt (opt.value)}
          <button
            type="button"
            onclick={() => (statsRange = opt.value)}
            class="transition-colors {statsRange === opt.value
              ? 'font-semibold text-accent'
              : 'text-content-muted hover:text-content'}"
          >
            {opt.label}
          </button>
        {/each}
      </div>
    </div>
    {#if statsLoading}
      <div class="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {#each Array(4) as _, i (i)}
          <div class="{cardCls} h-[72px] animate-pulse p-4"></div>
        {/each}
      </div>
    {:else}
      <div class="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {#each weekStats as s (s.label)}
          <div class="{cardCls} flex flex-col gap-1.5 p-4">
            <span class="text-[10px] font-bold uppercase tracking-wider text-content-muted">{s.label}</span>
            <span class="text-[24px] font-bold leading-none text-content">{s.value}</span>
          </div>
        {/each}
      </div>
      {#if !hasWeekData}
        <p class="text-[12px] text-content-muted">
          Collecting data — these fill in as your team runs sessions.
        </p>
      {/if}
    {/if}
  </section>

  <!-- Token activity (full-width GitHub-style heatmap) -->
  <section class="flex flex-col gap-3">
    <div class="{cardCls} flex flex-col gap-3 p-4">
      <h3 class="text-[13px] font-bold text-content">Token activity</h3>
      <div class="flex flex-col gap-1.5">
        <!-- month labels, aligned to week columns -->
        <div class="flex gap-1.5">
          <div class="w-[26px] shrink-0"></div>
          <div class="relative h-3 flex-1 text-[9px] text-content-muted">
            {#each monthLabels as m (m.col)}
              <span
                class="absolute top-0 leading-3"
                style="left: {(m.col / heatWeeks.length) * 100}%;"
              >{m.name}</span>
            {/each}
          </div>
        </div>
        <div class="flex gap-1.5">
          <div class="flex w-[26px] shrink-0 flex-col justify-between py-0.5 pr-1 text-[9px] text-content-muted">
            {#each dayLabels as d, i (i)}<span class="h-3 leading-3">{d}</span>{/each}
          </div>
          <div class="flex flex-1 gap-[3px]">
            {#each heatWeeks as week, w (w)}
              <div class="flex flex-1 flex-col gap-[3px]">
                {#each week as cell, d (d)}
                  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                  <!-- Intentionally focusable so keyboard users get the tooltip
                       (GitHub-style), with aria-label for screen readers. -->
                  <span
                    class="aspect-square w-full rounded-[2px]"
                    style="background: {heatColorFor(cell ? cell.value : null)};"
                    role={cell ? "img" : undefined}
                    tabindex={cell ? 0 : undefined}
                    aria-label={cell ? cellTooltip(cell) : undefined}
                    onmouseenter={cell ? (e) => showHeatTip(e, cell) : undefined}
                    onmouseleave={() => (heatTip = null)}
                    onfocus={cell ? (e) => showHeatTip(e, cell) : undefined}
                    onblur={() => (heatTip = null)}
                  ></span>
                {/each}
              </div>
            {/each}
          </div>
        </div>
        <!-- Less → More legend -->
        <div class="flex items-center justify-end gap-1 text-[9px] text-content-muted">
          <span>Less</span>
          {#each legendSwatches as swatch, i (i)}
            <span class="h-2.5 w-2.5 rounded-[2px]" style="background: {swatch};"></span>
          {/each}
          <span>More</span>
        </div>
      </div>
    </div>
  </section>

  <!-- Machines (capped preview + "see all" modal) -->
  <section class="flex flex-col gap-3">
    <h2 class="flex w-fit items-center gap-1.5 text-[16px] font-bold text-content">
      Machines
      <span class="text-[13px] font-medium text-content-muted">{daemons.length}</span>
    </h2>

    {#if daemons.length === 0}
      <div class="{cardCls} px-4 py-6 text-center text-[13px] text-content-muted">
        No daemons yet — each teammate's machine running a daemon shows up here.
      </div>
    {:else}
      <div class="grid grid-cols-1 gap-2 lg:grid-cols-2">
        {#each visibleDaemons as d (d.id)}
          {@render daemonCard(d)}
        {/each}
      </div>
      {#if hiddenCount > 0}
        <button
          type="button"
          onclick={() => (fleetModalOpen = true)}
          class="{cardCls} flex items-center justify-center gap-1.5 px-4 py-2.5 text-[13px] font-semibold text-content-dim transition-colors hover:bg-surface-hover hover:text-accent"
        >
          See all {daemons.length} machines
          <span class="rounded-full bg-content/10 px-1.5 py-px text-[11px] font-bold text-content-dim">+{hiddenCount}</span>
        </button>
      {/if}
    {/if}
  </section>

  <!-- Top agents (list below Fleet) -->
  <section class="flex flex-col gap-3">
    <h2 class="text-[16px] font-bold text-content">Top agents</h2>
    <div class="{cardCls} flex flex-col gap-3 p-4">
      {#if topAgents.length === 0}
        <div class="flex items-center justify-center py-6 text-center text-[12px] text-content-muted">
          No sessions yet this week.
        </div>
      {:else}
        <div class="flex flex-col gap-2.5">
          {#each topAgents as a, i (i)}
            <div class="flex items-center gap-2.5">
              {#if a.isCybo}
                <!-- Named cybo → its own profile avatar (image | emoji | initials
                     of its name), matching every other agent surface. -->
                <Avatar
                  name={a.name}
                  avatar={a.avatar}
                  width={20}
                  fontSize={9}
                  borderRadius={6}
                  class="shrink-0"
                />
              {:else}
                <!-- Generic dispatcher ("Agent") → keep the provider-tinted glyph. -->
                <span
                  class="flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px]"
                  style="background: color-mix(in srgb, {brand(a.provider)} 14%, transparent); color: {brand(a.provider)};"
                >
                  <ProviderIcon provider={a.provider} size={11} />
                </span>
              {/if}
              <span class="w-24 shrink-0 truncate text-[12px] font-medium text-content">{a.name}</span>
              <div class="h-2 flex-1 overflow-hidden rounded-full bg-content/5">
                <div class="h-full rounded-full" style="width: {(a.sessions / topMax) * 100}%; background: {brand(a.provider)};"></div>
              </div>
              <span class="w-8 shrink-0 text-right text-[12px] tabular-nums text-content-muted">{a.sessions}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </section>
</div>

<!-- Fleet "see all" modal — full daemon list (view only) + a shortcut to the
     daemons page. Clicking the Fleet heading still navigates there directly. -->
{#if fleetModalOpen}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) fleetModalOpen = false;
    }}
  >
    <div
      class="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-edge bg-surface shadow-xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby="machines-modal-title"
    >
      <header class="flex items-center justify-between border-b border-edge px-5 py-3.5">
        <div class="flex items-center gap-2">
          <h2 id="machines-modal-title" class="text-[15px] font-bold text-content">Machines</h2>
          <span class="text-[13px] font-medium text-content-muted">{daemons.length}</span>
        </div>
        <button
          type="button"
          onclick={() => (fleetModalOpen = false)}
          aria-label="Close"
          class="flex h-7 w-7 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </header>
      <div class="flex flex-col gap-2 overflow-y-auto p-4">
        {#each daemons as d (d.id)}
          {@render daemonCard(d)}
        {/each}
      </div>
      <footer class="border-t border-edge px-4 py-3">
        <button
          type="button"
          onclick={() => {
            fleetModalOpen = false;
            openFleet();
          }}
          class="flex w-full items-center justify-center gap-1.5 rounded-md bg-accent px-3.5 py-2 text-[13px] font-semibold text-accent-foreground transition-colors hover:bg-accent-hover"
        >
          Manage daemons
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
        </button>
      </footer>
    </div>
  </div>
{/if}

<!-- "New session" → provider-CLI session dialog (Terminal/Claude/Codex/…). -->
<CreateAgentDialog bind:open={newSessionOpen} />

<!-- Instant heatmap tooltip (fixed to the hovered cell; no native-title lag). -->
{#if heatTip}
  <div
    role="tooltip"
    class="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md bg-content px-2 py-1 text-[11px] font-medium text-surface shadow-lg"
    style="left: {heatTip.x}px; top: {heatTip.y - 6}px;"
  >
    {heatTip.text}
  </div>
{/if}
