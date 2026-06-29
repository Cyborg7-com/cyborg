<script lang="ts">
  // ─── Quick switcher (Cmd/Ctrl-K command palette) ──────────────────
  // Slack/Mattermost-style "jump to" modal: a global Cmd/Ctrl-K opens a search
  // box listing every channel, DM peer, and agent session. Type to fuzzy-filter,
  // Up/Down to move the highlight, Enter to open, Esc to close. Mounted once in
  // the workspace shell so it works from any route. Purely additive — it reuses
  // the existing router + state and adds no backend dependency.
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import {
    workspaceState,
    channelState,
    authState,
    notificationState,
    unreadFlagState,
    cyboState,
  } from "$lib/state/app.svelte.js";
  import { agentDisplayName as sharedAgentDisplayName } from "$lib/agent-display.js";
  import ChannelGlyph from "./channel/ChannelGlyph.svelte";
  import OverlayRoot from "./ui/overlay/OverlayRoot.svelte";
  import { cn, nameToColor, formatShortcut } from "$lib/utils.js";
  import { setNavOrigin } from "$lib/mobile/navOrigin";

  type SwitchTargetKind = "channel" | "groupdm" | "dm" | "agent";

  interface SwitchTarget {
    id: string;
    kind: SwitchTargetKind;
    name: string;
    // Raw target id used for unread/notification lookups + routing.
    targetId: string;
    isPrivate?: boolean;
    image?: string | null;
  }

  let open = $state(false);
  let query = $state("");
  let activeIndex = $state(0);
  let inputEl = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLDivElement | null>(null);

  const wsId = $derived(workspaceState.current?.id ?? page.params.id);

  // The full, unfiltered candidate list (channels → DMs → agents), built fresh
  // from current workspace state each time it's read.
  const allTargets = $derived.by<SwitchTarget[]>(() => {
    const out: SwitchTarget[] = [];
    for (const ch of workspaceState.channels) {
      // #608: a group DM is a hidden group_dm channel — list it as its own
      // "groupdm" target (routes to /channel/ like any channel, but renders with
      // a group glyph), never as a browsable "channel".
      const isGroup = ch.type === "group_dm" || ch.isHidden === true;
      out.push({
        id: `channel:${ch.id}`,
        kind: isGroup ? "groupdm" : "channel",
        name: ch.name,
        targetId: ch.id,
        isPrivate: ch.isPrivate,
      });
    }
    for (const member of workspaceState.members) {
      if (member.userId === authState.user?.id) continue;
      const name = member.name ?? member.email?.split("@")[0] ?? "User";
      out.push({
        id: `dm:${member.userId}`,
        kind: "dm",
        name,
        targetId: member.userId,
        image: authState.getMemberImage(member.userId),
      });
    }
    for (const agent of workspaceState.agents) {
      out.push({
        id: `agent:${agent.agentId}`,
        kind: "agent",
        name: sharedAgentDisplayName(agent, cyboState.list),
        targetId: agent.agentId,
      });
    }
    return out;
  });

  // Subsequence ("fuzzy") match: every char of the query appears in order in the
  // candidate. Scores prefix + word-boundary hits higher so "des" surfaces
  // "design" before "addressee". Returns -1 for no match.
  function fuzzyScore(text: string, q: string): number {
    if (!q) return 0;
    const haystack = text.toLowerCase();
    const needle = q.toLowerCase();
    if (haystack.startsWith(needle)) return 1000 - haystack.length;
    let score = 0;
    let ti = 0;
    let prevMatch = -1;
    for (let qi = 0; qi < needle.length; qi++) {
      const c = needle[qi];
      const found = haystack.indexOf(c, ti);
      if (found === -1) return -1;
      // Reward adjacency and word-boundary matches (after a space / separator).
      if (found === prevMatch + 1) score += 5;
      if (found === 0 || /[\s\-_/.]/.test(haystack[found - 1] ?? "")) score += 8;
      score += 1;
      prevMatch = found;
      ti = found + 1;
    }
    return score;
  }

  const results = $derived.by<SwitchTarget[]>(() => {
    const q = query.trim();
    if (!q) return allTargets.slice(0, 50);
    return allTargets
      .map((t) => ({ t, s: fuzzyScore(t.name, q) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 50)
      .map((x) => x.t);
  });

  // Keep the highlight in-bounds whenever the result set changes.
  $effect(() => {
    results;
    if (activeIndex >= results.length) activeIndex = Math.max(0, results.length - 1);
  });

  function unreadCount(t: SwitchTarget): number {
    if (!wsId) return 0;
    return notificationState.getCount(wsId, t.targetId);
  }

  function isBold(t: SwitchTarget): boolean {
    if (!wsId) return false;
    // Group DMs are channels — bold on the channel unread flag, like channels.
    if (t.kind === "channel" || t.kind === "groupdm") {
      return unreadFlagState.isUnread(wsId, t.targetId);
    }
    return notificationState.getCount(wsId, t.targetId) > 0;
  }

  function openSwitcher(): void {
    query = "";
    activeIndex = 0;
    open = true;
    // Focus after the input mounts.
    queueMicrotask(() => inputEl?.focus());
  }

  function closeSwitcher(): void {
    open = false;
    query = "";
  }

  function select(t: SwitchTarget | undefined): void {
    if (!t || !wsId) return;
    setNavOrigin(page.url.pathname);
    if (t.kind === "channel" || t.kind === "groupdm") {
      // A group DM rides the channel pipeline, so it routes to /channel/ too.
      goto(`/workspace/${wsId}/channel/${t.targetId}`);
    } else if (t.kind === "dm") {
      channelState.activeId = null;
      goto(`/workspace/${wsId}/dm/${t.targetId}`);
    } else {
      channelState.activeId = null;
      goto(`/workspace/${wsId}/agent/${t.targetId}`);
    }
    closeSwitcher();
  }

  function move(delta: number): void {
    if (results.length === 0) return;
    activeIndex = (activeIndex + delta + results.length) % results.length;
    scrollActiveIntoView();
  }

  function scrollActiveIntoView(): void {
    queueMicrotask(() => {
      const node = listEl?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
      node?.scrollIntoView({ block: "nearest" });
    });
  }

  function onInputKeydown(e: KeyboardEvent): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      select(results[activeIndex]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSwitcher();
    }
  }

  // True when focus is in a text field. The composer owns Cmd/Ctrl-K (insert
  // link) while typing, so the global switcher must yield to it there — except
  // when the switcher is already open (its own input is editable, but Cmd/Ctrl-K
  // should still toggle it closed).
  function isEditableTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }

  // Global Cmd/Ctrl-K. Ignore when an existing modifier combo would conflict
  // (Shift/Alt). Toggles the palette open; closes it if already open.
  function onGlobalKeydown(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
      // Don't hijack the composer's Cmd/Ctrl-K (insert link) while the user is
      // typing in a field — unless the switcher is already open (toggle closed).
      if (!open && isEditableTarget(e.target)) return;
      e.preventDefault();
      if (open) closeSwitcher();
      else openSwitcher();
    }
  }

  const modK = formatShortcut("Mod+K");
