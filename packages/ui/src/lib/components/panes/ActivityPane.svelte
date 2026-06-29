<script lang="ts">
  import { goto } from "$app/navigation";
  import { reportClientError } from "@cyborg7/observability/web";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import {
    activityState,
    refreshActivity,
    authState,
    client,
    daemonAccessRequestsState,
  } from "$lib/state/app.svelte.js";
  import PullToRefresh from "../PullToRefresh.svelte";
  import type { ActivityEventType, ActivityItem } from "$lib/state/app.svelte.js";
  import { SCOPE_META, scopesRequireRceConfirm, type DaemonScope } from "$lib/daemon-scopes.js";
  import { cn } from "$lib/utils.js";
  import { relativeTime } from "$lib/utils/datetime.js";
  import Avatar from "../Avatar.svelte";
  import EmptyState from "../EmptyState.svelte";
  import { viewportState } from "$lib/state/viewport.svelte.js";

  let { workspaceId }: { workspaceId: string } = $props();

  type Filter = "all" | "mentions" | "dms" | "permissions";

  const TAB_DEFS: Array<{ key: Filter; label: string }> = [
    { key: "all", label: "All" },
    { key: "mentions", label: "Mentions" },
    { key: "dms", label: "DMs" },
    { key: "permissions", label: "Permissions" },
  ];

  let filter = $state<Filter>("all");
  let showRead = $state(true);

  function matchesFilter(eventType: ActivityEventType, f: Filter): boolean {
    if (f === "all") return true;
    if (f === "mentions") return eventType === "mention" || eventType === "thread_reply";
    if (f === "dms") return eventType === "dm_received";
    if (f === "permissions")
      return (
        eventType === "permission_request" ||
        eventType === "daemon_access_request" ||
        eventType === "agent_error"
      );
    return false;
  }

  const entries = $derived(
    activityState.items
      .filter((e) => matchesFilter(e.eventType, filter))
      .filter((e) => showRead || !e.isRead)
      .toReversed(),
  );

  // Tab unread-count badges (matches v1 ActivityPane:381-414 — badges show the
  // number of unread items per tab).
  const tabCounts = $derived.by(() => {
    const c = { all: 0, mentions: 0, dms: 0, permissions: 0 };
    for (const e of activityState.items) {
      if (e.isRead) continue;
      c.all++;
      if (e.eventType === "mention" || e.eventType === "thread_reply") c.mentions++;
      else if (e.eventType === "dm_received") c.dms++;
      else if (
        e.eventType === "permission_request" ||
        e.eventType === "daemon_access_request" ||
        e.eventType === "agent_error"
      )
        c.permissions++;
    }
    return c;
  });

  const unreadCount = $derived(activityState.unreadCount);

  const grouped = $derived.by(() => {
    const groups: Array<{ bucket: string; items: typeof entries }> = [];
    const index = new Map<string, number>();
    for (const entry of entries) {
      const b = dayBucket(entry.createdAt);
      let idx = index.get(b);
      if (idx === undefined) {
        idx = groups.length;
        index.set(b, idx);
        groups.push({ bucket: b, items: [] });
      }
      groups[idx].items.push(entry);
    }
    return groups;
  });

  function dayBucket(iso: string): string {
    const d = new Date(iso);
    const now = new Date();
    const startOfDay = (dt: Date) =>
      new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
    const todayStart = startOfDay(now);
    const dayStart = startOfDay(d);
    if (dayStart === todayStart) return "Today";
    if (dayStart === todayStart - 86_400_000) return "Yesterday";
    if (dayStart > todayStart - 7 * 86_400_000) return "This week";
    return "Earlier";
  }

  // Left accent strip color per event type (matches v1 accentColorForType:87-91 +
  // the dm/permission/error extensions of the rewrite's wider type union).
  function accentColorForType(t: ActivityEventType): string {
    if (t === "mention" || t === "thread_reply") return "var(--activity-mention-accent)";
    if (t === "task_assigned" || t === "task_status_changed") return "var(--activity-task-accent)";
    if (t === "task_review_requested" || t === "reaction") return "var(--activity-review-accent)";
    if (t === "agent_error") return "var(--activity-error-accent)";
    if (t === "permission_request" || t === "daemon_access_request")
      return "var(--activity-review-accent)";
    return "var(--activity-mention-accent)";
  }

  // Split a preview into plain text + highlighted @handles (matches v1
  // renderPreview:511-533 — Slack-style yellow/blue @mention highlight).
  function previewParts(text: string): Array<{ text: string; mention: boolean }> {
    const parts: Array<{ text: string; mention: boolean }> = [];
    const regex = /(@[\w.-]+)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null = regex.exec(text);
    while (match !== null) {
      if (match.index > lastIndex) {
        parts.push({ text: text.slice(lastIndex, match.index), mention: false });
      }
      parts.push({ text: match[0], mention: true });
      lastIndex = match.index + match[0].length;
      match = regex.exec(text);
    }
    if (lastIndex < text.length) parts.push({ text: text.slice(lastIndex), mention: false });
    return parts;
  }

  function handleClick(item: ActivityItem): void {
    if (
      (item.eventType === "task_assigned" || item.eventType === "task_status_changed") &&
      item.sourceId
    ) {
      // Task activity: clear this task's row (local + server, cross-device) and
      // deep-link to the task detail. sourceId is the taskId (task rows key by
      // task:<taskId>). markReadByTask is idempotent — the TaskDetailCard open
      // path also fires markTaskRead, so the duplicate clear is safe. Do NOT also
      // call markRead(item.id): that would double-decrement the unread badge.
      activityState.markReadByTask(item.sourceId);
      if (workspaceId) client.markTaskRead(workspaceId, item.sourceId);
      goto(`/workspace/${workspaceId}/tasks/item/${item.sourceId}`);
      return;
    }
    if (item.eventType === "daemon_access_request") {
      // Route to the daemon detail (owner Access section) — the request's daemon
      // is on the live request row (keyed by the activity sourceId = request id).
      // This row has no channel/dm/task scope, so it must persist via the
      // per-row endpoint — otherwise getUnreadActivityCount keeps counting it and
      // the next seedFromServer resets the badge (only "Mark all read" cleared it).
      activityState.markRead(item.id);
      if (workspaceId) client.markActivityRead(workspaceId, item.id);
      const req = item.sourceId ? daemonAccessRequestsState.byId(item.sourceId) : undefined;
      if (req) goto(`/workspace/${workspaceId}/daemons/${req.daemonId}`);
      return;
    }
    if (item.eventType === "dm_received" && item.actorId) {
      // Clear the ENTIRE DM peer's activity, not just this row — multiple DMs from
      // the same peer must all clear on open. Persist server-side here too, because
      // selectDm early-returns when this peer is already the active conversation
      // (app.svelte.ts:3864), so its markReadByDmPeer/markDmRead would never fire.
      // markDmRead is idempotent (server clears WHERE isRead = false), so the
      // duplicate call from selectDm on a peer switch is safe. Do NOT also call
      // markRead(item.id) here — that would double-decrement the unread badge.
      activityState.markReadByDmPeer(item.actorId);
      if (workspaceId) client.markDmRead(workspaceId, item.actorId);
      goto(`/workspace/${workspaceId}/dm/${item.actorId}`);
      return;
    }
    if (item.channelId) {
      // Clear the ENTIRE channel's activity, not just this row — multiple
      // mentions in the same channel must all clear on open. Persist server-side
      // here too, because selectChannel early-returns when this channel is
      // already active (app.svelte.ts:3134), so its markRead/markReadByChannel
      // would never re-fire on a re-open. client.markRead is the same channel
      // read-persist selectChannel uses (app.svelte.ts:3173); the relay clears
      // this channel's Activity items and broadcasts back, so the duplicate call
      // from selectChannel on a channel switch is safe. Do NOT also call
      // markRead(item.id) here — that would double-decrement the unread badge.
      activityState.markReadByChannel(item.channelId);
      if (workspaceId) client.markRead(workspaceId, item.channelId);
      goto(`/workspace/${workspaceId}/channel/${item.channelId}`);
      return;
    }
    // Fallback (permission_request / agent_error): also scope-less, so persist
    // the per-row read server-side — same reason as daemon_access_request above.
    activityState.markRead(item.id);
    if (workspaceId) client.markActivityRead(workspaceId, item.id);
    if ((item.eventType === "permission_request" || item.eventType === "agent_error") && item.actorId) {
      goto(`/workspace/${workspaceId}/agent/${item.actorId}`);
    }
  }

  // "Mark all read" clears the in-memory feed AND persists server-side (eventId
  // omitted = clear all). Without the server call, getUnreadActivityCount keeps
  // the unscoped rows and the next seedFromServer resets the badge — so even
  // mark-all only looked fixed until the next reconnect.
  function handleMarkAllRead(): void {
    activityState.markAllRead();
    if (workspaceId) client.markActivityRead(workspaceId);
  }

  // ── Daemon-access-request resolution (#705, owner inbox) ───────────
  // The activity row is keyed by the request id (sourceId); the live request row
  // (daemonAccessRequestsState) carries the scopes + status the actions act on. A
  // resolved/missing request hides the actions (no stale Approve/Deny).
  function pendingRequestFor(item: ActivityItem) {
    if (item.eventType !== "daemon_access_request" || !item.sourceId) return undefined;
    const req = daemonAccessRequestsState.byId(item.sourceId);
    return req && req.status === "pending" ? req : undefined;
  }

  let resolvingRequest = $state<string | null>(null);
  // An approve held for the #35 RCE confirm (requested scopes include terminal/admin).
  let pendingApproval = $state<{ id: string; name: string; scopes: DaemonScope[] } | null>(null);

  async function resolveRequest(
    workspaceId2: string,
    requestId: string,
    decision: "approve" | "deny",
  ): Promise<void> {
    if (resolvingRequest) return;
    resolvingRequest = requestId;
    try {
      const { request } = await client.resolveDaemonAccessRequest(
        workspaceId2,
        requestId,
        decision,
      );
      daemonAccessRequestsState.upsert(request);
    } catch (err) {
      reportClientError({
        source: "ActivityPane.resolveRequest",
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : null,
        platform: "web",
      });
    } finally {
      resolvingRequest = null;
    }
  }

  function approve(req: {
    id: string;
    requesterName: string | null;
    requesterId: string;
    scopes: DaemonScope[];
  }): void {
    if (scopesRequireRceConfirm(req.scopes)) {
      pendingApproval = {
        id: req.id,
        name: req.requesterName ?? "this member",
        scopes: req.scopes,
      };
      return;
    }
    void resolveRequest(workspaceId, req.id, "approve");
  }

  const emptyCopy = $derived.by(() => {
    if (filter === "mentions") return "No mentions yet.";
    if (filter === "dms") return "No direct messages.";
    if (filter === "permissions") return "No permission requests.";
    return "No activity yet.";
  });

  const emptySubCopy = $derived.by(() => {
    if (filter === "mentions") return "You'll see @mentions and thread replies here.";
    if (filter === "dms") return "Direct messages from teammates will appear here.";
    if (filter === "permissions") return "Agent permission requests and errors will show up here.";
    return "Mentions, DMs, and permission requests will appear as they happen.";
  });

  // Header label per event type (mirrors the v1 per-row "Mention in" /
  // "Replied to your thread in" / "Task assigned by" / "Review requested from"
  // wording, adapted to the rewrite's type union).
  function headerLabel(eventType: ActivityEventType): string {
    switch (eventType) {
      case "mention": return "Mentioned you";
      case "thread_reply": return "Replied to your thread";
      case "dm_received": return "Sent you a message";
      case "task_assigned": return "Assigned you a task";
      case "task_status_changed": return "Updated your task";
      case "task_review_requested": return "Requested your review";
      case "reaction": return "Reacted to your message";
      case "permission_request": return "Needs permission";
      case "daemon_access_request": return "Requested daemon access";
      case "agent_error": return "Error";
      default: return eventType;
    }
  }

  // Mobile row line 1: lowercase action phrase continuing the actor's name
  // ("Seb mentioned you in #general" — iOS Notification Center / Slack iOS
  // Activity sentence shape). Same event→meaning mapping as headerLabel; the
  // channel folds into the sentence instead of a separate chip.
  function actionLabel(item: ActivityItem): string {
    const inChannel = item.channelName ? ` in #${item.channelName}` : "";
    switch (item.eventType) {
      case "mention": return `mentioned you${inChannel}`;
      case "thread_reply": return `replied to your thread${inChannel}`;
      case "dm_received": return "sent you a message";
      case "task_assigned": return `assigned you a task${inChannel}`;
      case "task_status_changed": return `updated your task${inChannel}`;
      case "task_review_requested": return `requested your review${inChannel}`;
      case "reaction": return `reacted to your message${inChannel}`;
      case "permission_request": return "needs your permission";
      case "daemon_access_request": return "requested access to your daemon";
      case "agent_error": return "ran into an error";
      default: return item.eventType;
    }
  }

  // Mobile empty-state glyph per filter (compound path data, stroked). Pairs
  // with the existing emptyCopy/emptySubCopy derived strings.
  const EMPTY_ICON_PATHS: Record<Filter, string> = {
    all: "M12 3.5a5.25 5.25 0 0 0-5.25 5.25v2.5c0 1.17-.43 2.3-1.2 3.17l-.94 1.05A1 1 0 0 0 5.35 17h13.3a1 1 0 0 0 .74-1.53l-.94-1.05A4.75 4.75 0 0 1 17.25 11.25V8.75A5.25 5.25 0 0 0 12 3.5Z M10 20a2 2 0 0 0 4 0",
    mentions: "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94",
    dms: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
    permissions: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  };
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-hidden">
{#if viewportState.isMobile}
  <!-- ── Mobile presentation (S7): iOS Notification Center / Slack iOS
       Activity. Same state, filters, counts, grouping, routing and unread
       accounting as desktop — only the rendering differs. Desktop renders
       the untouched branch below. ── -->

  <!-- Header: large title + actions, then an iOS segmented control. Sits
       outside the scroller (like the desktop header) so PTR works on the
       list alone. -->
  <div class="shrink-0 bg-surface pb-2">
    <div class="flex items-center justify-between px-4 pt-4">
      <h1 class="text-[28px] font-bold leading-[34px] tracking-[-0.01em] text-content">Activity</h1>
      <div class="-mr-2 flex items-center">
        {#if unreadCount > 0}
          <button
            type="button"
            onclick={handleMarkAllRead}
            class="pressable flex min-h-[44px] items-center rounded-full px-2 text-[13px] font-semibold text-accent"
          >
            Mark all read
          </button>
        {/if}
        <!-- Unread-only eye toggle (kept): accent when filtering to unread. -->
        <button
          type="button"
          onclick={() => { showRead = !showRead; }}
          class={cn(
            "pressable flex h-[44px] w-[44px] items-center justify-center rounded-full",
            !showRead ? "text-accent" : "text-content-muted",
          )}
          aria-label={showRead ? "Show unread only" : "Show all activity"}
          aria-pressed={!showRead}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- Filters: one rounded track, 4 equal segments, active segment raised.
         Unread counts inline ("Mentions · 3"), not badge pills. -->
    <div class="mx-4 mt-1 grid h-[44px] grid-cols-4 gap-[2px] rounded-[10px] bg-surface-alt p-[2px]">
      {#each TAB_DEFS as t (t.key)}
        {@const count = tabCounts[t.key]}
        {@const active = filter === t.key}
        <button
          type="button"
          onclick={() => { filter = t.key; }}
          class={cn(
            "flex min-w-0 cursor-pointer items-center justify-center rounded-[8px] px-1 transition-colors",
            active
              ? "bg-raised font-semibold text-content shadow-[0_1px_3px_rgba(0,0,0,0.12)]"
              : "text-content-muted",
          )}
          aria-pressed={active}
        >
          <span class="truncate text-[15px] leading-[20px]">{t.label}{count > 0 ? ` · ${count > 99 ? "99+" : count}` : ""}</span>
        </button>
      {/each}
    </div>
  </div>

  <!-- Feed: day-grouped notification rows, spacing-only separation. -->
  <PullToRefresh scrollClass="min-h-0 flex-1 overflow-y-auto" onRefresh={refreshActivity}>
    <div class="flex min-h-full flex-col pb-8">
      {#if entries.length === 0}
        <!-- Designed empty state per filter, vertically centered. -->
        <EmptyState
          iconWrap={false}
          title={emptyCopy}
          description={emptySubCopy}
          class="flex-1 px-8 pb-12"
          titleClass="text-[15px] font-semibold text-content"
          descriptionClass="mt-1 text-[13px] leading-[18px] text-content-muted"
        >
          {#snippet icon()}
            <span class="flex h-[56px] w-[56px] items-center justify-center rounded-full bg-raised text-content-muted" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                <path d={EMPTY_ICON_PATHS[filter]} />
              </svg>
            </span>
          {/snippet}
        </EmptyState>
      {:else}
        {#each grouped as group (group.bucket)}
          <!-- Day group header: TODAY / YESTERDAY / THIS WEEK / EARLIER -->
          <div class="px-4 pb-1 pt-6 text-[13px] font-semibold uppercase tracking-[0.06em] text-content-muted">
            {group.bucket}
          </div>
          {#each group.items as item (item.id)}
            {@const accessReq = pendingRequestFor(item)}
            <!-- Notification row: 44px avatar · actor + action · preview ·
                 trailing time with unread dot. No accent strip, no hairlines —
                 spacing only. -->
            <button
              type="button"
              onclick={() => handleClick(item)}
              class="pressable-row flex w-full min-h-[68px] cursor-pointer items-center gap-3 px-4 py-2 text-left"
            >
              <Avatar
                name={item.actorName}
                image={item.actorType === "human" && item.actorId ? authState.getMemberImage(item.actorId) : null}
                width={44}
                fontSize={16}
              />
              <span class="flex min-w-0 flex-1 flex-col justify-center gap-px">
                <span class="truncate text-[16px] leading-[21px]">
                  <span class="font-semibold text-content">{item.actorName}</span>
                  <span class="text-content-dim">{actionLabel(item)}</span>
                </span>
                {#if item.preview.trim()}
                  <span class="truncate text-[15px] leading-[20px] text-content-muted">
                    {#each previewParts(item.preview) as part}
                      {#if part.mention}
                        <span
                          class="rounded px-0.5 font-semibold"
                          style="color: var(--activity-mention-text); background-color: var(--activity-mention-bg);"
                        >{part.text}</span>
                      {:else}{part.text}{/if}
                    {/each}
                  </span>
                {/if}
              </span>
              <span class="flex shrink-0 flex-col items-end justify-center gap-[5px]">
                <span class="text-[13px] leading-[16px] text-content-muted tabular-nums">{relativeTime(item.createdAt)}</span>
                {#if !item.isRead}
                  <span class="h-2 w-2 rounded-full bg-accent" aria-hidden="true"></span>
                {/if}
              </span>
            </button>
            <!-- #705: owner inbox actions (mobile) — sibling of the row button. -->
            {#if accessReq}
              <div class="flex items-center gap-2 px-4 pb-3">
                <span class="mr-auto text-[13px] text-content-muted">
                  {accessReq.scopes.map((s) => SCOPE_META[s].label).join(", ")}
                </span>
                <button
                  type="button"
                  disabled={resolvingRequest === accessReq.id}
                  onclick={() =>
                    approve({
                      id: accessReq.id,
                      requesterName: accessReq.requesterName,
                      requesterId: accessReq.requesterId,
                      scopes: accessReq.scopes,
                    })}
                  class="rounded-lg px-4 py-2 text-[15px] font-semibold text-accent-foreground bg-accent active:bg-accent-hover disabled:opacity-50"
                >
                  Approve
                </button>
                <button
                  type="button"
                  disabled={resolvingRequest === accessReq.id}
                  onclick={() => void resolveRequest(workspaceId, accessReq.id, "deny")}
                  class="rounded-lg border border-edge px-4 py-2 text-[15px] font-medium text-content bg-surface-alt active:bg-raised disabled:opacity-50"
                >
                  Deny
                </button>
              </div>
            {/if}
          {/each}
        {/each}
      {/if}
    </div>
  </PullToRefresh>
{:else}
  <!-- Header -->
  <div class="sticky top-0 z-10 border-b border-edge-dim bg-surface">
    <div class="mx-auto w-full max-w-[var(--content-max)] px-6 pt-5 pb-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <h1 class="text-[17px] font-bold text-content">Activity</h1>
          {#if unreadCount > 0}
            <Badge variant="mention">{unreadCount} new</Badge>
          {/if}
        </div>

        <div class="flex items-center gap-2">
          <!-- Show read toggle -->
          <button
            type="button"
            onclick={() => { showRead = !showRead; }}
            class={cn(
              "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[12px] transition-colors",
              !showRead
                ? "text-content-dim"
                : "text-content-muted hover:text-content-dim hover:bg-hover-gray",
            )}
            style={!showRead ? "background-color: var(--bg-elevated);" : undefined}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
            </svg>
            {showRead ? "Unread only" : "Show all"}
          </button>

          <!-- Mark all read -->
          {#if unreadCount > 0}
            <button
              type="button"
              onclick={handleMarkAllRead}
              class="cursor-pointer rounded-md px-2 py-1 text-[12px] text-content-muted transition-colors hover:bg-hover-gray hover:text-content"
            >
              Mark all read
            </button>
          {/if}
        </div>
      </div>

      <!-- Tabs -->
      <div class="mt-3 flex flex-wrap items-center gap-1">
        {#each TAB_DEFS as t (t.key)}
          {@const count = tabCounts[t.key]}
          {@const active = filter === t.key}
          <button
            type="button"
            onclick={() => { filter = t.key; }}
            class={cn(
              "inline-flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors",
              active
                ? "bg-[var(--sidebar-active)]"
                : "text-content-dim hover:bg-hover-gray hover:text-content",
            )}
            style={active ? "color: var(--sidebar-active-text, #fff);" : undefined}
          >
            <span>{t.label}</span>
            {#if count > 0}
              <span
                class={cn(
                  "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold",
                  active ? "bg-accent-foreground/25" : "bg-hover-gray text-content-dim",
                )}
              >
                {count > 99 ? "99+" : count}
              </span>
            {/if}
          </button>
        {/each}
      </div>
    </div>
  </div>

  <!-- Feed -->
  <PullToRefresh scrollClass="min-h-0 flex-1 overflow-y-auto" onRefresh={refreshActivity}>
    <div class="mx-auto w-full max-w-[var(--content-max)] px-6 pb-12">
      {#if entries.length === 0}
        <div class="py-20 text-center">
          <div class="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full bg-raised text-content-muted">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3.5a5.25 5.25 0 0 0-5.25 5.25v2.5c0 1.17-.43 2.3-1.2 3.17l-.94 1.05A1 1 0 0 0 5.35 17h13.3a1 1 0 0 0 .74-1.53l-.94-1.05A4.75 4.75 0 0 1 17.25 11.25V8.75A5.25 5.25 0 0 0 12 3.5Z" stroke-linejoin="round"/>
              <path d="M10 20a2 2 0 0 0 4 0"/>
            </svg>
          </div>
          <p class="text-[14px] font-medium text-content">{emptyCopy}</p>
          <p class="mt-1 text-[12px] text-content-muted">{emptySubCopy}</p>
        </div>
      {:else}
        {#each grouped as group (group.bucket)}
          <section>
            <div
              class="sticky top-0 z-[var(--z-sticky)] bg-surface py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-content-muted"
            >
              {group.bucket}
            </div>
            <div class="flex flex-col gap-1.5">
              {#each group.items as item (item.id)}
                {@const accent = accentColorForType(item.eventType)}
                {@const accessReq = pendingRequestFor(item)}
                <div class="flex flex-col">
                <button
                  type="button"
                  onclick={() => handleClick(item)}
                  class={cn(
                    "group relative w-full cursor-pointer rounded-lg border py-3 pl-5 pr-3 text-left transition-colors hover:bg-hover-gray",
                    item.isRead ? "border-transparent" : "border-edge-dim",
                    accessReq ? "rounded-b-none" : "",
                  )}
                  style={!item.isRead ? "background-color: var(--activity-unread-bg);" : undefined}
                >
                  <!-- Left accent strip — colored by event type, solid for unread, faint for read -->
                  <span
                    aria-hidden="true"
                    class="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full transition-opacity"
                    style="background-color: {accent}; opacity: {item.isRead ? 0 : 1};"
                  ></span>

                  <!-- Header row -->
                  <div class="mb-1.5 flex items-center justify-between gap-2">
                    <div class="flex min-w-0 items-center gap-1.5 truncate text-[12px] text-content-dim">
                      <span class="text-content-dim">{headerLabel(item.eventType)}</span>
                      {#if item.channelName}
                        <span class="inline-flex items-center gap-1 font-semibold text-content">#{item.channelName}</span>
                      {/if}
                    </div>
                    <span class="shrink-0 text-[11px] text-content-muted">{relativeTime(item.createdAt)}</span>
                  </div>

                  <!-- Body: actor avatar + name + preview with @mention highlight -->
                  <div class="flex items-start gap-3 pl-0.5">
                    <div class="mt-0.5 shrink-0">
                      <Avatar
                        name={item.actorName}
                        image={item.actorType === "human" && item.actorId ? authState.getMemberImage(item.actorId) : null}
                        width={34}
                        fontSize={13}
                        borderRadius={6}
                      />
                    </div>
                    <div class="min-w-0 flex-1">
                      <div class="text-[13.5px] font-bold leading-tight text-content">{item.actorName}</div>
                      <div class="mt-1 break-words text-[13.5px] leading-snug text-content">
                        {#each previewParts(item.preview) as part}
                          {#if part.mention}
                            <span
                              class="rounded px-0.5 font-semibold"
                              style="color: var(--activity-mention-text); background-color: var(--activity-mention-bg);"
                            >{part.text}</span>
                          {:else}{part.text}{/if}
                        {/each}
                      </div>
                    </div>
                  </div>
                </button>

                <!-- #705: owner inbox actions — Approve grants the requested
                     scopes server-side (terminal/admin routes through the RCE
                     confirm); Deny dismisses the request. Rendered as a sibling
                     of the row button (never nested) for valid a11y. -->
                {#if accessReq}
                  <div
                    class="flex items-center gap-2 rounded-b-lg border border-t-0 border-edge-dim px-5 py-2.5"
                    style="background-color: var(--activity-unread-bg);"
                  >
                    <span class="mr-auto text-[11px] text-content-dim">
                      {accessReq.scopes.map((s) => SCOPE_META[s].label).join(", ")}
                    </span>
                    <button
                      type="button"
                      disabled={resolvingRequest === accessReq.id}
                      onclick={() =>
                        approve({
                          id: accessReq.id,
                          requesterName: accessReq.requesterName,
                          requesterId: accessReq.requesterId,
                          scopes: accessReq.scopes,
                        })}
                      class="rounded px-3 py-1 text-xs font-medium text-accent-foreground transition-colors bg-accent hover:bg-accent-hover disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={resolvingRequest === accessReq.id}
                      onclick={() => void resolveRequest(workspaceId, accessReq.id, "deny")}
                      class="rounded border border-edge px-3 py-1 text-xs font-medium text-content transition-colors bg-surface-alt hover:bg-hover-gray disabled:opacity-50"
                    >
                      Deny
                    </button>
                  </div>
                {/if}
                </div>
              {/each}
            </div>
          </section>
        {/each}
      {/if}
    </div>
  </PullToRefresh>
{/if}

<!-- Approve-request RCE confirm (#705 + #35): approving a request whose scopes
     include terminal/admin grants a host shell / host control. -->
<ConfirmDialog
  open={!!pendingApproval}
  title={pendingApproval?.scopes.includes("admin")
    ? "Approve admin (full host control)?"
    : "Approve a host shell?"}
  message={pendingApproval
    ? `Approving ${pendingApproval.name}'s request lets them ${pendingApproval.scopes.includes("admin") ? "update/restart this machine and run code on it (RCE)" : "open a shell with access to this machine's files"}. Only approve this for people you trust with that computer.`
    : ""}
  confirmLabel="Approve"
  cancelLabel="Cancel"
  destructive
  onconfirm={() => {
    const a = pendingApproval;
    pendingApproval = null;
    if (a) void resolveRequest(workspaceId, a.id, "approve");
  }}
  oncancel={() => (pendingApproval = null)}
/>
</div>
