<script lang="ts">
  import {
    agentStreamState,
    daemonStatusState,
    workspaceState,
  } from "$lib/state/app.svelte.js";
  import type { Agent } from "$lib/plugins/agents/types.js";
  import type { TurnStatus } from "$lib/plugins/agents/state.svelte.js";
  import type { CuratedActivity } from "$lib/plugins/agents/activity-curator.js";

  // ── Props ──────────────────────────────────────────────────────────
  // wsId is accepted for parity with sibling tabs (and a future server-backed
  // feed would key on it); the client activity we render is scoped purely by
  // cyboId since workspaceState.agents already belongs to the current workspace.
  // eslint-disable-next-line no-unused-vars -- reserved for the server feed
  let { cyboId, wsId }: { cyboId: string; wsId: string } = $props();

  // ── Source of truth ────────────────────────────────────────────────
  // A cybo's "activity" is its work over time. The richest client-side signal
  // is its bound live sessions (workspaceState.agents scoped to this cybo),
  // each enriched from agentStreamState — the per-agent live timeline that the
  // agent view streams into. We project each session to a feed row carrying its
  // turn status, the curated "what it's doing right now" line, model + daemon.
  const boundSessions = $derived(
    workspaceState.agents.filter((a: Agent) => a.cyboId === cyboId),
  );

  // Loading: the roster hasn't settled yet (no agents loaded AND the workspace
  // is still resolving). Once the workspace is present we trust an empty list as
  // a real "no sessions" answer rather than spinning forever.
  const loading = $derived(
    workspaceState.agents.length === 0 && workspaceState.current == null,
  );

  type Tone = "active" | "error" | "idle";

  interface FeedRow {
    agentId: string;
    status: TurnStatus;
    tone: Tone;
    statusLabel: string;
    daemonOnline: boolean;
    model: string | null;
    activity: CuratedActivity | null;
  }

  function toneForStatus(status: TurnStatus, daemonOnline: boolean): Tone {
    if (status === "error") return "error";
    if (status === "running") return "active";
    return daemonOnline ? "idle" : "idle";
  }

  function statusLabel(status: TurnStatus, daemonOnline: boolean): string {
    if (status === "running") return "Working";
    if (status === "error") return "Error";
    if (status === "canceled") return "Canceled";
    return daemonOnline ? "Idle" : "Offline";
  }

  // Short model label (drop the provider/ prefix), matching the profile page.
  function modelLabel(model: string | null | undefined): string | null {
    if (!model) return null;
    return model.split("/").pop() ?? model;
  }

  // Build the feed. Reading getTurnStatus/getLastActivity/getModel inside the
  // $derived keeps this reactive — agentStreamState mutates its streams map on
  // every event, so the feed advances as sessions stream. Live (running) and
  // errored sessions float to the top; the rest keep roster order.
  const feed = $derived.by((): FeedRow[] => {
    const rows = boundSessions.map((a: Agent): FeedRow => {
      const status = agentStreamState.getTurnStatus(a.agentId);
      const daemonOnline = a.daemonId
        ? daemonStatusState.get(a.daemonId) === "online"
        : false;
      return {
        agentId: a.agentId,
        status,
        tone: toneForStatus(status, daemonOnline),
        statusLabel: statusLabel(status, daemonOnline),
        daemonOnline,
        model: modelLabel(agentStreamState.getModel(a.agentId) ?? a.model),
        activity: agentStreamState.getLastActivity(a.agentId),
      };
    });
    const rank = (r: FeedRow): number =>
      r.status === "running" ? 0 : r.status === "error" ? 1 : 2;
    return rows.sort((x, y) => rank(x) - rank(y));
  });

  // Tone → theme token (no raw hex; semantic colors, matching the profile pill).
  function toneColor(tone: Tone): string {
    if (tone === "active") return "var(--color-online, var(--color-success))";
    if (tone === "error") return "var(--color-error, var(--color-warning))";
    return "var(--text-muted)";
  }

  // Activity-kind → coarse icon tone label for the leading glyph.
  function kindGlyph(kind: CuratedActivity["kind"] | undefined): string {
    switch (kind) {
      case "Tool":
        return "tool";
      case "Error":
        return "error";
      case "Thought":
        return "thought";
      case "Tasks":
        return "tasks";
      default:
        return "message";
    }
  }
</script>

<div class="mb-4">
  <h2 class="text-[15px] font-bold tracking-[-0.01em] text-content">Activity</h2>
  <p class="mt-0.5 text-[12.5px] text-content-muted">
    A timeline of what this agent has done.
  </p>
