<script lang="ts">
  import type { CyboReadiness } from "$lib/plugins/agents/types.js";

  // #636 — "created but unspawnable" guardrail. A cybo's creation is NEVER
  // blocked on provider/daemon state (it can change a second later); instead the
  // relay computes a readiness status and we surface a NON-blocking banner when a
  // cybo can't run anywhere yet. Only "needs-daemon" warrants an alarm:
  //   • ready   — a reachable daemon can run it → nothing to show.
  //   • created — indeterminate (native harness host-login unobservable, or only
  //               older daemons online) → stay quiet, don't false-alarm.
  //   • needs-daemon — committed fine, but nothing reachable can run it → THIS.
  let {
    readiness,
    workspaceId,
  }: {
    readiness: CyboReadiness | undefined;
    workspaceId: string | undefined;
  } = $props();
</script>

{#if readiness === "needs-daemon"}
  <!-- Plain container (no ARIA live-region role): it houses an interactive
       "Manage daemons" link, and a live region wrapping focusable content is an
       a11y anti-pattern (screen readers re-announce the whole container / mishandle
       focus). The warning colour + heading carry the meaning. -->
  <div class="rounded-lg border border-warning/20 bg-warning/10 px-4 py-3 text-sm text-warning">
    <p class="font-medium">Needs a daemon</p>
    <p class="mt-0.5 text-warning/90">
      This cybo was created, but no connected daemon can run its provider yet. Connect or set up a
      daemon and it'll become runnable — nothing else to fix here.
    </p>
    {#if workspaceId}
      <a
        href={`/workspace/${workspaceId}/daemons`}
        class="mt-2 inline-block font-medium underline underline-offset-2 hover:no-underline"
      >
        Manage daemons
      </a>
    {/if}
  </div>
{/if}
