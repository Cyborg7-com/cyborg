<script lang="ts">
  import { untrack } from "svelte";
  import { workspaceState, client, cyboState, fetchCybos } from "$lib/state/app.svelte.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
  } from "$lib/components/ui/tooltip/index.js";
  import { toast } from "svelte-sonner";

  // Cybo Autonomy — Phase 1 (S2) UI: the per-cybo autonomy dial + the workspace
  // master switch. Effective agency in a channel is min(cyboLevel, channelCeiling);
  // the per-channel ceiling lands in a later slice, so this tab covers the per-cybo
  // half plus the workspace-wide on/off.
  const workspace = $derived(workspaceState.current);
  const wsId = $derived(workspace?.id ?? "");
  const myRole = $derived(workspace?.role ?? "viewer");
  const canEdit = $derived(myRole === "owner" || myRole === "admin");

  // The 4 public presets (mirror server cybo-types.ts AUTONOMY_PRESETS). The level
  // is the single dial users set; L2/L5 (advanced/swarm) are not surfaced here.
  const PRESETS = [
    { level: "L0", label: "Off", hint: "Never wakes on its own" },
    { level: "L1", label: "Mention-only", hint: "Replies only when @-mentioned" },
    { level: "L3", label: "Active", hint: "May speak when relevant" },
    { level: "L4", label: "Autonomous", hint: "Can self-initiate" },
  ] as const;

  // Null autonomy_level (un-migrated cybo) falls back from the deprecated
  // behavior_mode (responsive->L1, proactive->L3) — same mapping as the server.
  function levelOf(c: { autonomyLevel?: string | null; behaviorMode?: string }): string {
    if (c.autonomyLevel) return c.autonomyLevel;
    return c.behaviorMode === "proactive" ? "L3" : "L1";
  }

  let masterOn = $state(true);
  let masterLoading = $state(true);
  let savingId = $state<string | null>(null);

  const cybos = $derived(cyboState.list);

  // Per-cybo levels are only meaningful while the workspace master switch is ON:
  // master off ⇒ every cybo is effectively mention-only regardless of its saved
  // level, so the per-cybo dial is moot and we lock it. Derived (not an effect) so
  // the controls flip the instant the master switch or role changes.
  const controlsLive = $derived(canEdit && !masterLoading && masterOn);
  // Show the "turn on autonomy" tooltip only for an admin who could edit if the
  // master switch were on — viewers get the separate admins-only note instead.
  const lockedByMaster = $derived(canEdit && !masterLoading && !masterOn);

  // Load (and reload on workspace switch) the master switch + cybo roster. Using
  // $effect over onMount so a workspace that resolves AFTER mount still triggers
  // the fetch. We track only wsId; the body runs under untrack() so reading
  // cyboState.list / writing masterLoading can't re-trigger the effect.
  let loadedWsId: string | null = null;
  $effect(() => {
    const id = wsId;
    if (!id || id === loadedWsId) return;
    loadedWsId = id;
    masterLoading = true; // reset stale state from a prior workspace
    void untrack(() =>
      (async () => {
        // intentional: best-effort prefetch; the empty-state UI covers a miss.
        if (cyboState.list.length === 0 && !cyboState.loading) await fetchCybos().catch(() => {});
        try {
          const { enabled } = await client.getWorkspaceAutonomy(id);
          masterOn = enabled;
        } catch {
          masterOn = true;
        } finally {
          masterLoading = false;
        }
      })(),
    );
  });

  async function toggleMaster(next: boolean) {
    if (!wsId || !canEdit) return;
    const prev = masterOn;
    masterOn = next; // optimistic
    try {
      await client.setWorkspaceAutonomy(wsId, next);
    } catch (err) {
      masterOn = prev;
      toast.error(err instanceof Error ? err.message : "Couldn't update workspace autonomy");
    }
  }

  async function setLevel(cybo: (typeof cybos)[number], level: string) {
    if (!wsId || !canEdit || savingId) return;
    if (levelOf(cybo) === level) return;
    savingId = cybo.id;
    // Optimistic: reflect the new level in place so the buttons re-highlight.
    const target = cyboState.list.find((c) => c.id === cybo.id);
    const prev = target?.autonomyLevel ?? null;
    if (target) target.autonomyLevel = level;
    try {
      await client.updateCybo(wsId, cybo.id, { autonomyLevel: level });
    } catch (err) {
      if (target) target.autonomyLevel = prev;
      toast.error(err instanceof Error ? err.message : "Couldn't update the cybo's autonomy");
    } finally {
      savingId = null;
    }
  }
