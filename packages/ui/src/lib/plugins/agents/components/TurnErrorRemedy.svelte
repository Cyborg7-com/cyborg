<script lang="ts">
  // Renders a turn-time agent error. When the daemon classified the failure as a
  // known provider gate (usage_gated / auth_invalid / expired / rate_limited), we
  // show the SAME polished remedy the SPAWN path shows (providerRemedy → "Add
  // usage" / "Reconnect with an API key") with WORKING actions, instead of the raw
  // `[System Error] 400 {…}` blob. The raw error stays available (expandable) for
  // debugging. For an unclassified error we fall back to the plain error block.
  //
  // Self-contained so AgentStreamView (and any other stream renderer) can drop it
  // in without owning the remedy/terminal wiring — mirrors runRemedyAction in
  // AgentsPane so the two paths behave identically.
  import { providerRemedy, type RemedyAction } from "$lib/provider-remedy.js";
  import type { ProviderReasonKind } from "$lib/plugins/agents/types.js";
  import { openExternalUrl } from "$lib/desktop-terminal.js";
  import SetupCyboTerminalDialog from "$lib/components/daemon/SetupCyboTerminalDialog.svelte";
  import { cn } from "$lib/utils.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";

  let {
    content,
    code,
    reasonKind = null,
    unavailableReason = null,
    provider,
    providerLabel,
    daemonLabel = "this daemon",
    onRecheck,
  }: {
    // The raw error text (kept for debugging — shown expanded).
    content: string;
    code?: string;
    reasonKind?: ProviderReasonKind | null;
    unavailableReason?: string | null;
    provider?: string;
    // Preferred display label for the provider (falls back to `provider`).
    providerLabel?: string;
    daemonLabel?: string;
    // Re-probe the agent's daemon providers (the "rate_limited" Re-check action).
    onRecheck?: () => void;
  } = $props();

  // Only the KNOWN gates get the polished remedy treatment; an "unknown" (or
  // absent) classification renders the plain raw error — never a misleading
  // "couldn't classify" remedy card for a generic crash.
  const isClassified = $derived(
    reasonKind === "usage_gated" ||
      reasonKind === "auth_invalid" ||
      reasonKind === "expired" ||
      reasonKind === "rate_limited" ||
      reasonKind === "not_configured",
  );

  const remedy = $derived(
    isClassified
      ? providerRemedy(reasonKind, providerLabel || provider || "this provider", unavailableReason)
      : null,
  );

  let setupTerminalOpen = $state(false);
  let rawExpanded = $state(false);

  function runRemedyAction(action: RemedyAction): void {
    switch (action.kind) {
      case "open_url":
        if (action.url) openExternalUrl(action.url);
        break;
      case "setup":
      case "reconnect":
      case "reconnect_api_key":
        setupTerminalOpen = true;
        break;
      case "recheck":
        onRecheck?.();
        break;
    }
  }
</script>

{#if remedy}
  <div
    class={cn(
      "bg-error/10 border border-error/20 text-content",
      viewportState.isMobile
        ? "mt-2 rounded-[12px] px-4 py-3.5"
        : "rounded-md px-4 py-3.5 ml-12",
    )}
  >
    <div class="flex items-start gap-2.5">
      <svg
        class="mt-0.5 h-4 w-4 shrink-0 text-error"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <div class="min-w-0 flex-1">
        <div class="text-sm font-semibold text-error">{remedy.title}</div>
        <p class="mt-0.5 text-[13px] leading-[19px] text-content-dim">{remedy.body}</p>

        <div class="mt-2.5 flex flex-wrap gap-2">
          {#each remedy.actions as action (action.label + action.kind)}
            <button
              type="button"
              onclick={() => runRemedyAction(action)}
              class={cn(
                "rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors",
                action === remedy.actions[0]
                  ? "bg-error text-white hover:bg-error/90"
                  : "border border-edge bg-surface text-content hover:bg-surface-alt",
              )}
            >
              {action.label}
            </button>
          {/each}
        </div>

        <button
          type="button"
          onclick={() => (rawExpanded = !rawExpanded)}
          class="mt-2.5 flex items-center gap-1 text-[11px] text-content-muted hover:text-content-dim transition-colors"
          aria-expanded={rawExpanded}
        >
          <svg
            class={cn("h-3 w-3 shrink-0 transition-transform", rawExpanded && "rotate-90")}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
          ><path d="M9 18l6-6-6-6" /></svg>
          {rawExpanded ? "Hide details" : "Show details"}
        </button>
        {#if rawExpanded}
          <pre class="mt-1.5 whitespace-pre-wrap break-words rounded bg-surface-alt px-2.5 py-2 font-mono text-[11px] leading-[16px] text-content-muted">{content}{#if code} ({code}){/if}</pre>
        {/if}
      </div>
    </div>
  </div>

  <SetupCyboTerminalDialog bind:open={setupTerminalOpen} {daemonLabel} onClosed={onRecheck} />
{:else}
  <!-- Unclassified failure: original plain error block (unchanged shape). -->
  <div
    class={cn(
      "bg-error/10 border border-error/20 text-error",
      viewportState.isMobile
        ? "mt-2 rounded-[12px] px-4 py-3 text-[14px] leading-[20px]"
        : "rounded-md px-4 py-3 text-sm ml-12",
    )}
  >
    {content}
    {#if code}
      <span class="ml-2 text-xs text-error/60">({code})</span>
    {/if}
  </div>
{/if}
