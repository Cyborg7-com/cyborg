<script lang="ts">
  import { cn } from "$lib/utils.js";
  import {
    providerState,
    fetchProviders,
    restoreSession,
    daemonStatusState,
  } from "$lib/state/app.svelte.js";
  import type { ArchivedSession, ResumeOverrides } from "$lib/state/app.svelte.js";
  import CombinedModelSelector from "$lib/components/agents/components/CombinedModelSelector.svelte";

  // One archived-session sidebar row (#593). The row click restores ON the
  // archived config (unchanged one-click behavior). An "options" affordance opens
  // a small popover where the user can pick a DIFFERENT model/mode before
  // restoring, so the resumed agent boots on the override instead of the stale
  // archived model — no restore-then-setModel round-trip. Defaulting to no
  // override keeps existing behavior identical when the user just clicks the row.
  let {
    session,
    importing,
    timeAgo,
    displayName,
    onRestore,
    layout = "desktop",
  }: {
    session: ArchivedSession;
    importing: boolean;
    timeAgo: (ms: number) => string;
    displayName: (s: ArchivedSession) => string;
    /**
     * Restore with optional overrides. Returns once the restore has been
     * dispatched (the parent owns navigation/importing bookkeeping).
     */
    onRestore: (session: ArchivedSession, overrides?: ResumeOverrides) => void | Promise<void>;
    layout?: "desktop" | "mobile";
  } = $props();

  let menuOpen = $state(false);
  let container: HTMLDivElement | undefined = $state();

  // The picker's selected model. Seeded to the archived model when the popover
  // opens (see toggleMenu) so the trigger reads the current value; choosing a
  // different one becomes the override. Starts null (popover is closed at init).
  let pickedModel = $state<string | null>(null);
  // Mode override is optional; null ⇒ keep archived. Surfaced only when the
  // chosen provider actually exposes modes (Claude etc.).
  let pickedModeId = $state<string | null>(null);

  // Providers for the archived session's owning daemon — modes/models come from
  // ProviderInfo. Fetch lazily when the options popover opens (and re-fetch if a
  // daemon-scoped catalog isn't cached yet).
  const daemonId = $derived(session.daemonId ?? undefined);
  const providers = $derived(providerState.forDaemon(daemonId));
  const provider = $derived(providers.find((p) => p.id === session.provider));
  const selectorProviders = $derived(provider ? [provider] : []);
  const availableModes = $derived(provider?.modes ?? []);

  function ensureProviders(): void {
    if (daemonId) {
      if (!providerState.byDaemon[daemonId]) void fetchProviders(daemonId);
    } else if (providerState.list.length === 0 && !providerState.loading) {
      void fetchProviders();
    }
  }

  // Self-heal: when the owning daemon comes online while the menu is open, fetch
  // its provider catalog (mirrors the AgentComposer pattern).
  $effect(() => {
    if (
      menuOpen &&
      daemonId &&
      daemonStatusState.get(daemonId) === "online" &&
      !providerState.byDaemon[daemonId] &&
      !providerState.loadingDaemons[daemonId]
    ) {
      void fetchProviders(daemonId);
    }
  });

  function toggleMenu(e: Event): void {
    e.stopPropagation();
    menuOpen = !menuOpen;
    if (menuOpen) {
      pickedModel = session.model;
      pickedModeId = null;
      ensureProviders();
    }
  }

  // Build the override payload from the picker. Only fields that DIFFER from the
  // archived config are sent — picking the same model as the archive sends no
  // override (identical to a plain row click).
  function buildOverrides(): ResumeOverrides | undefined {
    const overrides: ResumeOverrides = {};
    if (pickedModel && pickedModel !== session.model) overrides.model = pickedModel;
    if (pickedModeId) overrides.modeId = pickedModeId;
    return overrides.model !== undefined || overrides.modeId !== undefined ? overrides : undefined;
  }

  async function restoreWithOverrides(): Promise<void> {
    menuOpen = false;
    await onRestore(session, buildOverrides());
  }

  function handleWindowClick(ev: MouseEvent): void {
    if (!menuOpen) return;
    if (container && !container.contains(ev.target as Node)) menuOpen = false;
  }

  const isMobile = $derived(layout === "mobile");
</script>

<svelte:window onclick={handleWindowClick} />

