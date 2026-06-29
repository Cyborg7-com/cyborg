<script lang="ts">
  // #705 (REQUEST → NOTIFY → APPROVE): the requester-side affordance for a daemon
  // they DON'T own and have no access to. Opens a small role picker (Viewer /
  // Operator / Admin from ROLE_PRESETS + ROLE_META) and calls
  // requestDaemonAccess(wsId, daemonId, scopesForRole(role)). Once a pending
  // request exists for this daemon (live via daemonAccessRequestsState), the
  // trigger collapses to a disabled "Requested" state.
  //
  // Reused by the Home Machines list, the fleet modal rows, and DaemonDetail —
  // pass `variant` to match the surrounding density.
  import { reportClientError } from "@cyborg7/observability/web";
  import { toast } from "svelte-sonner";
  import {
    client,
    authState,
    daemonAccessRequestsState,
  } from "$lib/state/app.svelte.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
  } from "$lib/components/ui/dialog/index.js";
  import {
    ROLE_ORDER,
    ROLE_META,
    scopesForRole,
    type DaemonRole,
  } from "$lib/daemon-scopes.js";

  let {
    workspaceId,
    daemonId,
    daemonLabel = "this daemon",
    variant = "card",
  }: {
    workspaceId: string | undefined;
    daemonId: string;
    daemonLabel?: string;
    // "card" — compact row/card surfaces (Home Machines list, fleet modal).
    // "section" — the larger DaemonDetail call-to-action.
    variant?: "card" | "section";
  } = $props();

  // Live pending-outgoing state: a request I already sent for this daemon → show
  // "Requested" (disabled), not a re-request affordance.
  const pending = $derived(
    daemonAccessRequestsState.hasPendingOutgoing(daemonId, authState.user?.id),
  );

  let pickerOpen = $state(false);
  let submitting = $state(false);

  async function submit(role: Exclude<DaemonRole, "custom">): Promise<void> {
    if (!workspaceId || submitting) return;
    submitting = true;
    try {
      const { request } = await client.requestDaemonAccess(
        workspaceId,
        daemonId,
        scopesForRole(role),
      );
      // Upsert immediately so the affordance flips to "Requested" without waiting
      // for the daemon_access_request_changed echo.
      daemonAccessRequestsState.upsert(request);
      pickerOpen = false;
      toast.success(`Access requested — ${daemonLabel}'s owner will be notified.`);
    } catch (err) {
      reportClientError({
        source: "RequestDaemonAccessButton.submit",
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : null,
        platform: "web",
      });
      toast.error("Couldn't send the access request. Try again.");
    } finally {
      submitting = false;
    }
  }
</script>

{#if pending}
  <!-- Pending outgoing request: disabled "Requested" pill, consistent across
       both surfaces. -->
  {#if variant === "section"}
    <Button variant="outline" size="sm" disabled>Requested</Button>
  {:else}
    <span
      class="shrink-0 rounded-md border border-edge bg-surface-alt px-2.5 py-1 text-[12px] font-medium text-content-muted"
    >
      Requested
    </span>
  {/if}
{:else if variant === "section"}
  <Button variant="outline" size="sm" disabled={!workspaceId} onclick={() => (pickerOpen = true)}>
    Request access
  </Button>
{:else}
  <button
    type="button"
    disabled={!workspaceId}
    onclick={() => (pickerOpen = true)}
    class="shrink-0 rounded-md border border-edge bg-surface-alt px-2.5 py-1 text-[12px] font-medium text-content transition-colors hover:bg-hover-gray hover:text-accent disabled:opacity-50"
  >
    Request access
  </button>
{/if}

<!-- Role picker — Viewer / Operator / Admin from the shared taxonomy. -->
<Dialog bind:open={pickerOpen}>
  <DialogContent class="mx-4 w-full max-w-sm gap-0 rounded-xl bg-raised p-5 shadow-xl">
    <DialogHeader>
      <DialogTitle class="text-base font-bold text-content">Request access</DialogTitle>
      <DialogDescription class="mt-1 text-sm text-content-dim">
        Choose how much access to ask for on <span class="font-medium text-content">{daemonLabel}</span>. The
        owner approves or denies your request.
      </DialogDescription>
    </DialogHeader>
    <div class="mt-4 flex flex-col gap-2">
      {#each ROLE_ORDER as role (role)}
        <button
          type="button"
          disabled={submitting}
          onclick={() => void submit(role)}
          class="flex flex-col items-start gap-0.5 rounded-lg border border-edge bg-surface-alt px-3 py-2.5 text-left transition-colors hover:border-accent/50 hover:bg-hover-gray disabled:opacity-50"
        >
          <span class="text-[13px] font-semibold text-content">{ROLE_META[role].label}</span>
          <span class="text-[11px] text-content-dim">{ROLE_META[role].blurb}</span>
        </button>
      {/each}
    </div>
    <button
      type="button"
      disabled={submitting}
      onclick={() => (pickerOpen = false)}
      class="mt-3 w-full rounded-xl border border-edge px-4 py-2 text-sm font-medium text-content-dim transition-colors hover:bg-surface-alt disabled:opacity-50"
    >
      Cancel
    </button>
  </DialogContent>
</Dialog>