</script>

<div class="mx-auto flex max-w-2xl flex-col gap-6 p-4">
  <header class="flex flex-col gap-1">
    <h1 class="text-lg font-semibold text-content">Autonomy</h1>
    <p class="text-[13px] text-content-dim">
      How freely cybos act on their own. Each cybo's level is its disposition; a channel can
      cap it lower (effective = the lower of the two).
    </p>
  </header>

  <section class="rounded-xl border border-edge bg-surface-alt p-4">
    <div class="flex items-center justify-between gap-4">
      <div class="flex flex-col gap-0.5">
        <span class="text-sm font-medium text-content">Workspace autonomy</span>
        <span class="text-[12px] text-content-dim">
          Master switch. When off, no cybo wakes on its own anywhere in this workspace
          (mentions still work).
        </span>
      </div>
      <Switch
        checked={masterOn}
        disabled={!canEdit || masterLoading}
        onCheckedChange={toggleMaster}
        aria-label="Workspace autonomy"
      />
    </div>
  </section>

  <section class="flex flex-col gap-2">
    <div class="flex flex-col gap-1">
      <h2 class="text-[11px] font-semibold uppercase tracking-wide text-content-dim">Cybos</h2>
      <p class="text-[12px] text-content-dim">
        {#if !masterLoading && !masterOn}
          Workspace autonomy is off — every cybo stays mention-only here, whatever its saved
          level. Turn it on to let each cybo act at its own level.
        {:else}
          Each cybo acts at its own level. A channel can cap it lower — the effective level is
          the lower of the two.
        {/if}
      </p>
    </div>
    {#if cybos.length === 0}
      <div class="rounded-xl border border-edge bg-surface-alt p-4 text-[13px] text-content-dim italic">
        No cybos in this workspace yet.
      </div>
    {:else}
      <div class="flex flex-col gap-2">
        {#each cybos as cybo (cybo.id)}
          {@const current = levelOf(cybo)}
          <div class="flex flex-col gap-2.5 rounded-xl border border-edge bg-surface-alt p-3">
            <div class="flex items-center gap-2">
              <span class="truncate text-sm font-medium text-content">{cybo.name}</span>
              {#if cybo.slug}<span class="text-[12px] text-content-muted">@{cybo.slug}</span>{/if}
              {#if savingId === cybo.id}
                <span class="ml-auto text-[11px] text-content-dim">saving…</span>
              {/if}
            </div>
            {#if lockedByMaster}
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger>
                    {#snippet child({ props })}
                      <div {...props} class="w-fit">{@render levelControl(cybo, current)}</div>
                    {/snippet}
                  </TooltipTrigger>
                  <TooltipContent>Enable workspace autonomy to set per-cybo levels</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            {:else}
              {@render levelControl(cybo, current)}
            {/if}
          </div>
        {/each}
      </div>
    {/if}
    {#if !canEdit}
      <p class="text-[12px] text-content-dim italic">Only workspace admins can change autonomy.</p>
    {/if}
  </section>
</div>

<!-- Segmented control for a single cybo's autonomy level. Greyed + non-interactive
     when the controls aren't live (viewer, still loading, or master switch off). -->
{#snippet levelControl(cybo: (typeof cybos)[number], current: string)}
  <div
    role="group"
    aria-label="Autonomy level for {cybo.name}"
    class={[
      "inline-flex flex-wrap gap-0.5 rounded-lg border border-edge bg-surface p-0.5",
      !controlsLive && "opacity-55",
    ]}
  >
    {#each PRESETS as preset (preset.level)}
      {@const selected = current === preset.level}
      <button
        type="button"
        title={preset.hint}
        aria-pressed={selected}
        disabled={!controlsLive || savingId === cybo.id}
        onclick={() => setLevel(cybo, preset.level)}
        class={[
          "rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors disabled:pointer-events-none disabled:cursor-not-allowed",
          selected
            ? "bg-accent text-accent-foreground shadow-sm"
            : "text-content-dim hover:text-content",
        ]}
      >
        {preset.label}
      </button>
    {/each}
  </div>
{/snippet}
