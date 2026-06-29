<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { reportClientError } from "@cyborg7/observability/web";
  import {
    workspaceState,
    daemonState,
    client,
    authState,
    daemonAccessRequestsState,
  } from "$lib/state/app.svelte.js";
  import type { Agent, ProviderInfo } from "$lib/plugins/agents/types.js";
  import { cn } from "$lib/utils.js";
  import ProviderIcon from "$lib/plugins/agents/components/ProviderIcon.svelte";
  import CyborgIcon from "$lib/components/CyborgIcon.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import SetupCyboTerminalDialog from "$lib/components/daemon/SetupCyboTerminalDialog.svelte";
  import SessionList from "$lib/components/daemon/SessionList.svelte";
  import RequestDaemonAccessButton from "$lib/components/daemon/RequestDaemonAccessButton.svelte";
  import {
    SCOPE_COLUMNS,
    SCOPE_META,
    ROLE_ORDER,
    ROLE_META,
    normalizeScopes,
    roleForScopes,
    scopesForRole,
    newlyEscalatedRceScopes,
    scopesRequireRceConfirm,
    type DaemonScope,
    type DaemonRole,
  } from "$lib/daemon-scopes.js";
  import {
    connectProviderLabel,
    resolveSetupCyboCta,
    runtimeSupportsLogin,
  } from "$lib/setup-cybo-cta.js";
  import { desktopTerminalBridge, openExternalUrl } from "$lib/desktop-terminal.js";
  import { providerRemedy, type RemedyAction } from "$lib/provider-remedy.js";

  // Detail view for one daemon — rendered inside the Agents pane's Daemon
  // sub-tab (primary flow) and by the /daemons/[daemonId] deep-link route.
  let { daemonId }: { daemonId: string } = $props();

  const wsId = $derived(workspaceState.current?.id ?? (page.params.id as string));
  const currentUserId = $derived(authState.user?.id);

  const daemon = $derived(daemonState.byId(daemonId));
  const online = $derived(daemonState.isOnline(daemonId));
  const owned = $derived(daemon?.ownerId === currentUserId);
  const location = $derived(daemonState.locationLabel(daemon?.meta) ?? "Unknown location");
  // Is THIS the daemon new sessions will actually launch on, and why (#33)?
  const isLoadedDaemon = $derived(daemonState.effectiveId(currentUserId) === daemonId);
  const loadedReason = $derived(daemonState.loadedReason(currentUserId));

  const members = $derived(workspaceState.members);
  function memberName(userId: string): string {
    const m = members.find((mm) => mm.userId === userId);
    return m?.name ?? m?.email?.split("@")[0] ?? userId.slice(0, 8);
  }

  // Keep this daemon as the global selection while its detail view is open, so
  // new sessions target it.
  $effect(() => {
    if (daemonId && daemonState.byId(daemonId)) {
      daemonState.selectedId = daemonId;
    }
  });

  // ── Rename (#441, owner-only) ──────────────────────────────────────
  // The server marks the label user-set, so reconnect upserts (which report
  // the raw os.hostname(), an IP on some networks) can never overwrite it.
  let renaming = $state(false);
  let renameValue = $state("");
  let renameSaving = $state(false);
  let renameError = $state("");
  function startRename(): void {
    if (!daemon) return;
    renameValue = daemon.label;
    renameError = "";
    renaming = true;
  }
  async function commitRename(): Promise<void> {
    const label = renameValue.trim();
    if (!daemon || renameSaving) return;
    if (!label || label === daemon.label) {
      renaming = false;
      return;
    }
    renameSaving = true;
    renameError = "";
    try {
      await client.renameDaemon(wsId, daemonId, label);
      daemon.label = label;
      renaming = false;
    } catch (err) {
      renameError = err instanceof Error ? err.message : "Rename failed";
    } finally {
      renameSaving = false;
    }
  }

  // Providers for THIS daemon, kept LOCAL: the global providerState is also
  // written by the Agents pane's unscoped fetch (cybo-runnable check), so
  // sharing it would let whichever request finishes last win and show another
  // daemon's providers here. Re-fetched when the daemon comes back online.
  let providers = $state<ProviderInfo[]>([]);
  let providersLoading = $state(false);
  let providersLoadedFor = $state<string | null>(null);
  $effect(() => {
    if (daemonId && online && providersLoadedFor !== daemonId) {
      // Capture the requested id — `daemonId` is a reactive prop, so by the
      // time the response lands it may already point at another daemon.
      const target = daemonId;
      providersLoadedFor = target;
      providersLoading = true;
      client
        .listProviders({ daemonId: target })
        .then((list) => {
          // Drop a stale response if the view switched to another daemon.
          if (providersLoadedFor === target) providers = list;
          return;
        })
        .catch(() => {
          if (providersLoadedFor === target) providers = [];
        })
        .finally(() => {
          if (providersLoadedFor === target) providersLoading = false;
        });
    } else if (!online) {
      // Reset so providers re-fetch if the daemon comes back online.
      providersLoadedFor = null;
    }
  });

  const availableProviders = $derived(providers.filter((p) => p.available));

  // ── Cybo runtime: the PI/cybo CLI version installed on THIS daemon's host.
  // Probed daemon-side via cyborg:cybo_cli_status (runs `cybo --version`); "Check
  // for updates" just re-probes. (A server-side "Update" trigger is a follow-up —
  // it needs a new daemon-forwarded message + spawning `cybo upgrade`, which can't
  // be verified here; for now the Update button surfaces the canonical command.)
  let cliStatus = $state<{ installed: boolean; version?: string | null; path?: string | null } | null>(
    null,
  );
  let cliLoading = $state(false);
  let cliLoadedFor = $state<string | null>(null);
  let showUpdateCmd = $state(false);
  async function loadCliStatus(force = false): Promise<void> {
    if (!wsId || !online) return;
    if (!force && cliLoadedFor === daemonId) return;
    // Capture the target up front so the async guards below compare against the
    // request's daemon, not the (possibly-changed) reactive daemonId — otherwise
    // a daemon switch mid-request would let the first request's finally clear
    // cliLoading while the second is still in flight.
    const target = daemonId;
    // Switching daemons: drop the previous daemon's status so its version/update
    // options don't linger until the new probe resolves. A same-daemon re-probe
    // ("Check for updates") keeps the current value (no flicker).
    if (cliLoadedFor !== target) cliStatus = null;
    cliLoading = true;
    cliLoadedFor = target;
    showUpdateCmd = false;
    try {
      const r = await client.cyboCliStatus(wsId, target);
      if (cliLoadedFor === target) cliStatus = r;
    } catch {
      if (cliLoadedFor === target) cliStatus = null;
    } finally {
      if (cliLoadedFor === target) cliLoading = false;
    }
  }
  $effect(() => {
    // Re-probe whenever the shown daemon changes (and it's online).
    if (online && wsId && cliLoadedFor !== daemonId) void loadCliStatus();
    // Offline: drop the status AND the loaded marker, so coming back online
    // re-triggers a fresh probe (else cliLoadedFor stays === daemonId and the
    // effect never re-fires → stale "not installed").
    if (!online) {
      cliStatus = null;
      cliLoadedFor = null;
    }
  });

  // "Re-check providers" self-repair: the daemon's provider snapshot is sticky (a
  // settled "unavailable" never re-probes), so a provider installed after boot can
  // look missing until restart. This forces a daemon-side refreshSnapshotForCwd,
  // then re-fetches the providers + cybo-runtime sections so the page shows truth.
  let recheckBusy = $state(false);
  let recheckError = $state<string | null>(null);
  async function recheckProviders(): Promise<void> {
    if (recheckBusy || !wsId || !online) return;
    const target = daemonId;
    recheckBusy = true;
    recheckError = null;
    try {
      await client.refreshProviders(wsId, target);
      if (daemonId === target) {
        // Re-fetch what this page shows (live probes), now that the snapshot is fresh.
        providersLoadedFor = null;
        void loadCliStatus(true);
      }
    } catch (e) {
      // Surface it — a silent catch made the button look dead (e.g. against a
      // relay that doesn't forward cyborg:refresh_providers yet, or rate-limit).
      if (daemonId === target) {
        recheckError =
          e instanceof Error && e.message
            ? e.message
            : "Couldn't re-check providers — the relay may need an update. Try again later.";
      }
    } finally {
      recheckBusy = false;
    }
  }
  // The command surfaced as the manual fallback ("Show command"). Defaults to
  // npm; on an update failure the daemon reports the host's OWNING manager's
  // command (pnpm/bun) — npm's is useless on those installs.
  let cyboUpdateCmd = $state("npm install -g @cyborg7/cybo@latest");

  // ── Always-reachable "Connect provider" CTA (runtime section) ──
  // Two real users couldn't find the login door: it only existed inside the
  // not-runnable banner, so (a) it was absent from THIS section where they
  // looked (next to Check/Update), and (b) a daemon already authenticated with
  // one backend never showed the banner at all — no way to add a second
  // backend. The CTA now lives here unconditionally (online + installed),
  // independent of any runnable gating. Resolution + terminal are the existing
  // #399 pieces; the label says which backends are already connected (#398
  // capability meta).
  let appHostname = $state<string | null>(null);
  $effect(() => {
    const bridge = desktopTerminalBridge();
    if (!bridge) return;
    bridge
      .hostInfo()
      .then((info) => {
        appHostname = info.hostname;
        return;
      })
      // intentional: optional desktop-bridge host probe; absent/failed leaves appHostname null + the CTA degrades gracefully.
      .catch(() => {});
  });
  const detailDaemon = $derived(daemonState.byId(daemonId));
  const setupCta = $derived(
    resolveSetupCyboCta({
      hasTerminalBridge: desktopTerminalBridge() !== null,
      daemon: detailDaemon,
      currentUserId: authState.user?.id,
      appHostname,
      cliInstalled: cliStatus?.installed === true,
      cliVersion: cliStatus?.version,
    }),
  );
  const connectCta = $derived(connectProviderLabel(detailDaemon?.meta?.cyboRuntime));
  let setupTerminalOpen = $state(false);
  // Old runtime (< 0.2.6, no `cybo login`): update first via the existing flow,
  // then open the terminal once the gate passes (same shape as AgentsPane).
  async function connectUpdateFirst(): Promise<void> {
    await runCyboUpdate();
    if (runtimeSupportsLogin(cliStatus?.version)) setupTerminalOpen = true;
  }
  // Terminal closed -> the existing self-repair re-probe refreshes providers +
  // runtime status, so new backends show up without a manual click.
  function handleSetupTerminalClosed(): void {
    void recheckProviders();
  }

  // Perform a provider-remedy action (from provider-remedy.ts). open_url opens
  // the OS browser; recheck reuses the existing self-repair re-probe;
  // setup/reconnect/reconnect_api_key all open the existing SetupCyboTerminalDialog
  // (it runs `cybo login`, where the user picks OAuth or the API-key option). The
  // dialog has no API-key hint prop yet, so reconnect_api_key just opens it too.
  function runRemedyAction(action: RemedyAction): void {
    switch (action.kind) {
      case "open_url":
        if (action.url) openExternalUrl(action.url);
        break;
      case "recheck":
        void recheckProviders();
        break;
      case "setup":
      case "reconnect":
      case "reconnect_api_key":
        setupTerminalOpen = true;
        break;
    }
  }
  // Run the install/upgrade ON the daemon host (npm i -g @cyborg7/cybo@latest),
  // then reflect the new version. Daemon access is already required to reach here.
  let cliUpdating = $state(false);
  let cliUpdateError = $state<string | null>(null);
  async function runCyboUpdate(): Promise<void> {
    if (!wsId || !online || cliUpdating) return;
    cliUpdating = true;
    cliUpdateError = null;
    showUpdateCmd = false;
    try {
      const r = await client.cyboCliUpdate(wsId, daemonId);
      if (r.ok) {
        cliStatus = { installed: r.installed, version: r.version, path: cliStatus?.path ?? null };
      } else {
        cliUpdateError = r.error ?? "Update failed.";
        if (r.command) cyboUpdateCmd = r.command;
      }
    } catch (e) {
      cliUpdateError = e instanceof Error ? e.message : "Update failed.";
    } finally {
      cliUpdating = false;
    }
  }

  // ── "Check latest version": ask the daemon's npm for the latest @cyborg7/cybo
  //    and compare to what's installed (app-like update check). ──
  let cliChecking = $state(false);
  let cliLatest = $state<string | null>(null);
  let cliCheckError = $state<string | null>(null);
  async function checkLatest(): Promise<void> {
    if (!wsId || !online || cliChecking) return;
    cliChecking = true;
    cliCheckError = null;
    cliLatest = null;
    const target = daemonId;
    try {
      const r = await client.cyboCliLatest(wsId, daemonId);
      if (daemonId !== target) return; // daemon switched mid-request
      if (r.ok && r.latest) cliLatest = r.latest;
      else cliCheckError = r.error ?? "Couldn't read the latest version from npm.";
    } catch (e) {
      if (daemonId === target) cliCheckError = e instanceof Error ? e.message : "Check failed.";
    } finally {
      if (daemonId === target) cliChecking = false;
    }
  }
  function semver(v: string | null | undefined): [number, number, number] | null {
    const m = v?.match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }
  // true = update available, false = up to date, null = can't compare (unknown shape).
  const updateAvailable = $derived.by(() => {
    const a = semver(cliLatest);
    const b = semver(cliStatus?.version);
    if (!a || !b) return null;
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
  });
  $effect(() => {
    // Reset the latest-check when the shown daemon changes — a different daemon may
    // resolve a different "latest" (its own npm/registry).
    // oxlint-disable-next-line eslint/no-unused-expressions -- track daemonId to reset
    daemonId;
    cliLatest = null;
    cliCheckError = null;
  });

  // ── Daemon self-update (#663) — the same trio as the Cybo runtime, but the
  //    daemon RESTARTS, so the response is "restarting" (the WS drops) and the
  //    new version surfaces via the heartbeat, not the RPC return. ──
  const daemonVersion = $derived(daemon?.meta?.version ?? null);
  let daemonUpdating = $state(false);
  let daemonUpdateError = $state<string | null>(null);
  let daemonRestarting = $state(false);
  let daemonUpdateCmd = $state<string | null>(null);
  let showDaemonUpdateCmd = $state(false);
  async function runDaemonUpdate(): Promise<void> {
    if (!wsId || !online || daemonUpdating) return;
    daemonUpdating = true;
    daemonUpdateError = null;
    daemonRestarting = false;
    daemonUpdateCmd = null;
    showDaemonUpdateCmd = false;
    try {
      const r = await client.updateDaemon(wsId, daemonId);
      if (r.ok) {
        // The daemon is restarting; it'll reconnect with the new version via the
        // heartbeat. Keep the "updating…" state — the online dot + version row
        // reconcile from daemonState once it's back.
        daemonRestarting = true;
      } else {
        daemonUpdateError = r.error ?? "Update failed.";
        if (r.command) daemonUpdateCmd = r.command;
      }
    } catch (e) {
      daemonUpdateError = e instanceof Error ? e.message : "Update failed.";
    } finally {
      daemonUpdating = false;
    }
  }

  let daemonChecking = $state(false);
  let daemonLatest = $state<string | null>(null);
  let daemonCheckError = $state<string | null>(null);
  async function checkDaemonLatest(): Promise<void> {
    if (!wsId || !online || daemonChecking) return;
    daemonChecking = true;
    daemonCheckError = null;
    daemonLatest = null;
    const target = daemonId;
    try {
      const r = await client.daemonUpdateLatest(wsId, daemonId);
      if (daemonId !== target) return; // daemon switched mid-request
      if (r.ok && r.latest) daemonLatest = r.latest;
      else daemonCheckError = r.error ?? "Couldn't read the latest version from npm.";
    } catch (e) {
      if (daemonId === target) daemonCheckError = e instanceof Error ? e.message : "Check failed.";
    } finally {
      if (daemonId === target) daemonChecking = false;
    }
  }
  const daemonUpdateAvailable = $derived.by(() => {
    const a = semver(daemonLatest);
    const b = semver(daemonVersion);
    if (!a || !b) return null;
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
  });
  $effect(() => {
    // oxlint-disable-next-line eslint/no-unused-expressions -- track daemonId to reset
    daemonId;
    daemonLatest = null;
    daemonCheckError = null;
    daemonRestarting = false;
    sawRestartDrop = false;
  });

  // Clear the "restarting…" banner once the daemon has actually come back. The
  // update drops the daemon offline (WS closes) then online (reconnects); we
  // arm on the drop and clear on the return, so the banner doesn't linger
  // forever after a successful reconnect (and a no-op update that never dropped
  // is cleared on the next daemon switch).
  let sawRestartDrop = false;
  $effect(() => {
    if (!daemonRestarting) return;
    if (!online) {
      sawRestartDrop = true;
    } else if (sawRestartDrop) {
      daemonRestarting = false;
      sawRestartDrop = false;
    }
  });

  // Every session on this daemon (all users, all lifecycles) — the count shown
  // beside the "Sessions" sub-section header; the SessionList does the grouping.
  const daemonSessions = $derived(workspaceState.agents.filter((a) => a.daemonId === daemonId));
  // Active sessions on this daemon — kept for the revoke-impact preview, which
  // counts only a user's RUNNING sessions (a subset of daemonSessions).
  const activeSessions = $derived(daemonSessions);

  // ── Daemon-owner session AUDIT (#993) ──────────────────────────────
  // The owner / an admin-scope grantee gets the AUDIT lens: ALL sessions on this
  // daemon, including ephemeral/internal summons and OTHER users' (via
  // cyborg:list_daemon_sessions). Kept in LOCAL state, NEVER merged into
  // workspaceState.agents — that store feeds the scoped chat sidebar, and leaking
  // ephemerals into it re-triggers the 2026-06-12 ghost-session flood. A non-admin
  // keeps today's scoped daemon view over workspaceState.agents (below).
  const canAudit = $derived(
    owned || (!!currentUserId && scopesFor(currentUserId).includes("admin")),
  );
  let auditSessions = $state<Agent[]>([]);
  let auditLoadedFor = $state<string | null>(null);
  $effect(() => {
    if (canAudit && daemonId && online && wsId && auditLoadedFor !== daemonId) {
      // Capture the requested id — daemonId is reactive, so by the time the
      // response lands the view may already point at another daemon (stale guard,
      // mirrors the providers / cli probes).
      const target = daemonId;
      auditLoadedFor = target;
      client
        .listDaemonSessions(wsId, target)
        .then((list) => {
          if (auditLoadedFor === target) auditSessions = list;
          return;
        })
        .catch(() => {
          if (auditLoadedFor === target) auditSessions = [];
        });
    } else if (!online || !canAudit) {
      // Reset so it re-fetches when the daemon comes back online / access changes.
      auditLoadedFor = null;
      auditSessions = [];
    }
  });
  // The count beside the Sessions header reflects the active lens.
  const sessionsHeaderCount = $derived(canAudit ? auditSessions.length : daemonSessions.length);

  const accessUserIds = $derived(daemonState.accessUserIds(daemonId));
  // Members that could be granted access but don't have it yet (owner-only UI).
  const grantableMembers = $derived(
    members.filter((m) => m.membershipType === "active" && !accessUserIds.includes(m.userId)),
  );

  let mutating = $state<string | null>(null);

  // ── Access scopes (#705) ──────────────────────────────────────────
  // The current scopes a non-owner grantee holds (normalized: a present row with
  // no/empty scopes → ['admin'], the legacy total-access fail-safe). Owner is
  // implicit admin and never has a row, so this is only read for grantees.
  function scopesFor(userId: string): DaemonScope[] {
    return normalizeScopes(daemonState.accessScopesFor(daemonId, userId));
  }
  function roleFor(userId: string): DaemonRole {
    return roleForScopes(daemonState.accessScopesFor(daemonId, userId));
  }

  // The row whose per-scope override is expanded (null = all collapsed to a badge).
  let expandedUser = $state<string | null>(null);

  // #35: enabling `terminal` or `admin` = letting that user run code / open a shell
  // on this machine (RCE). A pending scope change that NEWLY introduces an RCE
  // scope is held here until the user confirms; non-RCE changes apply immediately.
  let pendingScopeChange = $state<{
    userId: string;
    name: string;
    scopes: DaemonScope[];
    escalated: DaemonScope[];
  } | null>(null);

  // How many active sessions a revoke would stop (impact preview), per user. A
  // revoke removes the user's ability to drive their running agents on this
  // daemon. `initiatedBy` is the user id that launched the agent.
  function activeSessionCountFor(userId: string): number {
    return activeSessions.filter((a) => a.initiatedBy === userId && a.lifecycle === "running")
      .length;
  }

  // A pending revoke awaiting confirmation (carries the impact preview).
  let pendingRevoke = $state<{ userId: string; name: string; sessions: number } | null>(null);

  async function refreshAccess(): Promise<void> {
    if (!wsId) return;
    try {
      const { access } = await client.fetchDaemonAccess(wsId);
      daemonState.load(daemonState.list, access);
    } catch (err) {
      // After a mutation this refetch keeps the access list in sync; a failure
      // leaves it stale (showing the pre-mutation roster). Log it — the mutation
      // handlers surface their own RPC errors, so no extra toast here.
      reportClientError({
        source: "DaemonDetail.refreshAccess",
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : null,
        platform: "web",
      });
    }
  }

  // Apply a scope set for a user. Empty array revokes (deletes the grant). Caller
  // is responsible for the #35 confirmation when escalating — applyScopes itself
  // is unconditional (used after confirm, and for non-RCE changes).
  async function applyScopes(userId: string, scopes: DaemonScope[]): Promise<void> {
    if (!wsId || mutating) return;
    mutating = userId;
    try {
      await client.setDaemonAccess(wsId, daemonId, userId, scopes);
      await refreshAccess();
    } catch (err) {
      console.error("Failed to set daemon access:", err);
    } finally {
      mutating = null;
    }
  }

  // Request a scope change: if it newly enables terminal/admin, route through the
  // #35 confirmation; otherwise apply immediately. `prev` is the current set so we
  // only confirm on a genuine escalation (not on keeping an existing RCE scope).
  function requestScopeChange(userId: string, name: string, next: DaemonScope[]): void {
    const prev = scopesFor(userId);
    const escalated = newlyEscalatedRceScopes(prev, next);
    if (escalated.length > 0) {
      pendingScopeChange = { userId, name, scopes: next, escalated };
      return;
    }
    void applyScopes(userId, next);
  }

  // Role-preset selection: maps the role → its scope bundle, then routes through
  // requestScopeChange (so Admin fires #35, Viewer/Operator don't).
  function selectRole(userId: string, name: string, role: Exclude<DaemonRole, "custom">): void {
    requestScopeChange(userId, name, scopesForRole(role));
  }

  // Per-scope toggle in the override expander. Builds the next set from the
  // current one ± the toggled scope, then routes through requestScopeChange.
  function toggleScope(userId: string, name: string, scope: DaemonScope, on: boolean): void {
    const current = new Set(scopesFor(userId));
    // `admin` is the superset: toggling a granular scope while admin is set means
    // the user is moving OFF admin to a custom set — expand admin to the full
    // granular list first, then apply the toggle.
    if (current.has("admin") && scope !== "admin") {
      current.delete("admin");
      current.add("chat");
      current.add("spawn");
      current.add("terminal");
    }
    if (scope === "admin") {
      // Toggling admin on collapses to the single superset scope; off clears it.
      requestScopeChange(userId, name, on ? ["admin"] : []);
      return;
    }
    if (on) current.add(scope);
    else current.delete(scope);
    requestScopeChange(userId, name, [...current] as DaemonScope[]);
  }

  // Start the grant flow for a member who has no access yet: default to the
  // least-privilege Viewer role (chat only) — no #35 friction.
  function grantViewer(userId: string, name: string): void {
    void applyScopes(userId, scopesForRole("viewer"));
    expandedUser = userId;
  }

  function requestRevoke(userId: string, name: string): void {
    pendingRevoke = { userId, name, sessions: activeSessionCountFor(userId) };
  }

  // ── Access REQUESTS (#705 REQUEST → NOTIFY → APPROVE) ──────────────
  // Requester view: can the current (non-owner) user already run on this daemon?
  // If not, the header surfaces the "Request access" affordance.
  const canAccessThis = $derived(daemonState.canAccess(daemonId, currentUserId));
  // Owner view: pending requests for THIS daemon, surfaced atop the Access section.
  const pendingRequests = $derived(daemonAccessRequestsState.pendingForDaemon(daemonId));

  function requesterName(req: { requesterId: string; requesterName: string | null }): string {
    return req.requesterName ?? memberName(req.requesterId);
  }

  // The request id currently being resolved (disables its row's buttons).
  let resolvingRequest = $state<string | null>(null);
  // An approve held for the #35 RCE confirmation (requested scopes include
  // terminal/admin → approving GRANTS a host shell / host control).
  let pendingApproval = $state<{ id: string; name: string; scopes: DaemonScope[] } | null>(null);

  async function resolveRequest(
    requestId: string,
    decision: "approve" | "deny",
  ): Promise<void> {
    if (!wsId || resolvingRequest) return;
    resolvingRequest = requestId;
    try {
      const { request } = await client.resolveDaemonAccessRequest(wsId, requestId, decision);
      // Reflect the resolution locally (pending → approved/denied) so the row
      // drops out of the inbox without waiting for the echo…
      daemonAccessRequestsState.upsert(request);
      // …and on approve the server ran the grant, so refresh the access matrix.
      if (decision === "approve") await refreshAccess();
    } catch (err) {
      reportClientError({
        source: "DaemonDetail.resolveRequest",
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : null,
        platform: "web",
      });
    } finally {
      resolvingRequest = null;
    }
  }

  // Approve: route through the #35 confirm when the requested scopes include
  // terminal/admin (granting RCE), otherwise approve directly.
  function approveRequest(req: {
    id: string;
    requesterId: string;
    requesterName: string | null;
    scopes: DaemonScope[];
  }): void {
    if (scopesRequireRceConfirm(req.scopes)) {
      pendingApproval = { id: req.id, name: requesterName(req), scopes: req.scopes };
      return;
    }
    void resolveRequest(req.id, "approve");
  }

  // ── Workspace slash daemon (read-only) ──
  // Whether THIS daemon is the workspace's slash-command daemon. Editing the
  // workspace slash config (daemon + model) now lives in Settings → AI — the
  // single source of truth — so this view only badges it + links there.
  const isDefaultSlash = $derived(daemonState.defaultSlashDaemonId === daemonId);
  // ── Workspace serving (owner-only): which workspaces this daemon serves ──
  let daemonWorkspaces = $state<Array<{ workspaceId: string; name: string; enabled: boolean }>>([]);
  let wsLoadedFor = $state<string | null>(null);
  // Per-workspace pending state, so toggling one switch doesn't block the others.
  let togglingWs = $state<Record<string, boolean>>({});

  $effect(() => {
    if (owned && daemonId && wsLoadedFor !== daemonId) {
      wsLoadedFor = daemonId;
      togglingWs = {};
      void loadDaemonWorkspaces(daemonId);
    } else if (!owned) {
      daemonWorkspaces = [];
      wsLoadedFor = null;
      togglingWs = {};
    }
  });

  async function loadDaemonWorkspaces(id: string): Promise<void> {
    try {
      const { workspaces } = await client.listDaemonWorkspaces(id);
      // Ignore a stale response if the view already switched to another daemon.
      if (wsLoadedFor === id) daemonWorkspaces = workspaces;
    } catch (err) {
      console.error("Failed to load daemon workspaces:", err);
    }
  }

  async function toggleWorkspace(workspaceId: string, enabled: boolean): Promise<void> {
    if (togglingWs[workspaceId]) return;
    // Capture the daemon this toggle belongs to — the component is reused
    // across daemonId changes, so guard every post-await state write.
    const targetDaemonId = daemonId;
    togglingWs = { ...togglingWs, [workspaceId]: true };
    // Optimistic — revert on failure.
    const prev = daemonWorkspaces;
    daemonWorkspaces = daemonWorkspaces.map((w) =>
      w.workspaceId === workspaceId
        ? { workspaceId: w.workspaceId, name: w.name, enabled }
        : w,
    );
    try {
      await client.setDaemonWorkspace(targetDaemonId, workspaceId, enabled);
    } catch (err) {
      console.error("Failed to update daemon workspace serving:", err);
      if (daemonId === targetDaemonId) daemonWorkspaces = prev;
    } finally {
      if (daemonId === targetDaemonId) togglingWs = { ...togglingWs, [workspaceId]: false };
    }
  }

