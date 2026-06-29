<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { toast } from "svelte-sonner";
  import { workspaceState, agentStreamState, attentionState, archiveAgent, daemonStatusState, client, providerState, fetchProviders, agentsPaneState, daemonState, authState, spawnCybo, sessionState, fetchSessions, loadMoreSessions, restoreSession } from "$lib/state/app.svelte.js";
  import type { ArchivedSession, ResumeOverrides } from "$lib/state/app.svelte.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import type { AttentionBadge } from "$lib/plugins/agents/attention-badge.js";
  import { cyboState, deleteCybo, fetchCybos } from "$lib/state/app.svelte.js";
  import ArchivedSessionRow from "$lib/components/channel/ArchivedSessionRow.svelte";
  import ProviderIcon from "$lib/plugins/agents/components/ProviderIcon.svelte";
  import CyborgIcon from "$lib/components/CyborgIcon.svelte";
  import CyboSessionAvatar from "$lib/components/CyboSessionAvatar.svelte";
  import ConversationRow from "$lib/components/channel/ConversationRow.svelte";
  import Avatar from "$lib/components/Avatar.svelte";
  import { sessionCyboIdentity } from "$lib/cybo-chat-identity.js";
  import DaemonDetail from "$lib/components/daemon/DaemonDetail.svelte";
  import CreateAgentDialog from "$lib/components/agent/CreateAgentDialog.svelte";
  import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    TooltipProvider,
  } from "$lib/components/ui/tooltip/index.js";
  import { cn, isDesktopApp, nameToColor, resolveAvatarSource } from "$lib/utils.js";
  import { MAC_DMG, WINDOWS_EXE } from "$lib/desktop-downloads.js";
  import AppleLogo from "$lib/components/brand/AppleLogo.svelte";
  import WindowsLogo from "$lib/components/brand/WindowsLogo.svelte";
  import { CYBO_CONFIGURED_TIP, CYBO_SETUP_CTA_LABEL, cyboBackendOf, cyboCapabilityFor, daemonDisplayName, isNativeHarnessCybo, nativeHarnessAvailable } from "$lib/cybo-capability.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import { agentDisplayName as sharedAgentDisplayName, providerBrandColor } from "$lib/agent-display.js";
  import { isCyboRunnable, shouldProbeCliStatus, shouldReprobeOnFocus } from "$lib/cybo-runnable.js";
  import { resolveSetupCyboCta, runtimeSupportsLogin } from "$lib/setup-cybo-cta.js";
  import { desktopTerminalBridge, openExternalUrl } from "$lib/desktop-terminal.js";
  import SetupCyboTerminalDialog from "$lib/components/daemon/SetupCyboTerminalDialog.svelte";
  import { providerRemedy, type RemedyAction } from "$lib/provider-remedy.js";
  import type { ProviderInfo, ProviderReasonKind } from "$lib/plugins/agents/types.js";
  import { ProviderUnavailableError } from "$lib/core/client.js";

  interface DaemonInfo {
    id: string;
    label: string;
    ownerId: string;
    status: string;
    lastSeenAt: number | null;
    meta?: { cpu?: number; memMb?: number; agents?: number; queueDepth?: number } | null;
  }

  let daemonsList = $state<DaemonInfo[]>([]);

  $effect(() => {
    if (wsId) {
      // Guard against stale responses: switching workspace mid-flight would let
      // the previous workspace's daemons overwrite the new one's list (same
      // pattern as DaemonSidebar/DaemonDetail).
      const target = wsId;
      client.listDaemons(target).then(({ daemons }) => {
        if (target !== wsId) return;
        daemonsList = daemons;
        daemonStatusState.load(daemons);
        return;
      })
        // intentional: background daemon-list load; a miss keeps the prior list, healed by daemon_status updates / remount.
        .catch(() => {});
      // Provider availability tells us whether Cybo (PI) is actually installed on
      // the user's daemon — used to flag un-runnable cybo templates. Target the
      // user's effective daemon: an un-targeted fetch is answered by an arbitrary
      // daemon in multi-daemon workspaces (wrong catalog).
      void fetchProviders(
        daemonState.selectedId ?? daemonState.effectiveId(authState.user?.id) ?? undefined,
      );
    }
  });

  // Sub-tab state is shared (agentsPaneState) so the DaemonSidebar — rendered
  // by the workspace layout, outside this pane — can switch to the Daemon
  // sub-tab in-page when a daemon is clicked, without navigating away.
  const activeSubTab = $derived(agentsPaneState.subTab);

  // Single source of truth for cybos: the workspace roster (cyboState.list).
  // The old starter/template system kept a separate, filtered list — removed so
  // every "Your cybos" surface shows exactly the same set.
  const myCybos = $derived(cyboState.list);

  // Refetch the authoritative roster whenever the cybo view (re)opens or the
  // workspace changes. The roster is otherwise populated once at workspace
  // select / reconnect, so a cybo deleted elsewhere (another device, the CLI,
  // or a delete that didn't reach this socket) lingered as a PHANTOM in
  // "Your cybos" until a hard reload. A fetch on open prunes it. Guarded against
  // a stale workspace clobbering a newer selection (mirrors the daemon-list
  // effect above); fetchCybos itself no-ops without an active workspace.
  $effect(() => {
    if (wsId) void fetchCybos();
  });

  // The daemon shown in the Daemon sub-tab: an explicit sidebar selection wins
  // (even if that daemon is offline — the user asked for it), else the
  // effective default.
  const shownDaemonId = $derived(
    daemonState.selectedId ?? daemonState.effectiveId(authState.user?.id),
  );
  const shownDaemon = $derived(shownDaemonId ? daemonState.byId(shownDaemonId) : undefined);
  // Is the shown daemon online right now? The cybo-runtime probe/install RPCs
  // only reach a connected daemon — gating the install CTA on this stops a
  // doomed click that fails and whose error is then wiped by the offline tick
  // (mirrors DaemonDetail's "offline — version unavailable" handling).
  const shownDaemonOnline = $derived(
    !!shownDaemonId && daemonStatusState.get(shownDaemonId) === "online",
  );

  // "New session" dialog: launches a provider session (or a cybo, pre-selected).
  // Creating a new cybo lives at /agent/new.
  let createDialogOpen = $state(false);
  let createDialogCyboId = $state<string | null>(null);

  // Same access gate as the header "Agent session" button — template cards
  // also launch sessions on the selected daemon, so they must not bypass it.
  function handleEditCybo(cyboId: string) {
    if (!wsId) return;
    goto(`/workspace/${wsId}/agent/new?edit=${cyboId}`);
  }

  // Clicking a cybo card opens its full profile (overview / tasks / cron /
  // activity / memory / edit) — NOT start-a-chat (that's the explicit button).
  function handleOpenProfile(cyboId: string) {
    if (!wsId) return;
    goto(`/workspace/${wsId}/cybo/${cyboId}`);
  }

  // Delete a cybo straight from its card (no need to open Edit). Owners/admins
  // can remove any cybo; the relay enforces the permission.
  let deletingId = $state<string | null>(null);
  async function handleDeleteCybo(c: { id: string; name: string; slug: string }): Promise<void> {
    if (deletingId) return;
    const label = c.name || `@${c.slug}`;
    if (!confirm(`Delete "${label}"? This removes it for the whole workspace and can't be undone.`)) {
      return;
    }
    deletingId = c.id;
    try {
      await deleteCybo(c.id);
      toast.success(`Deleted ${label}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete cybo");
    } finally {
      deletingId = null;
    }
  }

  const agents = $derived(workspaceState.agents);
  const wsId = $derived(workspaceState.current?.id ?? page.params.id);
  const onlineCount = $derived(agents.filter((a: { lifecycle: string }) => a.lifecycle === "running").length);
  const onlineDaemons = $derived(daemonsList.filter((d) => daemonStatusState.get(d.id) === "online").length);
  // Cybo CLI (PI) status for the shown daemon's host — probed on the daemon via
  // `cybo --version` (the bin @cyborg7/cybo links onto PATH; bundled `pi` isn't).
  // Drives the install CTA AND reconciles `cyboRunnable` below (the provider
  // snapshot can lag a fresh install). Probed on pane load for EVERY sub-tab where
  // the banner/CTA is visible (roster + daemon), cached by daemon (`cliLoadedFor`)
  // so it's a one-shot per daemon, not a re-probe on every tab switch.
  let cliStatus = $state<{ installed: boolean; version?: string | null; path?: string | null } | null>(
    null,
  );
  // Daemon id the current `cliStatus` was probed for (cache key), and whether a
  // probe is in flight (so the banner doesn't flash "isn't installed" mid-probe).
  let cliLoadedFor = $state<string | null>(null);
  let cliLoading = $state(false);
  let cliInstalling = $state(false);
  let cliInstallError = $state<string | null>(null);
  // Version after a SUCCESSFUL manual install this session — drives the success
  // check. Separate from cliStatus so the roster block can show success even
  // before the provider catalog refreshes.
  let cliJustInstalled = $state<string | null>(null);
  // The last daemon id this pane SHOWED. Plain (NON-$state) so writing it never
  // re-triggers the $effect below; used to detect an actual daemon SWITCH (id
  // changed) so status ticks don't wipe transient state like `cliInstallError`.
  // The offline branch re-runs on EVERY presence/status tick, and an
  // unconditional reset there wiped a freshly-set `cliInstallError` ~0.1s after
  // the user saw it — so it resets only on a real switch, not per tick. Recorded
  // unconditionally at the END of the $effect so a switch through an ONLINE
  // daemon is detected too.
  let lastShownDaemonId: string | null = null;
  // The command the install button runs ON the daemon (a MANUAL install, not an
  // auto-update) — shown in the UI and the failure fallback.
  // Default install command; on a failed install the daemon reports the host's
  // OWNING manager's command (pnpm/bun) and this updates so the manual hint works.
  let CYBO_INSTALL_CMD = $state("npm i -g @cyborg7/cybo@latest");

  // "No machine connected" empty state: lead the user to the desktop app (the
  // easiest way to get a first machine online), picking their OS. Falls back to
  // macOS. openExternalUrl works in both the desktop shell and the browser.
  const isWindows = /Win/i.test(globalThis.navigator?.userAgent ?? "");
  function downloadDesktopApp(): void {
    openExternalUrl(isWindows ? WINDOWS_EXE : MAC_DMG);
  }

  // Can the user actually run cybos here? Needs an online daemon with PI installed.
  // Reconcile the two (sometimes-disagreeing) signals — the provider snapshot can
  // lag a fresh install, so a confirmed `cybo --version` / install counts too. See
  // $lib/cybo-runnable for the full rationale. `cliStatus`/`cliJustInstalled` are
  // for `shownDaemonId`; the install button (which sets them) only runs on an online
  // daemon, so a confirmed install implies a runnable online daemon.
  const piProvider = $derived(providerState.list.find((p) => p.id === "pi"));
  const cyboInstalledHere = $derived(cliStatus?.installed === true || cliJustInstalled !== null);
  const cyboRunnable = $derived(
    isCyboRunnable(onlineDaemons, piProvider?.available ?? false, cyboInstalledHere),
  );
  // Name the daemon, not "this computer" — the probe/install target is
  // `shownDaemonId`, which may be a different machine than the one you're on.
  // (Foreign daemons get the dedicated #344 UX; the banner is suppressed there.)
  const cyboUnavailableReason = $derived(
    onlineDaemons === 0
      ? "You don't have an active daemon on this computer. These cybos belong to the workspace, but you need a daemon with the cybo runtime to run them."
      : `The cybo runtime isn't installed on ${shownDaemon?.label ?? "this daemon"}. Install it to run cybos:  npm i -g @cyborg7/cybo`,
  );

  // Thin wrapper over the ONE shared resolver ($lib/agent-display.ts) — do not
  // inline a local fallback chain here; that's exactly how this bug regressed.
  function agentName(agent: typeof agents[0]): string {
    return sharedAgentDisplayName(agent, cyboState.list);
  }

  function agentHandle(agent: typeof agents[0]): string {
    const name = agentName(agent);
    return name.toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function cyboAvatar(agent: typeof agents[0]): string | null {
    // Photo-URL avatar only (img branch); emoji/initials render via
    // CyboSessionAvatar. Denormalized row field first, then the roster.
    const identity = sessionCyboIdentity(agent, cyboState.list);
    return identity.image;
  }

  function agentRole(agent: typeof agents[0]): string {
    if (agent.cyboId) {
      const cybo = cyboState.list.find((c) => c.id === agent.cyboId);
      if (cybo?.role) return cybo.role;
    }
    return "Agent";
  }

  // Per-cybo live status, derived from sessions bound by cyboId: "active" when a
  // bound session is running or its daemon is online, "idle" when bound sessions
  // exist but none are live, "none" when the cybo has no session at all.
  function cyboStatus(cyboId: string): "active" | "idle" | "none" {
    const bound = agents.filter((a) => a.cyboId === cyboId);
    if (bound.length === 0) return "none";
    const live = bound.some(
      (a) =>
        agentStreamState.getTurnStatus(a.agentId) === "running" ||
        (a.daemonId ? daemonStatusState.get(a.daemonId) === "online" : false),
    );
    return live ? "active" : "idle";
  }

  // Always-visible status pill for a cybo card, so an idle / un-runnable cybo
  // never looks the same as a healthy one. A running session wins regardless of
  // local runtime; otherwise we flag "Inactive" when the cybo can't even start
  // here (no online daemon / PI not installed) and say WHY in the tooltip.
  function cyboBadge(cybo: { id: string; provider: string; model?: string | null }): {
    label: string;
    tone: "active" | "idle" | "inactive";
    tip: string;
  } {
    const s = cyboStatus(cybo.id);
    if (s === "active") return { label: "Active", tone: "active", tip: "A session is running" };
    if (s === "idle") return { label: "Idle", tone: "idle", tip: "Has sessions, none active right now" };
    // NATIVE harness (claude/codex): provider IS the harness (internal docs) — it
    // runs on the daemon's OWN provider, NOT the Cybo runtime, so the runtime
    // credentials axis below does not apply. Mirror the daemon's gate
    // (spawnHarnessGateBlocked): "configured + runnable" iff the shown daemon's
    // provider catalog lists the native provider as available. (The snapshot can
    // lag a fresh login; the Start-chat auto-heal re-probe recovers from that.)
    if (isNativeHarnessCybo(cybo.provider)) {
      const shown = shownDaemon ? daemonDisplayName(shownDaemon) : "this daemon";
      if (nativeHarnessAvailable(cybo.provider, providerState.list)) {
        return {
          label: `Configured on ${shown}`,
          tone: "idle",
          tip: `${shown}: ${CYBO_CONFIGURED_TIP}.`,
        };
      }
      return {
        label: "Needs setup",
        tone: "inactive",
        tip: `${CYBO_SETUP_CTA_LABEL}: ${shown} — ${cybo.provider} isn't connected there.`,
      };
    }
    // No sessions yet — distinguish "can run, just not started" from "can't run".
    if (!cyboRunnable) return { label: "Inactive", tone: "inactive", tip: cyboUnavailableReason };
    // REAL capability (internal docs item 3): WHERE can this cybo run today? Its
    // backend needs runtime credentials on a daemon — "Ready" unconditionally was
    // a lie when no online daemon is authenticated for it. Daemons without a
    // published profile stay "unknown" → fall back to the plain Ready of today.
    const backend = cyboBackendOf(cybo.provider, cybo.model ?? null);
    // accessibleOnline, not online: a backend configured only on a foreign
    // daemon (no daemon_access grant) is not "Ready" FOR THIS USER, and a
    // foreign daemon must not be suggested as the setup target.
    const cap = cyboCapabilityFor(backend ? [backend] : [], daemonState.accessibleOnline);
    if (cap.configured.length > 0) {
      const names = cap.configured.map(daemonDisplayName);
      const shown = names.slice(0, 2).join(", ") + (names.length > 2 ? ` +${names.length - 2}` : "");
      return {
        label: `Configured on ${shown}`,
        tone: "idle",
        tip: `${names.join(", ")}: ${CYBO_CONFIGURED_TIP}.`,
      };
    }
    if (cap.needsSetup.length > 0 && cap.unknown.length === 0) {
      const names = cap.needsSetup.map(daemonDisplayName).join(", ");
      return {
        label: "Needs setup",
        tone: "inactive",
        tip: `${CYBO_SETUP_CTA_LABEL}: ${names} — the Cybo runtime has no credentials for ${backend ?? "any backend"} there.`,
      };
    }
    return { label: "Ready", tone: "idle", tip: "No sessions yet — Start chat to run it" };
  }

  // Probe `cybo --version` on the shown daemon. CACHED by daemon (`cliLoadedFor`):
  // a call for an already-loaded daemon is a no-op, so switching sub-tabs / leaving
  // and returning to the pane never re-probes — only a daemon switch or `force`
  // does. The captured `target` guards every async write so a switch mid-probe
  // can't clobber the newly-shown daemon's status (and stops the first probe's
  // finally from clearing `cliLoading` while the second is in flight).
  async function loadCliStatus(force = false): Promise<void> {
    const target = shownDaemonId;
    if (!wsId || !target) return;
    if (!force && cliLoadedFor === target) return;
    if (cliLoadedFor !== target) {
      // New daemon: drop the previous daemon's status + transient install CTA state
      // so neither lingers under the wrong daemon.
      cliStatus = null;
      cliInstalling = false;
      cliInstallError = null;
      cliJustInstalled = null;
    }
    cliLoading = true;
    cliLoadedFor = target;
    try {
      const r = await client.cyboCliStatus(wsId, target);
      if (cliLoadedFor === target) cliStatus = r;
    } catch {
      if (cliLoadedFor === target) cliStatus = null;
    } finally {
      if (cliLoadedFor === target) cliLoading = false;
    }
  }

  // ── "Set up Cybo on this daemon" (internal docs Phase 1) ──
  // The embedded terminal only runs where the pty executes: this machine, in
  // the desktop app, for the user's OWN daemon. Anything else shows the exact
  // command instead (Phase 2 = remote PTY). The app hostname comes from the
  // desktop bridge (null in a browser → command fallback).
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
  const setupCta = $derived(
    resolveSetupCyboCta({
      hasTerminalBridge: desktopTerminalBridge() !== null,
      daemon: shownDaemon,
      currentUserId: authState.user?.id,
      appHostname,
      cliInstalled: cliStatus?.installed === true,
      cliVersion: cliStatus?.version,
    }),
  );
  let setupTerminalOpen = $state(false);
  // update-first path (W0's #399 finding): a runtime older than 0.2.6 treats
  // `cybo login` as a one-shot AI PROMPT — never spawn the terminal there. Run
  // the existing update RPC; runCyboInstall refreshes cliStatus.version on
  // success, so when the gate passes we open the terminal in the same click.
  async function handleUpdateThenSetup(): Promise<void> {
    await runCyboInstall();
    if (runtimeSupportsLogin(cliStatus?.version)) setupTerminalOpen = true;
  }
  // Terminal closed (user closed the dialog or `cybo login` exited) → run the
  // #369 provider re-probe on the daemon (heals the sticky "unavailable"
  // snapshot without a restart) + refresh the pane's own provider/CLI views so
  // the banner updates by itself.
  function handleSetupTerminalClosed(): void {
    const target = shownDaemonId;
    if (!wsId || !target) return;
    void client
      .refreshProviders(wsId, target)
      // intentional: best-effort re-probe after the setup terminal closed; the .then() refreshes providers + CLI status.
      .catch(() => {})
      .then(() => {
        void fetchProviders(target);
        void loadCliStatus(true);
        return;
      });
  }

  $effect(() => {
    // Probe on pane load for ANY sub-tab where the "isn't installed" banner / install
    // CTA can appear — the cybos ROSTER and the daemon sub-tab, not just "daemon".
    // The roster previously never probed, so it fell back to the (often stale / wrong-
    // daemon) provider snapshot and showed a false "isn't installed" banner every
    // visit. `loadCliStatus` caches by daemon, so this fires once per daemon (no loop).
    const onCyboTab = activeSubTab === "cybos" || activeSubTab === "daemon";
    const online = !!shownDaemonId && daemonStatusState.get(shownDaemonId) === "online";
    if (wsId && shouldProbeCliStatus({ onCyboTab, shownDaemonOnline: online, shownDaemonId, cliLoadedFor })) {
      void loadCliStatus();
    } else if (onCyboTab && shownDaemonId && !online && cliLoadedFor !== shownDaemonId) {
      // Offline shown daemon: drop a previous daemon's stale status; leave
      // `cliLoadedFor` unset so coming back online re-probes. Reset ONLY on an
      // actual daemon switch — this branch re-runs on every presence/status
      // tick while offline, and an unconditional reset wiped a just-set
      // `cliInstallError` before the user could read it (the install button is
      // now gated offline, but keep this reset switch-only regardless).
      if (shownDaemonId !== lastShownDaemonId) {
        cliStatus = null;
        cliInstallError = null;
        cliJustInstalled = null;
      }
    }
    // Record the daemon this run showed, AFTER the if/else-if. Unconditional so a
    // switch through an online daemon (A offline → B online → A offline) is still
    // detected — otherwise A would keep B's stale status. Repeated ticks for the
    // SAME offline daemon have `shownDaemonId === lastShownDaemonId`, so the reset
    // above doesn't run and a freshly-set `cliInstallError` survives.
    lastShownDaemonId = shownDaemonId;
  });

  // External-login heal: the user ran `cybo login` in a terminal and came back
  // to the app — nothing re-probes (the per-daemon cache above correctly never
  // re-fires), so a "needs setup" banner sticks until reload. On window focus,
  // force a status re-probe (its RPC also triggers the daemon's passive
  // snapshot reconcile, #358) and refetch the provider catalog so the banner
  // recomputes. User-driven + throttled per daemon (no loops); the provider
  // refetch can race the daemon-side reconcile by design — the NEXT focus
  // (≥30s later) converges.
  const focusProbeAt = new Map<string, number>();
  function handleWindowFocus(): void {
    const target = shownDaemonId;
    const onCyboTab = activeSubTab === "cybos" || activeSubTab === "daemon";
    const online = !!target && daemonStatusState.get(target) === "online";
    if (
      !wsId ||
      !target ||
      !shouldReprobeOnFocus({
        onCyboTab,
        shownDaemonOnline: online,
        shownDaemonId: target,
        lastProbeAt: focusProbeAt.get(target) ?? null,
        now: Date.now(),
      })
    ) {
      return;
    }
    focusProbeAt.set(target, Date.now());
    void loadCliStatus(true).then(() =>
      shownDaemonId === target ? fetchProviders(target) : undefined,
    );
  }

  // Install/upgrade the cybo CLI ON the shown daemon's host via the SAME RPC the
  // DaemonDetail "Install" button uses (cyborg:cybo_cli_update → npm i -g
  // @cyborg7/cybo@latest). On success, reflect the new status. Capture the target
  // daemon up front and guard every post-await write so a slow install resolving
  // after the user switched daemons can't clobber the newly-shown daemon's state.
  async function runCyboInstall(): Promise<void> {
    if (!wsId || !shownDaemonId || !shownDaemonOnline || cliInstalling) return;
    const targetDaemonId = shownDaemonId;
    cliInstalling = true;
    cliInstallError = null;
    cliJustInstalled = null;
    try {
      const r = await client.cyboCliUpdate(wsId, targetDaemonId);
      // Ignore a stale result if the user switched daemons mid-install.
      if (shownDaemonId !== targetDaemonId) return;
      if (r.ok) {
        cliStatus = { installed: r.installed, version: r.version, path: cliStatus?.path ?? null };
        cliLoadedFor = targetDaemonId; // the cache now reflects this fresh probe
        cliJustInstalled = r.version ?? "latest";
        // Re-fetch the target daemon's provider catalog so `piProvider` (and thus
        // `cyboRunnable`) recomputes — otherwise the "Cybo (PI) isn't installed"
        // banner stays up even though the install succeeded. Same fetchProviders
        // path the load $effect uses; it's keyed by daemonId. Re-guard after the
        // await so a daemon switch during it doesn't refresh under the wrong daemon.
        await fetchProviders(targetDaemonId);
        if (shownDaemonId !== targetDaemonId) return;
      } else {
        cliInstallError = r.error ?? "Install failed.";
        if (r.command) CYBO_INSTALL_CMD = r.command;
      }
    } catch (e) {
      if (shownDaemonId === targetDaemonId) {
        cliInstallError = e instanceof Error ? e.message : "Install failed.";
      }
    } finally {
      if (shownDaemonId === targetDaemonId) cliInstalling = false;
    }
  }

  function getUsagePct(agentId: string): number {
    const usage = agentStreamState.getUsage(agentId);
    if (!usage?.totalCostUsd) return 0;
    return Math.min(1, usage.totalCostUsd / 25);
  }

  // Known provider CLIs use their brand color (Claude = orange); the rest fall
  // back to the ONE shared hashed palette (utils.ts nameToColor, #528) so an
  // identity gets the same swatch on every surface. providerBrandColor is also
  // shared, so every surface agrees.
  function avatarColor(provider: string, name: string): string {
    return providerBrandColor(provider) ?? nameToColor(name);
  }

  // ─── Status taxonomy (real signals, not mock) ────────────────────
  // WAITING  — paused for human approval (pending permissions)   [sorts first]
  // WORKING  — currently in a turn
  // IDLE     — process up + daemon online, no active turn
  // OFFLINE  — process not running, or its daemon is offline
  type AgentStatus = "waiting" | "working" | "idle" | "offline";

  function agentStatus(agent: typeof agents[0]): AgentStatus {
    const daemonOnline = agent.daemonId ? daemonStatusState.get(agent.daemonId) === "online" : true;
    // Availability follows the daemon (matching ChannelSidebar): an agent is
    // offline only when its daemon is down or its process has ended/errored. A
    // finished-but-ready agent reports lifecycle "idle" — that's IDLE (online),
    // not OFFLINE.
    if (!daemonOnline || agent.lifecycle === "closed" || agent.lifecycle === "error") return "offline";
    if (agentStreamState.getPendingPermissions(agent.agentId).length > 0) return "waiting";
    if (agentStreamState.getTurnStatus(agent.agentId) === "running" || agent.lifecycle === "running")
      return "working";
    return "idle";
  }

  const STATUS_META: Record<
    AgentStatus,
    { label: string; line: string; color: string; rank: number }
  > = {
    waiting: { label: "Waiting", line: "Waiting for your approval", color: "var(--health-watching-text, #e8ab5a)", rank: 0 },
    working: { label: "Working", line: "Working now", color: "var(--agent-accent, #7c3aed)", rank: 1 },
    idle: { label: "Idle", line: "Online · idle", color: "var(--health-ok-text, #16a34a)", rank: 2 },
    offline: { label: "Offline", line: "Offline", color: "var(--text-muted)", rank: 3 },
  };

  // Default sort: Waiting → Working → Idle → Offline ("needs you" floats up).
  // Enrich once per agent (status/name/avatar/model/pct) then sort on the
  // precomputed rank — avoids re-running the reactive lookups during every
  // sort comparison and again in the template.
  const sortedAgents = $derived(
    agents
      .map((agent) => {
        const st = agentStatus(agent);
        return {
          agent,
          name: agentName(agent),
          avatar: cyboAvatar(agent),
          st,
          meta: STATUS_META[st],
          model: agentModel(agent),
          pct: getUsagePct(agent.agentId),
          // Curated, glanceable "what is this agent doing right now" line (#594):
          // [Shell] pnpm test → [Assistant] Done. Reads the live stream so it
          // advances with the timeline; null until there's activity (then the row
          // falls back to the generic status line).
          lastActivity: agentStreamState.getLastActivity(agent.agentId),
        };
      })
      .sort((a, b) => a.meta.rank - b.meta.rank),
  );

  function agentModel(agent: typeof agents[0]): string | null {
    const m = agentStreamState.getModel(agent.agentId) ?? agent.model;
    return m ? (m.split("/").pop() ?? m) : null;
  }

  // #591: the derived "needs attention" badge (finished/errored — review me) for
  // an agent row, or null. Distinct from the WAITING status (pending permission),
  // which the status taxonomy + permission chip already own — so the two never
  // double-count: a permission prompt is "Waiting", a finished/errored turn is
  // this badge.
  function attentionBadge(agentId: string): AttentionBadge | null {
    return attentionState.badgeFor(agentId);
  }

  function handleOpenAgent(agentId: string) {
    if (!wsId) return;
    goto(`/workspace/${wsId}/agent/${agentId}`);
  }

  function handleNewAgent() {
    if (!canLaunchOnShownDaemon) return;
    createDialogCyboId = null;
    createDialogOpen = true;
  }

  // Per-cybo in-flight guard so a rapid double-click can't fire two spawns
  // (each would also navigate) for the same cybo card.
  let spawningCybos = $state<Record<string, boolean>>({});

  // The ProviderInfo that gates a given cybo on the shown daemon: the one whose
  // id matches the cybo's resolved backend (cyboBackendOf), falling back to the
  // cybo runtime ("pi") row. Carries the daemon's classified unavailableReason /
  // reasonKind (the locked ProviderInfo contract) — the honest-error source.
  function gatingProviderFor(cybo: { provider: string; model?: string | null }): ProviderInfo | undefined {
    const backend = cyboBackendOf(cybo.provider, cybo.model ?? null);
    const byBackend = backend ? providerState.list.find((p) => p.id === backend) : undefined;
    return byBackend ?? providerState.list.find((p) => p.id === "pi");
  }

  // Does the backend look unavailable right now (the chat would fail)? True when
  // the gating provider reports !available, OR capability says this cybo needs
  // setup on the online daemons. Used to decide whether to auto-heal.
  function backendLooksUnavailable(cybo: { provider: string; model?: string | null }): boolean {
    const gating = gatingProviderFor(cybo);
    if (gating && gating.available === false) return true;
    // NATIVE harness: it doesn't route through the Cybo runtime, so the runtime
    // capability axis below must NOT gate it — its sole signal is the native
    // provider's `available` flag, already checked above. Anything else here
    // would falsely flag a connected native harness as "needs heal".
    if (isNativeHarnessCybo(cybo.provider)) {
      return !nativeHarnessAvailable(cybo.provider, providerState.list);
    }
    const backend = cyboBackendOf(cybo.provider, cybo.model ?? null);
    // accessibleOnline: "configured on a daemon you can't use" must still
    // count as unavailable, and the heal path can only set up YOUR daemons.
    const cap = cyboCapabilityFor(backend ? [backend] : [], daemonState.accessibleOnline);
    return cap.configured.length === 0 && cap.needsSetup.length > 0;
  }

  // A spawn error that smells like a backend gap (provider not connected / no
  // model / auth) vs an unrelated failure — only the former is worth auto-healing.
  function looksLikeBackendGap(err: unknown): boolean {
    // The daemon now sends a typed, code-tagged refusal — trust it directly.
    if (err instanceof ProviderUnavailableError) return true;
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    return (
      msg.includes("provider") ||
      msg.includes("not configured") ||
      msg.includes("no model") ||
      msg.includes("unavailable") ||
      msg.includes("auth") ||
      msg.includes("credential") ||
      msg.includes("login") ||
      msg.includes("not found")
    );
  }

  // Run one remedy action surfaced by the honest-error toast: open the URL, or
  // open the existing SetupCyboTerminalDialog (cybo login). recheck just re-runs
  // the heal probe (no-op here — the toast's Fix is the primary path).
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
        if (wsId && shownDaemonId) {
          void client
            .refreshProviders(wsId, shownDaemonId)
            // intentional: best-effort recheck re-probe; the .then() fetch refreshes the provider view.
            .catch(() => {})
            .then(() => fetchProviders(shownDaemonId ?? undefined));
        }
        break;
    }
  }

  // Surface the HONEST reason a cybo wouldn't start (provider's classified
  // unavailableReason/reasonKind + the remedy mapper) with a one-tap "Fix" that
  // opens the remedy's first action — NOT a generic "run cybo login".
  function surfaceStartChatError(cybo: { provider: string; model?: string | null }, err: unknown): void {
    const gating = gatingProviderFor(cybo);
    // Prefer the daemon's PRECISE per-backend reason from the spawn refusal
    // (ProviderUnavailableError carries the exact classified kind/reason), and
    // fall back to the gating provider's row, then the raw message.
    const typed = err instanceof ProviderUnavailableError ? err : null;
    const reasonKind = ((typed?.reasonKind ?? gating?.reasonKind) ?? null) as
      | ProviderReasonKind
      | null;
    const reasonText =
      typed?.unavailableReason ??
      gating?.unavailableReason ??
      (err instanceof Error ? err.message : null);
    const remedy = providerRemedy(reasonKind, gating?.label ?? cybo.provider, reasonText);
    const primary = remedy.actions[0];
    toast.error(remedy.title, {
      description: remedy.body,
      ...(primary
        ? { action: { label: primary.label, onClick: () => runRemedyAction(primary) } }
        : {}),
    });
  }

  // "Start chat" on a cybo card — launch a session with THAT cybo, no intermediate
  // dialog. The daemon spawns it in the cybo's own sandboxed dir (~/.cybo/agents/<id>),
  // so we pass no cwd. One unified spawn path.
  async function handleStartChat(cyboId: string) {
    if (!wsId || spawningCybos[cyboId]) return;
    const cybo = cyboState.list.find((c) => c.id === cyboId);
    if (!cybo) return;
    // Per-cybo gate (native harness vs runtime) — see cyboStartBlocked.
    if (cyboStartBlocked(cybo)) return;
    spawningCybos[cyboId] = true;
    try {
      // A LOCAL (disk) cybo only exists on its home machine: the roster is
      // served by ONE workspace daemon, so a local entry may belong to a
      // different daemon than the one shown here. Target its HOME daemon —
      // spawning it anywhere else is a guaranteed "Cybo not found" (the relay
      // can't enrich a cybo that isn't in the workspace DB).
      const isLocalCybo = cybo.isLocal || cybo.id.startsWith("local:");
      const homeDaemonId = isLocalCybo ? (cybo.daemonId ?? undefined) : undefined;
      const targetDaemonId = homeDaemonId ?? shownDaemonId ?? undefined;

      // Auto-heal: the daemon's provider snapshot is sticky, so a backend that
      // looks unavailable here can actually be fine after a re-probe. If it looks
      // unavailable up front, silently refresh providers + re-evaluate BEFORE
      // spawning, so a healthy backend never shows a spurious error.
      if (backendLooksUnavailable(cybo)) {
        // intentional: silent pre-spawn auto-heal re-probe; a still-failing spawn surfaces via the outer catch (surfaceStartChatError).
        await client.refreshProviders(wsId, targetDaemonId).catch(() => {});
        await fetchProviders(targetDaemonId);
      }

      let agentId: string;
      try {
        agentId = await spawnCybo(cybo.slug || cybo.id, undefined, { daemonId: targetDaemonId });
      } catch (spawnErr) {
        // Spawn threw something that smells like a backend gap — re-probe once
        // and retry the spawn a SINGLE time. A transient sticky-snapshot miss
        // self-heals without bothering the user.
        if (!looksLikeBackendGap(spawnErr)) throw spawnErr;
        // intentional: silent re-probe before the single spawn retry; a failed retry throws to the outer catch (honest error).
        await client.refreshProviders(wsId, targetDaemonId).catch(() => {});
        await fetchProviders(targetDaemonId);
        agentId = await spawnCybo(cybo.slug || cybo.id, undefined, { daemonId: targetDaemonId });
      }
      // ?cybo= carries the cybo's identity into the chat view from frame 0
      // (photo/name from the roster — no Cyborg/bot placeholder flash) and
      // lets the view name the cybo if the session vanishes (rollback toast).
      goto(`/workspace/${wsId}/agent/${agentId}?cybo=${encodeURIComponent(cybo.id)}`);
    } catch (err) {
      // Still failing after the heal+retry — surface the HONEST reason + a Fix
      // action (the remedy mapper), not a generic "run cybo login".
      console.error("Failed to start chat with cybo:", err);
      surfaceStartChatError(cybo, err);
    } finally {
      spawningCybos[cyboId] = false;
    }
  }

  // New sessions launch ON the daemon selected in the sidebar — if the user
  // has no daemon_access grant there (e.g. a teammate's daemon), launching is
  // blocked with an explanatory tooltip instead of failing on spawn.
  const currentUserId = $derived(authState.user?.id);
  const canLaunchOnShownDaemon = $derived(
    !shownDaemonId ||
      (!!currentUserId && daemonState.accessUserIds(shownDaemonId).includes(currentUserId)),
  );
  const launchBlockedReason = $derived(
    `You don't have access to ${shownDaemon?.label ?? "this daemon"} — sessions launch on the selected daemon. Pick another daemon in the sidebar or ask the owner for access.`,
  );

  // Per-cybo "Start chat" gate. The pane-wide `cyboRunnable` is the Cybo
  // RUNTIME (pi) signal — correct for runtime cybos, but a NATIVE-harness cybo
  // (provider claude/codex, internal docs) doesn't use the runtime at all: it
  // spawns on the daemon's own provider, so it's runnable when that native
  // provider is available on the shown daemon (mirrors the daemon's gate), even
  // if pi isn't installed. Access to the shown daemon still applies to both.
  function cyboStartBlocked(cybo: { provider: string; model?: string | null }): boolean {
    if (!canLaunchOnShownDaemon) return true;
    if (isNativeHarnessCybo(cybo.provider)) {
      return onlineDaemons === 0 || !nativeHarnessAvailable(cybo.provider, providerState.list);
    }
    return !cyboRunnable;
  }
  // Warn NOTORIOUSLY when the daemon shown here isn't the user's own — even if
  // they have an access grant — so they never create cybos/sessions on a
  // teammate's machine without realizing it.
  const shownDaemonForeign = $derived(
    !!shownDaemon && !!currentUserId && shownDaemon.ownerId !== currentUserId,
  );
  const shownDaemonOwnerName = $derived.by(() => {
    if (!shownDaemon) return "another user";
    const m = workspaceState.members.find((mm) => mm.userId === shownDaemon.ownerId);
    return m?.name ?? m?.email ?? "another user";
  });
  // Viewing SOMEONE ELSE's daemon with no access to launch on it: you can't start
  // sessions or install cybos here. Surfaced prominently so the missing "Start chat"
  // (and hidden install) is never a silent mystery.
  const foreignNoLaunch = $derived(shownDaemonForeign && !canLaunchOnShownDaemon);

  function handleNewCybo() {
    if (!wsId) return;
    goto(`/workspace/${wsId}/agent/new`);
  }

  // Split the cybo roster so the desktop "Your cybos" grid LEADS with the ones
  // that have a live session (the green "Active" pill) and tucks the rest behind
  // a collapsible "Inactive · N" section — same idea as the mobile DMs tab's
  // online/offline split and the Archived/Offline collapse pattern. "Active"
  // here mirrors the status pill: cyboBadge tone === "active" (a session is
  // running). Everything else (idle / ready / configured / needs-setup) is
  // "inactive" for the purposes of this collapse.
  const activeCybos = $derived(myCybos.filter((c) => cyboBadge(c).tone === "active"));
  const inactiveCybos = $derived(myCybos.filter((c) => cyboBadge(c).tone !== "active"));
  // Collapsed by default (mirrors offlineAgentsOpen on mobile).
  let inactiveCybosOpen = $state(false);

  // ─── Archived sessions (moved off the chat sidebar) ─────────────────
  // Ended provider/cybo sessions you can restore. This pane is now the desktop
  // home for browsing + restoring them (the ChannelSidebar section was removed),
  // so a user with no open session can still get back to one from here. Reuses
  // the SAME machinery the sidebar used: sessionState/fetchSessions/restoreSession
  // and the ArchivedSessionRow component, so restore behavior is identical.
  const archivedSessions = $derived(sessionState.list);
  // Archived sessions are paginated SERVER-SIDE (keyset cursor): fetchSessions loads
  // page 1 and "Show more" appends older pages via loadMoreSessions, so the daemon
  // never streams an unbounded archive and the DOM only holds what was fetched.
  function handleLoadMoreSessions() {
    void loadMoreSessions();
  }
  // Collapsed by default — leads with live sessions, tucks the archive away
  // (mirrors the Inactive cybos / mobile Offline collapse pattern).
  let archivedSessionsOpen = $state(false);
  let archivedRestoringId = $state<string | null>(null);
  // Guarded one-shot fetch (mirrors the sidebar's sessionsFetchGuard): pull the
  // archived list once the workspace is known, refetching when it changes.
  let archivedFetchedWsId = $state<string | null>(null);
  $effect(() => {
    if (wsId && archivedFetchedWsId !== wsId && !sessionState.loading) {
      archivedFetchedWsId = wsId;
      void fetchSessions();
    }
  });

  // A cybo session reads "<Cybo> session", not "<provider> session" — prefer the
  // server-denormalized name (or a cyboState lookup), then the provider. Copied
  // verbatim from the sidebar so the row label is identical.
  function sessionDisplayName(session: ArchivedSession): string {
    if (session.title) return session.title;
    return `${sharedAgentDisplayName(session, cyboState.list)} session`;
  }

  function sessionTimeAgo(ts: number): string {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }

  async function handleRestoreSession(session: ArchivedSession, overrides?: ResumeOverrides) {
    if (!wsId || archivedRestoringId) return;
    // Snapshot the reactive wsId before the await: if the user switches
    // workspaces mid-restore, the post-await `goto` must target the workspace
    // we restored INTO, not whatever is current now (Gemini — race/404 guard).
    const currentWsId = wsId;
    archivedRestoringId = session.id;
    try {
      const agentId = await restoreSession(session.id, overrides);
      goto(`/workspace/${currentWsId}/agent/${agentId}?from=session`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't restore the session");
    } finally {
      archivedRestoringId = null;
    }
  }

  function handleClose() {
    if (!wsId) return;
    const first = workspaceState.channels[0];
    if (first) goto(`/workspace/${wsId}/channel/${first.id}`);
    else goto(`/workspace/${wsId}`);
  }

  // ─── Mobile presentation helpers (S6/P6) ────────────────────────
  // Everything below feeds ONLY the viewportState.isMobile branch — same state,
  // same handlers, iOS rows instead of the desktop card grid.

  // Mobile has no hover tooltips: a blocked "new session" tap explains itself
  // with a toast instead of silently doing nothing.
  function handleNewAgentMobile(): void {
    if (!canLaunchOnShownDaemon) {
      toast.error(launchBlockedReason);
      return;
    }
    handleNewAgent();
  }

  // Row tap = the card's primary action (Start chat). When the cybo can't run
  // here, surface the desktop tooltip's explanation as a toast instead.
  function handleCyboRowTap(c: (typeof myCybos)[number], tip: string): void {
    if (cyboStartBlocked(c)) {
      toast.info(tip);
      return;
    }
    void handleStartChat(c.id);
  }

  // Lifecycle-dot color for a cybo row's badge tone — matches the Home
  // dashboard's agent-row dot palette.
  function cyboToneColor(tone: "active" | "idle" | "inactive"): string {
    if (tone === "active") return "var(--color-success)";
    if (tone === "inactive") return "var(--warning, #e8ab5a)";
    return "#6b7280";
  }

  // Sessions list grouped by the existing status taxonomy (13px uppercase
  // section headers). Built from sortedAgents so the enrichment runs once.
  const SESSION_SECTION_LABELS: Record<AgentStatus, string> = {
    waiting: "Needs attention",
    working: "Running",
    idle: "Idle",
    offline: "Offline",
  };
  const mobileSessionSections = $derived.by(() => {
    const order: AgentStatus[] = ["waiting", "working", "idle", "offline"];
    return order
      .map((st) => ({
        st,
        label: SESSION_SECTION_LABELS[st],
        items: sortedAgents.filter((s) => s.st === st),
      }))
      .filter((s) => s.items.length > 0);
  });

  // Status line under a session row, matching the Home dashboard's agent rows:
  // "lifecycle · model · Remote". When the live timeline has a curated activity
  // (#594), prefer that glanceable one-liner ([Shell] pnpm test → [Assistant]
  // Done) so the mobile list is scannable too; fall back to the static line until
  // there's activity. ConversationRow already truncates this preview string.
  function mobileSessionLine(
    s: (typeof sortedAgents)[number],
  ): string {
    if (s.lastActivity) {
      return s.lastActivity.line;
    }
    return [s.meta.label, s.model, s.agent.daemonLocal === false ? "Remote" : null]
      .filter(Boolean)
      .join(" · ");
  }

  // Segmented control entries (same agentsPaneState.subTab state as desktop).
  const mobileTabs = $derived.by(() => {
    const tabs: { key: "cybos" | "agents" | "daemon"; label: string }[] = [
      { key: "cybos", label: myCybos.length > 0 ? `Agents · ${myCybos.length}` : "Agents" },
      { key: "agents", label: agents.length > 0 ? `Sessions · ${agents.length}` : "Sessions" },
    ];
    if (shownDaemonId) tabs.push({ key: "daemon", label: "Daemon" });
    return tabs;
  });
</script>

<!-- External-login heal: re-probe the cybo runtime when the window regains
     focus (terminal `cybo login` round-trip). Gated + throttled per daemon. -->
<svelte:window onfocus={handleWindowFocus} />

<!-- Shared install CTA: clear progress (spinner + package@version), success check
     with the installed version, and an error with the manual command. Made it a
     snippet so the Daemon sub-tab and the cybos roster show identical feedback. -->
{#snippet cyboInstallControls()}
  {#if !shownDaemonOnline}
    <!-- Offline daemon: the install/probe RPCs can't reach it, so don't show a
         doomed button (its failure was wiped by the offline status tick before
         the user could read it). Mirror DaemonDetail's "offline — unavailable"
         handling with a muted notice + how to recover. -->
    <div class="text-[11px] text-content-muted">
      {shownDaemon?.label ?? "This daemon"} is offline. Its cybo runtime can't be checked or installed until it's back online — open it in the Daemon tab and bring it online, then retry.
    </div>
  {:else}
  <div class="flex flex-col gap-1.5">
    <div class="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onclick={runCyboInstall}
        disabled={cliInstalling}
        class="inline-flex items-center gap-1.5 px-2.5 py-1 text-[12px] font-medium rounded cursor-pointer disabled:cursor-default disabled:opacity-80 border border-edge bg-surface-alt text-content"
        style="font-family: inherit;"
      >
        {#if cliInstalling}
          <span class="h-3 w-3 shrink-0 rounded-full border-2 border-current border-t-transparent animate-spin"></span>
          {cliStatus?.installed ? "Updating" : "Installing"} @cyborg7/cybo@latest…
        {:else}
          {cliStatus?.installed ? "Update to latest" : "Install latest cybo"}
        {/if}
      </button>
      <code class="text-[11px] px-2 py-1 rounded bg-edge-dim text-content" style="font-family: ui-monospace, monospace;">{CYBO_INSTALL_CMD}</code>
    </div>
    {#if cliInstalling}
      <div class="text-[11px] text-content-dim">
        Running <span class="font-mono">{CYBO_INSTALL_CMD}</span> on the daemon — this can take a moment…
      </div>
    {:else if cliInstallError}
      <div class="text-[11px] text-error">
        {cliStatus?.installed ? "Update" : "Install"} failed: {cliInstallError}
        <span class="block mt-0.5 text-content-muted">Run it manually on the daemon host: <span class="font-mono">{CYBO_INSTALL_CMD}</span></span>
      </div>
    {:else if cliJustInstalled}
      <div class="flex items-center gap-1.5 text-[11px] text-online">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M20 6 9 17l-5-5"/></svg>
        cybo {cliJustInstalled} ready
      </div>
    {:else if cliStatus?.installed}
      <div class="text-[11px] text-content-muted">
        Installed — runs <span class="font-mono">{CYBO_INSTALL_CMD}</span> to update to the latest published version.
      </div>
    {:else}
      <div class="text-[11px] text-content-muted">
        Manual install (not an auto-update) — runs <span class="font-mono">{CYBO_INSTALL_CMD}</span> on this daemon.
      </div>
    {/if}
  </div>
  {/if}
{/snippet}

<!-- Desktop "Your cybos" card — compact & minimal. Reused by the active grid and
     the collapsed "Inactive" grid so both render identically (one source of
     truth for the card). Keeps every action/info: avatar, name, @handle,
     role/description, capability chips, model, Start chat / Edit / delete, and
     the status badge. Active cards get a subtle accent ring. -->
{#snippet cyboCard(c: (typeof myCybos)[number])}
  {@const badge = cyboBadge(c)}
  {@const startBlocked = cyboStartBlocked(c)}
  {@const avatarSource = resolveAvatarSource(c.avatar, c.name)}
  <article
    class={cn(
      "group/tpl relative flex cursor-pointer flex-col gap-2 rounded-lg border border-edge bg-surface-alt p-3 transition-colors hover:border-edge-light",
    )}
    role="button"
    tabindex="0"
    onclick={() => handleOpenProfile(c.id)}
    onkeydown={(e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handleOpenProfile(c.id);
      }
    }}
    aria-label={`Open ${c.name} profile`}
  >
    <div class="flex items-center gap-2.5">
      {#if avatarSource.kind === "image"}
        <img src={avatarSource.value} alt={c.name} class="h-8 w-8 shrink-0 rounded-lg object-cover" />
      {:else if avatarSource.kind === "emoji"}
        <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-alt text-[18px] leading-none">
          <span aria-hidden="true">{avatarSource.value}</span>
        </div>
      {:else}
        <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style="background: linear-gradient(135deg, var(--agent-accent, #6366f1), #5BB5F0);">
          <CyborgIcon size={16} class="text-accent-foreground" />
        </div>
      {/if}
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1.5">
          <span class="truncate text-[13px] font-semibold leading-tight text-content">{c.name}</span>
          <span class="shrink-0 text-[11px] text-content-muted">@{c.slug}</span>
        </div>
        {#if c.role || c.description}
          <div class="truncate text-[11.5px] leading-tight text-content-dim">{c.role ?? c.description}</div>
        {/if}
      </div>
    </div>

    <!-- Status pill on its OWN line below the name/@handle. The label can be a
         long "Configured on <host>" / "Needs setup", so keeping it inline with
         the flex-1 name collapsed the name to zero and the gray label landed on
         the handle's row (the overlap bug). On its own row it has the full card
         width, truncates with the full text in the tooltip, and the idle tone
         uses the readable content-dim token (not the dimmer content-muted) so
         it's legible on the card. -->
    <div class="flex min-w-0">
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger>
            {#snippet child({ props })}
              <span
                {...props}
                class="inline-flex min-w-0 max-w-full cursor-help items-center gap-1 rounded-full px-1.5 py-[2px] text-[10px] font-semibold"
                style="background: {badge.tone === 'active'
                  ? 'color-mix(in srgb, var(--color-online) 14%, transparent)'
                  : badge.tone === 'inactive'
                    ? 'color-mix(in srgb, var(--color-warning, #e8ab5a) 18%, transparent)'
                    : 'var(--border-dim)'}; color: {badge.tone === 'active'
                  ? 'var(--color-online)'
                  : badge.tone === 'inactive'
                    ? 'var(--color-warning, #e8ab5a)'
                    : 'var(--text-secondary)'};"
              >
                <span
                  class="h-[5px] w-[5px] shrink-0 rounded-full"
                  class:animate-pulse={badge.tone === "active"}
                  style="background: currentColor;"
                ></span>
                <span class="truncate">{badge.label}</span>
              </span>
            {/snippet}
          </TooltipTrigger>
          <TooltipContent side="bottom" class="max-w-[260px] text-xs leading-snug">
            {badge.tip}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>

    {#if c.soulExcerpt}
      <p class="m-0 line-clamp-1 text-[11px] leading-snug text-content-muted" title={c.soulExcerpt}>{c.soulExcerpt}</p>
    {/if}


    <div class="flex items-center justify-end gap-2">
      <div class="flex shrink-0 items-center gap-1">
        <!-- Start chat only when the cybo can actually run; otherwise hidden
             (the status badge already says why). Model/provider moved to the
             profile screen — cards stay minimal. -->
        {#if !startBlocked}
          <button
            type="button"
            onclick={(e) => {
              e.stopPropagation();
              handleStartChat(c.id);
            }}
            disabled={spawningCybos[c.id]}
            aria-disabled={spawningCybos[c.id]}
            aria-label="Start chat with {c.name}"
            class="inline-flex items-center gap-1 rounded-md px-2 py-[4px] text-[11px] font-semibold transition-opacity hover:opacity-90"
            style="background: var(--agent-accent, #7c3aed); color: var(--btn-primary-text, #fff); border: 1px solid transparent; font-family: inherit; opacity: {spawningCybos[c.id] ? 0.6 : 1}; cursor: {spawningCybos[c.id] ? 'wait' : 'pointer'};"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 8.6 8.6 0 0 1-3.9-.9L3 21l1.9-5.6A8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z"/></svg>
            {spawningCybos[c.id] ? "Starting…" : "Start chat"}
          </button>
        {/if}
        <button
          type="button"
          onclick={(e) => {
            e.stopPropagation();
            handleEditCybo(c.id);
          }}
          title="Edit agent"
          aria-label="Edit {c.name}"
          class="inline-flex items-center justify-center rounded-md border border-edge bg-transparent px-1.5 py-[4px] text-content-dim transition-colors hover:bg-hover-gray"
          style="font-family: inherit;"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>
        </button>
        <button
          type="button"
          onclick={(e) => {
            e.stopPropagation();
            handleDeleteCybo(c);
          }}
          disabled={deletingId === c.id}
          title="Delete cybo"
          aria-label="Delete {c.name}"
          class="inline-flex items-center justify-center rounded-md border border-edge bg-transparent px-1.5 py-[4px] text-content-muted transition-colors hover:bg-error/10 hover:text-error disabled:cursor-not-allowed disabled:opacity-50"
          style="font-family: inherit;"
        >
          {#if deletingId === c.id}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="animate-spin"><path d="M21 12a9 9 0 1 1-6.2-8.5"/></svg>
          {:else}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
          {/if}
        </button>
      </div>
    </div>
  </article>
{/snippet}

{#if viewportState.isMobile}
<!-- ── Mobile presentation (S6/P6): iOS rows matching the Home dashboard's
     agent rows — same state, handlers, sub-tabs, install/setup CTAs and
     warnings as the desktop branch below; only the rendering differs. ── -->
<div class="flex h-full min-w-0 flex-col overflow-hidden font-lato bg-surface">
  <!-- Header: large title + actions, then an iOS segmented control. -->
  <div class="shrink-0 pb-2">
    <div class="flex items-center justify-between px-4 pt-4">
      <h1 class="text-[28px] font-bold leading-[34px] tracking-[-0.01em] text-content">Agents</h1>
      <div class="-mr-2 flex items-center">
        <button
          type="button"
          onclick={handleNewCybo}
          class="pressable flex h-[44px] w-[44px] items-center justify-center rounded-full text-content-muted"
          aria-label="New cybo"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/>
            <path d="M19 16l.7 1.8L21.5 18.5l-1.8.7L19 21l-.7-1.8L16.5 18.5l1.8-.7z"/>
          </svg>
        </button>
        <button
          type="button"
          onclick={handleNewAgentMobile}
          class={cn(
            "pressable flex h-[44px] w-[44px] items-center justify-center rounded-full text-accent",
            !canLaunchOnShownDaemon && "opacity-50",
          )}
          aria-label="New session"
          aria-disabled={!canLaunchOnShownDaemon}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M12 5v14M5 12h14"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- Sub-tabs: one rounded track, equal segments, active segment raised. -->
    <div
      class={cn(
        "mx-4 mt-1 grid h-[44px] gap-[2px] rounded-[10px] bg-surface-alt p-[2px]",
        shownDaemonId ? "grid-cols-3" : "grid-cols-2",
      )}
    >
      {#each mobileTabs as t (t.key)}
        {@const active = activeSubTab === t.key}
        <button
          type="button"
          onclick={() => { agentsPaneState.subTab = t.key; }}
          class={cn(
            "flex min-w-0 cursor-pointer items-center justify-center rounded-[8px] px-1 transition-colors",
            active
              ? "bg-raised font-semibold text-content shadow-[0_1px_3px_rgba(0,0,0,0.12)]"
              : "text-content-muted",
          )}
          aria-pressed={active}
        >
          <span class="truncate text-[15px] leading-[20px]">{t.label}</span>
        </button>
      {/each}
    </div>
  </div>

  <!-- Foreign-daemon warning: never let sessions start on a teammate's
       machine without the user realizing it (same copy as desktop). -->
  {#if shownDaemonForeign}
    <div
      class="mx-4 mb-2 flex shrink-0 items-start gap-2.5 rounded-[12px] px-3.5 py-2.5 text-[13px] leading-[18px] text-warning"
      style="background-color: color-mix(in srgb, var(--warning, #e8ab5a) 12%, transparent);"
      role="alert"
    >
      <svg class="mt-px h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <span>
        <strong>{shownDaemon?.label}</strong> is <strong>{shownDaemonOwnerName}'s</strong> daemon — not yours.
        {#if canLaunchOnShownDaemon}
          Sessions you start here run on their machine.
        {:else}
          You can't start sessions or install cybos on someone else's daemon.
        {/if}
      </span>
    </div>
  {/if}

  {#if activeSubTab === "daemon"}
    <!-- Daemon sub-tab: runtime status card + the existing DaemonDetail
         (it manages its own scroll). -->
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      {#if shownDaemonId}
        {#if cliStatus}
          <div class="shrink-0 px-4 pb-1 pt-2">
            {#if cliStatus.installed}
              <div class="flex min-h-[40px] items-center gap-2.5 rounded-[12px] bg-surface-alt px-3.5 text-[13px] text-content-dim">
                <span class="h-[7px] w-[7px] shrink-0 rounded-full bg-online"></span>
                <span>Cybo runtime{cliStatus.version ? ` · ${cliStatus.version}` : ""}</span>
              </div>
            {:else}
              <div class="rounded-[14px] bg-surface-alt px-3.5 py-3">
                <div class="text-[15px] font-semibold text-content">Cybo runtime not found</div>
                {#if foreignNoLaunch}
                  <div class="mt-1 text-[13px] leading-[18px] text-content-dim">
                    This is <strong>{shownDaemonOwnerName}'s</strong> daemon — only its owner can
                    install the cybo runtime on that machine.
                  </div>
                {:else}
                  <div class="mb-2 mt-1 text-[13px] text-content-dim">Install it to run cybos on this daemon:</div>
                  {@render cyboInstallControls()}
                {/if}
              </div>
            {/if}
          </div>
        {/if}
        <div class="min-h-0 flex-1 overflow-hidden">
          <DaemonDetail daemonId={shownDaemonId} />
        </div>
      {:else}
        <div class="flex flex-1 flex-col items-center justify-center gap-3 px-8 pb-12 text-center">
          <span class="flex h-[56px] w-[56px] items-center justify-center rounded-full bg-surface-alt text-content-muted" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><circle cx="6" cy="6" r="1" fill="currentColor"/><circle cx="6" cy="18" r="1" fill="currentColor"/>
            </svg>
          </span>
          <div class="flex max-w-[360px] flex-col items-center gap-1">
            <p class="text-[15px] font-semibold text-content">No machine connected yet</p>
            <p class="text-[13px] leading-[18px] text-content-muted">
              Your agents need a computer to run on.
              {#if isDesktopApp()}
                Install the cybo runtime on this computer to run agents here.
              {:else}
                Get the Cyborg desktop app — it becomes your first machine.
              {/if}
            </p>
          </div>

          {#if !isDesktopApp()}
            <button
              type="button"
              onclick={downloadDesktopApp}
              class="mt-1 inline-flex items-center gap-2.5 rounded-lg bg-accent px-4 py-2 text-[13px] font-semibold text-accent-foreground transition-colors hover:bg-accent-hover"
            >
              {#if isWindows}
                <WindowsLogo class="size-4" />
              {:else}
                <AppleLogo class="size-[17px]" />
              {/if}
              Download Cyborg for {isWindows ? "Windows" : "macOS"}
            </button>
          {/if}

          <!-- CLI path for users running a daemon on a server / their own machine. -->
          <div class="mt-2 flex flex-col items-center gap-1.5">
            <p class="text-[12px] text-content-muted">
              {isDesktopApp() ? "Run this on the daemon host:" : "Prefer the CLI? Run this on any computer:"}
            </p>
            <code class="rounded bg-edge-dim px-2 py-1 text-[11px] text-content" style="font-family: ui-monospace, monospace;">{CYBO_INSTALL_CMD}</code>
          </div>
        </div>
      {/if}
    </div>
  {:else}
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="flex min-h-full flex-col pb-8">
        {#if activeSubTab === "cybos"}
          {#if foreignNoLaunch}
            <!-- Explains WHY rows won't start a chat on this daemon. -->
            <div
              class="mx-4 mt-2 rounded-[12px] px-3.5 py-2.5 text-[13px] leading-[18px] text-warning"
              style="background-color: color-mix(in srgb, var(--warning, #e8ab5a) 12%, transparent);"
              role="note"
            >
              <strong>{shownDaemon?.label ?? "This daemon"}</strong> is
              <strong>{shownDaemonOwnerName}'s</strong> daemon — you can't start sessions here.
              Pick your own daemon to run a cybo.
            </div>
          {/if}

          {#if myCybos.length === 0}
            <!-- Designed empty state, vertically centered. -->
            <div class="flex flex-1 flex-col items-center justify-center gap-3 px-8 pb-12 text-center">
              <span class="flex h-[56px] w-[56px] items-center justify-center rounded-full bg-surface-alt text-content-muted" aria-hidden="true">
                <CyborgIcon size={24} />
              </span>
              <div class="flex flex-col gap-1">
                <p class="text-[15px] font-semibold text-content">No cybos yet</p>
                <p class="text-[13px] leading-[18px] text-content-muted">
                  Create a cybo with its own name, photo and personality — it shows up here, ready to chat.
                </p>
              </div>
              <button
                type="button"
                onclick={handleNewCybo}
                class="pressable mt-1 flex h-[44px] items-center justify-center rounded-[12px] bg-accent px-5 text-[15px] font-semibold text-accent-foreground"
              >
                New cybo
              </button>
            </div>
          {:else}
            <div class="flex min-h-[36px] items-end px-4 pb-1 pt-3 text-[13px] font-semibold uppercase tracking-[0.06em] text-content-muted">
              Your cybos
            </div>
            {#each myCybos as c (c.id)}
              {@const badge = cyboBadge(c)}
              {@const startBlocked = cyboStartBlocked(c)}
              <ConversationRow
                kind="agent"
                name={c.name}
                preview={[badge.label, c.model ?? c.provider].filter(Boolean).join(" · ")}
                ariaLabel={startBlocked ? c.name : `Start chat with ${c.name}`}
                onclick={() => handleCyboRowTap(c, badge.tip)}
              >
                {#snippet leading()}
                  {@const avatarSource = resolveAvatarSource(c.avatar, c.name)}
                  <div class="relative flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[12px] bg-surface-alt text-content-muted">
                    {#if avatarSource.kind === "image"}
                      <img src={avatarSource.value} alt="" class="h-[28px] w-[28px] rounded-[9px] object-cover" />
                    {:else if avatarSource.kind === "emoji"}
                      <span class="text-[22px] leading-none" aria-hidden="true">{avatarSource.value}</span>
                    {:else}
                      <Avatar name={c.name} width={28} fontSize={12} borderRadius={9} />
                    {/if}
                    {#if badge.tone === "active"}
                      <span class="absolute animate-ping rounded-full" style="bottom: -2px; right: -2px; width: 10px; height: 10px; background: var(--color-success); opacity: 0.45;"></span>
                    {/if}
                    <span class="absolute rounded-full" style="bottom: -2px; right: -2px; width: 10px; height: 10px; border: 2px solid var(--bg-base); background: {cyboToneColor(badge.tone)};"></span>
                  </div>
                {/snippet}
                {#snippet trailing()}
                  {#if spawningCybos[c.id]}
                    <span class="h-4 w-4 animate-spin rounded-full border-2 border-content-muted border-t-transparent" aria-hidden="true"></span>
                  {:else}
                    <button
                      type="button"
                      onclick={(e) => { e.stopPropagation(); handleEditCybo(c.id); }}
                      onkeydown={(e) => e.stopPropagation()}
                      class="flex h-[44px] w-[36px] items-center justify-center text-content-muted"
                      aria-label="Edit {c.name}"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>
                    </button>
                    <button
                      type="button"
                      onclick={(e) => { e.stopPropagation(); void handleDeleteCybo(c); }}
                      onkeydown={(e) => e.stopPropagation()}
                      disabled={deletingId === c.id}
                      class="flex h-[44px] w-[36px] items-center justify-center text-content-muted disabled:opacity-50"
                      aria-label="Delete {c.name}"
                    >
                      {#if deletingId === c.id}
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="animate-spin"><path d="M21 12a9 9 0 1 1-6.2-8.5"/></svg>
                      {:else}
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                      {/if}
                    </button>
                  {/if}
                {/snippet}
              </ConversationRow>
            {/each}
            <!-- Prominent "New cybo" row (Home-dashboard pattern). -->
            <button
              type="button"
              onclick={handleNewCybo}
              class="pressable-row flex w-full min-h-[54px] cursor-pointer items-center gap-3 px-4 text-left"
            >
              <span class="flex h-[42px] w-[42px] shrink-0 items-center justify-center text-content-muted" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
              </span>
              <span class="flex-1 truncate text-[16px] font-medium text-content-muted">New cybo</span>
            </button>
          {/if}

          {#if !cyboRunnable && !foreignNoLaunch && !cliLoading}
            <!-- Runtime unavailable: same reason + install/setup CTAs as desktop,
                 restyled as a clean card (no dashed borders). -->
            <div class="mx-4 mt-4 rounded-[14px] bg-surface-alt px-4 py-3">
              <div class="flex items-start gap-2.5 text-[13px] leading-[18px] text-content-dim">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class="mt-px shrink-0 text-content-muted">
                  <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>
                </svg>
                <span>{cyboUnavailableReason}</span>
              </div>
              {#if onlineDaemons > 0 && shownDaemonId && canLaunchOnShownDaemon}
                <div class="mt-3">
                  {@render cyboInstallControls()}
                </div>
                {#if setupCta.kind === "terminal"}
                  <button
                    type="button"
                    onclick={() => (setupTerminalOpen = true)}
                    class="pressable mt-2 inline-flex min-h-[36px] items-center gap-1.5 rounded-[10px] bg-raised px-3 text-[13px] font-medium text-content"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
                    Set up Cybo on this daemon
                  </button>
                {:else if setupCta.kind === "update-first"}
                  <button
                    type="button"
                    onclick={handleUpdateThenSetup}
                    disabled={cliInstalling}
                    class="pressable mt-2 inline-flex min-h-[36px] items-center gap-1.5 rounded-[10px] bg-raised px-3 text-[13px] font-medium text-content disabled:opacity-60"
                  >
                    {#if cliInstalling}
                      <span class="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"></span>
                      Updating Cybo runtime…
                    {:else}
                      Update Cybo runtime, then set up
                    {/if}
                  </button>
                  <div class="mt-1 text-[11px] text-content-muted">
                    Setup needs cybo ≥ 0.2.6{cliStatus?.version ? ` (this daemon has ${cliStatus.version})` : ""}.
                  </div>
                {:else if setupCta.kind === "command"}
                  <div class="mt-2 text-[12px] leading-[17px] text-content-muted">
                    To connect a model provider, run this on {shownDaemon?.label ?? "the daemon's machine"}:
                    <code class="font-mono text-content">{setupCta.command}</code>
                  </div>
                {/if}
              {/if}
            </div>
          {/if}

        {:else if agents.length === 0}
          <!-- Sessions empty state, vertically centered. -->
          <div class="flex flex-1 flex-col items-center justify-center gap-3 px-8 pb-12 text-center">
            <span class="flex h-[56px] w-[56px] items-center justify-center rounded-full bg-surface-alt text-content-muted" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 8V4H8" /><rect width="16" height="12" x="4" y="8" rx="2" /><path d="M2 14h2" /><path d="M20 14h2" /><path d="M15 13v2" /><path d="M9 13v2" />
              </svg>
            </span>
            <div class="flex flex-col gap-1">
              <p class="text-[15px] font-semibold text-content">No agent sessions yet</p>
              <p class="text-[13px] leading-[18px] text-content-muted">Launch a provider agent, or start a chat with one of your cybos.</p>
            </div>
            <button
              type="button"
              onclick={handleNewAgentMobile}
              class="pressable mt-1 flex h-[44px] items-center justify-center rounded-[12px] bg-accent px-5 text-[15px] font-semibold text-accent-foreground"
            >
              New session
            </button>
          </div>
        {:else}
          <!-- Sessions grouped by status; rows match the Home dashboard. -->
          {#each mobileSessionSections as section (section.st)}
            <div class="px-4 pb-1 pt-5 text-[13px] font-semibold uppercase tracking-[0.06em] text-content-muted">
              {section.label}
            </div>
            {#each section.items as s (s.agent.agentId)}
              {@const perms = agentStreamState.getPendingPermissions(s.agent.agentId).length}
              <ConversationRow
                kind="agent"
                name={s.name}
                preview={mobileSessionLine(s)}
                onclick={() => handleOpenAgent(s.agent.agentId)}
              >
                {#snippet leading()}
                  <div
                    class={cn(
                      "relative flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[12px] bg-surface-alt text-content-muted",
                      s.st === "offline" && "opacity-60",
                    )}
                  >
                    <CyboSessionAvatar agent={s.agent} size={28} radius="9px" />
                    {#if s.st === "working"}
                      <span class="absolute animate-ping rounded-full" style="bottom: -2px; right: -2px; width: 10px; height: 10px; background: {s.meta.color}; opacity: 0.45;"></span>
                    {/if}
                    <span class="absolute rounded-full" style="bottom: -2px; right: -2px; width: 10px; height: 10px; border: 2px solid var(--bg-base); background: {s.meta.color};"></span>
                  </div>
                {/snippet}
                {#snippet trailing()}
                  <!-- #591: derived "needs attention" badge (Done / Error). -->
                  {@const ab = attentionBadge(s.agent.agentId)}
                  {#if ab}
                    {#key ab.reason}
                      <Badge
                        variant={ab.tone === "error" ? "attentionError" : "attentionDone"}
                        class="animate-pulse-once"
                        aria-label={ab.description}
                      >
                        {ab.label}
                      </Badge>
                    {/key}
                  {/if}
                  {#if perms > 0}
                    <span
                      class="flex h-[19px] min-w-[19px] items-center justify-center rounded-full px-[6px] text-[12px] font-bold leading-none"
                      style="background: color-mix(in srgb, var(--warning, #e8ab5a) 18%, transparent); color: var(--warning, #e8ab5a);"
                    >{perms}</span>
                  {/if}
                  {#if s.pct >= 0.8}
                    <!-- Budget pill, only near cap (desktop parity). -->
                    <span
                      class="text-[12px] font-bold tabular-nums"
                      style="color: {s.pct >= 0.95 ? 'var(--color-error, #e01e5a)' : 'var(--warning, #e8ab5a)'};"
                    >{Math.round(s.pct * 100)}%</span>
                  {/if}
                {/snippet}
              </ConversationRow>
            {/each}
          {/each}
          <!-- Prominent "New session" row (Home-dashboard pattern). -->
          <button
            type="button"
            onclick={handleNewAgentMobile}
            class="pressable-row mt-2 flex w-full min-h-[54px] cursor-pointer items-center gap-3 px-4 text-left"
          >
            <span class="flex h-[42px] w-[42px] shrink-0 items-center justify-center text-content-muted" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
            </span>
            <span class="flex-1 truncate text-[16px] font-medium text-content-muted">New session</span>
          </button>
        {/if}
      </div>
    </div>
  {/if}
</div>
{:else}
<div class="flex h-full flex-col min-w-0 overflow-hidden font-lato bg-surface-alt text-content">
  <!-- Header -->
  <div class="shrink-0 border-b border-edge px-3.5 sm:px-[22px]">
    <div class="flex items-center justify-between" style="height: 56px;">
      <div class="flex items-center gap-2.5 sm:gap-3.5 min-w-0">
        <CyborgIcon size={20} class="shrink-0 text-[var(--agent-accent,var(--primary))]" />
        <span class="text-lg font-bold tracking-tight">
          Agents
        </span>
        <!-- Inline stats are redundant with the tab badges below; hide on mobile. -->
        <div class="hidden sm:flex items-center gap-2.5 ml-1">
          <span class="text-xs flex items-center gap-1.5 text-content-dim">
            <span class="w-[7px] h-[7px] rounded-full bg-online"></span>
            {onlineCount} online
          </span>
          <span class="text-xs text-content-muted">·</span>
          <span class="text-xs text-content-dim">
            {agents.length} agent{agents.length !== 1 ? "s" : ""}
          </span>
        </div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onclick={handleNewCybo}
          aria-label="New cybo"
          class="inline-flex items-center gap-1.5 px-2.5 sm:px-3.5 py-[7px] rounded-lg text-[12.5px] font-bold cursor-pointer bg-transparent text-content-dim border border-edge"
          style="font-family: inherit;"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/>
            <path d="M19 16l.7 1.8L21.5 18.5l-1.8.7L19 21l-.7-1.8L16.5 18.5l1.8-.7z"/>
          </svg>
          <span class="hidden sm:inline">New cybo</span>
        </button>
        <TooltipProvider>
          <Tooltip>
            <!-- The trigger IS the button (bits-ui renders one). No `disabled`
                 attribute: it would swallow pointer events and the explanatory
                 tooltip would never show — handleNewAgent guards instead. -->
            <TooltipTrigger
              type="button"
              onclick={handleNewAgent}
              aria-disabled={!canLaunchOnShownDaemon}
              aria-label="Agent session"
              class="inline-flex items-center gap-1.5 px-2.5 sm:px-3.5 py-[7px] rounded-lg text-[12.5px] font-bold"
              style="background: var(--btn-primary-bg); color: var(--btn-primary-text); border: none; font-family: inherit; box-shadow: 0 2px 6px color-mix(in srgb, var(--btn-primary-bg) 20%, transparent), 0 1px 0 color-mix(in srgb, white 14%, transparent) inset; opacity: {canLaunchOnShownDaemon ? 1 : 0.5}; cursor: {canLaunchOnShownDaemon ? 'pointer' : 'not-allowed'};"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M12 5v14M5 12h14"/>
              </svg>
              <span class="hidden sm:inline">Create new session</span>
            </TooltipTrigger>
            {#if !canLaunchOnShownDaemon}
              <TooltipContent side="bottom" class="max-w-[260px] text-xs">
                {launchBlockedReason}
              </TooltipContent>
            {/if}
          </Tooltip>
        </TooltipProvider>
        <!-- Close is redundant on mobile (the bottom tab bar navigates away). -->
        {#if !viewportState.isMobile}
          <button
            type="button"
            onclick={handleClose}
            class="p-1 rounded cursor-pointer ml-1 transition-colors text-content-muted"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        {/if}
      </div>
    </div>

    {#if shownDaemonForeign}
      <div
        class="mt-2 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12.5px] text-warning"
        role="alert"
      >
        <svg
          class="mt-0.5 h-4 w-4 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <span>
          <strong>{shownDaemon?.label}</strong> is <strong>{shownDaemonOwnerName}'s</strong> daemon — not
          yours.
          {#if canLaunchOnShownDaemon}
            Sessions you start here run on their machine. Pick your own daemon in the sidebar to
            launch on yours.
          {:else}
            You can't start sessions or install cybos on someone else's daemon — pick your own
            daemon in the sidebar.
          {/if}
        </span>
      </div>
    {/if}

    <!-- Sub-tabs -->
    <div class="flex gap-1 -mb-px flex-wrap">
      <button
        type="button"
        onclick={() => { agentsPaneState.subTab = "cybos"; }}
        class="inline-flex items-center gap-[7px] px-3.5 py-[11px] text-[13px] font-semibold cursor-pointer"
        style="background: transparent; border: none; border-bottom: 2px solid {activeSubTab === 'cybos' ? 'var(--text-primary)' : 'transparent'}; color: {activeSubTab === 'cybos' ? 'var(--text-primary)' : 'var(--text-muted)'}; font-family: inherit;"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/>
          <path d="M19 16l.7 1.8L21.5 18.5l-1.8.7L19 21l-.7-1.8L16.5 18.5l1.8-.7z"/>
        </svg>
        Agents
        <span class="text-[10.5px] font-medium px-1.5 py-[1px] rounded-full bg-edge-dim text-content-muted" style="font-family: 'JetBrains Mono', ui-monospace, monospace;">
          {myCybos.length}
        </span>
      </button>
      <button
        type="button"
        onclick={() => { agentsPaneState.subTab = "agents"; }}
        class="inline-flex items-center gap-[7px] px-3.5 py-[11px] text-[13px] font-semibold cursor-pointer"
        style="background: transparent; border: none; border-bottom: 2px solid {activeSubTab === 'agents' ? 'var(--text-primary)' : 'transparent'}; color: {activeSubTab === 'agents' ? 'var(--text-primary)' : 'var(--text-muted)'}; font-family: inherit;"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="9" cy="9" r="3.5"/><path d="M3 19c0-3 2.5-5.5 6-5.5s6 2.5 6 5.5"/><circle cx="17" cy="8" r="2.5"/><path d="M17 13c2 0 4 1.5 4 4"/>
        </svg>
        All sessions
        <span class="text-[10.5px] font-medium px-1.5 py-[1px] rounded-full bg-edge-dim text-content-muted" style="font-family: 'JetBrains Mono', ui-monospace, monospace;">
          {agents.length}
        </span>
      </button>
      {#if shownDaemonId}
        <button
          type="button"
          onclick={() => { agentsPaneState.subTab = "daemon"; }}
          class="inline-flex items-center gap-[7px] px-3.5 py-[11px] text-[13px] font-semibold cursor-pointer"
          style="background: transparent; border: none; border-bottom: 2px solid {activeSubTab === 'daemon' ? 'var(--text-primary)' : 'transparent'}; color: {activeSubTab === 'daemon' ? 'var(--text-primary)' : 'var(--text-muted)'}; font-family: inherit;"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><circle cx="6" cy="6" r="1" fill="currentColor"/><circle cx="6" cy="18" r="1" fill="currentColor"/>
          </svg>
          Daemon
          {#if shownDaemon}
            <span class="text-[10.5px] font-medium px-1.5 py-[1px] rounded-full max-w-[120px] truncate bg-edge-dim text-content-muted" style="font-family: 'JetBrains Mono', ui-monospace, monospace;">
              {shownDaemon.label}
            </span>
          {/if}
        </button>
      {/if}
    </div>
  </div>

  <!-- Content -->
  {#if activeSubTab === "daemon"}
    <!-- The daemon detail manages its own scroll + padding; the sub-tab bar
         above stays visible so All agents / Templates remain one click away. -->
    <div class="flex-1 min-h-0 overflow-hidden flex flex-col">
      {#if shownDaemonId}
        {#if cliStatus}
          <div class="shrink-0 px-5 pt-4">
            {#if cliStatus.installed}
              <div class="flex items-center gap-2 rounded-lg border border-edge bg-surface-alt px-3 py-2 text-[12px] text-content-dim">
                <span class="w-[7px] h-[7px] rounded-full shrink-0 bg-online"></span>
                <span>Cybo runtime{cliStatus.version ? ` · ${cliStatus.version}` : ""}</span>
              </div>
            {:else}
              <div class="rounded-lg border border-dashed border-edge bg-surface-alt px-3 py-2.5 text-[12px] text-content-dim">
                <div class="font-semibold text-content">Cybo runtime not found</div>
                {#if foreignNoLaunch}
                  <div class="mt-0.5">
                    This is <strong>{shownDaemonOwnerName}'s</strong> daemon — only its owner can install
                    the cybo runtime on that machine.
                  </div>
                {:else}
                  <div class="mt-0.5 mb-2">Install it to run cybos on this daemon:</div>
                  {@render cyboInstallControls()}
                {/if}
              </div>
            {/if}
          </div>
        {/if}
        <div class="flex-1 min-h-0 overflow-hidden">
          <DaemonDetail daemonId={shownDaemonId} />
        </div>
      {:else}
        <div class="flex h-full items-center justify-center p-8 text-center text-sm text-content-muted">
          No daemons are connected to this workspace yet.
        </div>
      {/if}
    </div>
  {:else}
  <div class="flex-1 min-h-0 overflow-auto" style="padding: 20px 22px 30px;">
    {#if activeSubTab === "cybos"}
      <!-- Your cybos: the workspace cybo roster (single source of truth). -->
      <div class="flex items-baseline justify-between mb-3">
        <h3 class="text-[15px] font-bold text-content">
          Your cybos
          <span class="ml-1.5 text-[11px] font-medium text-content-muted" style="font-family: 'JetBrains Mono', ui-monospace, monospace;">{myCybos.length}</span>
        </h3>
        <span class="text-[11.5px] text-content-muted">Cybos you created — Edit to change name, photo and personality</span>
      </div>

      {#if foreignNoLaunch}
        <!-- Notorious "not your daemon" state: explains WHY the cybo cards have no
             Start chat (you can't run sessions on someone else's machine). -->
        <div
          class="mb-4 flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/10 px-3.5 py-3 text-[12.5px] text-warning"
          role="note"
        >
          <svg class="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <span>
            <strong>{shownDaemon?.label ?? "This daemon"}</strong> is
            <strong>{shownDaemonOwnerName}'s</strong> daemon — you can't start sessions here (they'd
            run on someone else's machine), so <strong>Start chat</strong> is hidden.
            <span class="mt-0.5 block">Pick <strong>your own daemon</strong> in the sidebar to run a cybo.</span>
          </span>
        </div>
      {/if}

      {#if myCybos.length === 0}
        <div class="flex items-center gap-4 border border-dashed border-edge bg-surface-alt" style="padding: 18px 20px; border-radius: 12px;">
          <div class="flex items-center justify-center shrink-0" style="width: 40px; height: 40px; border-radius: 10px; background: color-mix(in srgb, var(--agent-accent, #7c3aed) 12%, transparent); color: var(--agent-accent, #7c3aed);">
            <CyborgIcon size={20} />
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-[13.5px] font-semibold text-content m-0">No cybos yet</p>
            <p class="text-[12px] mt-0.5 text-content-dim mb-0">Create a cybo with its own name, photo, personality and provider — it shows up here, ready to edit anytime.</p>
          </div>
          <button
            type="button"
            onclick={handleNewCybo}
            class="shrink-0 inline-flex items-center gap-1.5 px-3 py-[7px] rounded-lg text-[12px] font-bold cursor-pointer transition-colors bg-transparent text-content-dim border border-edge"
            style="font-family: inherit;"
          >
            New cybo
          </button>
        </div>
      {:else}
        <!-- Active cybos (a live session is running) lead the grid. -->
        {#if activeCybos.length > 0}
          <div class="grid gap-2.5" style="grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));">
            {#each activeCybos as c (c.id)}
              {@render cyboCard(c)}
            {/each}
          </div>
        {/if}

        <!-- Inactive cybos collapsed behind a toggle (mirrors the mobile DMs
             "Offline · N" pattern + Archived collapse): leads with the ones
             you can use right now, tucks the rest away (collapsed by default). -->
        {#if inactiveCybos.length > 0}
          <button
            type="button"
            onclick={() => (inactiveCybosOpen = !inactiveCybosOpen)}
            aria-expanded={inactiveCybosOpen}
            class={cn(
              "flex w-full items-center gap-2 py-2 text-left text-[12px] font-semibold uppercase tracking-[0.06em] text-content-muted",
              activeCybos.length > 0 && "mt-3",
            )}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="transform: rotate({inactiveCybosOpen ? 90 : 0}deg); transition: transform 0.15s;"><polyline points="9 18 15 12 9 6"/></svg>
            <span>Inactive</span>
            <span class="tabular-nums">{inactiveCybos.length}</span>
          </button>
          {#if inactiveCybosOpen}
            <div class="grid gap-2.5" style="grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));">
              {#each inactiveCybos as c (c.id)}
                {@render cyboCard(c)}
              {/each}
            </div>
          {/if}
        {/if}
      {/if}

      {#if !cyboRunnable && !foreignNoLaunch && !cliLoading}
        <div class="mt-[22px] bg-surface-alt border border-dashed border-edge text-content-dim" style="padding: 14px; border-radius: 10px; font-size: 12px; line-height: 1.55;">
          <div class="flex items-center gap-3">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-content-muted">
              <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>
            </svg>
            <span>{cyboUnavailableReason}</span>
          </div>
          {#if onlineDaemons > 0 && shownDaemonId && canLaunchOnShownDaemon}
            <!-- "PI not installed" on an online daemon → offer the SAME install
                 action as the Daemon sub-tab (shared cyboInstallControls snippet:
                 spinner + version + success/error). Hidden when onlineDaemons === 0:
                 the message is then "no active daemon" and there's nowhere to install. -->
            <div class="mt-2.5 pl-[26px]">
              {@render cyboInstallControls()}
            </div>
            <!-- "Set up Cybo on this daemon" (internal docs): the runtime may be
                 installed but unauthenticated (auth.json empty → 0 models → pi
                 unavailable). Local own daemon in the desktop app → embedded
                 terminal running `cybo login`; anywhere else → the exact command
                 to run on that machine (Phase 2 = remote PTY, not built yet). -->
            {#if setupCta.kind === "terminal"}
              <div class="mt-2 pl-[26px]">
                <button
                  type="button"
                  onclick={() => (setupTerminalOpen = true)}
                  class="inline-flex items-center gap-1.5 px-2.5 py-1 text-[12px] font-medium rounded cursor-pointer border border-edge bg-surface-alt text-content"
                  style="font-family: inherit;"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
                  Set up Cybo on this daemon
                </button>
              </div>
            {:else if setupCta.kind === "update-first"}
              <!-- Runtime predates `cybo login` (W0's finding: <0.2.6 treats it as
                   an AI prompt). One click: update via the existing RPC, then the
                   terminal opens automatically once the gate passes. -->
              <div class="mt-2 pl-[26px]">
                <button
                  type="button"
                  onclick={handleUpdateThenSetup}
                  disabled={cliInstalling}
                  class="inline-flex items-center gap-1.5 px-2.5 py-1 text-[12px] font-medium rounded cursor-pointer disabled:cursor-default disabled:opacity-80 border border-edge bg-surface-alt text-content"
                  style="font-family: inherit;"
                >
                  {#if cliInstalling}
                    <span class="h-3 w-3 shrink-0 rounded-full border-2 border-current border-t-transparent animate-spin"></span>
                    Updating Cybo runtime…
                  {:else}
                    Update Cybo runtime, then set up
                  {/if}
                </button>
                <span class="ml-2 text-[11px] text-content-muted">
                  Setup needs cybo ≥ 0.2.6{cliStatus?.version ? ` (this daemon has ${cliStatus.version})` : ""}.
                </span>
              </div>
            {:else if setupCta.kind === "command"}
              <div class="mt-2 pl-[26px] text-[11px] text-content-muted">
                To connect a model provider, run this on {shownDaemon?.label ?? "the daemon's machine"}:
                <code class="ml-1 px-2 py-0.5 rounded bg-edge-dim text-content" style="font-family: ui-monospace, monospace;">{setupCta.command}</code>
              </div>
            {/if}
          {/if}
        </div>
      {/if}

    {:else if agents.length === 0}
      <!-- Empty state -->
      <div class="mx-auto" style="max-width: 720px; margin-top: 40px;">
        <div
          class="flex items-center gap-6 rounded-[14px]"
          style="padding: 32px 28px; background: linear-gradient(135deg, var(--agent-accent-soft, rgba(99,102,241,0.08)) 0%, var(--bg-surface) 80%); border: 1px solid var(--agent-accent-border, rgba(99,102,241,0.2));"
        >
          <div
            class="flex items-center justify-center shrink-0"
            style="width: 56px; height: 56px; border-radius: 14px; background: linear-gradient(135deg, var(--agent-accent, #6366f1), #5BB5F0); color: #fff;"
          >
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/>
              <path d="M19 16l.7 1.8L21.5 18.5l-1.8.7L19 21l-.7-1.8L16.5 18.5l1.8-.7z"/>
            </svg>
          </div>
          <div class="flex-1">
            <h2 class="text-[22px] font-bold tracking-tight text-content m-0">
              A workspace without agents is just chat.
            </h2>
            <p class="text-[13.5px] mt-1.5 mb-3.5 leading-relaxed text-content-dim">
              Launch an agent from a provider you already have, or create a custom Cybo with its own personality.
            </p>
            <div class="flex gap-2">
              <button
                type="button"
                onclick={handleNewAgent}
                class="inline-flex items-center gap-[7px] px-3.5 py-2 rounded-[7px] text-[13px] font-bold cursor-pointer bg-btn-primary-bg text-btn-primary-text"
                style="border: none; font-family: inherit;"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/>
                  <path d="M19 16l.7 1.8L21.5 18.5l-1.8.7L19 21l-.7-1.8L16.5 18.5l1.8-.7z"/>
                </svg>
                Add an agent
              </button>
            </div>
          </div>
        </div>
      </div>
    {:else}
      <!-- Roster: card grid (a team page, not a billing table). Status floats
           "needs you" to the top; budget is a quiet pill, only when near cap. -->
      <div class="grid gap-3" style="grid-template-columns: repeat(auto-fill, minmax(264px, 1fr));">
        {#each sortedAgents as { agent, name, avatar, st, meta, model, pct, lastActivity } (agent.agentId)}
          <button
            type="button"
            onclick={() => handleOpenAgent(agent.agentId)}
            class="group flex flex-col gap-3 p-3.5 text-left transition-colors cursor-pointer border border-[var(--border)] hover:border-[var(--border-light,var(--border))]"
            style="border-radius: 12px; background: var(--bg-base); font-family: inherit; color: var(--text-primary); opacity: {st === 'offline' ? 0.72 : 1};"
          >
            <!-- Header: avatar (presence ring) + name/handle + role -->
            <div class="flex items-start gap-2.5">
              <div class="relative shrink-0">
                {#if avatar}
                  <img src={avatar} alt={name} class="object-cover" style="width: 40px; height: 40px; border-radius: 10px;" />
                {:else if agent.cyboId}
                  <CyboSessionAvatar {agent} size={40} radius="10px" />
                {:else}
                  <div class="flex items-center justify-center" style="width: 40px; height: 40px; border-radius: 10px; background: color-mix(in srgb, {avatarColor(agent.provider, name)} 14%, transparent); color: {avatarColor(agent.provider, name)};">
                    <ProviderIcon provider={agent.provider} size={20} />
                  </div>
                {/if}
                <!-- presence ring dot — soft live pulse while online -->
                {#if st !== "offline"}
                  <span
                    class="absolute rounded-full animate-ping"
                    style="bottom: -2px; right: -2px; width: 12px; height: 12px; background: {meta.color}; opacity: 0.45;"
                  ></span>
                {/if}
                <span
                  class="absolute rounded-full"
                  style="bottom: -2px; right: -2px; width: 12px; height: 12px; border: 2px solid var(--bg-base); background: {meta.color};"
                ></span>
              </div>

              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5">
                  <span class="text-sm font-bold truncate" style="color: var(--agent-accent, var(--primary));">{name}</span>
                  <span class="text-[11px] shrink-0 text-content-muted">@{agentHandle(agent)}</span>
                </div>
                <div class="flex items-center gap-1.5 mt-1">
                  <span class="inline-block text-[11px] font-medium px-1.5 py-[1px] rounded bg-edge-dim text-content-dim">
                    {agentRole(agent)}
                  </span>
                  <!-- #591: derived "needs attention" badge (Done / Error). One-shot
                       pop on appearance, reduced-motion-safe (animate-pulse-once). -->
                  {#if attentionBadge(agent.agentId)}
                    {@const ab = attentionBadge(agent.agentId)}
                    {#key ab?.reason}
                      <Badge
                        variant={ab?.tone === "error" ? "attentionError" : "attentionDone"}
                        class="animate-pulse-once"
                        title={ab?.description}
                        aria-label={ab?.description}
                      >
                        {#if ab?.tone === "error"}
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                        {:else}
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
                        {/if}
                        {ab?.label}
                      </Badge>
                    {/key}
                  {/if}
                </div>
              </div>

              <!-- Budget: demoted to a quiet pill, only at >=80% of cap -->
              {#if pct >= 0.8}
                <span
                  class="shrink-0 text-[10.5px] font-bold px-1.5 py-[1px] rounded-full"
                  style="color: {pct >= 0.95 ? 'var(--health-attention-text, #e01e5a)' : 'var(--health-watching-text, #e8ab5a)'}; background: color-mix(in srgb, {pct >= 0.95 ? 'var(--health-attention-text, #e01e5a)' : 'var(--health-watching-text, #e8ab5a)'} 16%, transparent);"
                  title="Budget used"
                >
                  {Math.round(pct * 100)}%
                </span>
              {/if}
            </div>

            <!-- Status line: what they're doing right now (#594). When the live
                 timeline has a curated activity, show that glanceable one-liner
                 ([Shell] pnpm test → [Assistant] Done) instead of the generic
                 status text; the presence dot keeps the at-a-glance state. Plain
                 text swap — no transition/transform, so it's reduced-motion safe. -->
            <div class="flex items-center gap-[6px] text-[12px] font-medium min-w-0" style="color: {meta.color};">
              <span class="rounded-full shrink-0" style="width: 6px; height: 6px; background: {meta.color};"></span>
              {#if lastActivity}
                <span class="truncate min-w-0" title={lastActivity.line}>
                  <span style="color: {meta.color};">[{lastActivity.label}]</span>
                  {#if lastActivity.text}
                    <span class="text-content-dim">{lastActivity.text}</span>
                  {/if}
                </span>
              {:else}
                <span class="truncate min-w-0">{meta.line}</span>
              {/if}
            </div>

            <!-- Footer: model + working-directory chips + hover affordance -->
            <div class="flex items-center justify-between gap-2">
              <span class="flex items-center gap-1.5 min-w-0">
                {#if model}
                  <span class="inline-flex items-center gap-1.5 text-[11px] px-2 py-[3px] rounded-md min-w-0 bg-edge-dim text-content-dim">
                    <ProviderIcon provider={agent.provider} size={12} />
                    <span class="truncate">{model}</span>
                  </span>
                {/if}
                {#if agent.cwd}
                  <span
                    class="inline-flex items-center gap-1 text-[11px] px-2 py-[3px] rounded-md min-w-0 font-mono bg-edge-dim text-content-dim"
                    title={agent.cwd}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
                    <span class="truncate" style="max-width: 110px;">{agent.cwd.replace(/\/+$/, "").split("/").pop() || "/"}</span>
                  </span>
                {/if}
              </span>
              <span class="flex items-center gap-1 text-[11px] font-medium opacity-0 transition-opacity group-hover:opacity-100 shrink-0 text-content-dim">
                Open
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
              </span>
            </div>
          </button>
        {/each}
      </div>
    {/if}

    <!-- Archived sessions: moved here off the chat sidebar (#) so a desktop user
         with no open session can still browse + restore ended sessions. Scoped to
         the "All sessions" sub-tab and collapsed by default (mirrors the Inactive
         cybos collapse). Reuses ArchivedSessionRow + restoreSession, so restore
         behaves exactly as it did in the sidebar. -->
    {#if activeSubTab === "agents"}
      <button
        type="button"
        onclick={() => (archivedSessionsOpen = !archivedSessionsOpen)}
        aria-expanded={archivedSessionsOpen}
        class="mt-5 flex w-full items-center gap-2 py-2 text-left text-[12px] font-semibold uppercase tracking-[0.06em] text-content-muted"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="transform: rotate({archivedSessionsOpen ? 90 : 0}deg); transition: transform 0.15s;"><polyline points="9 18 15 12 9 6"/></svg>
        <span>Archived sessions</span>
        {#if archivedSessions.length > 0}
          <span class="tabular-nums">{archivedSessions.length}</span>
        {/if}
      </button>
      {#if archivedSessionsOpen}
        {#if sessionState.loading}
          <div class="pl-4 pr-2.5 h-[32px] flex items-center text-[12px] text-content-dim">
            Loading...
          </div>
        {:else if archivedSessions.length === 0}
          <div class="pl-4 pr-2.5 h-[32px] flex items-center text-[12px] text-content-dim italic">
            No archived sessions
          </div>
        {:else}
          <div class="flex flex-col gap-0.5">
            {#each archivedSessions as session (session.id)}
              <ArchivedSessionRow
                {session}
                importing={archivedRestoringId === session.id}
                timeAgo={sessionTimeAgo}
                displayName={sessionDisplayName}
                onRestore={handleRestoreSession}
                layout="desktop"
              />
            {/each}
            {#if sessionState.nextCursor}
              <button
                type="button"
                class="pl-4 pr-2.5 h-[32px] w-full flex items-center text-[12px] text-content-dim hover:text-content disabled:opacity-50"
                disabled={sessionState.loadingMore}
                onclick={handleLoadMoreSessions}
              >
                {sessionState.loadingMore ? "Loading…" : "Show more"}
              </button>
            {/if}
          </div>
        {/if}
      {/if}
    {/if}

  </div>
  {/if}
</div>
{/if}

<CreateAgentDialog
  bind:open={createDialogOpen}
  initialCyboId={createDialogCyboId}
/>

<!-- Shared by both presentations (open-state driven; render location is
     irrelevant for a dialog). -->
<SetupCyboTerminalDialog
  bind:open={setupTerminalOpen}
  daemonLabel={shownDaemon?.label ?? "this daemon"}
  onClosed={handleSetupTerminalClosed}
/>