</div>

{#if loading}
  <!-- Loading: skeleton rows matching the feed row shape. -->
  <div class="flex flex-col gap-2" aria-busy="true" aria-label="Loading activity">
    {#each [0, 1, 2] as i (i)}
      <div
        class="flex items-center gap-3 rounded-xl border border-edge-light bg-surface-alt px-4 py-3.5"
      >
        <span class="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-hover-gray"></span>
        <span class="flex min-w-0 flex-1 flex-col gap-1.5">
          <span class="h-3 w-1/3 animate-pulse rounded bg-hover-gray"></span>
          <span class="h-2.5 w-2/3 animate-pulse rounded bg-hover-gray"></span>
        </span>
      </div>
    {/each}
  </div>
{:else if feed.length === 0}
  <!-- Empty state — mirrors the profile page's `emptyState` snippet: centered
       accent medallion + confident title + restrained muted copy. -->
  <div
    class="flex flex-col items-center justify-center gap-4 rounded-xl border border-edge-light bg-surface-alt px-6 py-16 text-center"
  >
    <div
      class="flex h-14 w-14 items-center justify-center rounded-2xl"
      style="background: color-mix(in srgb, var(--agent-accent, var(--color-accent)) 10%, transparent); color: var(--agent-accent, var(--color-accent));"
    >
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
    </div>
    <div>
      <div class="text-[15px] font-semibold tracking-[-0.01em] text-content">
        No recent activity
      </div>
      <p class="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-content-muted">
        Session starts, turns, and tool calls for this agent will stream into
        this timeline.
      </p>
    </div>
  </div>
{:else}
  <!-- Feed: one row per bound live session, live-first. -->
  <ul class="flex flex-col gap-2">
    {#each feed as row (row.agentId)}
      {@const glyph = kindGlyph(row.activity?.kind)}
      <li>
        <div
          class="flex items-start gap-3 rounded-xl border border-edge-light bg-surface-alt px-4 py-3.5 shadow-[var(--shadow-divider)]"
        >
          <!-- Leading activity glyph, tinted by status tone. -->
          <span
            class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
            style="background: color-mix(in srgb, {toneColor(row.tone)} 12%, transparent); color: {toneColor(row.tone)};"
            aria-hidden="true"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              {#if glyph === "tool"}
                <path
                  d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.8 2.8-2-2 2.8-2.8z"
                />
              {:else if glyph === "error"}
                <circle cx="12" cy="12" r="9" /><line x1="12" y1="8" x2="12" y2="13" /><line
                  x1="12"
                  y1="16"
                  x2="12"
                  y2="16"
                />
              {:else if glyph === "thought"}
                <path d="M9 18h6M10 22h4" /><path
                  d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2V17h6v-.3c0-.8.4-1.5 1-2A7 7 0 0 0 12 2z"
                />
              {:else if glyph === "tasks"}
                <path d="M9 11l3 3L22 4" /><path
                  d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"
                />
              {:else}
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              {/if}
            </svg>
          </span>

          <div class="min-w-0 flex-1">
            <!-- Header row: status pill + model -->
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span
                class="inline-flex items-center gap-1.5 rounded-full px-2 py-[2px] text-[11px] font-bold uppercase tracking-[0.04em]"
                style="color: {toneColor(row.tone)}; background: color-mix(in srgb, {toneColor(row.tone)} 13%, transparent);"
              >
                <span
                  class="h-[6px] w-[6px] rounded-full bg-current"
                  class:animate-pulse={row.status === "running"}
                ></span>
                {row.statusLabel}
              </span>
              {#if row.model}
                <span
                  class="rounded bg-edge-dim px-1.5 py-[1px] font-mono text-[11px] text-content-dim"
                  >{row.model}</span
                >
              {/if}
            </div>

            <!-- Curated last-activity line (or a quiet fallback). -->
            {#if row.activity}
              <p class="mt-1.5 break-words text-[13px] leading-snug text-content-dim">
                <span class="font-semibold text-content">{row.activity.label}</span>
                <span class="text-content-muted/60" aria-hidden="true"> · </span>
                {row.activity.text}
              </p>
            {:else}
              <p class="mt-1.5 text-[13px] italic leading-snug text-content-muted">
                {row.status === "running"
                  ? "Starting up…"
                  : "No activity in this session yet."}
              </p>
            {/if}
          </div>
        </div>
      </li>
    {/each}
  </ul>
{/if}
