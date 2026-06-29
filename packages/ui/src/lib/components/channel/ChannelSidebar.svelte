<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { workspaceState, channelState, selectChannel, agentStreamState, attentionState, inviteMember, authState, userStatusState, presenceState, connectionState, workspaceUserStatusesState, archiveAgent, reloadSession, fetchProjects, createProject as createProjectAction, updateProject as updateProjectAction, deleteProject as deleteProjectAction, setChannelProject, deleteChannel, notificationState, unreadFlagState, daemonStatusState, threadsState, notifPrefsState, setChannelNotificationPref, rememberLastChannel, dmTypingState, sortMembersByDmRecency, dmActivityState, projectsCache, daemonState } from "$lib/state/app.svelte.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { shellConfig, pluginRegistry } from "$lib/core/plugin.svelte.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import PanelLeftCloseIcon from "@lucide/svelte/icons/panel-left-close";
  import { cn, nameToColor } from "$lib/utils.js";
  import { toast } from "svelte-sonner";
  import Emoji from "$lib/components/Emoji.svelte";
  import ChannelGlyph from "./ChannelGlyph.svelte";
  import { agentDisplayName as sharedAgentDisplayName } from "$lib/agent-display.js";
  import { sessionAlias } from "$lib/state/session-alias.svelte.js";
  import { terminalAlias } from "$lib/state/terminal-alias.svelte.js";
  import { terminalSessionsState } from "$lib/state/terminal-sessions.svelte.js";
  import { client } from "$lib/state/app.svelte.js";
  import SidebarSection from "$lib/components/SidebarSection.svelte";
  import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";
  import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "$lib/components/ui/tooltip/index.js";
  import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuLabel } from "$lib/components/ui/dropdown-menu/index.js";
  import ProviderIcon from "$lib/plugins/agents/components/ProviderIcon.svelte";
  import PendingPermissionsPanel from "$lib/plugins/agents/components/PendingPermissionsPanel.svelte";
  import CyborgIcon from "$lib/components/CyborgIcon.svelte";
  import CyboSessionAvatar from "$lib/components/CyboSessionAvatar.svelte";
  import ChannelDetailsDialog from "$lib/components/channel/ChannelDetailsDialog.svelte";
  import ChannelContextMenu from "$lib/components/channel/ChannelContextMenu.svelte";
  import ConversationRow, { conversationTime } from "$lib/components/channel/ConversationRow.svelte";
  import BrowseChannelsModal from "$lib/components/channel/BrowseChannelsModal.svelte";
  import NewGroupDmDialog from "$lib/components/channel/NewGroupDmDialog.svelte";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import MobileSheet from "$lib/components/MobileSheet.svelte";
  import Field, { fieldInputClass } from "$lib/components/Field.svelte";
  import * as Select from "$lib/components/ui/select/index.js";
  import { cyboState } from "$lib/state/app.svelte.js";
  import { leaveChannel as leaveChannelAction, createChannel as createChannelAction, createGroupDm as createGroupDmAction } from "$lib/state/app.svelte.js";
  import { visibleChannels, groupDmChannels } from "$lib/channel-visibility.js";
  import { draftsState } from "$lib/drafts.svelte.js";
  import { filterMine, countOthersPersonalSessions, soleOthersDaemonId, remoteDaemonLabel } from "$lib/session-scope.js";
  import { setNavOrigin } from "$lib/mobile/navOrigin";
  import { favoritesState } from "$lib/state/app.svelte.js";
  import { onMount, untrack } from "svelte";
  import { flip } from "svelte/animate";

  const PROJECT_COLORS = [
    "#a78bfa", "#5BB5F0", "#3daa7c", "#e8ab5a",
    "#f472b6", "#fbbf24", "#f87171", "#9b9c9e",
  ];

  interface Project {
    id: string;
    name: string;
    color: string;
    createdAt?: number;
  }

  // Thin wrapper over the ONE shared resolver ($lib/agent-display.ts).
  function agentDisplayName(agent: typeof agents[0]): string {
    return sharedAgentDisplayName(agent, cyboState.list);
  }

  // Contrast-aware stroke for the selected color-swatch check: dark stroke on
  // light swatches, white on dark ones (relative luminance threshold).
  function checkStroke(hex: string): string {
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return L > 0.6 ? "#0d0e10" : "#ffffff";
  }

  const INVITE_ROLES = [
    { value: "member", label: "Member" },
    { value: "admin", label: "Admin" },
    { value: "viewer", label: "Viewer" },
  ];
  const inviteRoleLabel = $derived(INVITE_ROLES.find((r) => r.value === inviteRole)?.label ?? "Member");

  function folderName(cwd: string | null | undefined): string {
    if (!cwd) return "unknown";
    const parts = cwd.split("/");
    return parts[parts.length - 1] || parts[parts.length - 2] || cwd;
  }

  // The folder the agent was opened in — shown as a small badge so you can tell
  // where each session is running. Last path segment; full path on hover.
  // Returns null when cwd looks like a raw session/cybo id so callers can omit
  // the subtitle instead of surfacing an opaque identifier.
  function agentFolder(cwd: string): string | null {
    const parts = cwd.replace(/\/+$/, "").split("/");
    const last = parts[parts.length - 1] || cwd;
    // Guard: raw session identifiers (cybo_*, UUID-shaped strings, short hex
    // agentId prefixes) are not human-readable folder names — hide them.
    if (/^cybo_[0-9a-f-]{8,}/i.test(last)) return null;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(last)) return null;
    return last;
  }

  const channels = $derived(workspaceState.channels.filter((c) => !c.isPrivate));
  // #608: group DMs (hidden group_dm channels the user is a member of) list under
  // the Direct Messages section. fetch_channels is member-scoped, so every group
  // DM in workspaceState.channels is one we belong to. Sort by most-recent
  // activity (channel unread/last-message recency), newest first, then by name so
  // a fresh group DM with no activity sits stably.
  const groupDms = $derived(
    // groupDmChannels returns a fresh (filtered) array, so we can sort it in place.
    groupDmChannels(workspaceState.channels)
      .sort((a, b) => {
        // dmActivityState is bumped per channelId on every channel message, so it
        // doubles as the group-DM recency clock (newest first).
        const ra = wsId ? dmActivityState.getActivity(wsId, a.id) : 0;
        const rb = wsId ? dmActivityState.getActivity(wsId, b.id) : 0;
        if (rb !== ra) return rb - ra;
        return a.name.localeCompare(b.name);
      }),
  );
  // Full workspace agent list — kept for cross-user lookups (e.g. resolving a
  // favorited agent that someone else launched). The chat sidebar's Agents
  // SECTION renders the filtered `myAgents` instead (#706).
  const agents = $derived(workspaceState.agents);
  // #706: on a shared daemon the Agents section flooded with EVERY user's
  // sessions. Show only MINE + shared channel-bound cybos here; OTHER users'
  // personal sessions move to the daemon detail (and Settings → Logs for the
  // workspace-wide audit). filterMine keeps mine, keeps channel-bound shared
  // cybos, and keeps unattributable legacy rows — only other users' personal
  // sessions are dropped (see session-scope.ts).
  const myAgents = $derived(filterMine(workspaceState.agents, authState.user?.id));
  // How many of OTHER users' personal sessions were filtered out — drives the
  // "N sessions from others → view in the daemon" redirect hint so the move
  // reads as a redirection, not a silent disappearance.
  const othersSessionCount = $derived(
    countOthersPersonalSessions(workspaceState.agents, authState.user?.id),
  );
  // The single daemon those others' sessions run on, when unambiguous — lets the
  // hint deep-link straight to that daemon's Sessions sub-section.
  const othersDaemonId = $derived(soleOthersDaemonId(workspaceState.agents, authState.user?.id));
  const members = $derived(workspaceState.members);
  // Only owners/admins can invite people (the relay enforces this). Gate the
  // entry points so members/viewers never hit a raw "forbidden" wall.
  const canInvite = $derived(
    workspaceState.current?.role === "owner" || workspaceState.current?.role === "admin",
  );
  const wsId = $derived(workspaceState.current?.id ?? page.params.id);
  const pathname = $derived(page.url.pathname);

  // #17: order the Direct Messages list by most-recent message DESC
  // (Slack/Mattermost-style) via the ONE shared sort, so the sidebar and the
  // mobile DMs tab never diverge. Pre-sort by display name so peers with no
  // recorded activity form a stable, alphabetical tail.
  const dmMembers = $derived(
    sortMembersByDmRecency(
      [...members].sort((a, b) =>
        (a.name ?? a.email ?? "").localeCompare(b.name ?? b.email ?? ""),
      ),
      wsId,
    ),
  );

  const cfg = $derived(shellConfig.sidebar);
  const showAgents = $derived(shellConfig.features.agents);
  const pluginSections = $derived(pluginRegistry.getSidebarSections());

  // ── Warm projects cache ──────────────────────────────────────────────────
  // Seed synchronously from the module-level warm cache so projects paint on
  // the FIRST frame after swipe-back (channels are warm in workspaceState;
  // projects must match). A background refetch fires on every mount and swaps in
  // fresh data — no blank gap. The cache is keyed by wsId so workspace switches
  // can never bleed across. Cold-start (no cache yet) renders skeleton normally.
  function seedFromCache(id: string | undefined): {
    projects: Project[];
    channelProjectMap: Map<string, string>;
  } {
    if (!id) return { projects: [], channelProjectMap: new Map() };
    const cached = projectsCache.get(id);
    if (!cached) return { projects: [], channelProjectMap: new Map() };
    return { projects: cached.projects, channelProjectMap: new Map(cached.channelProjectMap) };
  }

  // Read the workspace id directly (not via the $derived `wsId`) so Svelte
  // doesn't warn about capturing a derived value at component initialization.
  // This is correct: on first mount we want the snapshot, and $effect handles
  // subsequent changes.
  const _initWsId = workspaceState.current?.id ?? (page.params.id as string | undefined);
  const _seed = seedFromCache(_initWsId);
  let projects = $state<Project[]>(_seed.projects);
  // Authoritative channel→project assignments from the server (channel_projects).
  // Used as a fallback in grouping so a channel still lands under its project
  // even when its per-channel `projectId` didn't propagate on this load — e.g. a
  // private channel that arrived via a later membership sync, after the initial
  // fetch. This makes grouping self-healing instead of one-shot.
  let channelProjectMap = $state<Map<string, string>>(_seed.channelProjectMap);

  // Track the last wsId we fetched for so the $effect knows when to re-seed
  // from cache (workspace switch) and kick off a fresh background fetch.
  // Plain let (not $state) — writing it must NOT re-trigger the effect or we'd
  // fire two background fetches per mount (one before the seed, one after).
  let fetchedForWsId: string | undefined;

  // Item 4 — skeleton loaders during initial sidebar hydration. Members load
  // after core data in selectWorkspace, so the DM roster has a real "loading but
  // empty" window; show shimmer rows instead of a blank/collapsed section. The
  // channels skeleton only fires while members are still in flight AND no channel
  // data has arrived at all — so a workspace that genuinely has zero channels
  // still shows its real empty-state copy, never a permanent shimmer.
  const dmListLoading = $derived(workspaceState.membersLoading && members.length === 0);
  const channelsLoading = $derived(
    workspaceState.membersLoading &&
      workspaceState.channels.length === 0 &&
      projects.length === 0,
  );

  $effect(() => {
    if (!wsId) return;
    if (wsId !== fetchedForWsId) {
      // Workspace changed (or first mount): seed from cache synchronously so
      // the sidebar paints the cached list while the background fetch runs.
      const fresh = untrack(() => seedFromCache(wsId));
      projects = fresh.projects;
      channelProjectMap = fresh.channelProjectMap;
      fetchedForWsId = wsId;
    }
    // Always kick off a background refresh on every mount. The cached value
    // renders immediately; the fetch result replaces it when it lands.
    const currentWsId = wsId;
    fetchProjects()
      .then(({ projects: ps, channelProjects: cps }) => {
        // Guard: discard if the workspace changed while the fetch was in flight.
        if (fetchedForWsId !== currentWsId) return;
        projects = ps;
        channelProjectMap = new Map(cps.map((cp) => [cp.channelId, cp.projectId]));
        return undefined;
      })
      // intentional: background project-grouping hydration; on failure channels render flat, self-heals on remount.
      .catch(() => {});
  });

  // Group EVERY channel (public + private) by project. Private channels live
  // under their project with a lock icon — no separate "Private" section, no
  // "Unfiled" bucket (project-less channels render flat). The per-channel
  // projectId wins; channelProjectMap is the authoritative fallback so a
  // late/un-propagated assignment still groups correctly.
  const channelsByProject = $derived.by(() => {
    const grouped = new Map<string | null, typeof channels>();
    for (const project of projects) {
      grouped.set(project.id, []);
    }
    grouped.set(null, []);
    // #608: group DMs are hidden group_dm channels — they list under Direct
    // Messages, never as a project/Channels row. Exclude them here.
    for (const ch of visibleChannels(workspaceState.channels)) {
      const pid = (ch.projectId ?? channelProjectMap.get(ch.id)) ?? null;
      if (pid && grouped.has(pid)) {
        grouped.get(pid)!.push(ch);
      } else {
        grouped.get(null)!.push(ch);
      }
    }
    return grouped;
  });


  // Track which project contains the active channel. Must use the same dual-source
  // lookup as channelsByProject (ch.projectId first, then channelProjectMap) so that
  // a channel assigned only via the map still auto-expands its project.
  const activeChannelProjectId = $derived.by(() => {
    if (!channelState.activeId) return null;
    const ch = workspaceState.channels.find((c) => c.id === channelState.activeId);
    if (!ch) return null;
    return ch.projectId ?? channelProjectMap.get(ch.id) ?? null;
  });

  let channelsOpen = $state(true);
  let agentsOpen = $state(true);
  let terminalsOpen = $state(true);
  // Machines (daemons) — surfaced in the mobile Home/Projects tab (in addition to
  // the dedicated Daemons bottom-nav tab). Online first.
  let machinesOpen = $state(true);
  const machines = $derived(
    daemonState.list
      .map((d) => ({
        id: d.id,
        host: d.meta?.host ?? d.label,
        online: daemonStatusState.get(d.id) === "online",
      }))
      .sort((a, b) => Number(b.online) - Number(a.online)),
  );
  function handleMachineClick() {
    if (!wsId) return;
    viewportState.closeDrawer();
    setNavOrigin(page.url.pathname);
    // The clean daemon page (the old /daemons/[id] route redirects to the removed
    // Agents view); mirrors the Daemons tab target.
    goto(`/workspace/${wsId}/settings/daemon`);
  }
  let dmsOpen = $state(true);

  // Live (daemon-scoped, non-PG) terminal sessions for this workspace, tracked
  // client-side (#701) so the user can return to one after switching tabs. The list
  // is seeded both by terminals THIS client started AND by the daemon's directory
  // feed below — so a terminal opened out-of-band (CLI `cyborg terminal create
  // --workspace`, or another client) also appears here.
  const terminals = $derived(wsId ? terminalSessionsState.forWorkspace(wsId) : []);

  // Source the sidebar from the daemon's ACTUAL terminal directory for the active
  // workspace, not just terminals this client opened (terminal CLI-UI unification).
  // On workspace activation: pull the current directory once (list_terminals), then
  // subscribe to the push feed (terminals_changed) so a CLI start/kill — or another
  // client's — updates the sidebar live. ingestDirectory de-dupes by terminalId and
  // respects the dismissed set, so this never double-adds a client-started row.
  $effect(() => {
    const id = wsId;
    if (!id) return;
    let active = true;
    void client
      .listTerminals(id)
      .then((entries) => {
        if (active) terminalSessionsState.ingestDirectory(id, entries);
      })
      .catch((err) => {
        // intentional: a daemon without the directory RPC (older build) or an
        // offline daemon just means no out-of-band rows — the client-started list
        // still renders. Never surface a sidebar error for this. But DO log it:
        // swallowing every failure silently is what hid the relay rejecting this
        // pull ("daemonId required"), so the Terminals section stayed invisible
        // with no trace. Log so a real routing regression is debuggable.
        console.debug("[ChannelSidebar] listTerminals directory pull failed", err);
      });
    const off = client.onTerminalsChanged((payload) => {
      if (active && payload.workspaceId === id) {
        terminalSessionsState.ingestDirectory(id, payload.terminals);
      }
    });
    return () => {
      active = false;
      off();
    };
  });

  // Open a tracked terminal session: route back to its live emulator, carrying
  // the daemon so input/resize target the right pty (#701). Closes the mobile
  // drawer + records the nav origin like the other sidebar row handlers.
  function handleTerminalClick(terminalId: string, daemonId: string) {
    if (!wsId) return;
    channelState.activeId = null;
    viewportState.closeDrawer();
    setNavOrigin(page.url.pathname);
    goto(`/workspace/${wsId}/terminal/${terminalId}?daemon=${encodeURIComponent(daemonId)}`);
  }

  // Highlight the row whose session is currently open.
  function isTerminalActive(terminalId: string): boolean {
    return page.params.terminalId === terminalId;
  }

  // Dismiss a terminal from the sidebar: kill the daemon pty (best-effort — the
  // session is daemon-scoped, and a corrupted/dead session may reject the kill)
  // then drop the client-side entry. Removal must NOT depend on the kill.
  //
  // dismiss() marks the id so the still-mounted terminal route can't re-add() it
  // — its $effect resurrects a plain remove() of the viewed session (#701), which
  // is exactly why the row was un-deletable. If we're currently viewing the
  // dismissed session, also navigate away so the route unmounts and stops driving
  // a now-dead pty.
  function closeTerminal(terminalId: string, daemonId: string, e: Event) {
    e.stopPropagation();
    if (wsId) {
      try {
        client.terminalSocket().send({
          type: "cyborg:kill_terminal",
          workspaceId: wsId,
          daemonId,
          terminalId,
        });
      } catch {
        // intentional: kill is best-effort; the row is removed regardless.
      }
    }
    terminalSessionsState.dismiss(terminalId);
    if (wsId && page.params.terminalId === terminalId) {
      channelState.activeId = null;
      setNavOrigin(page.url.pathname);
      goto(`/workspace/${wsId}`);
    }
  }

  // User-toggled expansion state (explicit overrides only)
  let projectToggle = $state<Map<string, boolean>>(new Map());

  function isProjectExpanded(projectId: string): boolean {
    const override = projectToggle.get(projectId);
    if (override !== undefined) return override;
    if (activeChannelProjectId === projectId) return true;
    // Mobile: default-open the FIRST project so Chats lands on real channels
    // instead of an all-collapsed list. Any project can still be collapsed (the
    // toggle is stored in projectToggle, which takes precedence above).
    if (viewportState.isMobile && projects[0]?.id === projectId) return true;
    return false;
  }

  function toggleProjectExpanded(projectId: string) {
    const next = new Map(projectToggle);
    next.set(projectId, !isProjectExpanded(projectId));
    projectToggle = next;
  }

  // ─── Unread-only filter (additive) ────────────────────────────────
  // When enabled, the Channels / DMs / Favorites lists show only items with an
  // unread signal. Off by default, so the normal sidebar is unchanged.
  let unreadOnly = $state(false);

  function channelHasUnread(channelId: string): boolean {
    if (!wsId) return false;
    return unreadFlagState.isUnread(wsId, channelId) || notificationState.getCount(wsId, channelId) > 0;
  }
  function dmHasUnread(userId: string): boolean {
    if (!wsId) return false;
    return notificationState.getCount(wsId, userId) > 0;
  }
  function agentHasUnread(agentId: string): boolean {
    if (!wsId) return false;
    return notificationState.getCount(wsId, agentId) > 0;
  }
  // A channel passes the filter when the toggle is off OR it's unread OR it's the
  // currently open channel (so the active row never vanishes under your cursor).
  function channelPassesFilter(channelId: string): boolean {
    return !unreadOnly || channelHasUnread(channelId) || isChannelActive(channelId);
  }
  function dmPassesFilter(userId: string): boolean {
    return !unreadOnly || dmHasUnread(userId) || isDmActive(userId);
  }

  // ─── Collapsed-group unread surfacing (Discord-style) ─────────────
  // A collapsed project hides its read channels but still SURFACES any channel
  // with an unread signal, so a new message in a hidden channel isn't invisible
  // (you only heard a sound before). The header also rolls the group's unread up
  // into a dot + mention count. Muted channels never bubble up.
  // The active channel is NOT peeked — its project auto-expands (isProjectExpanded
  // returns true when activeChannelProjectId matches), and if the user explicitly
  // collapsed the project the channel is already open in the main view; showing it
  // below the header looks like an orphaned/ungrouped row (the bug).
  function projectPeekChannels(projectChannels: typeof channels): typeof channels {
    return projectChannels.filter(
      (ch) => notifPrefsState.get(ch.id) !== "muted" && channelHasUnread(ch.id),
    );
  }
  function projectUnreadRollup(
    projectChannels: typeof channels,
  ): { hasUnread: boolean; mentionCount: number } {
    let hasUnread = false;
    let mentionCount = 0;
    for (const ch of projectChannels) {
      if (notifPrefsState.get(ch.id) === "muted" || isChannelActive(ch.id)) continue;
      if (!wsId) continue;
      if (unreadFlagState.isUnread(wsId, ch.id)) hasUnread = true;
      const count = notificationState.getCount(wsId, ch.id);
      if (count > 0) {
        hasUnread = true;
        mentionCount += count;
      }
    }
    return { hasUnread, mentionCount };
  }

  // ─── Favorites (client-only, additive) ────────────────────────────
  // Starred channels / DMs / agents pinned to a "Favorites" section at the top.
  // Persisted per-user in localStorage via favoritesState.
  function isFavorite(targetId: string): boolean {
    return wsId ? favoritesState.isFavorite(wsId, targetId) : false;
  }
  function toggleFavorite(targetId: string, e?: MouseEvent): void {
    e?.stopPropagation();
    if (wsId) favoritesState.toggle(wsId, targetId);
  }

  interface FavoriteRow {
    id: string;
    kind: "channel" | "dm" | "agent";
    name: string;
    isPrivate?: boolean;
    image?: string | null;
  }

  const favoriteRows = $derived.by<FavoriteRow[]>(() => {
    if (!wsId) return [];
    const ids = favoritesState.list(wsId);
    const rows: FavoriteRow[] = [];
    for (const id of ids) {
      const ch = workspaceState.channels.find((c) => c.id === id);
      if (ch) {
        rows.push({ id, kind: "channel", name: ch.name, isPrivate: ch.isPrivate });
        continue;
      }
      const member = members.find((m) => m.userId === id);
      if (member) {
        const name = member.name ?? member.email?.split("@")[0] ?? "User";
        rows.push({ id, kind: "dm", name, image: authState.getMemberImage(member.userId) });
        continue;
      }
      const agent = agents.find((a) => a.agentId === id);
      if (agent) {
        rows.push({ id, kind: "agent", name: agentDisplayName(agent) });
      }
      // Unknown ids (e.g. a left channel) are silently dropped from the view but
      // kept in storage, so re-joining restores the star.
    }
    return rows;
  });
  let favoritesOpen = $state(true);

  function openFavoriteRow(row: FavoriteRow): void {
    if (row.kind === "channel") handleChannelClick(row.id);
    else if (row.kind === "dm") handleDmClick(row.id);
    else handleAgentClick(row.id);
  }

  // ─── Alt+Up/Down channel navigation (additive) ────────────────────
  // A flat, display-order list of every navigable sidebar target. Alt+Up/Down
  // cycles through ALL of them; Alt+Shift+Up/Down cycles only the unread ones.
  // Mirrors Mattermost's navigateChannelShortcut, wrapping at the boundaries.
  interface NavTarget {
    id: string;
    kind: "channel" | "dm" | "agent";
  }

  const navTargets = $derived.by<NavTarget[]>(() => {
    const out: NavTarget[] = [];
    // Channels in the same visual order the sidebar renders them: each project's
    // channels (in project order), then project-less ("orphan") channels.
    for (const project of projects) {
      for (const ch of channelsByProject.get(project.id) ?? []) {
        out.push({ id: ch.id, kind: "channel" });
      }
    }
    for (const ch of channelsByProject.get(null) ?? []) {
      out.push({ id: ch.id, kind: "channel" });
    }
    for (const agent of myAgents) out.push({ id: agent.agentId, kind: "agent" });
    // #608: group DMs route via the channel pipeline (kind "channel" →
    // handleChannelClick), but render in the DM section, so place them with DMs.
    for (const gdm of groupDms) out.push({ id: gdm.id, kind: "channel" });
    for (const member of dmMembers) {
      if (member.userId === authState.user?.id) continue;
      out.push({ id: member.userId, kind: "dm" });
    }
    return out;
  });

  function navTargetIsUnread(t: NavTarget): boolean {
    if (t.kind === "channel") return channelHasUnread(t.id);
    if (t.kind === "dm") return dmHasUnread(t.id);
    return agentHasUnread(t.id);
  }

  // Index of the currently-open target within navTargets, or -1.
  function currentNavIndex(): number {
    return navTargets.findIndex((t) => {
      if (t.kind === "channel") return isChannelActive(t.id);
      if (t.kind === "dm") return isDmActive(t.id);
      return isAgentActive(t.id);
    });
  }

  function openNavTarget(t: NavTarget): void {
    if (t.kind === "channel") handleChannelClick(t.id);
    else if (t.kind === "dm") handleDmClick(t.id);
    else handleAgentClick(t.id);
  }

  function navigateRelative(delta: number, unreadOnlyNav: boolean): void {
    const list = unreadOnlyNav ? navTargets.filter(navTargetIsUnread) : navTargets;
    if (list.length === 0) return;
    const current = currentNavIndex();
    if (unreadOnlyNav) {
      // For unread nav, start from the current item's position in the full list
      // and walk forward/backward to the next unread.
      const full = navTargets;
      if (full.length === 0) return;
      // No current selection: seed so the first step lands on the first (delta>0)
      // or last (delta<0) item. (Flattened from a nested ternary — oxlint.)
      let idx = current;
      if (current === -1) idx = delta > 0 ? -1 : 0;
      for (let step = 0; step < full.length; step++) {
        idx = (idx + delta + full.length) % full.length;
        if (navTargetIsUnread(full[idx])) {
          openNavTarget(full[idx]);
          return;
        }
      }
      return;
    }
    // Plain prev/next over the full list, wrapping. If nothing is active, Alt+Down
    // opens the first item and Alt+Up the last.
    let nextIdx: number;
    if (current === -1) nextIdx = delta > 0 ? 0 : list.length - 1;
    else nextIdx = (current + delta + list.length) % list.length;
    openNavTarget(list[nextIdx]);
  }

  // Global keydown: Alt+Up/Down (+ Shift for unread-only). Guarded so it never
  // fires while typing in an input/textarea/contenteditable, and never on mobile.
  function isEditableTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }

  function handleNavKeydown(e: KeyboardEvent): void {
    if (viewportState.isMobile) return;
    if (!e.altKey || e.metaKey || e.ctrlKey) return;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if (isEditableTarget(e.target)) return;
    e.preventDefault();
    const delta = e.key === "ArrowDown" ? 1 : -1;
    navigateRelative(delta, e.shiftKey);
  }

  onMount(() => {
    window.addEventListener("keydown", handleNavKeydown);
    return () => window.removeEventListener("keydown", handleNavKeydown);
  });

  // ─── FLIP channel reorder (#524) ──────────────────────────────────
  // Channel rows slide to their new positions when the list order changes
  // (e.g. a channel jumps on new activity) instead of snapping. animate:flip is
  // a pure GPU transform, so ~50 rows stay at 60fps. prefers-reduced-motion
  // collapses the duration to 0 → the move is instant (no slide) for
  // motion-sensitive users. Tracked reactively so a mid-session OS toggle wins.
  let reduceMotion = $state(false);
  onMount(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduceMotion = mq.matches;
    const onChange = (e: MediaQueryListEvent) => (reduceMotion = e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  });
  const flipParams = $derived({ duration: reduceMotion ? 0 : 220 });

  let sidebarWidth = $state(275);
  let isDragging = $state(false);
  const minWidth = 215;

  // Modals
  let showBrowseChannels = $state(false);
  // #608: the multi-select "start a group DM" picker.
  let showNewGroupDm = $state(false);
  let showAddChannel = $state(false);
  let newChannelName = $state("");
  let newChannelPrivate = $state(false);
  let newChannelProject = $state<string | null>(null);

  let showAddProject = $state(false);
  let newProjectName = $state("");
  let newProjectColor = $state(PROJECT_COLORS[0]);

  // On mobile the create-channel form renders as a sheet (no bits-ui Dialog),
  // so the desktop `onOpenChange(open=true)` seed never fires. Mirror it here:
  // default the project select to the first project when the sheet opens, so
  // the Create button (which requires a project) isn't stuck disabled.
  let wasAddChannelOpen = false;
  $effect(() => {
    if (showAddChannel && !wasAddChannelOpen && viewportState.isMobile) {
      newChannelProject = newChannelProject ?? projects[0]?.id ?? null;
    }
    wasAddChannelOpen = showAddChannel;
  });

  let showInviteHuman = $state(false);
  let inviteEmail = $state("");
  let inviteRole = $state("member");
  let inviteSentUrl = $state("");
  let inviteSentEmail = $state("");
  let inviteCopied = $state(false);
  // Track the "Copied" reset timer so rapid re-clicks don't clobber each other —
  // each click clears the prior timer so the badge shows for a full 2s.
  let copyTimeout: ReturnType<typeof setTimeout> | null = null;
  let inviting = $state(false);
  let inviteError = $state<string | null>(null);

  // Project editing
  let editingProject = $state<string | null>(null);
  let editProjectName = $state("");
  let editProjectColor = $state("");

  let workspaceMenuOpen = $state(false);
  let projectMenuOpen = $state<string | null>(null);
  let agentMenuOpen = $state<string | null>(null);
  // Agent currently being restarted (#592) — disables its menu item + shows a
  // "Restarting…" label while the reload round-trips.
  let restartingAgentId = $state<string | null>(null);
  let channelMenuOpen = $state<string | null>(null);
  let channelMenuPos = $state({ x: 0, y: 0 });
  let showEditChannelDialog = $state(false);
  let editingChannelForDialog = $state<typeof channels[0] | null>(null);
  // Item 3: confirm before leaving a channel from the sidebar context menu — a
  // destructive action that was previously instant. Holds the pending channel.
  let pendingLeaveChannel = $state<typeof channels[0] | null>(null);

  function isChannelActive(id: string): boolean {
    return channelState.activeId === id;
  }

  function isAgentActive(agentId: string): boolean {
    return page.params.agentId === agentId;
  }

  function isDraftActive(): boolean {
    return pathname.endsWith("/agent/new");
  }

  function isDmActive(userId: string): boolean {
    return pathname.includes(`/dm/${userId}`);
  }

  function handleChannelClick(channelId: string) {
    if (!wsId) return;
    // Close the mobile drawer on selection. Must be explicit (not just the
    // layout's close-on-route effect): re-tapping the ACTIVE channel is a
    // same-URL goto that SvelteKit no-ops, so pathname never changes and the
    // route effect never fires — that was the "drawer stuck open" case.
    // No-op on desktop (drawer isn't rendered there).
    viewportState.closeDrawer();
    // Record the list we're opening FROM so mobile back (swipe + button) returns
    // here rather than the static parent.
    setNavOrigin(page.url.pathname);
    // The channel route's $effect owns selectChannel — calling it here too
    // caused a duplicate concurrent fetch for the same channel.
    goto(`/workspace/${wsId}/channel/${channelId}`);
  }

  function handleDmClick(userId: string) {
    if (!wsId) return;
    viewportState.closeDrawer();
    channelState.activeId = null;
    setNavOrigin(page.url.pathname);
    goto(`/workspace/${wsId}/dm/${userId}`);
  }

  function handleAgentClick(agentId: string) {
    if (!wsId) return;
    viewportState.closeDrawer();
    channelState.activeId = null;
    setNavOrigin(page.url.pathname);
    goto(`/workspace/${wsId}/agent/${agentId}`);
  }

  function handleNewAgent() {
    if (!wsId) return;
    viewportState.closeDrawer();
    channelState.activeId = null;
    // Launch sessions from the Agents tab (AgentsPane's "Create agent" dialog) —
    // the old /agent/new page flow is superseded.
    goto(`/workspace/${wsId}/agents`);
  }

  // Bottom "Add agent" action opens the Agents tab (overview of all agents),
  // not the create-new form — that's where you browse/launch from.
  function handleOpenAgents() {
    if (!wsId) return;
    viewportState.closeDrawer();
    channelState.activeId = null;
    goto(`/workspace/${wsId}/agents`);
  }

  // #706 redirect hint: jump to where OTHER users' sessions now live. When all
  // of them share one daemon, deep-link to that daemon's detail (its Sessions
  // sub-section); otherwise open the Daemons overview to pick one.
  function handleViewOthersSessions() {
    if (!wsId) return;
    viewportState.closeDrawer();
    channelState.activeId = null;
    setNavOrigin(page.url.pathname);
    goto(
      othersDaemonId
        ? `/workspace/${wsId}/daemons/${othersDaemonId}`
        : `/workspace/${wsId}/daemons`,
    );
  }

  // An agent is "online" when its daemon is alive. While the daemon is online we
  // still surface live lifecycle nuance (running pulses, error is red); when the
  // daemon is offline the agent is dimmed regardless of its last lifecycle.
  function agentDotClass(agent: { daemonId?: string | null; lifecycle: string }): string {
    const daemonOnline = !!agent.daemonId && daemonStatusState.get(agent.daemonId) === "online";
    if (!daemonOnline) return "bg-content-dim";
    if (agent.lifecycle === "running") return "bg-online animate-pulse";
    if (agent.lifecycle === "error") return "bg-error";
    return "bg-online";
  }

  // Cross-daemon labeling: the "my sessions" list aggregates MY sessions across
  // ALL daemons, so a session on a remote machine is tagged with WHICH daemon it
  // lives on (its label, or "Remote" when unresolved) — otherwise a remote
  // session is indistinguishable from a local one. Pure logic in session-scope.
  function remoteDaemonBadge(agent: { daemonLocal?: boolean; daemonId?: string | null }): string | null {
    return remoteDaemonLabel(agent, (id) => daemonState.byId(id)?.label);
  }


  async function handleAddChannel() {
    if (!newChannelName.trim()) return;
    // Every channel must belong to a project — no project, no channel.
    if (!newChannelProject) return;
    const slug = newChannelName.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-").replace(/^-+|-+$/g, "");
    if (!slug) return;
    const projectId = newChannelProject;
    const isPrivate = newChannelPrivate;
    showAddChannel = false;
    newChannelName = "";
    newChannelPrivate = false;
    newChannelProject = null;
    try {
      const ch = await createChannelAction(slug, { isPrivate, projectId });
      if (ch) {
        selectChannel(ch.id);
        viewportState.closeDrawer();
        if (wsId) goto(`/workspace/${wsId}/channel/${ch.id}`);
      }
    } catch (err) {
      console.error("Failed to create channel:", err);
    }
  }

  // Write the current projects + channelProjectMap back into the warm cache so
  // a subsequent remount (swipe-back) paints the up-to-date list immediately.
  function syncProjectsToCache(): void {
    if (!wsId) return;
    projectsCache.set(wsId, { projects, channelProjectMap });
  }

  async function handleAddProject() {
    if (!newProjectName.trim()) return;
    const name = newProjectName.trim();
    const color = newProjectColor;
    showAddProject = false;
    newProjectName = "";
    newProjectColor = PROJECT_COLORS[0];
    try {
      const id = await createProjectAction(name, color);
      projects = [...projects, { id, name, color, createdAt: Date.now() }];
      syncProjectsToCache();
    } catch (err) {
      console.error("Failed to create project:", err);
    }
  }

  function openEditProject(project: Project, e: MouseEvent) {
    e.stopPropagation();
    projectMenuOpen = null;
    editingProject = project.id;
    editProjectName = project.name;
    editProjectColor = project.color;
  }

  async function handleSaveProject() {
    if (!editingProject || !editProjectName.trim()) return;
    const id = editingProject;
    const name = editProjectName.trim();
    const color = editProjectColor;
    editingProject = null;
    projects = projects.map((p) => (p.id === id ? { ...p, name, color } : p));
    syncProjectsToCache();
    try {
      await updateProjectAction(id, name, color);
    } catch (err) {
      console.error("Failed to update project:", err);
    }
  }

  async function handleDeleteProject(projectId: string) {
    projectMenuOpen = null;
    // Snapshot for rollback — the server delete can fail (e.g. permissions); we
    // optimistically unfile the project's channels + drop it, then restore on
    // error so a rejected delete doesn't look like it worked and then "come back"
    // on the next fetchProjects.
    // Independent copies for rollback — assigning the $state array by reference
    // would let later in-place mutations corrupt the snapshot (Gemini).
    const prevProjects = $state.snapshot(projects);
    const prevAssignments = workspaceState.channels.map((ch) => [ch.id, ch.projectId] as const);
    for (const ch of workspaceState.channels) {
      if (ch.projectId === projectId) ch.projectId = null;
    }
    workspaceState.channels = workspaceState.channels.slice();
    projects = projects.filter((p) => p.id !== projectId);
    syncProjectsToCache();
    try {
      await deleteProjectAction(projectId);
    } catch (err) {
      console.error("Failed to delete project:", err);
      projects = prevProjects;
      const restore = new Map(prevAssignments);
      for (const ch of workspaceState.channels) {
        const pid = restore.get(ch.id);
        if (pid !== undefined) ch.projectId = pid;
      }
      workspaceState.channels = workspaceState.channels.slice();
      // Rollback the cache too so a remount gets the restored list.
      syncProjectsToCache();
      toast.error("Couldn't delete the project — please try again.");
    }
  }

  async function moveChannelToProject(channelId: string, projectId: string | null) {
    channelMenuOpen = null;
    const ch = workspaceState.channels.find((c) => c.id === channelId);
    if (!ch) return;
    const prevProjectId = ch.projectId ?? null;
    const prevMap = new Map(channelProjectMap);
    // Optimistic: update the channel AND the authoritative assignment map.
    ch.projectId = projectId;
    workspaceState.channels = workspaceState.channels.slice();
    const nextMap = new Map(channelProjectMap);
    if (projectId) nextMap.set(channelId, projectId);
    else nextMap.delete(channelId);
    channelProjectMap = nextMap;
    syncProjectsToCache();
    try {
      await setChannelProject(channelId, projectId);
    } catch {
      // Persist failed — revert and surface it instead of silently losing the
      // move (which would "stick" optimistically then vanish on reload).
      ch.projectId = prevProjectId;
      workspaceState.channels = workspaceState.channels.slice();
      channelProjectMap = prevMap;
      // Rollback the cache so a remount gets the reverted assignment.
      syncProjectsToCache();
      toast.error("Couldn't move the channel — please try again.");
    }
  }

  async function handleDeleteChannel(channelId: string, name: string) {
    channelMenuOpen = null;
    if (!confirm(`Delete #${name}? This removes the channel and its history for everyone. This can't be undone.`))
      return;
    try {
      await deleteChannel(channelId);
      toast.success(`Deleted #${name}`);
    } catch {
      toast.error("Couldn't delete the channel — please try again.");
    }
  }

  function openChannelMenu(channelId: string, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    channelMenuOpen = channelMenuOpen === channelId ? null : channelId;
    channelMenuPos = { x: e.clientX, y: e.clientY };
  }

  async function handleInviteHuman() {
    if (!inviteEmail.trim()) return;
    inviting = true;
    inviteError = null;
    try {
      const sentTo = inviteEmail.trim();
      const { inviteUrl } = await inviteMember(sentTo, inviteRole as "admin" | "member" | "viewer");
      // Keep the dialog open and surface the shareable invite link + Copy button
      // (matches the Members-settings modal) instead of silently closing.
      inviteSentEmail = sentTo;
      inviteSentUrl = inviteUrl;
      inviteCopied = false;
      inviteEmail = "";
    } catch (err) {
      const raw = err instanceof Error ? err.message : "Failed to send invite";
      // Map the relay's raw permission/error strings to something readable.
      if (raw === "forbidden") {
        inviteError = "Only workspace owners and admins can invite people.";
      } else if (raw === "already a member") {
        inviteError = "That person is already a member of this workspace.";
      } else {
        inviteError = raw;
      }
    } finally {
      inviting = false;
    }
  }

  async function copyInviteLink() {
    if (!inviteSentUrl) return;
    try {
      await navigator.clipboard.writeText(inviteSentUrl);
    } catch {
      const el = document.createElement("textarea");
      el.value = inviteSentUrl;
      el.style.cssText = "position:fixed;opacity:0;pointer-events:none";
      document.body.appendChild(el);
      el.select();
      try {
        document.execCommand("copy");
      } catch {
        /* ignore */
      }
      document.body.removeChild(el);
    }
    inviteCopied = true;
    if (copyTimeout) clearTimeout(copyTimeout);
    copyTimeout = setTimeout(() => {
      inviteCopied = false;
      copyTimeout = null;
    }, 2000);
  }

  function toggleAgentMenu(agentId: string, e: MouseEvent) {
    e.stopPropagation();
    agentMenuOpen = agentMenuOpen === agentId ? null : agentId;
    aliasEditing = null;
  }

  // Inline permission answering from the sidebar (#648): the warning badge on an
  // agent row opens a popover with the SAME QuestionCard / PermissionCard the
  // detail page uses, so a pending permission can be approved/denied without
  // leaving the current channel.
  let agentPermsOpen = $state<string | null>(null);
  function toggleAgentPerms(agentId: string, e: MouseEvent) {
    e.stopPropagation();
    agentPermsOpen = agentPermsOpen === agentId ? null : agentId;
    agentMenuOpen = null;
  }
  // Close the popover once its agent has nothing left to answer (the last
  // permission was just resolved), so an empty anchor box never lingers.
  $effect(() => {
    if (
      agentPermsOpen &&
      agentStreamState.getPendingPermissions(agentPermsOpen).length === 0
    ) {
      agentPermsOpen = null;
    }
  });

  // Client-only session alias (local tag, in-memory) — see session-alias store.
  let aliasEditing = $state<string | null>(null); // agentId whose alias input is open
  let aliasDraft = $state("");
  function startAliasEdit(agentId: string): void {
    aliasEditing = agentId;
    aliasDraft = sessionAlias.get(agentId) ?? "";
  }
  function saveAlias(agentId: string): void {
    sessionAlias.set(agentId, aliasDraft);
    aliasEditing = null;
    agentMenuOpen = null;
  }
  function clearAlias(agentId: string): void {
    sessionAlias.clear(agentId);
    aliasEditing = null;
    agentMenuOpen = null;
  }

  // Per-user terminal alias (server-backed, cross-device synced) — see
  // terminal-alias store. Inline rename right in the sidebar row so the affordance
  // is available on desktop too, not just the mobile DMs tab.
  let terminalAliasEditing = $state<string | null>(null); // terminalId whose input is open
  let terminalAliasDraft = $state("");
  function terminalName(terminal: { terminalId: string; title: string }): string {
    return terminalAlias.get(terminal.terminalId) ?? terminal.title;
  }
  function startTerminalAliasEdit(terminalId: string, e: Event): void {
    e.stopPropagation();
    terminalAliasEditing = terminalId;
    terminalAliasDraft = terminalAlias.get(terminalId) ?? "";
  }
  function saveTerminalAlias(terminalId: string): void {
    terminalAlias.set(terminalId, terminalAliasDraft, wsId);
    terminalAliasEditing = null;
  }
  function clearTerminalAlias(terminalId: string): void {
    terminalAlias.clear(terminalId, wsId);
    terminalAliasEditing = null;
  }

  function toggleProjectMenu(projectId: string, e: MouseEvent) {
    e.stopPropagation();
    projectMenuOpen = projectMenuOpen === projectId ? null : projectId;
  }

  function handleClickOutsideMenu(e: MouseEvent) {
    if (channelMenuOpen && !(e.target as HTMLElement).closest(".channel-context-menu")) {
      channelMenuOpen = null;
    }
    const target = e.target as HTMLElement;
    if (agentMenuOpen && !target.closest(".agent-context-menu")) {
      agentMenuOpen = null;
    }
    if (agentPermsOpen && !target.closest(".agent-perms-panel")) {
      agentPermsOpen = null;
    }
    if (projectMenuOpen && !target.closest(".project-context-menu")) {
      projectMenuOpen = null;
    }
  }

  function startResize() {
    isDragging = true;
    const onMove = (e: MouseEvent) => {
      if (!isDragging) return;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      sidebarWidth = Math.max(minWidth, sidebarWidth + e.movementX / 1.3);
    };
    const onUp = () => {
      isDragging = false;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }
</script>

{#snippet chevronSvg(open: boolean)}
  <svg class={cn("shrink-0 transition-transform duration-150", !open && "-rotate-90")} width="12" height="12" viewBox="0 0 16 16" fill="var(--secondary)">
    <path d="M4.5 6L8 9.5L11.5 6" stroke="var(--secondary)" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
{/snippet}

<!-- active: white-on-dark active row (--sidebar-active-text). bold (unread but
     NOT active): use text-content (theme-aware) so it reads in both dark and
     light mode. text-white was dark-only and rendered invisible in light mode. -->
{#snippet hashIcon(active: boolean, bold: boolean)}
  <span
    class={cn(
      "shrink-0",
      active ? "text-[var(--sidebar-active-text)]" : bold ? "text-content" : "text-content-muted",
    )}
  >
    <ChannelGlyph kind="hash" class="w-3.5 h-3.5" />
  </span>
{/snippet}

{#snippet lockIcon(active: boolean, bold: boolean)}
  <span
    class={cn(
      "shrink-0",
      active ? "text-[var(--sidebar-active-text)]" : bold ? "text-content" : "text-content-muted",
    )}
  >
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
  </span>
{/snippet}

{#snippet unreadBadge(count: number)}
  <!-- #524: a subtle one-shot pop when the badge appears (0→N) or its count
       increments. Keying on `count` remounts the span so the animation replays
       on each change; the fresh mount on 0→N pops it the first time too.
       animate-pulse-once is already reduced-motion-guarded in app.css. -->
  {#key count}
    <span class="animate-pulse-once shrink-0 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-error text-accent-foreground text-[10px] font-bold px-1">
      {count > 99 ? "99+" : count}
    </span>
  {/key}
{/snippet}

{#snippet muteIcon()}
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" class="shrink-0 opacity-50">
    <path d="M13.5 8a5.5 5.5 0 0 0-1.04-3.22l-7.72 7.72A5.5 5.5 0 0 0 13.5 8ZM3.54 11.22l7.72-7.72a5.5 5.5 0 0 0-7.72 7.72ZM15 8A7 7 0 1 1 1 8a7 7 0 0 1 14 0Z" fill="currentColor" />
  </svg>
{/snippet}

<!-- Draft pencil: channels with unsent composer text show a ✎ (v1 Sidebar.tsx). -->
{#snippet draftPencil(channelId: string)}
  {#if (draftsState.get(`channel:${channelId}`)?.text ?? "").trim() !== ""}
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" class="ml-auto shrink-0 text-content-dim" aria-label="Unsent draft">
      <title>Unsent draft</title>
      <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 2.474L4.877 12.51a2 2 0 0 1-.84.456l-2.868.722a.75.75 0 0 1-.92-.928l.722-2.868a2 2 0 0 1 .456-.84l8.586-8.625Zm.177 1.06a.25.25 0 0 0-.354 0L2.25 11.074a.5.5 0 0 0-.114.21l-.403 1.603 1.603-.403a.5.5 0 0 0 .21-.114l8.586-8.586a.25.25 0 0 0 0-.354l-.942-.942Z" />
    </svg>
  {/if}
{/snippet}

{#snippet channelRow(channel: typeof channels[0], flat: boolean)}
  <!-- BUG #2: BOLD comes from the unread FLAG (any non-muted unread message);
       the RED badge comes from the MENTION count (mentions only). `flat` = a
       project-less channel rendered at the top level (less indent). -->
  {@const isMuted = notifPrefsState.get(channel.id) === "muted"}
  {@const isUnread = wsId ? unreadFlagState.isUnread(wsId, channel.id) : false}
  {@const mentionCount = wsId ? notificationState.getCount(wsId, channel.id) : 0}
  {@const bold = isUnread && !isMuted}
  <div
    role="button"
    tabindex="0"
    aria-label={`${channel.isPrivate ? "Private channel" : "Channel"} ${channel.name}${isUnread ? ", unread" : ""}${mentionCount > 0 ? `, ${mentionCount} mention${mentionCount === 1 ? "" : "s"}` : ""}`}
    aria-current={isChannelActive(channel.id) ? "page" : undefined}
    onclick={() => handleChannelClick(channel.id)}
    oncontextmenu={(e) => openChannelMenu(channel.id, e)}
    onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleChannelClick(channel.id); } }}
    class={cn(
      "group/channel w-full flex items-center gap-1.5 pr-2.5 h-[32px] rounded-md cursor-pointer text-[15px] transition-colors touch-target-row focus-ring",
      flat ? "pl-4" : "pl-7",
      isChannelActive(channel.id)
        ? "bg-[var(--sidebar-active)] text-[var(--sidebar-active-text)] font-semibold"
        : bold
          ? "hover:bg-hover-gray text-content font-semibold"
          : "hover:bg-hover-gray text-sidebar-gray font-normal",
    )}
  >
    {#if channel.isPrivate}
      {@render lockIcon(isChannelActive(channel.id), bold)}
    {:else}
      {@render hashIcon(isChannelActive(channel.id), bold)}
    {/if}
    <span class={cn("truncate flex-1 text-left", isMuted && "opacity-50")}>{channel.name}</span>
    {@render draftPencil(channel.id)}
    {#if isMuted}
      {@render muteIcon()}
    {/if}
    {@render starButton(channel.id)}
    {#if mentionCount > 0 && !isMuted && !isChannelActive(channel.id)}
      {@render unreadBadge(mentionCount)}
    {:else if projects.length > 0}
      <button
        type="button"
        onclick={(e) => { e.stopPropagation(); openChannelMenu(channel.id, e); }}
        class={cn(
          "shrink-0 rounded p-0.5 transition-opacity cursor-pointer focus-ring",
          channelMenuOpen === channel.id ? "opacity-100 text-content" : "opacity-0 group-hover/channel:opacity-100 text-content-muted hover:text-content",
        )}
        aria-label={`Channel options for ${channel.name}`}
        aria-haspopup="menu"
        aria-expanded={channelMenuOpen === channel.id}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <circle cx="3" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="13" cy="8" r="1.5"/>
        </svg>
      </button>
    {/if}
  </div>
{/snippet}

<!-- #608: a group-DM row. A group DM IS a channel, so it shares the channel
     unread model (unreadFlagState + notificationState) and routes through
     handleChannelClick — but it lives in the DM section with a multi-person
     glyph and the auto-generated "name1, name2, …" title. -->
{#snippet groupDmRow(channel: typeof channels[0])}
  {@const isMuted = notifPrefsState.get(channel.id) === "muted"}
  {@const isUnread = wsId ? unreadFlagState.isUnread(wsId, channel.id) : false}
  {@const mentionCount = wsId ? notificationState.getCount(wsId, channel.id) : 0}
  {@const bold = isUnread && !isMuted}
  {@const active = isChannelActive(channel.id)}
  <button
    type="button"
    onclick={() => handleChannelClick(channel.id)}
    aria-label={`Group DM ${channel.name}${isUnread ? ", unread" : ""}`}
    aria-current={active ? "page" : undefined}
    class={cn(
      "group/channel w-full flex items-center gap-1.5 pl-4 pr-2.5 h-[32px] rounded-md cursor-pointer text-[15px] leading-[32px] transition-colors touch-target-row focus-ring",
      active
        ? "bg-[var(--sidebar-active)] text-[var(--sidebar-active-text)] font-semibold"
        : bold
          ? "hover:bg-hover-gray text-content font-semibold"
          : "hover:bg-hover-gray text-sidebar-gray",
    )}
  >
    <span class="relative shrink-0 w-5 h-5 flex items-center justify-center text-content-muted">
      <!-- Multi-person glyph distinguishes a group DM from a 1:1 in the list. -->
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    </span>
    <span class={cn("truncate flex-1 text-left", isMuted && "opacity-50")}>{channel.name}</span>
    {@render draftPencil(channel.id)}
    {#if isMuted}
      {@render muteIcon()}
    {/if}
    {@render starButton(channel.id)}
    {#if mentionCount > 0 && !isMuted && !active}
      {@render unreadBadge(mentionCount)}
    {/if}
  </button>
{/snippet}

<!-- Star toggle: filled when favorited, otherwise an outline that fades in on row
     hover (group/channel). Clicking toggles the favorite without opening the
     row. -->
{#snippet starButton(targetId: string)}
  {@const fav = isFavorite(targetId)}
  <button
    type="button"
    onclick={(e) => toggleFavorite(targetId, e)}
    class={cn(
      "shrink-0 rounded p-0.5 transition-opacity cursor-pointer",
      fav
        ? "opacity-100 text-warning"
        : "opacity-0 group-hover/channel:opacity-100 text-content-muted hover:text-content",
    )}
    aria-label={fav ? "Remove from favorites" : "Add to favorites"}
    aria-pressed={fav}
  >
    <svg width="13" height="13" viewBox="0 0 24 24" fill={fav ? "currentColor" : "none"} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  </button>
{/snippet}

<!-- Favorite-row icon (channel hash/lock, DM avatar, or agent glyph). -->
{#snippet favoriteIcon(row: FavoriteRow)}
  {#if row.kind === "channel"}
    {#if row.isPrivate}
      {@render lockIcon(false, false)}
    {:else}
      {@render hashIcon(false, false)}
    {/if}
  {:else if row.kind === "dm"}
    {#if row.image}
      <img src={row.image} alt="" class="w-[18px] h-[18px] rounded object-cover shrink-0" />
    {:else}
      <span
        class="w-[18px] h-[18px] rounded flex items-center justify-center text-[9px] font-bold text-accent-foreground shrink-0"
        style:background-color={nameToColor(row.name)}
      >{row.name[0]?.toUpperCase() ?? "?"}</span>
    {/if}
  {:else}
    <span class="shrink-0 text-content-muted">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 8V4H8" /><rect width="16" height="12" x="4" y="8" rx="2" /><path d="M2 14h2" /><path d="M20 14h2" /><path d="M15 13v2" /><path d="M9 13v2" />
      </svg>
    </span>
  {/if}
{/snippet}

<!-- Item 4: shimmer placeholder rows while the sidebar lists hydrate. `withAvatar`
     matches the DM row layout (avatar dot + label); without it matches a channel
     row (hash glyph + label). Count tunes how many rows fill the section. -->
{#snippet sidebarSkeleton(count: number, withAvatar: boolean)}
  <div class="space-y-1 py-0.5" aria-hidden="true">
    {#each Array(count) as _, i (i)}
      <div
        class={cn("flex items-center gap-2 h-[32px]", withAvatar ? "pl-4 pr-2.5" : "pl-7 pr-2.5")}
        style="--stagger-delay: {i * 80}ms"
      >
        {#if withAvatar}
          <div class="skeleton h-5 w-5 shrink-0 rounded"></div>
        {:else}
          <div class="skeleton h-3.5 w-3.5 shrink-0 rounded-sm"></div>
        {/if}
        <div class="skeleton h-3 rounded" style="width: {45 + ((i * 17) % 40)}%"></div>
      </div>
    {/each}
  </div>
{/snippet}

<!-- Shared context menus, extracted as snippets so the desktop markup and the
     mobile (iOS-list) presentation render the IDENTICAL menu DOM. -->
{#snippet projectContextMenu(project: Project)}
  <div
    class="project-context-menu absolute left-6 top-[30px] z-[var(--z-elevated)] w-[180px] rounded-lg py-1 shadow-2xl"
    style="background-color: var(--dropdown-bg); border: 1px solid var(--dropdown-border);"
  >
    <button
      type="button"
      onclick={(e) => openEditProject(project, e)}
      class="w-full text-left px-3 py-1.5 text-[12px] text-content-dim hover:bg-[var(--dropdown-hover)] hover:text-content transition-colors cursor-pointer"
    >Edit project</button>
    <button
      type="button"
      onclick={() => { showAddChannel = true; newChannelProject = project.id; projectMenuOpen = null; }}
      class="w-full text-left px-3 py-1.5 text-[12px] text-content-dim hover:bg-[var(--dropdown-hover)] hover:text-content transition-colors cursor-pointer"
    >Add channel here</button>
    <div style="border-top: 1px solid var(--dropdown-border);" class="mt-1 pt-1">
      <button
        type="button"
        onclick={() => handleDeleteProject(project.id)}
        class="w-full text-left px-3 py-1.5 text-[12px] text-error hover:bg-[var(--dropdown-hover)] transition-colors cursor-pointer"
      >Delete project</button>
    </div>
  </div>
{/snippet}

{#snippet agentPermsPopover(agentId: string)}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="agent-perms-panel absolute left-4 right-2 top-[30px] z-[var(--z-elevated)] max-h-[60vh] overflow-y-auto rounded-lg p-2 shadow-2xl"
    style="background-color: var(--dropdown-bg); border: 1px solid var(--dropdown-border);"
    onclick={(e) => e.stopPropagation()}
  >
    <PendingPermissionsPanel {agentId} />
  </div>
{/snippet}

{#snippet agentContextMenu(agent: typeof agents[0], name: string, alias: string | undefined)}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="agent-context-menu absolute left-4 top-[30px] z-[var(--z-elevated)] w-[var(--panel-slim)] rounded-lg py-1 shadow-2xl"
    style="background-color: var(--dropdown-bg); border: 1px solid var(--dropdown-border);"
    onclick={(e) => e.stopPropagation()}
  >
    <div class="px-3 py-2 flex items-center gap-2" style="border-bottom: 1px solid var(--dropdown-border);">
      <div class="w-7 h-7 rounded flex items-center justify-center shrink-0 text-content-muted bg-surface-alt">
        <CyboSessionAvatar {agent} size={16} />
      </div>
      <div class="min-w-0">
        <div class="text-[15px] font-semibold text-content truncate">{name}</div>
        <div class="text-[11px] text-content-muted">{agent.lifecycle}</div>
      </div>
    </div>
    <div class="px-3 py-1.5 flex items-center gap-2 text-[12px] text-content-dim">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      </svg>
      <span class="truncate" title={agent.cwd ?? "unknown"}>{folderName(agent.cwd)}</span>
    </div>
    <div class="px-3 py-1.5 flex items-center gap-2 text-[12px] text-content-dim">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
      </svg>
      <span>{agent.provider}</span>
    </div>
    {#if agent.model}
      <div class="px-3 py-1.5 flex items-center gap-2 text-[12px] text-content-dim">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
        </svg>
        <span class="truncate">{agent.model}</span>
      </div>
    {/if}
    <div class="px-3 py-1.5 flex items-center gap-2 text-[12px] text-content-dim">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
      </svg>
      <span class="font-mono text-[11px]">{agent.agentId.slice(0, 16)}</span>
    </div>
    <div style="border-top: 1px solid var(--dropdown-border);" class="mt-1 pt-1">
      {#if aliasEditing === agent.agentId}
        <!-- Client-only local alias editor (in-memory, non-persistent). -->
        <div class="px-3 py-1.5">
          <!-- svelte-ignore a11y_autofocus -->
          <input
            autofocus
            bind:value={aliasDraft}
            placeholder="Local alias (this device only)"
            maxlength="60"
            onclick={(e) => e.stopPropagation()}
            onkeydown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); saveAlias(agent.agentId); }
              else if (e.key === "Escape") { e.preventDefault(); aliasEditing = null; }
            }}
            class="w-full rounded border border-edge bg-surface px-2 py-1 text-[12px] text-content outline-none focus:border-edge-light"
          />
          <div class="mt-1.5 flex items-center gap-2 text-[11px]">
            <button
              type="button"
              onclick={() => saveAlias(agent.agentId)}
              class="rounded bg-btn-primary-bg px-2 py-0.5 font-medium text-btn-primary-text hover:bg-btn-primary-hover"
            >Save</button>
            {#if alias}
              <button
                type="button"
                onclick={() => clearAlias(agent.agentId)}
                class="text-content-muted hover:text-error"
              >Clear</button>
            {/if}
          </div>
        </div>
      {:else}
        <button
          type="button"
          onclick={() => startAliasEdit(agent.agentId)}
          class="w-full text-left px-3 py-1.5 text-[12px] text-content-dim hover:bg-[var(--dropdown-hover)] hover:text-content transition-colors cursor-pointer"
        >{alias ? "Rename alias" : "Set alias"}</button>
      {/if}
      <button
        type="button"
        onclick={() => { handleAgentClick(agent.agentId); agentMenuOpen = null; }}
        class="w-full text-left px-3 py-1.5 text-[12px] text-content-dim hover:bg-[var(--dropdown-hover)] hover:text-content transition-colors cursor-pointer"
      >Open agent view</button>
      <!-- Restart a wedged/desynced session in place (#592): rehydrate from disk
           recreates the live session keeping the same agentId/identity and
           re-streams history — recovery without archive/delete. -->
      <button
        type="button"
        disabled={restartingAgentId !== null}
        onclick={async () => {
          const id = agent.agentId;
          if (restartingAgentId) return;
          restartingAgentId = id;
          agentMenuOpen = null;
          try {
            await reloadSession(id, { rehydrateFromDisk: true });
          } finally {
            restartingAgentId = null;
          }
        }}
        class="w-full text-left px-3 py-1.5 text-[12px] text-content-dim hover:bg-[var(--dropdown-hover)] hover:text-content transition-colors cursor-pointer disabled:opacity-50"
      >{restartingAgentId === agent.agentId ? "Restarting…" : "Restart session"}</button>
      <button
        type="button"
        onclick={async () => {
          const id = agent.agentId;
          agentMenuOpen = null;
          await archiveAgent(id);
          // Archiving the agent you're viewing: go to the agents
          // list, not the workspace home (the old target dumped you
          // to Home — jarring, and inconsistent across providers).
          if (page.params.agentId === id && wsId) goto(`/workspace/${wsId}/agents`);
        }}
        class="w-full text-left px-3 py-1.5 text-[12px] text-warning hover:bg-[var(--dropdown-hover)] transition-colors cursor-pointer"
      >Archive agent</button>
    </div>
  </div>
{/snippet}

<!-- ─── Mobile-only building blocks (S3 iOS-list presentation) ─────────── -->

<!-- 13px uppercase iOS section header. Tapping toggles the section's existing
     collapse state; per-section action buttons render beside it (passed via
     markup at the call site, not here, to keep this a dumb label). -->
{#snippet mobileSectionLabel(label: string, open: boolean, toggle: () => void)}
  <button
    type="button"
    onclick={toggle}
    aria-expanded={open}
    class="flex min-h-[40px] items-center gap-1.5 px-4 text-[13px] font-semibold uppercase tracking-[0.06em] text-content-muted"
  >
    <span>{label}</span>
    {@render chevronSvg(open)}
  </button>
{/snippet}

<!-- Shimmer placeholders matching the ConversationRow layout (42px tile + two
     text lines). Rendered ONLY while the same loading deriveds that gate the
     desktop skeletons are true — cached opens never flash these. -->
{#snippet mobileSkeleton(count: number)}
  <div aria-hidden="true">
    {#each Array(count) as _, i (i)}
      <div class="flex min-h-[54px] items-center gap-3 px-4 py-1.5">
        <div class="skeleton h-[42px] w-[42px] shrink-0 rounded-[12px]"></div>
        <div class="flex min-w-0 flex-1 flex-col gap-1.5">
          <div class="skeleton h-3.5 rounded" style="width: {50 + ((i * 17) % 35)}%"></div>
          <div class="skeleton h-3 rounded" style="width: {28 + ((i * 23) % 30)}%"></div>
        </div>
      </div>
    {/each}
  </div>
{/snippet}

<!-- Mobile channel row: same unread semantics as the desktop channelRow
     snippet (BOLD = unread flag, pill = mention count), rendered through the
     shared ConversationRow. Kebab stays tap-reachable (desktop hides it behind
     hover, which doesn't exist on touch). -->
{#snippet mobileChannelRow(channel: typeof channels[0])}
  {@const isMuted = notifPrefsState.get(channel.id) === "muted"}
  {@const isUnread = wsId ? unreadFlagState.isUnread(wsId, channel.id) : false}
  {@const mentionCount = wsId ? notificationState.getCount(wsId, channel.id) : 0}
  <ConversationRow
    kind="channel"
    name={channel.name}
    isPrivate={channel.isPrivate}
    unread={isUnread && !isMuted}
    unreadCount={!isMuted && !isChannelActive(channel.id) ? mentionCount : 0}
    active={isChannelActive(channel.id)}
    muted={isMuted}
    ariaLabel={`${channel.isPrivate ? "Private channel" : "Channel"} ${channel.name}${isUnread ? ", unread" : ""}${mentionCount > 0 ? `, ${mentionCount} mention${mentionCount === 1 ? "" : "s"}` : ""}`}
    onclick={() => handleChannelClick(channel.id)}
    oncontextmenu={(e) => openChannelMenu(channel.id, e)}
  >
    {#snippet nameAccessory()}
      {@render draftPencil(channel.id)}
      {#if isMuted}
        {@render muteIcon()}
      {/if}
    {/snippet}
    {#snippet trailing()}
      {#if projects.length > 0}
        <button
          type="button"
          onclick={(e) => { e.stopPropagation(); openChannelMenu(channel.id, e); }}
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-content-dim"
          aria-label={`Channel options for ${channel.name}`}
          aria-haspopup="menu"
          aria-expanded={channelMenuOpen === channel.id}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <circle cx="3" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="13" cy="8" r="1.5"/>
          </svg>
        </button>
      {/if}
    {/snippet}
  </ConversationRow>
{/snippet}

<!-- #706 redirect affordance — shown under the (filtered) Agent sessions list
     when OTHER users' personal sessions were moved out, so the move reads as a
     redirection rather than a silent disappearance. Links to the owning daemon's
     Sessions sub-section (or the Daemons overview when they span several). The
     caller passes the per-surface class so desktop + mobile keep their look. -->
{#snippet othersSessionsHint(className: string)}
  {#if othersSessionCount > 0}
    <button type="button" onclick={handleViewOthersSessions} class={className}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0" aria-hidden="true">
        <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>
      </svg>
      <span class="truncate flex-1 text-left">
        {othersSessionCount} {othersSessionCount === 1 ? "session" : "sessions"} from others — view in the daemon
      </span>
    </button>
  {/if}
{/snippet}

<svelte:document onclick={handleClickOutsideMenu} />

{#if viewportState.isMobile}
  <!-- ── Mobile presentation (S3): iOS-style conversation list. Same data,
       same handlers, same dialogs/menus as desktop — only the row/section
       rendering differs. Used full-width on the Chats tab AND inside the
       slide-in drawer. Desktop renders the untouched branch below. ── -->
  <aside class="flex h-full w-full min-h-0 flex-col overflow-hidden bg-surface" aria-label="Conversations">
    <div class="min-h-0 flex-1 overflow-y-auto pb-4">

      <!-- Favorites (hidden until something is starred — parity w/ desktop) -->
      {#if favoriteRows.length > 0}
        <div class="mt-1 flex items-center justify-between pr-2">
          {@render mobileSectionLabel("Favorites", favoritesOpen, () => (favoritesOpen = !favoritesOpen))}
        </div>
        {#if favoritesOpen}
          {#each favoriteRows as row (row.id)}
            {@const favActive = row.kind === "channel" ? isChannelActive(row.id) : row.kind === "dm" ? isDmActive(row.id) : isAgentActive(row.id)}
            {@const favUnread = row.kind === "channel" ? channelHasUnread(row.id) : row.kind === "dm" ? dmHasUnread(row.id) : agentHasUnread(row.id)}
            {@const favCount = wsId ? notificationState.getCount(wsId, row.id) : 0}
            {#if !unreadOnly || favUnread || favActive}
              <ConversationRow
                kind={row.kind}
                name={row.name}
                isPrivate={row.isPrivate ?? false}
                image={row.kind === "dm" ? (row.image ?? null) : null}
                presence={row.kind === "dm" ? (presenceState.isOnline(row.id) && !presenceState.isAway(row.id) ? "online" : "away") : null}
                time={row.kind === "channel" ? null : conversationTime(wsId ? dmActivityState.getActivity(wsId, row.id) : 0)}
                unread={favUnread}
                unreadCount={favActive ? 0 : favCount}
                active={favActive}
                onclick={() => openFavoriteRow(row)}
              >
                {#snippet trailing()}
                  <button
                    type="button"
                    onclick={(e) => toggleFavorite(row.id, e)}
                    class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-warning"
                    aria-label="Remove from favorites"
                    aria-pressed="true"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                    </svg>
                  </button>
                {/snippet}
              </ConversationRow>
            {/if}
          {/each}
        {/if}
      {/if}

      <!-- Threads removed on mobile (kept on desktop). -->
      <!-- Saved-messages row intentionally NOT shown on mobile — it cluttered the
           top of the Projects list; the /saved route still exists for desktop. -->

      <!-- Channels grouped by project. The section IS the project list, so it's
           labelled "Projects"; the single header action adds a project (channels
           are added inside a project via its ⋯ → Add channel / the row below). -->
      {#if cfg.channels}
        <div class="mt-3 flex items-center justify-between pr-2">
          {@render mobileSectionLabel("Projects", channelsOpen, () => (channelsOpen = !channelsOpen))}
          <button
            type="button"
            onclick={() => { showAddProject = true; }}
            class="flex h-10 items-center gap-1 rounded-full px-3 text-content-muted active:bg-raised"
            aria-label="Add project"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            <span class="text-[13px] font-medium">Project</span>
          </button>
        </div>
        {#if channelsOpen}
          {#if channelsLoading}
            {@render mobileSkeleton(5)}
          {/if}

          <!-- Project-grouped channels -->
          {#each projects as project (project.id)}
            {@const projectChannels = channelsByProject.get(project.id) ?? []}
            {@const expanded = isProjectExpanded(project.id)}
            {@const rollup = projectUnreadRollup(projectChannels)}
            {@const showRollup = !expanded && rollup.hasUnread}
            <div class="relative">
              <div
                role="button"
                tabindex="0"
                aria-label={`Project ${project.name}${showRollup ? ", unread" : ""}`}
                aria-expanded={expanded}
                class="pressable-row flex min-h-[44px] w-full cursor-pointer items-center gap-2.5 px-4"
                onclick={() => toggleProjectExpanded(project.id)}
                onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleProjectExpanded(project.id); } }}
              >
                {@render chevronSvg(expanded)}
                <span
                  class="inline-flex shrink-0 select-none items-center justify-center text-[9px] font-bold"
                  style="width: 18px; height: 18px; border-radius: 5px; background-color: {project.color}; color: #0d0e10;"
                >{project.name[0]?.toUpperCase() ?? "?"}</span>
                <span class={cn("flex-1 truncate text-[15px]", showRollup ? "font-bold text-content" : "font-semibold text-content-dim")}>{project.name}</span>
                {#if !expanded && rollup.mentionCount > 0}
                  <span class="flex h-[19px] min-w-[19px] shrink-0 items-center justify-center rounded-full bg-accent px-[6px] text-[12px] font-bold leading-none text-accent-foreground">
                    {rollup.mentionCount > 99 ? "99+" : rollup.mentionCount}
                  </span>
                {:else if showRollup}
                  <span class="h-2 w-2 shrink-0 rounded-full bg-accent" aria-hidden="true"></span>
                {:else if projectChannels.length > 0}
                  <span class="text-[13px] text-content-dim tabular-nums">{projectChannels.length}</span>
                {/if}
                <button
                  type="button"
                  onclick={(e) => toggleProjectMenu(project.id, e)}
                  class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-content-dim"
                  aria-label={`Project options for ${project.name}`}
                  aria-haspopup="menu"
                  aria-expanded={projectMenuOpen === project.id}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <circle cx="3" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="13" cy="8" r="1.5"/>
                  </svg>
                </button>
              </div>

              {#if expanded}
                {#if projectChannels.length === 0}
                  <div class="flex min-h-[36px] items-center pl-[70px] pr-4 text-[13px] italic text-content-dim">
                    No channels yet
                  </div>
                {:else}
                  <!-- #524: animate:flip must be the immediate child of the keyed
                       each — filter inline (an {#if} wrapper breaks the directive). -->
                  {#each projectChannels.filter((c) => channelPassesFilter(c.id)) as channel (channel.id)}
                    <div animate:flip={flipParams}>
                      {@render mobileChannelRow(channel)}
                    </div>
                  {/each}
                {/if}
              {:else}
                <!-- Collapsed: peek out channels with an unread signal (desktop parity). -->
                {#each projectPeekChannels(projectChannels) as channel (channel.id)}
                  <div animate:flip={flipParams}>
                    {@render mobileChannelRow(channel)}
                  </div>
                {/each}
              {/if}

              {#if projectMenuOpen === project.id}
                {@render projectContextMenu(project)}
              {/if}
            </div>
          {/each}

          {@const orphanChannels = channelsByProject.get(null) ?? []}
          {@const visibleOrphans = orphanChannels.filter((c) => channelPassesFilter(c.id))}
          {#if workspaceState.channels.length === 0 && !channelsLoading}
            <!-- Fresh workspace: designed empty state -->
            <div class="flex flex-col items-center gap-1.5 px-8 py-8 text-center">
              <span
                class="mb-1 flex h-12 w-12 items-center justify-center rounded-[14px]"
                style="background: color-mix(in srgb, var(--accent) 11%, transparent); color: var(--accent);"
                aria-hidden="true"
              >
                <ChannelGlyph kind="hash" class="w-[22px] h-[22px]" strokeWidth={1.4} />
              </span>
              <p class="text-[15px] font-semibold text-content">No channels yet</p>
              <p class="text-[13px] leading-relaxed text-content-muted">Create a channel below, or browse existing ones to join the conversation.</p>
            </div>
          {/if}
          {#each visibleOrphans as channel (channel.id)}
            <div animate:flip={flipParams}>
              {@render mobileChannelRow(channel)}
            </div>
          {/each}

          <!-- Add channels: action row (Create / Browse) — same menu as desktop -->
          <DropdownMenu>
            <DropdownMenuTrigger class="pressable-row flex w-full min-h-[52px] cursor-pointer items-center gap-3 px-4 text-left">
              <span class="flex h-[42px] w-[42px] shrink-0 items-center justify-center text-content-muted" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </span>
              <span class="flex-1 truncate text-[16px] font-medium text-content-muted">Add channel</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" class="w-[200px]">
              <DropdownMenuItem
                class="gap-2 px-3 py-1.5 text-[15px] cursor-pointer"
                onclick={() => { showAddChannel = true; }}
              >
                Create a new channel
              </DropdownMenuItem>
              <DropdownMenuItem
                class="gap-2 px-3 py-1.5 text-[15px] cursor-pointer"
                onclick={() => { showBrowseChannels = true; }}
              >
                Browse channels
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        {/if}
      {/if}

      <!-- Agent sessions, Direct Messages, and Terminals moved to the Team tab;
           Archived sessions live on the Agents tab (desktop) / Team → Sessions
           (mobile). Machines (daemons) stay here in the Home tab too (in addition
           to the dedicated Daemons bottom-nav tab). -->
      {#if machines.length > 0}
        <div class="mt-3 flex items-center justify-between pr-2">
          {@render mobileSectionLabel("Machines", machinesOpen, () => (machinesOpen = !machinesOpen))}
        </div>
        {#if machinesOpen}
          {#each machines as m (m.id)}
            <button
              type="button"
              onclick={() => handleMachineClick()}
              class="pressable-row flex min-h-[52px] w-full cursor-pointer items-center gap-3 px-4 text-left"
              aria-label={`Machine ${m.host}`}
            >
              <span class="flex h-[42px] w-[42px] shrink-0 items-center justify-center text-content-muted" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
                </svg>
              </span>
              <span class="flex-1 truncate text-[16px] font-medium text-content">{m.host}</span>
              <span
                class="h-2 w-2 shrink-0 rounded-full"
                style="background: {m.online ? 'var(--color-success)' : 'var(--color-content-muted)'};"
              ></span>
            </button>
          {/each}
        {/if}
      {/if}

    </div>

    <!-- Invite Agents / Invite Humans moved to the profile menu on mobile. -->
  </aside>
{:else}
<aside
  class="relative flex h-full flex-col shrink-0 min-h-0 bg-sidebar-bg border-r border-solid border-r-edge-dim overflow-hidden"
  style="width: {sidebarWidth}px; min-width: {minWidth}px;"
>
  <!-- Workspace header + dropdown (Invite Humans / Add agents / Settings).
       Desktop only: on mobile the MobileTopBar already shows the workspace
       switcher, and Settings lives in the profile menu + agents on the Agents
       tab, so this 2nd "<workspace> ▾" is redundant (#18). -->
  {#if !viewportState.isMobile}
  <div class="shrink-0 px-4 pt-3 pb-2 flex items-center gap-1">
    <DropdownMenu bind:open={workspaceMenuOpen}>
      <DropdownMenuTrigger class="flex min-w-0 flex-1 items-center gap-2 hover:bg-hover-gray rounded-md py-[3px] px-2 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">
        <span class="text-content text-[18px] font-black truncate">
          {workspaceState.current?.name ?? shellConfig.appName}
        </span>
        <svg class={cn("shrink-0 transition-transform duration-150", workspaceMenuOpen && "rotate-180")} width="14" height="14" viewBox="0 0 16 16" fill="var(--primary)">
          <path d="M4.5 6L8 9.5L11.5 6" stroke="var(--primary)" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-[260px] bg-surface-alt border-edge">
        <DropdownMenuLabel class="px-3 py-2">
          <div class="text-[15px] font-bold text-content truncate">{workspaceState.current?.name ?? shellConfig.appName}</div>
          {#if workspaceState.current?.id}
            <div class="text-[11px] text-content-muted mt-0.5 font-mono truncate font-normal">{workspaceState.current.id}</div>
          {/if}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {#if canInvite}
          <DropdownMenuItem onclick={() => { showInviteHuman = true; }} class="gap-3 px-3 py-1.5 text-[15px] cursor-pointer">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" class="text-content-muted shrink-0">
              <circle cx="6" cy="5" r="2.5"/><path d="M1.5 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4"/><path d="M11.5 7.5l3 0m-1.5-1.5v3"/>
            </svg>
            Invite Humans
          </DropdownMenuItem>
        {/if}
        <DropdownMenuItem onclick={() => { handleNewAgent(); }} class="gap-3 px-3 py-1.5 text-[15px] cursor-pointer">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" class="text-content-muted shrink-0">
            <rect x="3" y="2" width="10" height="12" rx="2"/><circle cx="6.5" cy="6.5" r="1"/><circle cx="9.5" cy="6.5" r="1"/><path d="M6 10h4"/>
          </svg>
          Add agents
        </DropdownMenuItem>
        <DropdownMenuItem onclick={() => { if (wsId) goto(`/workspace/${wsId}/settings/workspace`); }} class="gap-3 px-3 py-1.5 text-[15px] cursor-pointer">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" class="text-content-muted shrink-0">
            <circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v2m0 9v2m-4.6-10.9 1.4 1.4m6.4 6.4 1.4 1.4M1.5 8h2m9 0h2m-10.9 4.6 1.4-1.4m6.4-6.4 1.4-1.4"/>
          </svg>
          Settings
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <!-- Collapse the sidebar (hidden/revealed by the workspace layout). Mirrors
         the Mod+\ shortcut listed in the keyboard help modal. -->
    <button
      type="button"
      onclick={() => viewportState.toggleSidebar()}
      aria-label="Collapse sidebar"
      title="Collapse sidebar"
      class="shrink-0 flex items-center justify-center p-1 text-content-muted hover:text-content hover:bg-surface-hover rounded cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
    >
      <PanelLeftCloseIcon class="h-4 w-4" />
    </button>
  </div>
  {/if}

  <!-- Scrollable content -->
  <ScrollArea class="flex-1 min-h-0">
    <div class="pb-3">

    <!-- Favorites (starred channels / DMs / agents pinned to the top). Hidden
         entirely until the user stars something — additive, never empty noise. -->
    {#if favoriteRows.length > 0}
      <SidebarSection label="Favorites" bind:open={favoritesOpen} class="mt-1">
          {#each favoriteRows as row (row.id)}
            {@const active = row.kind === "channel" ? isChannelActive(row.id) : row.kind === "dm" ? isDmActive(row.id) : isAgentActive(row.id)}
            {@const favUnread = row.kind === "channel" ? channelHasUnread(row.id) : row.kind === "dm" ? dmHasUnread(row.id) : agentHasUnread(row.id)}
            {@const favCount = wsId ? notificationState.getCount(wsId, row.id) : 0}
            {#if !unreadOnly || favUnread || active}
            <div
              role="button"
              tabindex="0"
              onclick={() => openFavoriteRow(row)}
              onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openFavoriteRow(row); } }}
              class={cn(
                "group/channel w-full flex items-center gap-1.5 pl-4 pr-2.5 h-[32px] rounded-md cursor-pointer text-[15px] transition-colors",
                active
                  ? "bg-[var(--sidebar-active)] text-[var(--sidebar-active-text)] font-semibold"
                  : favUnread
                    ? "hover:bg-hover-gray text-content font-semibold"
                    : "hover:bg-hover-gray text-sidebar-gray font-normal",
              )}
            >
              {@render favoriteIcon(row)}
              <span class="truncate flex-1 text-left">{row.name}</span>
              {@render starButton(row.id)}
              {#if favCount > 0 && !active}
                {@render unreadBadge(favCount)}
              {/if}
            </div>
            {/if}
          {/each}
      </SidebarSection>
    {/if}

    <!-- Threads (global followed-threads view) -->
    <button
      type="button"
      onclick={() => wsId && goto(`/workspace/${wsId}/threads`)}
      aria-label="Threads"
      aria-current={pathname.endsWith("/threads") ? "page" : undefined}
      class={cn(
        "mx-2 mt-1 mb-1 flex h-[34px] w-[calc(100%-1rem)] items-center gap-2 rounded-md px-2 text-[15px] transition-colors touch-target-row focus-ring",
        pathname.endsWith("/threads")
          ? "bg-[var(--sidebar-active)] text-[var(--sidebar-active-text)] font-semibold"
          : "hover:bg-hover-gray text-sidebar-gray",
      )}
    >
      <svg class="shrink-0" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <span class="flex-1 text-left font-medium">Threads</span>
      {#if threadsState.counts.totalUnreadMentions > 0}
        <span class="flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-accent-foreground shrink-0">
          {threadsState.counts.totalUnreadMentions > 99 ? "99+" : threadsState.counts.totalUnreadMentions}
        </span>
      {:else if threadsState.counts.totalUnreadThreads > 0}
        <span class="h-2 w-2 rounded-full bg-red-500 shrink-0"></span>
      {/if}
    </button>

    <!-- Saved (personal saved-messages view, #609) -->
    <button
      type="button"
      onclick={() => wsId && goto(`/workspace/${wsId}/saved`)}
      aria-label="Saved"
      aria-current={pathname.endsWith("/saved") ? "page" : undefined}
      class={cn(
        "mx-2 mb-1 flex h-[34px] w-[calc(100%-1rem)] items-center gap-2 rounded-md px-2 text-[15px] transition-colors touch-target-row focus-ring",
        pathname.endsWith("/saved")
          ? "bg-[var(--sidebar-active)] text-[var(--sidebar-active-text)] font-semibold"
          : "hover:bg-hover-gray text-sidebar-gray",
      )}
    >
      <svg class="shrink-0" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
      </svg>
      <span class="flex-1 text-left font-medium">Saved</span>
    </button>

    <!-- Channels grouped by project -->
    {#if cfg.channels}
      <SidebarSection label="Channels" bind:open={channelsOpen}>
        {#snippet actions()}
          <div class="flex items-center gap-0.5">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger>
                  <button
                    type="button"
                    onclick={() => { unreadOnly = !unreadOnly; }}
                    class={cn(
                      "rounded p-1 transition-colors cursor-pointer hover:bg-[var(--sidebar-hover)]",
                      unreadOnly ? "text-accent" : "text-content-muted hover:text-content",
                    )}
                    aria-label="Show only unread"
                    aria-pressed={unreadOnly}
                  >
                    <!-- Filter funnel: filled tint when the unread-only filter is on. -->
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                    </svg>
                  </button>
                </TooltipTrigger>
                <TooltipContent>{unreadOnly ? "Showing unread only" : "Show only unread"}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger>
                  <button
                    type="button"
                    onclick={() => { showAddProject = true; }}
                    class="rounded p-1 text-content-muted hover:text-content hover:bg-[var(--sidebar-hover)] transition-colors cursor-pointer focus-ring"
                    aria-label="New project"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                    </svg>
                  </button>
                </TooltipTrigger>
                <TooltipContent>New project</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <!-- Single "add channels" control (Create / Browse). Replaces the
                 former duplicate action row at the end of the list. -->
            <DropdownMenu>
              <DropdownMenuTrigger
                class="rounded p-1 text-content-muted hover:text-content hover:bg-[var(--sidebar-hover)] transition-colors cursor-pointer focus-ring"
                aria-label="Add channels"
                title="Add channels"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" class="w-[200px]">
                <DropdownMenuItem
                  class="gap-2 px-3 py-1.5 text-[15px] cursor-pointer"
                  onclick={() => { showAddChannel = true; }}
                >
                  Create a new channel
                </DropdownMenuItem>
                <DropdownMenuItem
                  class="gap-2 px-3 py-1.5 text-[15px] cursor-pointer"
                  onclick={() => { showBrowseChannels = true; }}
                >
                  Browse channels
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        {/snippet}
          {#if channelsLoading}
            {@render sidebarSkeleton(5, false)}
          {/if}
          <!-- Project-grouped channels -->
          {#each projects as project (project.id)}
            {@const projectChannels = channelsByProject.get(project.id) ?? []}
            {@const expanded = isProjectExpanded(project.id)}
            {@const rollup = projectUnreadRollup(projectChannels)}
            {@const showRollup = !expanded && rollup.hasUnread}
            <div class="relative mt-px">
              <div
                role="button"
                tabindex="0"
                aria-label={`Project ${project.name}${showRollup ? ", unread" : ""}`}
                aria-expanded={expanded}
                class="group/project flex items-center gap-2 px-2 h-[32px] cursor-pointer hover:bg-hover-gray rounded-md touch-target-row focus-ring"
                onclick={() => toggleProjectExpanded(project.id)}
                onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleProjectExpanded(project.id); } }}
              >
                <svg class={cn("shrink-0 transition-transform duration-150", !expanded && "-rotate-90")} width="10" height="10" viewBox="0 0 16 16">
                  <path d="M4.5 6L8 9.5L11.5 6" stroke="var(--secondary)" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <span
                  class="shrink-0 inline-flex items-center justify-center font-bold select-none text-[8px]"
                  style="width: 16px; height: 16px; border-radius: 4px; background-color: {project.color}; color: #0d0e10;"
                >{project.name[0]?.toUpperCase() ?? "?"}</span>
                <span class={cn("text-[15px] truncate flex-1", showRollup ? "font-semibold text-content" : "font-medium text-content")}>{project.name}</span>
                {#if !expanded && rollup.mentionCount > 0}
                  {@render unreadBadge(rollup.mentionCount)}
                {:else if showRollup}
                  <span class="shrink-0 w-2 h-2 rounded-full bg-error" aria-hidden="true"></span>
                {:else if projectChannels.length > 0}
                  <span class="text-[11px] text-content-dim tabular-nums">{projectChannels.length}</span>
                {/if}
                <button
                  type="button"
                  onclick={(e) => toggleProjectMenu(project.id, e)}
                  class={cn(
                    "shrink-0 rounded p-0.5 transition-opacity cursor-pointer focus-ring",
                    projectMenuOpen === project.id ? "opacity-100 text-content" : "opacity-0 group-hover/project:opacity-100 text-content-muted hover:text-content",
                  )}
                  aria-label={`Project options for ${project.name}`}
                  aria-haspopup="menu"
                  aria-expanded={projectMenuOpen === project.id}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <circle cx="3" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="13" cy="8" r="1.5"/>
                  </svg>
                </button>
              </div>

              {#if expanded}
                {#if projectChannels.length === 0}
                  <div class="pl-[30px] pr-2.5 h-[26px] flex items-center text-[12px] text-content-dim italic">
                    No channels yet
                  </div>
                {:else}
                  <!-- #524: the animate:flip element must be the immediate child
                       of the keyed each, so the unread-filter moves into the each
                       expression (an {#if} wrapper would break the directive). -->
                  {#each projectChannels.filter((c) => channelPassesFilter(c.id)) as channel (channel.id)}
                    <div animate:flip={flipParams}>
                      {@render channelRow(channel, false)}
                    </div>
                  {/each}
                {/if}
              {:else}
                <!-- Collapsed: peek out channels with an unread signal so a new
                     message in a hidden channel stays visible. Read channels hide. -->
                {#each projectPeekChannels(projectChannels) as channel (channel.id)}
                  <div animate:flip={flipParams}>
                    {@render channelRow(channel, false)}
                  </div>
                {/each}
              {/if}

              <!-- Project context menu -->
              {#if projectMenuOpen === project.id}
                {@render projectContextMenu(project)}
              {/if}
            </div>
          {/each}

          <!-- Channels with no project render flat — no "Unfiled" bucket and no
               separate "Private" section (private channels live under their
               project above, with a lock icon). -->
          {@const orphanChannels = channelsByProject.get(null) ?? []}
          {#if workspaceState.channels.length === 0}
            <div class="px-4 py-2 text-[12px] leading-relaxed text-content-muted">
              You're not in any channels yet. Search above to find and join one, or create a
              channel.
            </div>
          {/if}
          {#each orphanChannels.filter((c) => channelPassesFilter(c.id)) as channel (channel.id)}
            <div animate:flip={flipParams}>
              {@render channelRow(channel, true)}
            </div>
          {/each}
      </SidebarSection>
    {/if}

    <!-- Agents -->
    {#if showAgents}
      <SidebarSection label="Agent sessions" bind:open={agentsOpen} class="mt-2">
        {#snippet labelSuffix()}
          {#if myAgents.length > 0}
            <span class="text-[11px] text-content-dim tabular-nums">{myAgents.length}</span>
          {/if}
        {/snippet}
        {#snippet actions()}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger>
                <button
                  type="button"
                  onclick={handleNewAgent}
                  aria-label="New session"
                  class="rounded p-1 text-content-muted hover:text-content hover:bg-[var(--sidebar-hover)] transition-colors cursor-pointer focus-ring"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                  </svg>
                </button>
              </TooltipTrigger>
              <TooltipContent>New session</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        {/snippet}
          {#if isDraftActive()}
            <div class="flex w-full items-center gap-2.5 pl-4 pr-2.5 h-[32px] text-[15px] bg-[var(--sidebar-active)] text-[var(--sidebar-active-text)] font-medium rounded-md">
              <span class="h-2 w-2 rounded-full shrink-0 bg-warning"></span>
              <span>New agent</span>
            </div>
          {/if}

          {#if myAgents.length === 0 && !isDraftActive()}
            <button
              type="button"
              onclick={handleNewAgent}
              class="w-full flex items-center gap-1.5 pl-4 pr-2.5 h-[32px] rounded-md cursor-pointer text-[15px] text-content-muted hover:bg-[var(--sidebar-hover)] transition-colors touch-target-row focus-ring"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--secondary)" stroke-width="2" stroke-linecap="round">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              <span>New session</span>
            </button>
          {:else}
            {#each myAgents as agent (agent.agentId)}
              {@const name = agentDisplayName(agent)}
              {@const alias = sessionAlias.get(agent.agentId)}
              {@const perms = agentStreamState.getPendingPermissions(agent.agentId).length}
              {@const remoteBadge = remoteDaemonBadge(agent)}
              <div class="relative">
                <div
                  role="button"
                  tabindex="0"
                  aria-label={`Agent ${alias ?? name} — ${agent.lifecycle}`}
                  aria-current={isAgentActive(agent.agentId) ? "page" : undefined}
                  onclick={() => handleAgentClick(agent.agentId)}
                  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleAgentClick(agent.agentId); } }}
                  class={cn(
                    "group/agent w-full flex items-center gap-2.5 pl-4 pr-2.5 h-[32px] rounded-md cursor-pointer text-[15px] transition-colors touch-target-row focus-ring",
                    isAgentActive(agent.agentId)
                      ? "bg-[var(--sidebar-active)] text-[var(--sidebar-active-text)] font-semibold"
                      : "hover:bg-hover-gray text-sidebar-gray",
                  )}
                >
                  <div class="relative shrink-0 w-5 h-5 flex items-center justify-center text-content-muted">
                    <CyboSessionAvatar {agent} size={14} />
                    <span class={cn("absolute -bottom-0.5 -right-0.5 w-[8px] h-[8px] rounded-full border-[1.5px] border-avatar-ring", agentDotClass(agent))} aria-hidden="true"></span>
                  </div>
                  <div class="flex-1 min-w-0 flex items-center gap-1.5">
                    <span class="truncate" title={alias ? `${alias} · ${name}` : name}>{alias ?? name}</span>
                    {#if alias}
                      <span class="shrink-0 rounded bg-accent/15 px-1 text-[9px] font-bold uppercase leading-[14px] tracking-wider text-accent">alias</span>
                    {/if}
                    {#if agent.cwd && agentFolder(agent.cwd)}
                      <span
                        class="shrink-0 max-w-[84px] truncate rounded bg-surface-alt px-1 text-[10px] leading-[14px] text-content-muted"
                        title={agent.cwd}
                      >
                        {agentFolder(agent.cwd)}
                      </span>
                    {/if}
                    <!-- Cross-daemon tag: my sessions are aggregated across ALL
                         daemons, so sessions on another machine are labeled with
                         their daemon (name, or "Remote" when unresolved). -->
                    {#if remoteBadge}
                      <span
                        class="shrink-0 max-w-[84px] truncate rounded bg-warning/15 px-1 text-[10px] leading-[14px] font-medium text-warning"
                        title={`Runs on ${remoteBadge}`}
                      >
                        {remoteBadge}
                      </span>
                    {/if}
                    <!-- #591: derived "needs attention" badge (Done / Error). -->
                    {#if attentionState.badgeFor(agent.agentId)}
                      {@const ab = attentionState.badgeFor(agent.agentId)}
                      {#key ab?.reason}
                        <Badge
                          variant={ab?.tone === "error" ? "attentionError" : "attentionDone"}
                          class="animate-pulse-once shrink-0"
                          aria-label={ab?.description}
                          title={ab?.description}
                        >
                          {ab?.label}
                        </Badge>
                      {/key}
                    {/if}
                  </div>
                  {#if wsId && notificationState.getCount(wsId, agent.agentId) > 0}
                    <span class="flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-accent-foreground shrink-0">
                      {notificationState.getCount(wsId, agent.agentId) > 99
                        ? "99+"
                        : notificationState.getCount(wsId, agent.agentId)}
                    </span>
                  {/if}
                  {#if perms > 0}
                    <button
                      type="button"
                      onclick={(e) => toggleAgentPerms(agent.agentId, e)}
                      class="ml-auto flex h-4 w-4 items-center justify-center rounded-full bg-warning text-[9px] font-bold text-black shrink-0"
                      aria-label={`Answer ${perms} pending permission${perms > 1 ? "s" : ""} for ${alias ?? name}`}
                      aria-haspopup="dialog"
                      aria-expanded={agentPermsOpen === agent.agentId}
                    >
                      {perms}
                    </button>
                  {:else}
                    <button
                      type="button"
                      onclick={(e) => toggleAgentMenu(agent.agentId, e)}
                      class={cn(
                        "ml-auto shrink-0 rounded p-0.5 transition-opacity cursor-pointer focus-ring",
                        agentMenuOpen === agent.agentId ? "opacity-100 text-content" : "opacity-0 group-hover/agent:opacity-100 text-content-muted hover:text-content",
                      )}
                      aria-label={`Agent options for ${alias ?? name}`}
                      aria-haspopup="menu"
                      aria-expanded={agentMenuOpen === agent.agentId}
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                        <circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/>
                      </svg>
                    </button>
                  {/if}
                </div>

                <!-- Agent context menu -->
                {#if agentMenuOpen === agent.agentId}
                  {@render agentContextMenu(agent, name, alias)}
                {/if}
                {#if agentPermsOpen === agent.agentId}
                  {@render agentPermsPopover(agent.agentId)}
                {/if}
              </div>
            {/each}
          {/if}

          <!-- #706 redirect hint: other users' personal sessions were moved to
               the daemon detail; surface a compact pointer so they don't read as
               silently gone. -->
          {@render othersSessionsHint("w-full flex items-center gap-1.5 pl-4 pr-2.5 min-h-[30px] py-1 rounded-md cursor-pointer text-[12px] text-content-muted hover:text-content hover:bg-hover-gray transition-colors focus-ring")}
      </SidebarSection>
    {/if}

    <!-- Terminals (live daemon-scoped sessions, tracked client-side, #701) -->
    {#if terminals.length > 0}
      <SidebarSection label="Terminals" bind:open={terminalsOpen} class="mt-2">
        {#snippet labelSuffix()}
          <span class="text-[11px] text-content-dim tabular-nums">{terminals.length}</span>
        {/snippet}
        {#each terminals as terminal (terminal.terminalId)}
          {@const active = isTerminalActive(terminal.terminalId)}
          {#if terminalAliasEditing === terminal.terminalId}
            <!-- Inline rename editor (server-backed, synced across the user's devices). -->
            <div class="px-4 py-1.5">
              <!-- svelte-ignore a11y_autofocus -->
              <input
                autofocus
                bind:value={terminalAliasDraft}
                placeholder="Terminal alias"
                maxlength="60"
                onclick={(e) => e.stopPropagation()}
                onkeydown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); saveTerminalAlias(terminal.terminalId); }
                  else if (e.key === "Escape") { e.preventDefault(); terminalAliasEditing = null; }
                }}
                class="w-full rounded border border-edge bg-surface px-2 py-1 text-[12px] text-content outline-none focus:border-edge-light"
              />
              <div class="mt-1.5 flex items-center gap-2 text-[11px]">
                <button
                  type="button"
                  onclick={() => saveTerminalAlias(terminal.terminalId)}
                  class="rounded bg-btn-primary-bg px-2 py-0.5 font-medium text-btn-primary-text hover:bg-btn-primary-hover"
                >Save</button>
                {#if terminalAlias.get(terminal.terminalId)}
                  <button
                    type="button"
                    onclick={() => clearTerminalAlias(terminal.terminalId)}
                    class="text-content-muted hover:text-error"
                  >Clear</button>
                {/if}
              </div>
            </div>
          {:else}
            <div
              role="button"
              tabindex="0"
              aria-label={`Terminal ${terminalName(terminal)}`}
              aria-current={active ? "page" : undefined}
              class={cn(
                "group/terminal w-full flex items-center gap-2.5 pl-4 pr-2.5 h-[32px] rounded-md text-[15px] transition-colors touch-target-row focus-ring cursor-pointer",
                active
                  ? "bg-[var(--sidebar-active)] text-[var(--sidebar-active-text)] font-semibold"
                  : "hover:bg-hover-gray text-sidebar-gray",
              )}
              onclick={() => handleTerminalClick(terminal.terminalId, terminal.daemonId)}
              onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleTerminalClick(terminal.terminalId, terminal.daemonId); } }}
            >
              <svg class="h-3.5 w-3.5 shrink-0 text-content-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
              </svg>
              <span class="truncate flex-1 text-left">{terminalName(terminal)}</span>
              <button
                type="button"
                onclick={(e) => startTerminalAliasEdit(terminal.terminalId, e)}
                onkeydown={(e) => e.stopPropagation()}
                class="shrink-0 rounded p-0.5 opacity-0 group-hover/terminal:opacity-100 text-content-muted hover:text-content transition-opacity cursor-pointer focus-ring"
                aria-label={`Rename terminal ${terminalName(terminal)}`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
              </button>
              <button
                type="button"
                onclick={(e) => closeTerminal(terminal.terminalId, terminal.daemonId, e)}
                onkeydown={(e) => e.stopPropagation()}
                class="shrink-0 rounded p-0.5 opacity-0 group-hover/terminal:opacity-100 text-content-muted hover:text-content transition-opacity cursor-pointer focus-ring"
                aria-label={`Close terminal ${terminalName(terminal)}`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          {/if}
        {/each}
      </SidebarSection>
    {/if}

    <!-- Plugin sections -->
    {#each pluginSections as section (section.id)}
      <SidebarSection label={section.label} open={true} class="mt-2">
        {#snippet actions()}
          {#if section.actions}
            <div class="flex items-center gap-0.5">
              {#each section.actions as action}
                <button
                  type="button"
                  onclick={action.onclick}
                  class="rounded p-1 text-content-muted hover:text-content hover:bg-[var(--sidebar-hover)] transition-colors cursor-pointer focus-ring"
                  title={action.label}
                  aria-label={action.label}
                >
                  {action.icon ?? "+"}
                </button>
              {/each}
            </div>
          {/if}
        {/snippet}
          {#each section.items as item (item.id)}
            <button
              type="button"
              onclick={() => { channelState.activeId = null; item.onclick?.() ?? (item.href && goto(item.href)); }}
              aria-label={item.status ? `${item.label} — ${item.status}` : item.label}
              aria-current={item.active ? "page" : undefined}
              class={cn(
                "w-full flex items-center gap-1.5 pl-4 pr-2.5 h-[32px] rounded-md cursor-pointer text-[15px] transition-colors touch-target-row focus-ring",
                item.active
                  ? "bg-[var(--sidebar-active)] text-[var(--sidebar-active-text)] font-semibold"
                  : "hover:bg-hover-gray text-sidebar-gray",
              )}
            >
              {#if item.status}
                <span
                  class={cn(
                    "h-2 w-2 rounded-full shrink-0",
                    item.status === "online" ? "bg-online" :
                    item.status === "error" ? "bg-error" :
                    item.status === "idle" ? "bg-warning" :
                    "bg-content-muted"
                  )}
                  aria-hidden="true"
                ></span>
              {/if}
              <span class="truncate">{item.label}</span>
              {#if item.badge}
                <span class="ml-auto flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-error text-white text-[10px] font-bold px-1">
                  {item.badge}
                </span>
              {/if}
            </button>
          {/each}
      </SidebarSection>
    {/each}

    <!-- Direct Messages -->
    {#if members.length > 0 || dmListLoading}
      <SidebarSection label="Direct Messages" bind:open={dmsOpen} class="mt-2">
          {#snippet actions()}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger>
                  <button
                    type="button"
                    onclick={() => { showNewGroupDm = true; }}
                    class="rounded p-1 text-content-muted hover:text-content hover:bg-[var(--sidebar-hover)] transition-colors cursor-pointer focus-ring"
                    aria-label="New group DM"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </button>
                </TooltipTrigger>
                <TooltipContent>New group DM</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          {/snippet}
          {#if dmListLoading}
            {@render sidebarSkeleton(6, true)}
          {/if}
          <!-- #608: group DMs (hidden group_dm channels) list at the top of the
               DM section. They route via the channel pipeline like any channel. -->
          {#each groupDms as gdm (gdm.id)}
            {@render groupDmRow(gdm)}
          {/each}
          {#each dmMembers as member (member.userId)}
            {#if dmPassesFilter(member.userId)}
            {@const isSelf = member.userId === authState.user?.id}
            {@const isInvited = member.membershipType === "invited"}
            {@const avatarName = member.name ?? member.email?.split("@")[0] ?? "User"}
            {@const dmLabel = isSelf ? `${avatarName} (you)` : avatarName}
            {@const memberStatusEmoji = isSelf ? userStatusState.emoji : workspaceUserStatusesState.emojiFor(member.userId)}
            {@const memberStatus = isSelf ? null : workspaceUserStatusesState.get(member.userId)}
            {@const memberStatusTooltip = isSelf ? userStatusState.tooltip : [memberStatus?.emoji, memberStatus?.text].filter(Boolean).join(" ")}
            {@const memberImage = authState.getMemberImage(member.userId)}
            {@const dmUnread = (!isSelf && wsId) ? notificationState.getCount(wsId, member.userId) : 0}
            {@const dmTyping = !isSelf && dmTypingState.isTyping(member.userId)}
            {@const dmIsOnline = isSelf ? connectionState.status === "connected" : (!isInvited && presenceState.isOnline(member.userId))}
            {@const dmIsAway = !isInvited && presenceState.isAway(member.userId)}
            {@const dmIsActive = dmIsOnline && !dmIsAway}
            <button
              type="button"
              onclick={() => handleDmClick(member.userId)}
              aria-label={`Direct message with ${dmLabel}, ${dmIsActive ? "Active" : "Away"}${dmUnread > 0 ? `, ${dmUnread} unread` : ""}`}
              aria-current={isDmActive(member.userId) ? "page" : undefined}
              class={cn(
                "w-full flex items-center gap-1.5 pl-4 pr-2.5 h-[32px] rounded-md cursor-pointer text-[15px] leading-[32px] transition-colors touch-target-row focus-ring",
                isDmActive(member.userId)
                  ? "bg-[var(--sidebar-active)] text-[var(--sidebar-active-text)] font-semibold"
                  : dmUnread > 0
                    ? "hover:bg-hover-gray text-content font-semibold"
                    : "hover:bg-hover-gray text-sidebar-gray",
              )}
            >
              <div class="relative shrink-0 w-5 h-5">
                {#if memberImage}
                  <img src={memberImage} alt={avatarName} class="w-5 h-5 rounded object-cover" />
                {:else}
                  <!-- Color the letter avatar by name (same palette + hash as
                       the <Avatar> component, via the shared nameToColor) so the
                       DM list matches the colored avatar shown when the DM is
                       opened — a flat `bg-raised` left every initial grey. -->
                  <div
                    class="w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold text-accent-foreground"
                    style:background-color={nameToColor(avatarName)}
                  >
                    {avatarName[0]?.toUpperCase() ?? "?"}
                  </div>
                {/if}
                {#if dmTyping}
                  <span
                    class="absolute -bottom-0.5 -right-0.5 flex items-center gap-[1px] rounded-full border-[1.5px] border-avatar-ring bg-raised px-[2px] py-[1px]"
                    title="typing…"
                    aria-label="typing"
                  >
                    <span class="w-[3px] h-[3px] rounded-full bg-content-dim animate-bounce" style="animation-delay: 0ms; animation-duration: 1.2s;"></span>
                    <span class="w-[3px] h-[3px] rounded-full bg-content-dim animate-bounce" style="animation-delay: 150ms; animation-duration: 1.2s;"></span>
                    <span class="w-[3px] h-[3px] rounded-full bg-content-dim animate-bounce" style="animation-delay: 300ms; animation-duration: 1.2s;"></span>
                  </span>
                {:else if memberStatusEmoji}
                  <Emoji emoji={memberStatusEmoji} size={11} class="absolute -bottom-[3px] -right-[3px]" title={memberStatusTooltip} />
                {:else}
                  <!-- Self-presence is the REAL connection state, not a hardcoded
                       "always online": a dead/zombie socket otherwise shows you green
                       to yourself while co-members correctly see you offline. -->
                  {@const isOnline = isSelf ? connectionState.status === "connected" : (!isInvited && presenceState.isOnline(member.userId))}
                  <!-- Self included: the relay echoes self in awayUserIds, so your
                       own dot greys out when you set yourself away, like co-members see. -->
                  {@const isAway = !isInvited && presenceState.isAway(member.userId)}
                  <!-- Active = online & not manually away. Everything else (manual
                       away OR offline/app-closed) is one grey "Away" state. -->
                  {@const isActive = isOnline && !isAway}
                  <span
                    class={cn(
                      "absolute -bottom-0.5 -right-0.5 w-[8px] h-[8px] rounded-full border-[1.5px] border-avatar-ring",
                      isActive ? "bg-online" : "bg-content-dim",
                    )}
                    title={isActive ? "Active" : "Away"}
                    aria-hidden="true"
                  ></span>
                {/if}
              </div>
              <span class={cn("truncate flex-1 text-left text-[15px]", isInvited && !isSelf && "italic opacity-60")}>{dmLabel}</span>
              {#if isInvited && !isSelf}
                <span class="shrink-0 text-[9px] font-medium text-amber-400/80 uppercase tracking-wide">invited</span>
              {/if}
              {#if dmUnread > 0 && !isDmActive(member.userId)}
                {@render unreadBadge(dmUnread)}
              {:else if memberStatusEmoji}
                <Emoji emoji={memberStatusEmoji} size={14} title={memberStatusTooltip} />
              {/if}
            </button>
            {/if}
          {/each}
      </SidebarSection>
    {/if}

    </div>
  </ScrollArea>

  <!-- Bottom actions (pinned). mt-auto pins it to the bottom of the (flex-fill)
       aside even when the flex-1 ScrollArea above doesn't grow — in the mobile
       drawer the webview doesn't always grow the ScrollArea, which left this
       footer sitting right under the DM list instead of at the bottom (#16). -->
  <div class="mt-auto shrink-0 border-t border-edge-dim px-3 py-2 flex flex-col gap-0.5">
    <button
      type="button"
      onclick={handleOpenAgents}
      class="w-full flex items-center gap-2 px-2 h-[34px] rounded-md cursor-pointer text-[15px] hover:bg-hover-gray text-sidebar-gray transition-colors"
    >
      <CyborgIcon size={14} class="text-[var(--secondary)]" />
      <span>Invite Agents</span>
    </button>
    {#if canInvite}
      <button
        type="button"
        onclick={() => { showInviteHuman = true; }}
        class="w-full flex items-center gap-2 px-2 h-[34px] rounded-md cursor-pointer text-[15px] hover:bg-hover-gray text-sidebar-gray transition-colors"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--secondary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>
        </svg>
        <span>Invite Humans</span>
      </button>
    {/if}
  </div>

  <!-- Resize handle -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="absolute -right-1 w-2 h-full top-0 bg-transparent cursor-col-resize z-10"
    onmousedown={startResize}
  ></div>
</aside>
{/if}

<!-- Add Channel form body — shared between the desktop Dialog and mobile sheet.
     `bigInputs` bumps text to ≥16px on mobile to suppress iOS focus-zoom. -->
{#snippet addChannelBody(bigInputs: boolean)}
  <div class="flex flex-col gap-4">
    <div>
      <span class="mb-1.5 block text-[15px] font-medium text-content">Channel name</span>
      <div class="relative">
        <span class="absolute left-3 top-1/2 -translate-y-1/2 text-content-muted text-[14px] select-none">#</span>
        <input
          type="text"
          placeholder="e.g. design-reviews"
          bind:value={newChannelName}
          maxlength={40}
          class={cn(
            "h-10 w-full rounded-md border border-edge bg-transparent pl-7 pr-3 text-content outline-none placeholder:text-content-muted focus:border-edge-light focus:ring-[3px] focus:ring-edge/30 transition-shadow",
            bigInputs ? "text-base" : "h-9 text-sm",
          )}
          onkeydown={(e) => { if (e.key === "Enter") handleAddChannel(); }}
          oninput={(e) => {
            const target = e.target as HTMLInputElement;
            target.value = target.value.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
            newChannelName = target.value;
          }}
        />
      </div>
    </div>

    <div>
      <span class="mb-1.5 block text-[15px] font-medium text-content">Project</span>
      {#if projects.length === 0}
        <p class="text-[13px] text-content-muted">
          Create a project first — every channel belongs to a project.
        </p>
      {:else}
        <select
          bind:value={newChannelProject}
          class={cn(
            "w-full rounded-md border border-edge bg-transparent px-3 text-content outline-none focus:border-edge-light",
            bigInputs ? "h-11 text-base" : "h-9 text-sm",
          )}
        >
          {#each projects as project (project.id)}
            <option value={project.id}>{project.name}</option>
          {/each}
        </select>
      {/if}
    </div>

    <label class="flex items-center gap-2 cursor-pointer">
      <input type="checkbox" bind:checked={newChannelPrivate} class="w-4 h-4 rounded accent-accent" />
      <span class="text-[15px] text-content">Make private</span>
    </label>
  </div>
{/snippet}

{#snippet addProjectBody(bigInputs: boolean)}
  <div class="flex flex-col gap-4">
    <Field label="Project name" forId="new-project-name">
      <input
        id="new-project-name"
        type="text"
        placeholder="e.g. mobile-app"
        bind:value={newProjectName}
        maxlength={40}
        class={cn(fieldInputClass, bigInputs && "text-base h-11")}
        onkeydown={(e) => { if (e.key === "Enter") handleAddProject(); }}
      />
    </Field>

    <div>
      <span class="mb-2 block text-[15px] font-medium text-content">Color</span>
      <div class="flex gap-2.5 flex-wrap">
        {#each PROJECT_COLORS as c (c)}
          <button
            type="button"
            onclick={() => { newProjectColor = c; }}
            aria-label="Color {c}"
            class="relative w-7 h-7 rounded-full cursor-pointer transition-shadow"
            style="background-color: {c}; box-shadow: {newProjectColor === c ? `0 0 0 2px var(--bg-surface), 0 0 0 4px ${c}` : 'none'};"
          >
            {#if newProjectColor === c}
              <svg class="absolute inset-0 m-auto" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={checkStroke(c)} stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            {/if}
          </button>
        {/each}
      </div>
    </div>
  </div>
{/snippet}

<!-- Add Channel Dialog -->
{#if showAddChannel && viewportState.isMobile}
  <MobileSheet
    open={showAddChannel}
    title="Create a channel"
    onclose={() => { showAddChannel = false; newChannelName = ""; newChannelProject = null; }}
  >
    {@render addChannelBody(true)}
    <div class="mt-4 flex flex-col gap-2 pb-1">
      <Button class="h-12 w-full text-base" onclick={handleAddChannel} disabled={!newChannelName.trim() || !newChannelProject}>Create</Button>
      <Button variant="outline" class="h-12 w-full text-base" onclick={() => { showAddChannel = false; newChannelName = ""; newChannelProject = null; }}>Cancel</Button>
    </div>
  </MobileSheet>
{:else if showAddChannel}
  <Dialog bind:open={showAddChannel} onOpenChange={(open) => { if (open) { newChannelProject = newChannelProject ?? projects[0]?.id ?? null; } else { newChannelName = ""; newChannelProject = null; } }}>
    <DialogContent class="sm:max-w-[440px]" showCloseButton={true}>
      <DialogHeader>
        <DialogTitle>Create a channel</DialogTitle>
      </DialogHeader>

      {@render addChannelBody(false)}

      <DialogFooter>
        <Button variant="outline" onclick={() => { showAddChannel = false; newChannelName = ""; newChannelProject = null; }}>Cancel</Button>
        <Button onclick={handleAddChannel} disabled={!newChannelName.trim() || !newChannelProject}>Create</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
{/if}

<!-- Add Project Dialog -->
{#if showAddProject && viewportState.isMobile}
  <MobileSheet
    open={showAddProject}
    title="New project"
    onclose={() => { showAddProject = false; newProjectName = ""; }}
  >
    {@render addProjectBody(true)}
    <div class="mt-4 flex flex-col gap-2 pb-1">
      <Button class="h-12 w-full text-base" onclick={handleAddProject} disabled={!newProjectName.trim()}>Create</Button>
      <Button variant="outline" class="h-12 w-full text-base" onclick={() => { showAddProject = false; newProjectName = ""; }}>Cancel</Button>
    </div>
  </MobileSheet>
{:else if showAddProject}
  <Dialog bind:open={showAddProject} onOpenChange={(open) => { if (!open) { newProjectName = ""; } }}>
    <DialogContent class="sm:max-w-[400px]" showCloseButton={true}>
      <DialogHeader>
        <DialogTitle>New project</DialogTitle>
      </DialogHeader>

      {@render addProjectBody(false)}

      <DialogFooter>
        <Button variant="outline" onclick={() => { showAddProject = false; newProjectName = ""; }}>Cancel</Button>
        <Button onclick={handleAddProject} disabled={!newProjectName.trim()}>Create</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
{/if}

<!-- Edit Project Dialog -->
<Dialog open={editingProject !== null} onOpenChange={(open) => { if (!open) editingProject = null; }}>
  <DialogContent class="sm:max-w-[400px]" showCloseButton={true}>
    <DialogHeader>
      <DialogTitle>Edit project</DialogTitle>
    </DialogHeader>

    <div class="flex flex-col gap-4">
      <Field label="Project name" forId="edit-project-name">
        <input
          id="edit-project-name"
          type="text"
          bind:value={editProjectName}
          maxlength={40}
          class={fieldInputClass}
          onkeydown={(e) => { if (e.key === "Enter") handleSaveProject(); }}
        />
      </Field>

      <div>
        <span class="mb-2 block text-[15px] font-medium text-content">Color</span>
        <div class="flex gap-2.5 flex-wrap">
          {#each PROJECT_COLORS as c (c)}
            <button
              type="button"
              onclick={() => { editProjectColor = c; }}
              aria-label="Color {c}"
              class="relative w-7 h-7 rounded-full cursor-pointer transition-shadow"
              style="background-color: {c}; box-shadow: {editProjectColor === c ? `0 0 0 2px var(--bg-surface), 0 0 0 4px ${c}` : 'none'};"
            >
              {#if editProjectColor === c}
                <svg class="absolute inset-0 m-auto" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={checkStroke(c)} stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              {/if}
            </button>
          {/each}
        </div>
      </div>
    </div>

    <DialogFooter>
      <Button variant="outline" onclick={() => { editingProject = null; }}>Cancel</Button>
      <Button onclick={handleSaveProject} disabled={!editProjectName.trim()}>Save</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>

<!-- Invite People Dialog -->
<Dialog bind:open={showInviteHuman} onOpenChange={(open) => { if (!open) { inviteEmail = ""; inviteError = null; inviteSentUrl = ""; inviteSentEmail = ""; inviteCopied = false; } }}>
  <DialogContent class="sm:max-w-[440px]" showCloseButton={true}>
    <DialogHeader>
      <DialogTitle>Invite Humans</DialogTitle>
    </DialogHeader>

    {#if inviteSentUrl}
      <div class="flex flex-col gap-3">
        <p class="text-sm text-online">✓ Invitation sent to {inviteSentEmail}</p>
        <div class="space-y-1.5 rounded-lg px-3 py-2.5" style="background-color: var(--bg-base); border: 1px solid var(--border);">
          <p class="text-xs text-content-muted">Share this link to invite them directly:</p>
          <div class="flex items-center gap-2">
            <p class="flex-1 select-all break-all font-mono text-xs text-content">{inviteSentUrl}</p>
            <Button variant="outline" onclick={copyInviteLink}>{inviteCopied ? "✓ Copied" : "Copy"}</Button>
          </div>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onclick={() => { inviteSentUrl = ""; inviteSentEmail = ""; inviteCopied = false; }}>Invite another</Button>
        <Button onclick={() => { showInviteHuman = false; }}>Done</Button>
      </DialogFooter>
    {:else}
      <div class="flex flex-col gap-4">
        <Field label="Email address" forId="invite-email" error={inviteError}>
          <input
            id="invite-email"
            type="email"
            placeholder="colleague@example.com"
            bind:value={inviteEmail}
            class={fieldInputClass}
            onkeydown={(e) => { if (e.key === "Enter") handleInviteHuman(); }}
          />
        </Field>

        <Field label="Role" hint="Members post · Viewers read-only · Admins manage the workspace.">
          <Select.Root type="single" bind:value={inviteRole}>
            <Select.Trigger class={fieldInputClass}>{inviteRoleLabel}</Select.Trigger>
            <Select.Content>
              {#each INVITE_ROLES as role (role.value)}
                <Select.Item value={role.value} label={role.label}>{role.label}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </Field>
      </div>

      <DialogFooter>
        <Button variant="outline" onclick={() => { showInviteHuman = false; inviteEmail = ""; inviteError = null; }}>Cancel</Button>
        <Button onclick={handleInviteHuman} disabled={!inviteEmail.trim() || inviting}>
          {inviting ? "Inviting..." : "Send invite"}
        </Button>
      </DialogFooter>
    {/if}
  </DialogContent>
</Dialog>

<!-- Channel context menu. Desktop: floating menu anchored at the cursor.
     Mobile: a bottom sheet — the cursor-anchored menu overflowed off the right
     edge when the ⋯ was tapped near the screen edge. -->
{#if channelMenuOpen}
  {@const menuChannel = workspaceState.channels.find((c) => c.id === channelMenuOpen)}
  {#if menuChannel}
    {#if viewportState.isMobile}
      {@const fav = isFavorite(menuChannel.id)}
      {@const pref = notifPrefsState.get(menuChannel.id)}
      {@const otherProjects = projects.filter((p) => p.id !== menuChannel.projectId)}
      <MobileSheet open ariaLabel={`#${menuChannel.name} options`} onclose={() => (channelMenuOpen = null)}>
        <div class="mb-3 flex items-center gap-2 px-1">
          <span class="text-content-muted">#</span>
          <span class="truncate text-[16px] font-bold text-content">{menuChannel.name}</span>
        </div>

        <div class="mb-3 overflow-hidden rounded-[12px] bg-surface-alt">
          <button type="button" onclick={() => { toggleFavorite(menuChannel.id); channelMenuOpen = null; }}
            class="flex min-h-[48px] w-full items-center gap-3 px-4 text-left text-[16px] text-content active:bg-raised">
            <svg width="18" height="18" viewBox="0 0 24 24" fill={fav ? "currentColor" : "none"} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class={fav ? "text-warning" : "text-content-muted"}>
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
            {fav ? "Remove from favorites" : "Add to favorites"}
          </button>
          <div class="mx-4 h-px" style="background-color: var(--hairline);"></div>
          <button type="button" onclick={() => { editingChannelForDialog = menuChannel; showEditChannelDialog = true; channelMenuOpen = null; }}
            class="flex min-h-[48px] w-full items-center px-4 text-left text-[16px] text-content active:bg-raised">
            Edit channel
          </button>
          <div class="mx-4 h-px" style="background-color: var(--hairline);"></div>
          <button type="button" onclick={() => { pendingLeaveChannel = menuChannel; channelMenuOpen = null; }}
            class="flex min-h-[48px] w-full items-center px-4 text-left text-[16px] text-content active:bg-raised">
            Leave channel
          </button>
        </div>

        <div class="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-content-muted">Notifications</div>
        <div class="mb-3 overflow-hidden rounded-[12px] bg-surface-alt">
          {#each [{ value: "all", label: "All messages" }, { value: "mentions_only", label: "Mentions only" }, { value: "muted", label: "Muted" }] as opt, i (opt.value)}
            {#if i > 0}<div class="mx-4 h-px" style="background-color: var(--hairline);"></div>{/if}
            <button type="button" onclick={() => setChannelNotificationPref(menuChannel.id, opt.value as "all" | "mentions_only" | "muted")}
              class="flex min-h-[48px] w-full items-center justify-between px-4 text-left text-[16px] {pref === opt.value ? 'font-semibold text-content' : 'text-content'} active:bg-raised">
              {opt.label}
              {#if pref === opt.value}
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
              {/if}
            </button>
          {/each}
        </div>

        {#if otherProjects.length > 0}
          <div class="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-content-muted">Move to project</div>
          <div class="mb-3 overflow-hidden rounded-[12px] bg-surface-alt">
            {#each otherProjects as project, i (project.id)}
              {#if i > 0}<div class="mx-4 h-px" style="background-color: var(--hairline);"></div>{/if}
              <button type="button" onclick={() => moveChannelToProject(menuChannel.id, project.id)}
                class="flex min-h-[48px] w-full items-center gap-3 px-4 text-left text-[16px] text-content active:bg-raised">
                <span class="inline-flex shrink-0 items-center justify-center font-bold text-[9px]" style="width: 18px; height: 18px; border-radius: 4px; background-color: {project.color}; color: #0d0e10;">{project.name[0]?.toUpperCase() ?? "?"}</span>
                <span class="truncate">{project.name}</span>
              </button>
            {/each}
          </div>
        {/if}

        <div class="overflow-hidden rounded-[12px] bg-surface-alt">
          <button type="button" onclick={() => handleDeleteChannel(menuChannel.id, menuChannel.name)}
            class="flex min-h-[48px] w-full items-center justify-center px-4 text-[16px] font-semibold text-red-500 active:bg-raised">
            Delete channel
          </button>
        </div>
      </MobileSheet>
    {:else}
      <ChannelContextMenu
        channel={menuChannel}
        x={channelMenuPos.x}
        y={channelMenuPos.y}
        {projects}
        isFavorite={isFavorite(menuChannel.id)}
        onToggleFavorite={() => { toggleFavorite(menuChannel.id); channelMenuOpen = null; }}
        onEdit={() => { editingChannelForDialog = menuChannel; showEditChannelDialog = true; channelMenuOpen = null; }}
        onLeave={() => { pendingLeaveChannel = menuChannel; channelMenuOpen = null; }}
        onMoveToProject={(projectId) => moveChannelToProject(menuChannel.id, projectId)}
        onDelete={() => handleDeleteChannel(menuChannel.id, menuChannel.name)}
      />
    {/if}
  {/if}
{/if}

<!-- Item 3: confirm before leaving a channel from the sidebar context menu. -->
<ConfirmDialog
  open={pendingLeaveChannel !== null}
  title="Leave channel?"
  message={pendingLeaveChannel
    ? `You'll leave #${pendingLeaveChannel.name} and stop receiving its messages.${pendingLeaveChannel.isPrivate ? " Since it's private, you'll need a new invite to rejoin." : " You can rejoin anytime since it's public."}`
    : ""}
  confirmLabel="Leave"
  destructive
  onconfirm={() => { if (pendingLeaveChannel) leaveChannelAction(pendingLeaveChannel.id); pendingLeaveChannel = null; }}
  oncancel={() => (pendingLeaveChannel = null)}
/>

{#if editingChannelForDialog}
  <ChannelDetailsDialog bind:open={showEditChannelDialog} channel={editingChannelForDialog} initialTab="settings" ondeleted={() => { editingChannelForDialog = null; }} />
{/if}

<!-- Browse channels modal -->
<BrowseChannelsModal bind:open={showBrowseChannels} />
<NewGroupDmDialog bind:open={showNewGroupDm} />
