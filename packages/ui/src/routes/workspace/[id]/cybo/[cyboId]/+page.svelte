<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { toast } from "svelte-sonner";
  import {
    cyboState,
    agentStreamState,
    daemonStatusState,
    daemonState,
    providerState,
    authState,
    workspaceState,
    spawnCybo,
    fetchCybo,
    fetchCybos,
  } from "$lib/state/app.svelte.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import { conversationTime } from "$lib/components/channel/ConversationRow.svelte";
  import ProviderIcon from "$lib/plugins/agents/components/ProviderIcon.svelte";
  import CyborgIcon from "$lib/components/CyborgIcon.svelte";
  import CyboTasksTab from "$lib/components/cybo/CyboTasksTab.svelte";
  import CyboCronTab from "$lib/components/cybo/CyboCronTab.svelte";
  import CyboActivityTab from "$lib/components/cybo/CyboActivityTab.svelte";
  import CyboMemoryTab from "$lib/components/cybo/CyboMemoryTab.svelte";
  import {
    Tabs,
    TabsList,
    TabsTrigger,
    TabsContent,
  } from "$lib/components/ui/tabs/index.js";
  import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    TooltipProvider,
  } from "$lib/components/ui/tooltip/index.js";
  import { resolveAvatarSource } from "$lib/utils.js";
  import {
    CYBO_CONFIGURED_TIP,
    CYBO_SETUP_CTA_LABEL,
    cyboBackendOf,
    cyboCapabilityFor,
    daemonDisplayName,
    isNativeHarnessCybo,
    nativeHarnessAvailable,
  } from "$lib/cybo-capability.js";
  import { isCyboRunnable } from "$lib/cybo-runnable.js";
  import type { Cybo } from "$lib/plugins/agents/types.js";

  // Route params. wsId prefers the live workspace, falling back to the URL (same
  // pattern as AgentsPane) so the page works before the workspace store settles.
  const wsId = $derived(workspaceState.current?.id ?? page.params.id ?? "");
  const cyboId = $derived(page.params.cyboId ?? "");

  // The cybo from the workspace roster (cyboState.list) — the same source
  // AgentsPane derives `myCybos` from. The list omits the full soul; we fetch the
  // single cybo below to enrich it.
  const cybo = $derived(cyboState.list.find((c) => c.id === cyboId));

  // Full soul.md (personality) — only the single-cybo fetch (fetch_cybo)
  // populates it; the roster carries just `soulExcerpt`. Loaded on mount / when
  // the id changes, so the Personality card shows the complete text.
  let fullSoul = $state<string | null>(null);
  let soulLoadedFor = $state<string | null>(null);
  $effect(() => {
    if (!wsId || !cyboId) return;
    // Refetch the roster if the cybo isn't present yet (deep-link / hard reload).
    if (!cybo && cyboState.list.length === 0 && !cyboState.loading) {
      void fetchCybos();
    }
    if (soulLoadedFor === cyboId) return;
    // Capture the id: cyboId is reactive, so reading it inside the async .then
    // would see the CURRENT cybo, letting a late response from a previous cybo
    // clobber fullSoul. Compare against the captured id instead.
    const currentCyboId = cyboId;
    soulLoadedFor = currentCyboId;
    fullSoul = null;
    fetchCybo(currentCyboId)
      .then((full) => {
        if (soulLoadedFor === currentCyboId) fullSoul = full?.soul ?? null;
        return;
      })
      // intentional: best-effort full-soul load; falls back to the roster's soulExcerpt.
      .catch(() => {});
  });

  // The soul text shown in the Personality card: the full fetched soul wins,
  // falling back to the roster excerpt while it loads / if the fetch fails.
  const soulText = $derived(fullSoul ?? cybo?.soul ?? cybo?.soulExcerpt ?? null);

  // ─── Live session signals (mirrors AgentsPane.cyboStatus/cyboBadge) ─────
  const agents = $derived(workspaceState.agents);
  const shownDaemonId = $derived(
    daemonState.selectedId ?? daemonState.effectiveId(authState.user?.id),
  );
  const shownDaemon = $derived(shownDaemonId ? daemonState.byId(shownDaemonId) : undefined);
  const onlineDaemons = $derived(
    daemonState.list.filter((d) => daemonStatusState.get(d.id) === "online").length,
  );
  const piProvider = $derived(providerState.list.find((p) => p.id === "pi"));
  const cyboRunnable = $derived(
    isCyboRunnable(onlineDaemons, piProvider?.available ?? false, false),
  );

  // Bound sessions for THIS cybo (real signal — used for the status pill + the
  // Sessions stat). A live session = a running turn or an online daemon.
  const boundSessions = $derived(agents.filter((a) => a.cyboId === cyboId));
  const liveSessionCount = $derived(
    boundSessions.filter(
      (a) =>
        agentStreamState.getTurnStatus(a.agentId) === "running" ||
        (a.daemonId ? daemonStatusState.get(a.daemonId) === "online" : false),
    ).length,
  );

  function cyboStatus(): "active" | "idle" | "none" {
    if (boundSessions.length === 0) return "none";
    return liveSessionCount > 0 ? "active" : "idle";
  }

  // Always-visible status pill — same taxonomy + tones as AgentsPane.cyboBadge so
  // the pill reads identically to the card the user clicked through from.
  type Badge = { label: string; tone: "active" | "idle" | "inactive"; tip: string };
  const badge = $derived.by((): Badge => {
    if (!cybo) return { label: "Unknown", tone: "inactive", tip: "Agent not found" };
    const s = cyboStatus();
    if (s === "active") return { label: "Active", tone: "active", tip: "A session is running" };
    if (s === "idle") {
      return { label: "Idle", tone: "idle", tip: "Has sessions, none active right now" };
    }
    if (isNativeHarnessCybo(cybo.provider)) {
      const shown = shownDaemon ? daemonDisplayName(shownDaemon) : "this daemon";
      if (nativeHarnessAvailable(cybo.provider, providerState.list)) {
        return { label: `Configured on ${shown}`, tone: "idle", tip: `${shown}: ${CYBO_CONFIGURED_TIP}.` };
      }
      return {
        label: "Needs setup",
        tone: "inactive",
        tip: `${CYBO_SETUP_CTA_LABEL}: ${shown} — ${cybo.provider} isn't connected there.`,
      };
    }
    if (!cyboRunnable) {
      return {
        label: "Inactive",
        tone: "inactive",
        tip: "No online daemon with the cybo runtime — start one to run this agent.",
      };
    }
    const backend = cyboBackendOf(cybo.provider, cybo.model ?? null);
    const cap = cyboCapabilityFor(backend ? [backend] : [], daemonState.accessibleOnline);
    if (cap.configured.length > 0) {
      const names = cap.configured.map(daemonDisplayName);
      const shown = names.slice(0, 2).join(", ") + (names.length > 2 ? ` +${names.length - 2}` : "");
      return { label: `Configured on ${shown}`, tone: "idle", tip: `${names.join(", ")}: ${CYBO_CONFIGURED_TIP}.` };
    }
    if (cap.needsSetup.length > 0 && cap.unknown.length === 0) {
      const names = cap.needsSetup.map(daemonDisplayName).join(", ");
      return {
        label: "Needs setup",
        tone: "inactive",
        tip: `${CYBO_SETUP_CTA_LABEL}: ${names} — the Cybo runtime has no credentials for ${backend ?? "any backend"} there.`,
      };
    }
    return { label: "Ready", tone: "idle", tip: "No sessions yet — Start chat to run it" };
  });

  // Tone → theme token (no raw hex; matches the app's semantic colors).
  function toneColor(tone: Badge["tone"]): string {
    if (tone === "active") return "var(--color-online, var(--color-success))";
    if (tone === "inactive") return "var(--color-warning)";
    return "var(--text-muted)";
  }

  // ─── Display helpers ────────────────────────────────────────────
  const avatarSource = $derived(
    cybo ? resolveAvatarSource(cybo.avatar, cybo.name) : null,
  );

  // Short model label (drop the provider/ prefix), e.g. claude/sonnet → sonnet.
  const modelLabel = $derived(
    cybo?.model ? (cybo.model.split("/").pop() ?? cybo.model) : null,
  );

  // Human behavior-mode label (e.g. "autonomous" → "Autonomous").
  function titleCase(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  const behaviorLabel = $derived(cybo?.behaviorMode ? titleCase(cybo.behaviorMode) : null);

  function fmtDate(ms: number | null | undefined): string {
    if (!ms || Number.isNaN(ms)) return "—";
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" });
  }

  function fmtSpendCap(cap: number | null | undefined): string {
    if (cap === null || cap === undefined) return "No limit";
    return `$${cap.toLocaleString()}/mo`;
  }

  // Stat aggregates from the cybo's bound sessions + workspace tasks.
  // Tokens = sum of input+output across the cybo's live sessions. Tasks = tasks
  // this cybo created (createdBy ∈ {cyboId, its session agentIds} — same link the
  // Tasks tab uses). "Last active" = cybo.lastActiveAt, a SERVER-computed epoch-ms
  // value (max(agent_sessions.updated_at) for this cybo, from the PG/relay path).
  // Unlike the old client-local dmActivityState signal it survives device/login
  // changes and reflects real session activity. Absent on the SQLite-only daemon
  // path and on older relays / cybos with no sessions → renders "—".
  const totalTokens = $derived(
    boundSessions.reduce((n, a) => n + (a.inputTokens ?? 0) + (a.outputTokens ?? 0), 0),
  );
  const cyboCreatorIds = $derived(
    new Set<string>([cyboId, ...boundSessions.map((a) => a.agentId)]),
  );
  const cyboTaskCount = $derived(
    workspaceState.tasks.filter((t) => cyboCreatorIds.has(t.createdBy)).length,
  );
  function fmtCount(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + "k";
    return String(n);
  }
  const stats = $derived([
    { label: "Sessions", value: boundSessions.length > 0 ? String(boundSessions.length) : "—" },
    { label: "Tokens used", value: totalTokens > 0 ? fmtCount(totalTokens) : "—" },
    { label: "Tasks", value: cyboTaskCount > 0 ? String(cyboTaskCount) : "—" },
    {
      label: "Last active",
      // Server-supplied epoch ms. null/undefined (no sessions, SQLite path, or
      // an older relay that doesn't send the field) → "—".
      value: cybo?.lastActiveAt ? (conversationTime(cybo.lastActiveAt) ?? "—") : "—",
    },
  ]);

  // ─── Navigation / actions (same targets as AgentsPane) ──────────
  let activeTab = $state("overview");
  let spawning = $state(false);

  function handleBack(): void {
    if (!wsId) return;
    // Back to the Agents pane the card lives on.
    goto(`/workspace/${wsId}/agents`);
  }

  function handleEdit(): void {
    if (!wsId || !cybo) return;
    goto(`/workspace/${wsId}/agent/new?edit=${cybo.id}`);
  }

  async function handleStartChat(): Promise<void> {
    if (!wsId || !cybo || spawning) return;
    spawning = true;
    try {
      const isLocalCybo = cybo.isLocal || cybo.id.startsWith("local:");
      const homeDaemonId = isLocalCybo ? (cybo.daemonId ?? undefined) : undefined;
      const targetDaemonId = homeDaemonId ?? shownDaemonId ?? undefined;
      const agentId = await spawnCybo(cybo.slug || cybo.id, undefined, {
        daemonId: targetDaemonId,
      });
      goto(`/workspace/${wsId}/agent/${agentId}?cybo=${encodeURIComponent(cybo.id)}`);
    } catch (err) {
      // catch: surface the failure to the user; the AgentsPane card owns the
      // richer auto-heal/remedy flow, this page keeps a plain honest error.
      toast.error(err instanceof Error ? err.message : "Failed to start chat");
    } finally {
      spawning = false;
    }
  }

  const TABS: { value: string; label: string }[] = [
    { value: "overview", label: "Overview" },
    { value: "tasks", label: "Tasks" },
    { value: "cron", label: "Cron" },
    { value: "activity", label: "Activity" },
    { value: "memory", label: "Memory" },
  ];
</script>

<!-- Back chevron used by both the not-found and main views. -->
{#snippet backButton()}
  <button
    type="button"
    onclick={handleBack}
    aria-label="Back to agents"
    class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-content-dim transition-colors hover:bg-hover-gray hover:text-content focus-ring"
  >
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
  </button>
{/snippet}

<!-- Refined section-card shell: surface + hairline border + radius + a soft
     1px elevation, with a consistent header treatment (small-caps eyebrow header
     baked into the card top) so every Overview card reads as one family. -->
{#snippet sectionHeader(title: string, onEdit?: () => void)}
  <div class="flex items-center justify-between gap-2 px-5 pt-4 pb-3">
    <h2 class="text-[11px] font-semibold uppercase tracking-[0.08em] text-content-dim">{title}</h2>
    {#if onEdit}
      <button
        type="button"
        onclick={onEdit}
        title="Edit in the full editor"
        aria-label={`Edit ${title.toLowerCase()}`}
        class="focus-ring -mr-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-hover-gray hover:text-content"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>
      </button>
    {/if}
  </div>
{/snippet}

{#if !cybo}
  <!-- Not found: the cyboId isn't in the workspace roster. -->
  <div class="flex h-full flex-col">
    <div class="flex items-center gap-2 border-b border-edge-dim px-4 py-3">
      {@render backButton()}
    </div>
    <div class="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      <div
        class="flex h-14 w-14 items-center justify-center rounded-2xl"
        style="background: color-mix(in srgb, var(--agent-accent, #6366f1) 10%, transparent); color: var(--agent-accent, #6366f1);"
      >
        <CyborgIcon size={24} class="text-current" />
      </div>
      <div>
        <div class="text-[16px] font-semibold tracking-[-0.01em] text-content">Agent not found</div>
        <p class="mt-1 text-[13px] text-content-muted">
          {cyboState.loading ? "Loading agents…" : "This agent doesn't exist or was removed from the workspace."}
        </p>
      </div>
      <button
        type="button"
        onclick={handleBack}
        class="mt-1 inline-flex items-center gap-1.5 rounded-md border border-edge bg-surface-alt px-3 py-1.5 text-[13px] font-medium text-content transition-colors hover:bg-hover-gray"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
        Back to agents
      </button>
    </div>
  </div>
{:else}
  <div class="flex h-full flex-col overflow-y-auto">
    <!-- ── Hero header ── a restrained accent wash behind the identity block;
         the avatar carries a ring + soft shadow to feel like a real portrait,
         and the name uses Outfit (the app's display face) for a confident,
         premium headline. -->
    <div class="relative border-b border-edge-dim">
      <div
        class="pointer-events-none absolute inset-x-0 top-0 h-36"
        style="background: linear-gradient(180deg, color-mix(in srgb, var(--agent-accent, #6366f1) 10%, transparent), transparent);"
        aria-hidden="true"
      ></div>
      <div class="relative mx-auto w-full max-w-3xl px-4 pt-4 pb-8 sm:px-6">
        <div class="mb-4 flex items-center gap-2">
          {@render backButton()}
        </div>

        <div class={viewportState.isMobile ? "flex flex-col gap-5" : "flex items-start gap-5"}>
          <!-- Large avatar — refined radius, a subtle ring + lift so it reads as
               a portrait, not a flat tile. -->
          {#if avatarSource?.kind === "image"}
            <img
              src={avatarSource.value}
              alt={cybo.name}
              class="h-[72px] w-[72px] shrink-0 rounded-[20px] object-cover shadow-[var(--shadow-divider)] ring-1 ring-edge sm:h-24 sm:w-24"
              style="--tw-ring-offset-color: var(--avatar-ring);"
            />
          {:else if avatarSource?.kind === "emoji"}
            <div class="flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-[20px] bg-surface-alt text-[36px] leading-none shadow-[var(--shadow-divider)] ring-1 ring-edge sm:h-24 sm:w-24 sm:text-[46px]">
              <span aria-hidden="true">{avatarSource.value}</span>
            </div>
          {:else}
            <div
              class="flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-[20px] shadow-[var(--shadow-divider)] ring-1 ring-black/5 sm:h-24 sm:w-24"
              style="background: linear-gradient(135deg, var(--agent-accent, #6366f1), #5BB5F0);"
            >
              <CyborgIcon size={38} class="text-accent-foreground" />
            </div>
          {/if}

          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <h1 class="truncate font-outfit text-[26px] font-bold leading-[1.1] tracking-[-0.02em] text-content sm:text-[32px]">{cybo.name}</h1>
              <!-- Live status pill -->
              <TooltipProvider delayDuration={150}>
                <Tooltip>
                  <TooltipTrigger>
                    {#snippet child({ props })}
                      <span
                        {...props}
                        class="inline-flex cursor-help items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[11px] font-bold uppercase tracking-[0.04em]"
                        style="color: {toneColor(badge.tone)}; background: color-mix(in srgb, {toneColor(badge.tone)} 13%, transparent);"
                      >
                        <span class="h-[6px] w-[6px] rounded-full bg-current"></span>
                        {badge.label}
                      </span>
                    {/snippet}
                  </TooltipTrigger>
                  <TooltipContent>{badge.tip}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>

            <div class="mt-1 text-[13.5px] font-semibold text-accent">@{cybo.slug}</div>

            {#if cybo.role || cybo.description}
              <p class="mt-2 text-[13.5px] leading-relaxed text-content-dim">{cybo.role ?? cybo.description}</p>
            {/if}

            <!-- Compact meta row: provider/model · daemon · behavior mode -->
            <div class="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[12.5px] text-content-dim">
              <span class="inline-flex items-center gap-1.5">
                <ProviderIcon provider={cybo.provider} size={14} class="text-content-dim" />
                <span class="capitalize text-content-dim">{cybo.provider}</span>
                {#if modelLabel}<span class="rounded bg-edge-dim px-1.5 py-[1px] font-mono text-[11.5px] text-content-dim">{modelLabel}</span>{/if}
              </span>
              {#if badge.label.startsWith("Configured on")}
                <span class="text-content-muted/50" aria-hidden="true">·</span>
                <span>{badge.label}</span>
              {/if}
              {#if behaviorLabel}
                <span class="text-content-muted/50" aria-hidden="true">·</span>
                <span>{behaviorLabel}</span>
              {/if}
            </div>
          </div>

          <!-- Primary actions -->
          <div class={viewportState.isMobile ? "flex w-full items-center gap-2" : "flex shrink-0 items-center gap-2 self-start"}>
            <button
              type="button"
              onclick={handleStartChat}
              aria-disabled={spawning}
              class="inline-flex items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-[13px] font-semibold shadow-[var(--shadow-divider)] transition-opacity hover:opacity-90 disabled:cursor-wait focus-ring"
              class:flex-1={viewportState.isMobile}
              style="background: var(--agent-accent, #6366f1); color: var(--btn-primary-text, #fff); opacity: {spawning ? 0.6 : 1};"
              disabled={spawning}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 8.6 8.6 0 0 1-3.9-.9L3 21l1.9-5.6A8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z" /></svg>
              {spawning ? "Starting…" : "Start chat"}
            </button>
            <button
              type="button"
              onclick={handleEdit}
              aria-label="Edit {cybo.name}"
              class="inline-flex items-center justify-center gap-1.5 rounded-lg border border-edge bg-surface-alt px-4 py-2 text-[13px] font-medium text-content transition-colors hover:bg-hover-gray focus-ring"
              class:flex-1={viewportState.isMobile}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></svg>
              Edit
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <!-- ── Stat strip ── refined cards: a confident tabular number, a quiet
           small-caps label, on the app's raised surface with a hairline border. -->
      <div class="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {#each stats as stat (stat.label)}
          <div class="rounded-xl border border-edge-light bg-surface-alt px-4 py-3.5 shadow-[var(--shadow-divider)]">
            <div class="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-content-dim">{stat.label}</div>
            <div
              class="mt-1.5 text-[26px] font-bold leading-none tracking-[-0.02em] tabular-nums {stat.value === '—' ? 'text-content-muted' : 'text-content'}"
            >{stat.value}</div>
          </div>
        {/each}
      </div>

      <!-- ── Tabs ── -->
      <Tabs bind:value={activeTab} class="mt-8">
        <TabsList class="grid w-full grid-cols-5">
          {#each TABS as tab (tab.value)}
            <TabsTrigger
              value={tab.value}
              class="rounded-md px-3 py-1.5 text-[13px] font-medium text-content-dim transition-colors hover:text-content data-[state=active]:bg-surface data-[state=active]:text-accent data-[state=active]:font-semibold data-[state=active]:shadow-[var(--shadow-divider)]"
            >{tab.label}</TabsTrigger>
          {/each}
        </TabsList>

        <!-- Overview -->
        <TabsContent value="overview" class="mt-6 space-y-6">
          <!-- Personality -->
          <section class="overflow-hidden rounded-xl border border-edge-light bg-surface-alt shadow-[var(--shadow-divider)]">
            {@render sectionHeader("Personality", handleEdit)}
            <div class="px-5 pb-5">
              {#if soulText}
                <p class="whitespace-pre-wrap text-[13.5px] leading-relaxed text-content-dim">{soulText}</p>
              {:else}
                <p class="text-[13px] italic text-content-muted">No personality defined for this agent.</p>
              {/if}
            </div>
          </section>

          <!-- Capabilities — refined, de-emphasized chips: hairline outline,
               provider-neutral, lowercase mono so a raw permission slug reads as
               a precise technical token rather than a cheap gray tag. -->
          <section class="overflow-hidden rounded-xl border border-edge-light bg-surface-alt shadow-[var(--shadow-divider)]">
            {@render sectionHeader("Capabilities", handleEdit)}
            <div class="space-y-4 px-5 pb-5">
              <div>
                <div class="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-content-dim">Platform</div>
                {#if (cybo.platformPermissions?.length ?? 0) > 0}
                  <div class="flex flex-wrap gap-1.5">
                    {#each cybo.platformPermissions ?? [] as perm (perm)}
                      <span class="inline-flex items-center rounded-md border border-edge-light bg-surface px-2 py-[3px] font-mono text-[11.5px] tracking-tight text-content-dim">{perm}</span>
                    {/each}
                  </div>
                {:else}
                  <p class="text-[12.5px] text-content-muted">No platform permissions granted.</p>
                {/if}
              </div>
              <div>
                <div class="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-content-dim">Off-platform</div>
                <!-- Placeholder: off-platform permissions aren't on the Cybo shape
                     yet; the structure is here for the later data pass. -->
                <p class="text-[12.5px] text-content-muted">No off-platform integrations connected.</p>
              </div>
            </div>
          </section>

          <!-- Configuration — a refined key/value list, not a settings dump:
               quiet muted keys on the left, confident values on the right, with
               inset hairline dividers and a comfortable row rhythm. -->
          <section class="overflow-hidden rounded-xl border border-edge-light bg-surface-alt shadow-[var(--shadow-divider)]">
            {@render sectionHeader("Configuration", handleEdit)}
            <div class="px-5 pb-2">
              <dl class="divide-y divide-edge-dim">
                <div class="flex items-center justify-between py-3">
                  <dt class="text-[12.5px] text-content-dim">Provider</dt>
                  <dd class="inline-flex items-center gap-1.5 text-[13px] font-medium capitalize text-content">
                    <ProviderIcon provider={cybo.provider} size={14} class="text-content-dim" />
                    {cybo.provider}
                  </dd>
                </div>
                <div class="flex items-center justify-between py-3">
                  <dt class="text-[12.5px] text-content-dim">Model</dt>
                  <dd class="font-mono text-[12.5px] text-content">{cybo.model ?? "Default"}</dd>
                </div>
                <div class="flex items-center justify-between py-3">
                  <dt class="text-[12.5px] text-content-dim">Behavior mode</dt>
                  <dd class="text-[13px] font-medium text-content">{behaviorLabel ?? "—"}</dd>
                </div>
                <div class="flex items-center justify-between py-3">
                  <dt class="text-[12.5px] text-content-dim">Monthly spend cap</dt>
                  <dd class="text-[13px] font-medium text-content">{fmtSpendCap(cybo.monthlySpendCap)}</dd>
                </div>
                <div class="flex items-center justify-between py-3">
                  <dt class="text-[12.5px] text-content-dim">Daemon</dt>
                  <dd class="text-[13px] font-medium text-content">
                    {shownDaemon ? daemonDisplayName(shownDaemon) : "—"}
                  </dd>
                </div>
                <div class="flex items-center justify-between py-3">
                  <dt class="text-[12.5px] text-content-dim">Home daemon</dt>
                  <dd class="text-[13px] font-medium text-content">
                    {#if cybo.homeDaemonId}
                      {@const home = daemonState.byId(cybo.homeDaemonId)}
                      {home ? daemonDisplayName(home) : cybo.homeDaemonId}
                    {:else}
                      <span class="text-content-dim">Auto (sponsor daemon)</span>
                    {/if}
                  </dd>
                </div>
                <div class="flex items-center justify-between py-3">
                  <dt class="text-[12.5px] text-content-dim">Created</dt>
                  <dd class="text-[13px] text-content-dim">{fmtDate(cybo.createdAt)}</dd>
                </div>
              </dl>
            </div>
          </section>
        </TabsContent>

        <!-- Tasks -->
        <TabsContent value="tasks" class="mt-6">
          <div class="mb-4">
            <h2 class="text-[15px] font-bold tracking-[-0.01em] text-content">Tasks</h2>
            <p class="mt-0.5 text-[12.5px] text-content-muted">One-off jobs assigned to this agent.</p>
          </div>
          <CyboTasksTab {cyboId} {wsId} />
        </TabsContent>

        <!-- Cron -->
        <TabsContent value="cron" class="mt-6">
          <div class="mb-4">
            <h2 class="text-[15px] font-bold tracking-[-0.01em] text-content">Scheduled jobs</h2>
            <p class="mt-0.5 text-[12.5px] text-content-muted">Recurring runs on a cron schedule.</p>
          </div>
          <CyboCronTab {cyboId} {wsId} />
        </TabsContent>

        <!-- Activity -->
        <TabsContent value="activity" class="mt-6">
          <div class="mb-4">
            <h2 class="text-[15px] font-bold tracking-[-0.01em] text-content">Activity</h2>
            <p class="mt-0.5 text-[12.5px] text-content-muted">A timeline of what this agent has done.</p>
          </div>
          <CyboActivityTab {cyboId} {wsId} />
        </TabsContent>

        <!-- Memory -->
        <TabsContent value="memory" class="mt-6">
          <div class="mb-4">
            <h2 class="text-[15px] font-bold tracking-[-0.01em] text-content">Memory</h2>
            <p class="mt-0.5 text-[12.5px] text-content-muted">What this agent remembers across sessions.</p>
          </div>
          <CyboMemoryTab {cyboId} {wsId} />
        </TabsContent>
      </Tabs>
    </div>
  </div>
{/if}
