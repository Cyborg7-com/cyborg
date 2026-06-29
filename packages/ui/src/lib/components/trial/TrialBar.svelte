<script lang="ts">
  import { licenseState } from "$lib/state/license.svelte.js";
  import {
    workspaceState,
    updateWorkspace,
  } from "$lib/state/app.svelte.js";
  import ActivateLicenseModal from "./ActivateLicenseModal.svelte";

  // Workspace-level off switch (settings.trialDismissed in workspaces.settings
  // jsonb). Persisted via cyborg:update_workspace — no migration needed.
  const dismissed = $derived(workspaceState.current?.settings?.trialDismissed === true);

  const phase = $derived(licenseState.phase);

  // Manual (comp / team-granted) access: the workspace was activated by the
  // Cyborg7 team, NOT by a self-serve subscription — there is nothing for the
  // member to activate, so the trial bar (and the paywall modal) must stay hidden
  // even if the underlying state ever surfaces as trialing/expired. Driven by the
  // server-computed intent (`contact_admin` = manual + active). (Today a manual
  // grant reports state "active" so the bar is already hidden via "active-plan";
  // this guard keeps the suppression robust regardless of the state shape.)
  const manualAccess = $derived(licenseState.intent?.action === "contact_admin");

  // The bar is for action-required states only: activate the license (trial /
  // expired) or fix a failed payment (paused). A healthy active subscription
  // ("active-plan") shows NOTHING — billing lives in settings, not the banner.
  const trialVisible = $derived(
    !dismissed &&
      !manualAccess &&
      (phase === "trial-active" || phase === "trial-ending" || phase === "expired"),
  );

  async function dismiss(): Promise<void> {
    if (!workspaceState.current) return;
    // update_workspace REPLACES the settings jsonb — spread the current value.
    const settings = { ...workspaceState.current.settings, trialDismissed: true };
    try {
      await updateWorkspace({ settings });
    } catch (err) {
      // Non-admins can't persist the workspace setting; the bar stays visible.
      console.warn(
        "TrialBar: failed to persist trialDismissed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const copy = $derived.by(() => {
    const days = licenseState.daysLeft;
    const d = `${days} day${days === 1 ? "" : "s"}`;
    switch (phase) {
      case "trial-active":
        return {
          accent: "var(--color-online, #3daa7c)",
          message: `You're on a free trial — ${d} left. Activate your license.`,
          cta: "Activate license",
        };
      case "trial-ending":
        return {
          accent: "var(--color-warning, #e8ab5a)",
          message: `Trial ending — ${d} left to activate before your agents pause.`,
          cta: "Activate now",
        };
      case "expired":
        return {
          accent: "var(--color-error, #e01e5a)",
          message: "Trial ended — activate your license to bring agents back online.",
          cta: "Activate license",
        };
      default:
        return null;
    }
  });
</script>

{#if trialVisible && copy}
  <div
    class="flex h-7 shrink-0 items-center gap-2 px-3 text-[12px] border-b border-edge-dim"
    style="background: color-mix(in srgb, {copy.accent} 10%, transparent); color: var(--color-content, currentColor);"
  >
    <span class="inline-block h-1.5 w-1.5 rounded-full" style="background: {copy.accent};"></span>
    <span class="truncate">{copy.message}</span>
    <button
      type="button"
      onclick={() => { licenseState.openModal(); }}
      class="ml-auto text-[11.5px] font-semibold hover:underline"
      style="color: {copy.accent};"
    >
      {copy.cta} →
    </button>
    <button
      type="button"
      onclick={dismiss}
      class="shrink-0 rounded p-0.5 text-content-muted hover:bg-edge hover:text-content"
      title="Dismiss for this workspace"
      aria-label="Dismiss trial bar"
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
    </button>
  </div>
{/if}

<ActivateLicenseModal bind:open={licenseState.modalOpen} />
