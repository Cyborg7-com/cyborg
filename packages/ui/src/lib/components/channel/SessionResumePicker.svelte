<script lang="ts">
  import { untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { cn } from "$lib/utils.js";
  import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
  } from "$lib/components/ui/dialog/index.js";
  import {
    resumePickerState,
    sessionState,
    fetchSessions,
    loadMoreSessions,
    restoreSession,
    fetchRecentProviderSessions,
    importProviderSession,
    workspaceState,
    channelState,
    cyboState,
  } from "$lib/state/app.svelte.js";
  import type {
    ArchivedSession,
    RecentSession,
    ResumeOverrides,
  } from "$lib/state/app.svelte.js";
  import { agentDisplayName as sharedAgentDisplayName } from "$lib/agent-display.js";
  import ArchivedSessionRow from "$lib/components/channel/ArchivedSessionRow.svelte";

  // /resume session picker (Phase 3 + Phase 4). One cohesive sheet with TWO tabs:
  //   • Cloud      — archived_sessions restored via restore_session. Works for
  //                  everyone (the relay fans the list out + routes the restore to
  //                  the owning daemon). Reuses the sidebar's ArchivedSessionRow.
  //   • Local import — on-disk provider transcripts (Claude only at launch)
  //                  scanned across ALL cwds (no cwd filter) and resumed via the
  //                  new cyborg:import_session RPC. Needs a reachable local daemon;
  //                  degrades to a clear hint when none is present.
  // CLIENT-only, like the /catchup digest — opened by intercepting /resume in the
  // composer; nothing here is a server round-trip beyond the existing RPCs.

  type Tab = "cloud" | "local";
  let tab = $state<Tab>("cloud");

  // Busy markers gate the row clicks so a double-pick can't fire two resumes.
  let restoringId = $state<string | null>(null);
  let importingHandle = $state<string | null>(null);
  // A resume that failed AFTER a pick (restore/import RPC error) — shown inline so
  // the user isn't left with a silently dead click.
  let pickerError = $state("");

  // Local tab is fetched LAZILY (only when first viewed) so a cloud-only session
  // never pays for a daemon round-trip on every /resume.
  type LocalStatus = "idle" | "loading" | "ready" | "error";
  let localStatus = $state<LocalStatus>("idle");
  let localSessions = $state<RecentSession[]>([]);
  let localError = $state("");

  // Refresh the cloud archived list each time the picker opens (the sidebar may
  // not have fetched it, or it's stale); reset transient state on close so a
  // re-open starts clean.
  $effect(() => {
    if (resumePickerState.open) {
      // fetchSessions handles its own errors (falls back to []) — never throws.
      void fetchSessions();
    } else {
      untrack(() => {
        tab = "cloud";
        restoringId = null;
        importingHandle = null;
        pickerError = "";
        localStatus = "idle";
        localSessions = [];
        localError = "";
      });
    }
  });

  // Scan local transcripts the first time the Local tab is shown for this open.
  $effect(() => {
    if (resumePickerState.open && tab === "local" && localStatus === "idle") {
      void loadLocal();
    }
  });

  // Date.parse can be NaN (a missing/malformed timestamp); coerce NaN — and an
  // absent value — to 0 so the newest-first sort stays stable instead of
  // shuffling rows around an invalid entry.
  function activityMs(s: RecentSession): number {
    const t = s.lastActivityAt ? Date.parse(s.lastActivityAt) : 0;
    return Number.isNaN(t) ? 0 : t;
  }

  async function loadLocal(): Promise<void> {
    if (localStatus === "loading") return;
    localStatus = "loading";
    localError = "";
    try {
      // No cwd filter — scan ALL working directories (Phase 4): a session captured
      // under a different path must still surface here.
      const entries = await fetchRecentProviderSessions({});
      localSessions = entries
        // Claude provider only at launch.
        .filter((s) => s.providerId === "claude")
        // Newest activity first (Phase 4) — NaN-safe so a bad timestamp can't
        // destabilize the order.
        .sort((a, b) => activityMs(b) - activityMs(a));
      localStatus = "ready";
    } catch (err) {
      // Surface, never swallow: in cloud-only mode there's no local daemon to
      // answer this Paseo-native scan, so it rejects — show the graceful hint.
      localError = err instanceof Error ? err.message : "Couldn't reach a local daemon.";
      localStatus = "error";
      console.debug("[SessionResumePicker] local provider session scan failed", err);
    }
  }

  // ─── Display helpers (cloud rows mirror the sidebar exactly) ──────────
  function sessionDisplayName(session: ArchivedSession): string {
    if (session.title) return session.title;
    // A cybo session reads "<Cybo> session", not "<provider> session".
    return `${sharedAgentDisplayName(session, cyboState.list)} session`;
  }

  function timeAgo(ms: number): string {
    // A malformed/missing timestamp parses to NaN — render "unknown" instead of
    // "NaNd ago".
    if (!Number.isFinite(ms)) return "unknown";
    const diff = Date.now() - ms;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }

  function localTitle(s: RecentSession): string {
    return s.title ?? s.lastPromptPreview ?? s.firstPromptPreview ?? "Untitled session";
  }

  // ─── Pick handlers ───────────────────────────────────────────────────
  function navigateToAgent(agentId: string): void {
    const wsId = workspaceState.current?.id;
    resumePickerState.close();
    if (!wsId) return;
    channelState.activeId = null;
    void goto(`/workspace/${wsId}/agent/${agentId}?from=session`);
  }

  async function handleRestore(
    session: ArchivedSession,
    overrides?: ResumeOverrides,
  ): Promise<void> {
    if (restoringId || importingHandle) return;
    pickerError = "";
    restoringId = session.id;
    try {
      const agentId = await restoreSession(session.id, overrides);
      navigateToAgent(agentId);
    } catch (err) {
      pickerError = err instanceof Error ? err.message : "Failed to restore session.";
      console.error("[SessionResumePicker] restore failed", err);
    } finally {
      restoringId = null;
    }
  }

  async function handleImport(s: RecentSession): Promise<void> {
    if (restoringId || importingHandle) return;
    pickerError = "";
    importingHandle = s.providerHandleId;
    try {
      const agentId = await importProviderSession({
        provider: s.providerId,
        providerHandleId: s.providerHandleId,
        cwd: s.cwd,
        channelId: resumePickerState.channelId ?? undefined,
      });
      navigateToAgent(agentId);
    } catch (err) {
      pickerError = err instanceof Error ? err.message : "Failed to import session.";
      console.error("[SessionResumePicker] import failed", err);
    } finally {
      importingHandle = null;
    }
  }

  const cloudSessions = $derived(sessionState.list);
