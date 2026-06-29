<script lang="ts">
  // Context-window / token-usage + cost meter for the agent composer (#580).
  // Backend-agnostic: fed by the agent stream's AgentUsage (turn_completed /
  // usage_updated). Shows % of context used (when the provider reports a max),
  // the token count, and the estimated spend — degrading to whatever subset the
  // provider gives. Renders NOTHING when there's no usage yet.
  import { cn } from "$lib/utils.js";
  import type { AgentUsage } from "../types.js";
  import {
    buildContextWindowView,
    contextWindowTooltip,
    formatCost,
    formatTokens,
  } from "../context-window.js";

  let { usage, compact = false }: { usage: AgentUsage | null; compact?: boolean } = $props();

  const view = $derived(buildContextWindowView(usage));
  const tooltip = $derived(view && usage ? contextWindowTooltip(usage, view) : "");
</script>

{#if view}
  <div
    class={cn(
      "flex shrink-0 items-center gap-1.5 rounded-full bg-raised text-content-dim tabular-nums",
      compact ? "h-[28px] px-3 text-[13px]" : "h-7 px-2.5 text-[11px]",
    )}
    title={tooltip}
    aria-label={tooltip.replace(/\n/g, " · ")}
    role="status"
  >
    {#if view.pct !== null}
      <!-- Tiny context-occupancy bar -->
      <span class="relative h-1 w-8 overflow-hidden rounded-full bg-content-muted/25" aria-hidden="true">
        <span
          class={cn(
            "absolute inset-y-0 left-0 rounded-full",
            view.level === "critical"
              ? "bg-error"
              : view.level === "high"
                ? "bg-warning"
                : "bg-content-muted",
          )}
          style="width: {view.pct}%"
        ></span>
      </span>
      <span
        class={cn(
          "font-medium",
          view.level === "critical" ? "text-error" : view.level === "high" ? "text-warning" : "",
        )}>{view.pct}%</span
      >
    {:else if view.usedTokens !== null}
      <span class="font-medium">{formatTokens(view.usedTokens)}</span>
      <span class="opacity-70">tok</span>
    {/if}

    {#if view.costUsd !== null}
      {#if view.pct !== null || view.usedTokens !== null}<span class="opacity-40">·</span>{/if}
      <span>{formatCost(view.costUsd)}</span>
    {/if}
  </div>
{/if}