<div class="relative" bind:this={container}>
  <div
    role="button"
    tabindex="0"
    aria-label={`Archived session ${displayName(session)}`}
    aria-busy={importing}
    class={cn(
      "group/session w-full flex items-center text-[15px]",
      isMobile
        ? "pressable-row gap-3 px-4 min-h-[48px]"
        : "gap-2.5 pl-4 pr-1.5 h-[32px] rounded-md transition-colors touch-target-row focus-ring",
      importing
        ? isMobile
          ? "cursor-wait bg-hover-gray"
          : "bg-[var(--sidebar-active)] text-[var(--sidebar-active-text)] font-semibold cursor-wait"
        : isMobile
          ? "cursor-pointer text-content"
          : "hover:bg-hover-gray text-sidebar-gray cursor-pointer",
    )}
    onclick={() => onRestore(session)}
    onkeydown={(e) => {
      // Only act when the row itself is focused — Enter/Space on a nested
      // control (the options button) must NOT bubble up and restore (#711 a11y
      // class). The inner button also stops propagation as a belt-and-braces.
      if (e.currentTarget === e.target && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        void onRestore(session);
      }
    }}
  >
    {#if importing}
      <div
        class={cn(
          "shrink-0 animate-spin rounded-full border-t-transparent",
          isMobile ? "h-2.5 w-2.5 border border-content-muted" : "h-2 w-2 border border-white",
        )}
      ></div>
    {:else}
      <span
        class={cn("shrink-0 rounded-full bg-content-muted", isMobile ? "h-2.5 w-2.5" : "h-2 w-2")}
        aria-hidden="true"
      ></span>
    {/if}
    <span class="truncate flex-1 text-left">{displayName(session)}</span>

    {#if !importing}
      <!-- Restore-with-options: pick a different model/mode before resuming. -->
      <button
        type="button"
        onclick={toggleMenu}
        onkeydown={(e) => e.stopPropagation()}
        class={cn(
          "shrink-0 flex h-6 w-6 items-center justify-center rounded text-content-muted transition-colors hover:bg-raised hover:text-content focus-ring",
          isMobile ? "opacity-100" : "opacity-0 group-hover/session:opacity-100",
          menuOpen && "opacity-100 text-content",
        )}
        aria-label="Restore with a different model"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title="Restore with a different model"
      >
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="1" /><circle cx="12" cy="5" r="1" /><circle cx="12" cy="19" r="1" />
        </svg>
      </button>
    {/if}

    <span
      class={cn(
        "shrink-0 tabular-nums",
        isMobile ? "text-[13px] text-content-muted" : "text-[10px] text-content-dim",
      )}
    >
      {timeAgo(session.archivedAt)}
    </span>
  </div>

  {#if menuOpen}
    <div
      class="absolute z-50 right-1.5 mt-1 w-[260px] rounded-lg border border-edge bg-raised shadow-lg p-2 top-full"
      role="menu"
    >
      <p class="px-1 pb-1.5 text-[11px] font-semibold text-content">Restore with…</p>

      <!-- Model -->
      <div class="flex items-center justify-between gap-2 px-1 py-1">
        <span class="text-[11px] text-content-muted">Model</span>
        <CombinedModelSelector
          providers={selectorProviders}
          value={pickedModel}
          loading={daemonId ? !!providerState.loadingDaemons?.[daemonId] : providerState.loading}
          align="right"
          placeholder={session.model ?? "model"}
          onSelect={(id) => {
            pickedModel = id;
          }}
        />
      </div>

      <!-- Mode (only when the provider exposes modes) -->
      {#if availableModes.length > 1}
        <div class="flex items-center justify-between gap-2 px-1 py-1">
          <span class="text-[11px] text-content-muted">Mode</span>
          <select
            class="h-7 max-w-[150px] rounded-2xl border border-edge bg-surface px-2 text-[11px] text-content-muted outline-none cursor-pointer hover:bg-hover-gray"
            value={pickedModeId ?? ""}
            onchange={(e) => {
              const v = (e.currentTarget as HTMLSelectElement).value;
              pickedModeId = v === "" ? null : v;
            }}
          >
            <option value="">Keep archived</option>
            {#each availableModes as mode (mode.id)}
              <option value={mode.id}>{mode.label}</option>
            {/each}
          </select>
        </div>
      {/if}

      <button
        type="button"
        onclick={restoreWithOverrides}
        class="mt-1.5 w-full rounded-md bg-accent px-2 py-1.5 text-[12px] font-medium text-accent-foreground transition-colors hover:opacity-90 focus-ring"
      >
        Restore
      </button>
    </div>
  {/if}
</div>