</script>

<Dialog
  bind:open={resumePickerState.open}
  onOpenChange={(o) => {
    if (!o) resumePickerState.close();
  }}
>
  <DialogContent class="sm:max-w-[560px]" showCloseButton={true}>
    <DialogHeader>
      <DialogTitle>Resume a session</DialogTitle>
    </DialogHeader>

    <!-- Tab switch -->
    <div class="flex gap-1 rounded-lg bg-surface p-0.5" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={tab === "cloud"}
        onclick={() => (tab = "cloud")}
        class={cn(
          "flex-1 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors focus-ring",
          tab === "cloud"
            ? "bg-raised text-content shadow-sm"
            : "text-content-muted hover:text-content",
        )}
      >
        Cloud
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === "local"}
        onclick={() => (tab = "local")}
        class={cn(
          "flex-1 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors focus-ring",
          tab === "local"
            ? "bg-raised text-content shadow-sm"
            : "text-content-muted hover:text-content",
        )}
      >
        Local import
      </button>
    </div>

    {#if pickerError}
      <p class="text-[12px] text-error">{pickerError}</p>
    {/if}

    {#if tab === "cloud"}
      <!-- CLOUD: archived_sessions → restore_session (reuses ArchivedSessionRow). -->
      <div class="max-h-[52vh] overflow-y-auto">
        {#if cloudSessions.length === 0}
          <div class="py-8 text-center">
            <p class="text-[13px] text-content-muted">No archived sessions yet.</p>
            <p class="mt-1.5 text-[12px] text-content-dim">
              Sessions you archive show up here, re-resumable from any device.
            </p>
          </div>
        {:else}
          <div class="flex flex-col gap-0.5 py-1">
            {#each cloudSessions as session (session.id)}
              <ArchivedSessionRow
                {session}
                importing={restoringId === session.id}
                {timeAgo}
                displayName={sessionDisplayName}
                onRestore={handleRestore}
              />
            {/each}
            {#if sessionState.nextCursor}
              <button
                type="button"
                onclick={() => void loadMoreSessions()}
                disabled={sessionState.loadingMore}
                class="mt-1 w-full rounded-md py-1.5 text-[12px] text-content-muted hover:bg-surface hover:text-content transition-colors focus-ring disabled:opacity-50"
              >
                {sessionState.loadingMore ? "Loading…" : "Show more"}
              </button>
            {/if}
          </div>
        {/if}
      </div>
    {:else}
      <!-- LOCAL IMPORT: on-disk Claude transcripts → cyborg:import_session. -->
      <div class="max-h-[52vh] overflow-y-auto">
        {#if localStatus === "loading"}
          <div class="flex items-center gap-2 py-8 text-[13px] text-content-muted">
            <span
              class="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
            ></span>
            Scanning local sessions…
          </div>
        {:else if localStatus === "error"}
          <div class="py-8 text-center">
            <p class="text-[13px] text-content-muted">Couldn't scan local sessions.</p>
            {#if localError}
              <p class="mt-1.5 text-[12px] text-error">{localError}</p>
            {/if}
            <p class="mt-1.5 text-[12px] text-content-dim">
              Local import needs a running local daemon on this machine.
            </p>
            <button
              type="button"
              class="mt-3 text-[12px] underline text-content-muted hover:text-content focus-ring"
              onclick={() => void loadLocal()}
            >
              Try again
            </button>
          </div>
        {:else if localSessions.length === 0}
          <div class="py-8 text-center">
            <p class="text-[13px] text-content-muted">No local Claude sessions found.</p>
            <p class="mt-1.5 text-[12px] text-content-dim">
              Local import needs a running local daemon on this machine.
            </p>
          </div>
        {:else}
          <div class="flex flex-col gap-0.5 py-1">
            {#each localSessions as s (s.providerId + s.providerHandleId)}
              {@const busy = importingHandle === s.providerHandleId}
              <button
                type="button"
                disabled={!!importingHandle || !!restoringId}
                aria-busy={busy}
                onclick={() => void handleImport(s)}
                class={cn(
                  "group/local flex w-full flex-col gap-1 rounded-md px-3 py-2 text-left transition-colors focus-ring",
                  busy ? "cursor-wait bg-hover-gray" : "hover:bg-hover-gray",
                )}
              >
                <div class="flex items-center gap-2">
                  {#if busy}
                    <span
                      class="h-2 w-2 shrink-0 animate-spin rounded-full border border-content-muted border-t-transparent"
                    ></span>
                  {/if}
                  <span class="truncate flex-1 text-[14px] text-content">{localTitle(s)}</span>
                  <span class="shrink-0 text-[10px] tabular-nums text-content-dim">
                    {timeAgo(Date.parse(s.lastActivityAt))}
                  </span>
                </div>
                <div class="flex items-center gap-2 text-[11px] text-content-dim">
                  <span
                    class="shrink-0 rounded bg-surface px-1.5 py-0.5 font-medium text-content-muted"
                  >
                    {s.providerLabel}
                  </span>
                  <!-- Phase 4: surface the cwd plainly so a user recognizes work
                       captured under a different path. -->
                  <span class="truncate font-mono" title={s.cwd}>{s.cwd}</span>
                </div>
              </button>
            {/each}
          </div>
        {/if}

        <!-- Disk-only caveat + provider/daemon note (always shown on the local tab). -->
        <p class="mt-2 border-t border-edge pt-2 text-[11px] leading-snug text-content-dim">
          Claude only for now. Local import needs a running local daemon — only
          sessions whose transcript files are present on this machine can be resumed.
        </p>
      </div>
    {/if}
  </DialogContent>
</Dialog>