</script>

{#if !daemon}
  <div class="flex h-full items-center justify-center p-8 text-center text-sm text-content-muted">
    This daemon is no longer available in the workspace.
  </div>
{:else}
  <div class="h-full overflow-y-auto">
    <div class="mx-auto max-w-3xl px-6 py-6">
      <!-- Header -->
      <header class="flex items-start gap-3 border-b border-edge-dim pb-5">
        <span
          class={cn("mt-2 h-2.5 w-2.5 rounded-full shrink-0", online ? "bg-online" : "bg-content-dim")}
        ></span>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            {#if renaming}
              <!-- svelte-ignore a11y_autofocus — the user just clicked Rename; focus follows intent. -->
              <input
                class="w-56 rounded border border-edge bg-base px-2 py-1 text-lg font-bold text-white outline-none focus:border-btn-primary-bg"
                bind:value={renameValue}
                maxlength={64}
                disabled={renameSaving}
                autofocus
                onkeydown={(e) => {
                  if (e.key === "Enter") void commitRename();
                  // No cancel mid-save: unmounting the input while the rename is in
                  // flight would desync the UI from whatever the server persisted.
                  if (e.key === "Escape" && !renameSaving) renaming = false;
                }}
              />
              <button
                type="button"
                class="text-[12px] text-content-muted hover:text-content disabled:opacity-50"
                disabled={renameSaving}
                onclick={() => void commitRename()}
              >{renameSaving ? "Saving…" : "Save"}</button>
              <button
                type="button"
                class="text-[12px] text-content-dim hover:text-content disabled:opacity-50"
                disabled={renameSaving}
                onclick={() => (renaming = false)}
              >Cancel</button>
            {:else}
              <h1 class="truncate text-xl font-bold text-white">{daemon.label}</h1>
              {#if owned}
                <button
                  type="button"
                  class="text-[12px] text-content-dim underline hover:text-content"
                  title="Rename this daemon — the name sticks across reconnects"
                  onclick={startRename}
                >Rename</button>
              {/if}
            {/if}
            {#if owned}
              <span class="rounded bg-surface-alt px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-content-muted">You</span>
            {/if}
          </div>
          {#if renameError}
            <p class="mt-1 text-[12px] text-error">{renameError}</p>
          {/if}
          <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-content-muted">
            <span>{online ? "Online" : "Offline"}</span>
            <span>·</span>
            <span class="truncate">{location}</span>
            <span>·</span>
            <span>Owner: {memberName(daemon.ownerId)}</span>
          </div>
          <div class="mt-1 font-mono text-[11px] text-content-dim truncate">{daemon.id}</div>
        </div>
      </header>

      <!-- Offline guard (#33): explicit state + why new sessions are blocked. -->
      {#if !online}
        <div class="mt-4 rounded-md border border-edge-dim bg-surface-alt px-3 py-2 text-[12px] text-content">
          <span class="text-error">Offline.</span> New sessions can't be created on this daemon
          until it reconnects — pick another online daemon to launch agents now.
        </div>
      {/if}

      <!-- Request access (#705) — non-owner without a grant yet. The button opens
           the Viewer/Operator/Admin picker, or collapses to "Requested" while a
           request is pending. -->
      {#if !owned && !canAccessThis}
        <div class="mt-4 flex items-center justify-between gap-3 rounded-md border border-edge-dim bg-surface-alt px-3 py-2.5">
          <div class="min-w-0">
            <p class="text-[13px] font-medium text-content">You don't have access to this daemon</p>
            <p class="mt-0.5 text-[11px] text-content-dim">
              Ask {memberName(daemon.ownerId)} for access to run agents or open a shell here.
            </p>
          </div>
          <RequestDaemonAccessButton workspaceId={wsId} {daemonId} daemonLabel={daemon.label} variant="section" />
        </div>
      {/if}

      <!-- "Why this daemon is loaded" hint (#33). -->
      {#if isLoadedDaemon}
        <p class="mt-3 text-[11px] text-content-muted">Loaded for new sessions · {loadedReason}</p>
      {/if}

      <!-- Who has access — role-preset matrix (#705). A collapsed row shows a role
           badge; the owner expands it to per-scope toggles. Enabling terminal/admin
           fires the #35 RCE confirmation. -->
      <section class="border-b border-edge-dim py-5">
        <h2 class="mb-1 text-sm font-semibold text-content">Access</h2>
        <p class="mb-3 text-[11px] text-content-dim">
          What each member can do on this daemon. Higher roles run code or open a shell on the host.
        </p>

        <!-- Pending access requests (#705, owner-only). Approve runs the grant
             server-side (the matrix refreshes); terminal/admin requests route
             through the #35 RCE confirm. Deny dismisses the request. -->
        {#if owned && pendingRequests.length > 0}
          <div class="mb-3 flex flex-col gap-2">
            {#each pendingRequests as req (req.id)}
              {@const reqRole = roleForScopes(req.scopes)}
              <div class="rounded-md border border-warning/30 bg-warning/5 px-3 py-2.5">
                <div class="flex items-center gap-2 text-[13px]">
                  <span class="truncate font-medium text-content">{requesterName(req)}</span>
                  <span class="text-content-dim">requested</span>
                  <Badge
                    variant={reqRole === "admin" ? "destructive" : "secondary"}
                    class="text-[10px] capitalize"
                  >
                    {reqRole === "custom" ? "Custom" : ROLE_META[reqRole].label}
                  </Badge>
                </div>
                <div class="mt-1 text-[11px] text-content-dim">
                  {req.scopes.map((s) => SCOPE_META[s].label).join(", ")}
                </div>
                <div class="mt-2 flex items-center gap-2">
                  <Button
                    variant="default"
                    size="sm"
                    disabled={resolvingRequest === req.id}
                    onclick={() =>
                      approveRequest({
                        id: req.id,
                        requesterId: req.requesterId,
                        requesterName: req.requesterName,
                        scopes: req.scopes,
                      })}
                  >
                    Approve
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={resolvingRequest === req.id}
                    onclick={() => void resolveRequest(req.id, "deny")}
                  >
                    Deny
                  </Button>
                </div>
              </div>
            {/each}
          </div>
        {/if}

        <div class="flex flex-col gap-1">
          {#each accessUserIds as userId (userId)}
            {@const isOwner = userId === daemon.ownerId}
            {@const role = isOwner ? "admin" : roleFor(userId)}
            {@const scopes = isOwner ? (["admin"] as DaemonScope[]) : scopesFor(userId)}
            {@const expanded = expandedUser === userId}
            <div class="rounded-md border border-transparent hover:border-edge-dim/60 px-1 py-1.5">
              <div class="flex items-center gap-2 text-[13px]">
                <span class="h-1.5 w-1.5 rounded-full bg-content-muted shrink-0"></span>
                <span class="text-content truncate">{memberName(userId)}</span>
                {#if isOwner}
                  <!-- Owner = admin implicitly, and it can't be changed: an owner
                       always has full control of their own machine. -->
                  <Badge variant="secondary" class="ml-1 text-[10px]">Admin</Badge>
                  <span class="text-[11px] text-content-dim">implicit, locked</span>
                {:else}
                  <Badge
                    variant={role === "admin" ? "destructive" : "secondary"}
                    class="ml-1 text-[10px] capitalize"
                  >
                    {role === "custom" ? "Custom" : ROLE_META[role].label}
                  </Badge>
                  {#if owned}
                    <button
                      type="button"
                      onclick={() => (expandedUser = expanded ? null : userId)}
                      class="ml-auto text-[11px] text-content-muted hover:text-content transition-colors cursor-pointer"
                    >
                      {expanded ? "Done" : "Edit"}
                    </button>
                    <button
                      type="button"
                      onclick={() => requestRevoke(userId, memberName(userId))}
                      disabled={!!mutating}
                      class="text-[11px] text-content-muted hover:text-error transition-colors cursor-pointer disabled:opacity-50"
                    >
                      Revoke
                    </button>
                  {/if}
                {/if}
              </div>

              {#if !isOwner && owned && expanded}
                <div class="mt-2 ml-3.5 flex flex-col gap-3 border-l border-edge-dim pl-3 pb-1">
                  <!-- Role presets — the common path. -->
                  <div class="flex flex-wrap gap-1.5">
                    {#each ROLE_ORDER as r (r)}
                      <Button
                        variant={role === r ? "default" : "outline"}
                        size="sm"
                        disabled={!!mutating}
                        title={ROLE_META[r].blurb}
                        onclick={() => selectRole(userId, memberName(userId), r)}
                      >
                        {ROLE_META[r].label}
                      </Button>
                    {/each}
                  </div>
                  <!-- Per-scope override (escape hatch) — granular toggles with
                       human micro-copy. Toggling here yields a Custom role. -->
                  <div class="flex flex-col gap-2">
                    {#each SCOPE_COLUMNS as sc (sc)}
                      <div class="flex items-start gap-2.5">
                        <Switch
                          checked={scopes.includes("admin") || scopes.includes(sc)}
                          disabled={!!mutating || scopes.includes("admin")}
                          onCheckedChange={(v) => toggleScope(userId, memberName(userId), sc, v)}
                        />
                        <div class="flex flex-col leading-tight">
                          <span class="text-[12px] text-content">{SCOPE_META[sc].label}</span>
                          <span class="text-[11px] text-content-dim">{SCOPE_META[sc].blurb}</span>
                        </div>
                      </div>
                    {/each}
                    <div class="flex items-start gap-2.5">
                      <Switch
                        checked={scopes.includes("admin")}
                        disabled={!!mutating}
                        onCheckedChange={(v) => toggleScope(userId, memberName(userId), "admin", v)}
                      />
                      <div class="flex flex-col leading-tight">
                        <span class="text-[12px] text-content">{SCOPE_META.admin.label}</span>
                        <span class="text-[11px] text-error/90">{SCOPE_META.admin.blurb}</span>
                      </div>
                    </div>
                  </div>
                </div>
              {/if}
            </div>
          {/each}
        </div>

        {#if owned && grantableMembers.length > 0}
          <div class="mt-4">
            <div class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-content-dim">
              Grant access
            </div>
            <p class="mb-2 text-[11px] text-content-dim">
              New members start as <span class="text-content">Viewer</span> (message agents only). Expand
              to raise their role.
            </p>
            <div class="flex flex-wrap gap-2">
              {#each grantableMembers as m (m.userId)}
                {@const mName = m.name ?? m.email?.split("@")[0] ?? m.userId.slice(0, 8)}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!!mutating}
                  onclick={() => grantViewer(m.userId, mName)}
                >
                  + {mName}
                </Button>
              {/each}
            </div>
          </div>
        {/if}
      </section>

      <!-- Workspaces this daemon serves (owner-only) -->
      {#if owned}
        <section class="border-b border-edge-dim py-5">
          <h2 class="mb-1 text-sm font-semibold text-content">Workspaces</h2>
          <p class="mb-3 text-[11px] text-content-dim">
            Which workspaces this daemon serves. Disabling one stops it from running agents there.
          </p>
          {#if daemonWorkspaces.length === 0}
            <p class="text-[13px] text-content-muted">No workspaces.</p>
          {:else}
            <div class="flex flex-col gap-1">
              {#each daemonWorkspaces as ws (ws.workspaceId)}
                <div class="flex items-center gap-3 py-1 text-[13px]">
                  <span class={cn("text-content", !ws.enabled && "text-content-muted")}>{ws.name}</span>
                  <Switch
                    class="ml-auto"
                    checked={ws.enabled}
                    disabled={!!togglingWs[ws.workspaceId]}
                    onCheckedChange={(v) => toggleWorkspace(ws.workspaceId, v)}
                  />
                </div>
              {/each}
            </div>
          {/if}
        </section>
      {/if}

      <!-- Workspace slash daemon (read-only; edit in Settings → AI) -->
      {#if owned}
        <section class="border-b border-edge-dim py-5">
          <div class="mb-1 flex items-center gap-2">
            <h2 class="text-sm font-semibold text-content">Slash commands</h2>
            {#if isDefaultSlash}
              <span
                class="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent"
                >Workspace slash daemon</span
              >
            {/if}
          </div>
          <p class="mb-3 text-[11px] text-content-dim">
            {#if isDefaultSlash}
              This daemon runs the workspace's slash commands (<code>/summarize</code>,
              <code>/ask</code>). The slash daemon and its model are managed in one place.
            {:else}
              The workspace's slash commands run on its chosen daemon, managed in one place.
            {/if}
          </p>
          <Button variant="outline" size="sm" onclick={() => goto(`/workspace/${wsId}/settings/ai`)}>
            Configure in Settings → AI
          </Button>
        </section>
      {/if}

      <!-- Providers -->
      <section class="border-b border-edge-dim py-5">
        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-sm font-semibold text-content">Providers</h2>
          <div class="flex items-center gap-2">
            {#if providersLoading}
              <span class="text-[11px] text-content-dim">Loading...</span>
            {/if}
            {#if online}
              <!-- Self-repair: force the daemon to re-probe its provider snapshot
                   (a settled "unavailable" is sticky until re-probed). -->
              <button
                type="button"
                onclick={recheckProviders}
                disabled={recheckBusy}
                class="rounded border border-edge-dim px-2 py-0.5 text-[11px] text-content-dim transition-colors hover:bg-hover-gray hover:text-content disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {recheckBusy ? "Re-checking…" : "Re-check providers"}
              </button>
            {/if}
          </div>
        </div>
        {#if recheckError}
          <div class="mb-3 text-[12px] text-error">{recheckError}</div>
        {/if}
        {#if !online}
          <div class="text-[13px] text-content-muted">Daemon offline — providers unavailable.</div>
        {:else if providersLoading || providersLoadedFor !== daemonId}
          <!-- Until providers are loaded for THIS daemon, show loading rather
               than flicker the previous daemon's providers. -->
          <div class="text-[13px] text-content-muted">Loading providers...</div>
        {:else if providers.length === 0}
          <div class="text-[13px] text-content-muted">No providers detected on this daemon.</div>
        {:else}
          <!-- ONE honest status per provider (kills the old "green dot + needs
               setup" contradiction): available → Connected · N models; otherwise
               the daemon's exact unavailableReason + the mapped remedy actions. -->
          <div class="flex flex-col gap-2">
            {#each providers as provider (provider.id)}
              {@const remedy = provider.available
                ? null
                : providerRemedy(provider.reasonKind, provider.label, provider.unavailableReason)}
              <div
                class={cn(
                  "rounded-md border px-3 py-2.5",
                  provider.available
                    ? "border-edge-dim bg-surface-alt"
                    : "border-error/40 bg-error/5",
                )}
              >
                <div class="flex items-center gap-2 text-[13px]">
                  <ProviderIcon provider={provider.id} size={16} />
                  <span class="truncate font-medium text-content">{provider.label}</span>
                  {#if provider.available}
                    <span class="ml-auto flex items-center gap-1.5 text-[12px] text-online">
                      <span class="h-1.5 w-1.5 rounded-full bg-online shrink-0"></span>
                      Connected · {provider.models.length}
                      {provider.models.length === 1 ? "model" : "models"}
                    </span>
                  {:else}
                    <span class="ml-auto flex items-center gap-1.5 text-[12px] text-error">
                      <span class="h-1.5 w-1.5 rounded-full bg-error shrink-0"></span>
                      Unavailable
                    </span>
                  {/if}
                </div>
                {#if remedy}
                  <p class="mt-1.5 text-[12px] text-content-muted">{remedy.body}</p>
                  <div class="mt-2 flex flex-wrap gap-1.5">
                    {#each remedy.actions as action (action.kind + action.label)}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={action.kind === "recheck" && recheckBusy}
                        onclick={() => runRemedyAction(action)}
                      >
                        {#if action.kind === "recheck" && recheckBusy}
                          Re-checking…
                        {:else}
                          {action.label}
                        {/if}
                      </Button>
                    {/each}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
          <div class="mt-2 text-[11px] text-content-dim">
            {availableProviders.length} of {providers.length} available
          </div>
        {/if}
      </section>

      <!-- Cybo -->
      <!-- Cybo runtime: the PI/cybo CLI version on this daemon's host + updates. -->
      <section class="border-b border-edge-dim py-5">
        <div class="mb-3 flex items-center gap-2">
          <h2 class="text-sm font-semibold text-content">Cybo runtime</h2>
          {#if cliLoading}
            <span class="text-[11px] text-content-dim">checking…</span>
          {/if}
        </div>
        {#if !online}
          <div class="text-[13px] text-content-muted">Daemon offline — version unavailable.</div>
        {:else if cliStatus?.installed}
          <div class="flex flex-wrap items-center gap-2 text-[13px]">
            <CyborgIcon size={14} />
            <span class="text-content">Cybo runtime</span>
            <span class="font-mono text-[12px] text-content-dim">{cliStatus.version ?? "unknown version"}</span>
            <div class="ml-auto flex items-center gap-2">
              {#if setupCta.kind === "terminal"}
                <Button variant="outline" size="sm" onclick={() => (setupTerminalOpen = true)}>
                  {connectCta.label}
                </Button>
              {:else if setupCta.kind === "update-first"}
                <Button variant="outline" size="sm" disabled={cliUpdating} onclick={connectUpdateFirst} title="Setup needs cybo ≥ 0.2.6 — updates first, then opens setup.">
                  {#if cliUpdating}
                    <span class="mr-1.5 inline-block h-3 w-3 shrink-0 rounded-full border-2 border-current border-t-transparent animate-spin"></span>
                    Updating…
                  {:else}
                    {connectCta.label}
                  {/if}
                </Button>
              {/if}
              <Button variant="outline" size="sm" disabled={cliChecking || cliUpdating} onclick={checkLatest}>
                {#if cliChecking}
                  <span class="mr-1.5 inline-block h-3 w-3 shrink-0 rounded-full border-2 border-current border-t-transparent animate-spin"></span>
                  Checking…
                {:else}
                  Check latest version
                {/if}
              </Button>
              <Button variant="outline" size="sm" disabled={cliUpdating} onclick={runCyboUpdate}>
                {#if cliUpdating}
                  <span class="mr-1.5 inline-block h-3 w-3 shrink-0 rounded-full border-2 border-current border-t-transparent animate-spin"></span>
                  Updating @cyborg7/cybo@latest…
                {:else}
                  Update
                {/if}
              </Button>
            </div>
          </div>
          <!-- Connected backends (capability meta, #398) / remote command fallback —
               always visible so adding a SECOND backend has a door even when the
               runtime is fully runnable (the not-runnable banner never shows then). -->
          {#if connectCta.detail}
            <div class="mt-1.5 text-[12px] text-content-muted">{connectCta.detail}</div>
          {/if}
          {#if setupCta.kind === "command"}
            <div class="mt-1.5 text-[12px] text-content-muted">
              To connect a model provider, run this on the daemon's machine:
              <code class="ml-1 rounded bg-surface-alt px-2 py-0.5 font-mono text-content">{setupCta.command}</code>
            </div>
          {/if}
          <!-- Latest-check verdict: installed (cliStatus.version) vs npm latest. -->
          {#if cliChecking}
            <div class="mt-2 text-[12px] text-content-muted">Checking npm for the latest @cyborg7/cybo…</div>
          {:else if cliCheckError}
            <div class="mt-2 text-[12px] text-content-muted">Couldn't check npm: {cliCheckError}</div>
          {:else if cliLatest}
            {#if updateAvailable === true}
              <div class="mt-2 flex items-center gap-1.5 text-[12px]" style="color: var(--health-watching-text, #d97706);">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M12 5v14M5 12l7 7 7-7"/></svg>
                Update available: <span class="font-mono">{cliStatus.version ?? "?"}</span> → <span class="font-mono">{cliLatest}</span> — click Update.
              </div>
            {:else if updateAvailable === false}
              <div class="mt-2 flex items-center gap-1.5 text-[12px]" style="color: var(--color-online, #16a34a);">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M20 6 9 17l-5-5"/></svg>
                Up to date — latest is <span class="font-mono">{cliLatest}</span>.
              </div>
            {:else}
              <div class="mt-2 text-[12px] text-content-muted">
                Latest on npm: <span class="font-mono">{cliLatest}</span> (installed: <span class="font-mono">{cliStatus.version ?? "unknown"}</span>)
              </div>
            {/if}
          {/if}
          {#if cliUpdateError}
            <div class="mt-2 rounded-md border border-error/40 bg-error/10 px-3 py-2 text-[12px] text-error">
              Update failed: {cliUpdateError}
              <button type="button" class="ml-1 underline" onclick={() => (showUpdateCmd = !showUpdateCmd)}>Show command</button>
            </div>
          {/if}
          {#if showUpdateCmd}
            <div class="mt-2 rounded-md border border-edge-dim bg-surface-alt px-3 py-2 text-[12px] text-content-muted">
              Run it manually on this daemon's host:
              <code class="mt-1 block font-mono text-content">{cyboUpdateCmd}</code>
            </div>
          {/if}
        {:else if cliLoading || cliLoadedFor !== daemonId}
          <!-- Probe in flight (or switched daemon): don't flash a false "not
               installed" while cliStatus is null. Mirrors the providers section. -->
          <div class="text-[13px] text-content-muted">Loading runtime status…</div>
        {:else}
          <div class="text-[13px] text-content-muted">
            The cybo runtime is not installed on this daemon — cybos can't run here.
            <div class="mt-2">
              <Button variant="outline" size="sm" disabled={cliUpdating} onclick={runCyboUpdate}>
                {#if cliUpdating}
                  <span class="mr-1.5 inline-block h-3 w-3 shrink-0 rounded-full border-2 border-current border-t-transparent animate-spin"></span>
                  Installing @cyborg7/cybo@latest…
                {:else}
                  Install latest cybo
                {/if}
              </Button>
            </div>
            {#if cliUpdateError}
              <div class="mt-2 rounded-md border border-error/40 bg-error/10 px-3 py-2 text-[12px] text-error">
                Install failed: {cliUpdateError}
                <span class="block mt-1">Run manually: <code class="font-mono text-content">{cyboUpdateCmd}</code></span>
              </div>
            {/if}
          </div>
        {/if}
      </section>

      <!-- Daemon self-update (#663): the daemon's own version + a one-click
           remote update (runs `cyborg daemon update` on the host, which restarts
           it). Owner/grant-gated server-side; the button only shows when online. -->
      <section class="border-b border-edge-dim py-5">
        <div class="mb-3 flex items-center gap-2">
          <h2 class="text-sm font-semibold text-content">Daemon</h2>
          {#if daemonChecking}
            <span class="text-[11px] text-content-dim">checking…</span>
          {/if}
        </div>
        {#if !online}
          <div class="text-[13px] text-content-muted">Daemon offline — version unavailable.</div>
        {:else}
          <div class="flex flex-wrap items-center gap-2 text-[13px]">
            <span class="text-content">Daemon version</span>
            <span class="font-mono text-[12px] text-content-dim">{daemonVersion ?? "unknown"}</span>
            <div class="ml-auto flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={daemonChecking || daemonUpdating}
                onclick={checkDaemonLatest}
              >
                {#if daemonChecking}
                  <span class="mr-1.5 inline-block h-3 w-3 shrink-0 rounded-full border-2 border-current border-t-transparent animate-spin"></span>
                  Checking…
                {:else}
                  Check latest version
                {/if}
              </Button>
              <Button variant="outline" size="sm" disabled={daemonUpdating || daemonRestarting} onclick={runDaemonUpdate}>
                {#if daemonUpdating}
                  <span class="mr-1.5 inline-block h-3 w-3 shrink-0 rounded-full border-2 border-current border-t-transparent animate-spin"></span>
                  Updating…
                {:else}
                  Update
                {/if}
              </Button>
            </div>
          </div>

          {#if daemonRestarting}
            <div class="mt-2 flex items-center gap-1.5 text-[12px] text-content-muted">
              <span class="inline-block h-3 w-3 shrink-0 rounded-full border-2 border-current border-t-transparent animate-spin"></span>
              Update started — the daemon is restarting and will reconnect with the new version.
            </div>
          {/if}

          <!-- Latest-check verdict: running meta.version vs npm latest. -->
          {#if daemonChecking}
            <div class="mt-2 text-[12px] text-content-muted">Checking npm for the latest daemon version…</div>
          {:else if daemonCheckError}
            <div class="mt-2 text-[12px] text-content-muted">Couldn't check npm: {daemonCheckError}</div>
          {:else if daemonLatest}
            {#if daemonUpdateAvailable === true}
              <div class="mt-2 flex items-center gap-1.5 text-[12px]" style="color: var(--health-watching-text, #d97706);">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M12 5v14M5 12l7 7 7-7"/></svg>
                Update available: <span class="font-mono">{daemonVersion ?? "?"}</span> → <span class="font-mono">{daemonLatest}</span> — click Update.
              </div>
            {:else if daemonUpdateAvailable === false}
              <div class="mt-2 flex items-center gap-1.5 text-[12px]" style="color: var(--color-online, #16a34a);">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M20 6 9 17l-5-5"/></svg>
                Up to date — latest is <span class="font-mono">{daemonLatest}</span>.
              </div>
            {:else}
              <div class="mt-2 text-[12px] text-content-muted">
                Latest on npm: <span class="font-mono">{daemonLatest}</span> (running: <span class="font-mono">{daemonVersion ?? "unknown"}</span>)
              </div>
            {/if}
          {/if}
          {#if daemonUpdateError}
            <div class="mt-2 rounded-md border border-error/40 bg-error/10 px-3 py-2 text-[12px] text-error">
              Update failed: {daemonUpdateError}
              {#if daemonUpdateCmd}
                <button type="button" class="ml-1 underline" onclick={() => (showDaemonUpdateCmd = !showDaemonUpdateCmd)}>Show command</button>
              {/if}
            </div>
          {/if}
          {#if showDaemonUpdateCmd && daemonUpdateCmd}
            <div class="mt-2 rounded-md border border-edge-dim bg-surface-alt px-3 py-2 text-[12px] text-content-muted">
              Run it manually on this daemon's host:
              <code class="mt-1 block font-mono text-content">{daemonUpdateCmd}</code>
            </div>
          {/if}
        {/if}
      </section>

      <!-- Cybos are a WORKSPACE roster (no daemon ownership), shown in the Agents
           pane's cybos tab — intentionally NOT listed per-daemon here, so a daemon
           never reads as "owning" the workspace's cybos. This daemon's ability to
           run them is covered by the Cybo runtime + Providers sections above. -->

      <!-- Sessions (#706): every user's sessions on THIS daemon, grouped by
           owner and led by avatar + name — the daemon owner's "what ran on my
           machine" lens. This is where OTHER users' personal sessions land,
           moved out of the chat sidebar. The workspace-wide audit firehose
           lives in Settings → Logs (#704). -->
      <section class="py-5">
        <div class="mb-1 flex items-center gap-2">
          <h2 class="text-sm font-semibold text-content">Sessions</h2>
          {#if sessionsHeaderCount > 0}
            <span class="text-[11px] text-content-dim tabular-nums">{sessionsHeaderCount}</span>
          {/if}
        </div>
        {#if canAudit}
          <!-- Owner / admin audit lens: ALL sessions on this daemon, incl. ephemeral
               summons + other users' (from cyborg:list_daemon_sessions, LOCAL state). -->
          <p class="mb-3 text-[11px] text-content-dim">
            All sessions on this daemon, including ephemeral slash/@mention summons and
            every user's — your "what ran on my machine" lens. For the workspace-wide
            history, see
            <button
              type="button"
              class="underline hover:text-content"
              onclick={() => goto(`/workspace/${wsId}/settings/logs`)}
            >Settings → Logs</button>.
          </p>
          <SessionList
            scope="audit"
            sessions={auditSessions}
            {daemonId}
            emptyLabel="No sessions on this daemon."
          />
        {:else}
          <!-- Non-admin: today's scoped view over workspaceState.agents (unchanged). -->
          <p class="mb-3 text-[11px] text-content-dim">
            Your sessions on this daemon. For the workspace-wide history, see
            <button
              type="button"
              class="underline hover:text-content"
              onclick={() => goto(`/workspace/${wsId}/settings/logs`)}
            >Settings → Logs</button>.
          </p>
          <SessionList
            scope="daemon"
            sessions={workspaceState.agents}
            {daemonId}
            emptyLabel="No sessions on this daemon."
          />
        {/if}
      </section>
    </div>
  </div>
{/if}

<SetupCyboTerminalDialog
  bind:open={setupTerminalOpen}
  daemonLabel={detailDaemon?.label ?? "this daemon"}
  onClosed={handleSetupTerminalClosed}
/>

<!-- #35: enabling terminal or admin lets that user open a shell / run code on this
     machine (RCE). Confirm before escalating — never weaker than the old binary
     grant (which always confirmed). Only fires on a NEW terminal/admin scope. -->
<ConfirmDialog
  open={!!pendingScopeChange}
  title={pendingScopeChange?.escalated.includes("admin")
    ? "Grant admin (full host control)?"
    : "Allow a host shell?"}
  message={pendingScopeChange
    ? `Giving ${pendingScopeChange.name} the ${pendingScopeChange.escalated
        .map((s) => SCOPE_META[s].label)
        .join(" and ")} ${pendingScopeChange.escalated.length > 1 ? "scopes" : "scope"} lets them ${pendingScopeChange.escalated.includes("admin") ? "update/restart this machine and run code on it (RCE)" : "open a shell with access to this machine's files"}. Only grant this to people you trust with your computer.`
    : ""}
  confirmLabel="Grant"
  cancelLabel="Cancel"
  destructive
  onconfirm={() => {
    const c = pendingScopeChange;
    pendingScopeChange = null;
    if (c) void applyScopes(c.userId, c.scopes);
  }}
  oncancel={() => (pendingScopeChange = null)}
/>

<!-- Approve-request RCE confirm (#705 + #35): approving a request whose scopes
     include terminal/admin GRANTS a host shell / host control. Same confirm shape
     as the scope-edit escalation. -->
<ConfirmDialog
  open={!!pendingApproval}
  title={pendingApproval?.scopes.includes("admin")
    ? "Approve admin (full host control)?"
    : "Approve a host shell?"}
  message={pendingApproval
    ? `Approving ${pendingApproval.name}'s request lets them ${pendingApproval.scopes.includes("admin") ? "update/restart this machine and run code on it (RCE)" : "open a shell with access to this machine's files"}. Only approve this for people you trust with your computer.`
    : ""}
  confirmLabel="Approve"
  cancelLabel="Cancel"
  destructive
  onconfirm={() => {
    const a = pendingApproval;
    pendingApproval = null;
    if (a) void resolveRequest(a.id, "approve");
  }}
  oncancel={() => (pendingApproval = null)}
/>

<!-- Revoke impact (#705): surface how many running sessions this stops. -->
<ConfirmDialog
  open={!!pendingRevoke}
  title="Revoke daemon access?"
  message={pendingRevoke
    ? `${pendingRevoke.name} will lose all access to this daemon.${pendingRevoke.sessions > 0 ? ` This stops ${pendingRevoke.sessions} active ${pendingRevoke.sessions === 1 ? "session" : "sessions"} they're running here.` : ""}`
    : ""}
  confirmLabel="Revoke"
  cancelLabel="Cancel"
  destructive
  onconfirm={() => {
    const r = pendingRevoke;
    pendingRevoke = null;
    if (r) void applyScopes(r.userId, []);
  }}
  oncancel={() => (pendingRevoke = null)}
/>
