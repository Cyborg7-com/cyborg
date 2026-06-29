<script lang="ts">
  import type { AgentPermissionRequest } from "$lib/types.js";
  import { respondToPermission } from "$lib/state/app.svelte.js";
  import ToolCallDetail from "./ToolCallDetail.svelte";
  import { cn } from "$lib/utils.js";

  let {
    agentId,
    request,
  }: {
    agentId: string;
    request: AgentPermissionRequest;
  } = $props();

  let expanded = $state(false);

  function handleAction(actionId: string, behavior: "allow" | "deny") {
    respondToPermission(agentId, request.id, {
      behavior,
      selectedActionId: actionId,
    });
  }

  function handleAllow() {
    respondToPermission(agentId, request.id, { behavior: "allow" });
  }

  function handleDeny() {
    respondToPermission(agentId, request.id, { behavior: "deny" });
  }

  function variantClasses(variant?: string): string {
    if (variant === "danger")
      return "bg-error/10 text-error border-error/30 hover:bg-error/20";
    if (variant === "secondary")
      return "bg-surface-alt text-content border-edge hover:bg-[var(--sidebar-hover)]";
    return "bg-btn-primary-bg text-btn-primary-text border-transparent hover:bg-btn-primary-hover";
  }
</script>

<div class="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 space-y-2">
  <div class="flex items-start gap-2">
    <span class="text-warning text-sm shrink-0 mt-0.5">?</span>
    <div class="flex-1 min-w-0">
      <div class="text-sm font-medium text-content">
        {request.title ?? request.name}
      </div>
      {#if request.description}
        <div class="text-xs text-content-muted mt-0.5">{request.description}</div>
      {/if}
      <div class="text-[10px] text-content-dim mt-1">
        {request.kind} &middot; {request.provider}
      </div>
    </div>
  </div>

  {#if request.detail}
    <div>
      <button
        onclick={() => (expanded = !expanded)}
        class="text-[10px] text-content-muted hover:text-content transition-colors"
      >
        {expanded ? "Hide details" : "Show details"}
      </button>
      {#if expanded}
        <div class="mt-1 border-l border-edge pl-3">
          <ToolCallDetail detail={request.detail} />
        </div>
      {/if}
    </div>
  {/if}

  <div class="flex items-center gap-2 pt-1">
    {#if request.actions && request.actions.length > 0}
      {#each request.actions as action}
        <button
          onclick={() => handleAction(action.id, action.behavior)}
          class={cn(
            "rounded px-3 py-1 text-xs font-medium border transition-colors",
            variantClasses(action.variant),
          )}
        >
          {action.label}
        </button>
      {/each}
    {:else}
      <button
        onclick={handleAllow}
        class="rounded px-3 py-1 text-xs font-medium bg-btn-primary-bg text-btn-primary-text hover:bg-btn-primary-hover transition-colors"
      >
        Allow
      </button>
      <button
        onclick={handleDeny}
        class="rounded px-3 py-1 text-xs font-medium bg-surface-alt text-content border border-edge hover:bg-[var(--sidebar-hover)] transition-colors"
      >
        Deny
      </button>
    {/if}
  </div>
</div>
