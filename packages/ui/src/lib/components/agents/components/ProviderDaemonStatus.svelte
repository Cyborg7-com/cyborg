<script lang="ts">
  import type { Daemon } from "$lib/plugins/agents/types.js";
  import type { CyboCapability } from "$lib/cybo-capability.js";
  import {
    CYBO_CONFIGURED_TIP,
    CYBO_SETUP_CTA_LABEL,
    cyboSetupHref,
    daemonDisplayName,
  } from "$lib/cybo-capability.js";

  // Collapsed provider×daemon status (#443). The old layout printed one chip
  // per daemon per provider — with 7 daemons that's a wall of "needs setup on
  // 192.168.1.22" lines. Here: ONE summary line anchored on the daemon the
  // session will actually launch on (targetDaemonId), with the per-daemon
  // detail behind a toggle. `cap` already contains accessible daemons only
  // (#438 — daemonState.accessibleOnline upstream).
  let {
    cap,
    workspaceId,
    targetDaemonId = null,
  }: {
    cap: CyboCapability;
    workspaceId: string | undefined;
    targetDaemonId?: string | null;
  } = $props();

  let expanded = $state(false);

  // Target daemon first — its state is the headline; everything else is detail.
  function targetFirst(daemons: readonly Daemon[]): Daemon[] {
    return [...daemons].sort((a, b) =>
      a.id === targetDaemonId ? -1 : b.id === targetDaemonId ? 1 : 0,
    );
  }
  const configured = $derived(targetFirst(cap.configured));
  const needsSetup = $derived(targetFirst(cap.needsSetup));
  const total = $derived(configured.length + needsSetup.length);

  // The headline daemon: the launch target when it's in either bucket, else
  // the best available (configured beats needs-setup).
  const primary = $derived.by((): { daemon: Daemon; kind: "configured" | "needs-setup" } | null => {
    const t = targetDaemonId;
    if (t) {
      const c = configured.find((d) => d.id === t);
      if (c) return { daemon: c, kind: "configured" };
      const n = needsSetup.find((d) => d.id === t);
      if (n) return { daemon: n, kind: "needs-setup" };
    }
    if (configured.length > 0) return { daemon: configured[0], kind: "configured" };
    if (needsSetup.length > 0) return { daemon: needsSetup[0], kind: "needs-setup" };
    return null;
  });
  const restCount = $derived(total - (primary ? 1 : 0));
</script>

{#if primary}
  <div class="mt-1 px-1 text-[11px]">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      {#if primary.kind === "configured"}
        <span class="text-online" title={CYBO_CONFIGURED_TIP}>
          ✓ configured on {daemonDisplayName(primary.daemon)}
        </span>
      {:else}
        <span class="flex items-center gap-1 text-warning">
          ⚠ needs setup on {daemonDisplayName(primary.daemon)}
          {#if workspaceId}
            <a
              href={cyboSetupHref(workspaceId, primary.daemon.id)}
              title={CYBO_SETUP_CTA_LABEL}
              class="underline hover:opacity-80"
            >Set up →</a>
          {/if}
        </span>
      {/if}
      {#if restCount > 0}
        <button
          type="button"
          class="text-content-muted underline decoration-dotted hover:text-content"
          onclick={() => (expanded = !expanded)}
        >
          {expanded ? "hide" : `${restCount} more daemon${restCount === 1 ? "" : "s"}`}
        </button>
      {/if}
    </div>
    {#if expanded}
      <ul class="mt-1 flex flex-col gap-0.5 pl-3">
        {#each configured.filter((d) => d.id !== primary?.daemon.id) as d (d.id)}
          <li class="text-online" title={CYBO_CONFIGURED_TIP}>✓ {daemonDisplayName(d)}</li>
        {/each}
        {#each needsSetup.filter((d) => d.id !== primary?.daemon.id) as d (d.id)}
          <li class="flex items-center gap-1 text-warning">
            ⚠ {daemonDisplayName(d)}
            {#if workspaceId}
              <a
                href={cyboSetupHref(workspaceId, d.id)}
                title={CYBO_SETUP_CTA_LABEL}
                class="underline hover:opacity-80"
              >Set up →</a>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}