</script>

<svelte:window onkeydown={onGlobalKeydown} />

{#if open}
  <!-- OverlayRoot supplies the shared chrome: `use:portal` to <body> + the
       `fixed inset-0` scrim that dismisses on click. The scrim is kept at the
       original `rgba(0,0,0,0.5)` (the literal `bg-black/50` used before) so the
       backdrop is byte-identical. Escape stays input-scoped (the search input's
       own keydown), NOT window-level — closeOnEscape is intentionally left off
       so the dismiss semantics are unchanged. role="presentation" keeps the
       dialog role on the inner panel (where it was), not the scrim. -->
  <OverlayRoot
    onClose={closeSwitcher}
    ariaLabel="Quick switcher backdrop"
    role="presentation"
    scrim="rgba(0,0,0,0.5)"
    class="z-[var(--z-command)] flex items-start justify-center px-4 pt-[12vh]"
  >
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Quick switcher"
      class="w-full max-w-[560px] overflow-hidden rounded-xl shadow-2xl"
      style="background-color: var(--dropdown-bg); border: 1px solid var(--dropdown-border);"
      onclick={(e) => e.stopPropagation()}
    >
      <div class="flex items-center gap-2 border-b border-edge-dim px-3.5 py-2.5">
        <svg class="shrink-0 text-content-muted" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
        </svg>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          bind:this={inputEl}
          bind:value={query}
          autofocus
          type="text"
          placeholder="Jump to a channel, person, or agent…"
          aria-label="Search channels, people, and agents"
          class="flex-1 bg-transparent text-[15px] text-content outline-none placeholder:text-content-muted"
          onkeydown={onInputKeydown}
          oninput={() => { activeIndex = 0; }}
        />
        <kbd class="shrink-0 rounded border border-edge-dim px-1.5 py-0.5 text-[11px] font-medium text-content-muted">{modK}</kbd>
      </div>

      <div bind:this={listEl} class="max-h-[50vh] overflow-y-auto py-1.5">
        {#if results.length === 0}
          <div class="px-4 py-8 text-center text-[13px] text-content-muted">
            No matches for "{query}"
          </div>
        {:else}
          {#each results as t, i (t.id)}
            {@const bold = isBold(t)}
            {@const count = unreadCount(t)}
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <div
              role="option"
              aria-selected={i === activeIndex}
              data-index={i}
              onclick={() => select(t)}
              onmousemove={() => { activeIndex = i; }}
              class={cn(
                "mx-1.5 flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[15px]",
                i === activeIndex ? "bg-[var(--dropdown-hover)] text-content" : "text-sidebar-gray",
              )}
            >
              <span class="flex w-5 shrink-0 items-center justify-center text-content-muted">
                {#if t.kind === "channel"}
                  {#if t.isPrivate}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                  {:else}
                    <ChannelGlyph kind="hash" class="w-3.5 h-3.5" />
                  {/if}
                {:else if t.kind === "groupdm"}
                  <!-- #608: multi-person glyph for a group DM. -->
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                {:else if t.kind === "dm"}
                  {#if t.image}
                    <img src={t.image} alt="" class="h-5 w-5 rounded object-cover" />
                  {:else}
                    <span
                      class="flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold text-accent-foreground"
                      style:background-color={nameToColor(t.name)}
                    >{t.name[0]?.toUpperCase() ?? "?"}</span>
                  {/if}
                {:else}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 8V4H8" /><rect width="16" height="12" x="4" y="8" rx="2" /><path d="M2 14h2" /><path d="M20 14h2" /><path d="M15 13v2" /><path d="M9 13v2" />
                  </svg>
                {/if}
              </span>
              <span class={cn("flex-1 truncate text-left", bold && "font-semibold text-white")}>{t.name}</span>
              {#if t.kind === "dm"}
                <span class="shrink-0 text-[11px] uppercase tracking-wide text-content-dim">DM</span>
              {:else if t.kind === "groupdm"}
                <span class="shrink-0 text-[11px] uppercase tracking-wide text-content-dim">Group</span>
              {:else if t.kind === "agent"}
                <span class="shrink-0 text-[11px] uppercase tracking-wide text-content-dim">Agent</span>
              {/if}
              {#if count > 0}
                <span class="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-error px-1 text-[10px] font-bold text-accent-foreground">
                  {count > 99 ? "99+" : count}
                </span>
              {/if}
            </div>
          {/each}
        {/if}
      </div>

      <div class="flex items-center gap-3 border-t border-edge-dim px-3.5 py-2 text-[11px] text-content-muted">
        <span class="flex items-center gap-1"><kbd class="rounded border border-edge-dim px-1 py-0.5">↑</kbd><kbd class="rounded border border-edge-dim px-1 py-0.5">↓</kbd> to navigate</span>
        <span class="flex items-center gap-1"><kbd class="rounded border border-edge-dim px-1 py-0.5">↵</kbd> to open</span>
        <span class="flex items-center gap-1"><kbd class="rounded border border-edge-dim px-1 py-0.5">esc</kbd> to close</span>
      </div>
    </div>
  </OverlayRoot>
{/if}
