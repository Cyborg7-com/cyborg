<script lang="ts">
  import { notifPrefsState, setChannelNotificationPref } from "$lib/state/app.svelte.js";

  interface Project {
    id: string;
    name: string;
    color: string;
  }

  interface ChannelLike {
    id: string;
    name: string;
    projectId?: string | null;
  }

  let {
    channel,
    x,
    y,
    projects,
    isFavorite = false,
    onToggleFavorite,
    onEdit,
    onLeave,
    onMoveToProject,
    onDelete,
  }: {
    channel: ChannelLike;
    x: number;
    y: number;
    projects: Project[];
    isFavorite?: boolean;
    onToggleFavorite?: () => void;
    onEdit: () => void;
    onLeave: () => void;
    onMoveToProject: (projectId: string | null) => void;
    onDelete?: () => void;
  } = $props();

  // Per-channel notification preference (server-backed; defaults to
  // 'mentions_only' when unset — see NotificationPrefsState.get).
  const NOTIF_OPTIONS = [
    { value: "all", label: "All messages" },
    { value: "mentions_only", label: "Mentions only" },
    { value: "muted", label: "Muted" },
  ] as const;

  const currentPref = $derived(notifPrefsState.get(channel.id));

  function selectPref(value: "all" | "mentions_only" | "muted") {
    setChannelNotificationPref(channel.id, value);
  }
</script>

<div
  class="channel-context-menu fixed z-[var(--z-context-menu)] w-[var(--panel-slim)] rounded-lg py-1 shadow-2xl"
  style="background-color: var(--dropdown-bg); border: 1px solid var(--dropdown-border); left: {x}px; top: {y}px;"
>
  {#if onToggleFavorite}
    <button
      type="button"
      onclick={onToggleFavorite}
      class="w-full text-left px-3 py-1.5 text-[12px] text-content-dim hover:bg-[var(--dropdown-hover)] hover:text-content transition-colors cursor-pointer flex items-center gap-2"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill={isFavorite ? "currentColor" : "none"} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class={isFavorite ? "text-warning" : ""}>
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
      </svg>
      {isFavorite ? "Remove from favorites" : "Add to favorites"}
    </button>
  {/if}
  <button
    type="button"
    onclick={onEdit}
    class="w-full text-left px-3 py-1.5 text-[12px] text-content-dim hover:bg-[var(--dropdown-hover)] hover:text-content transition-colors cursor-pointer"
  >
    Edit channel
  </button>
  <button
    type="button"
    onclick={onLeave}
    class="w-full text-left px-3 py-1.5 text-[12px] text-content-dim hover:bg-[var(--dropdown-hover)] hover:text-content transition-colors cursor-pointer"
  >
    Leave channel
  </button>

  <!-- Notification preferences -->
  <div style="border-top: 1px solid var(--dropdown-border);" class="mt-1 pt-1">
    <div class="px-3 py-1.5 text-[11px] font-semibold text-content-dim uppercase tracking-wider">
      Notifications
    </div>
    {#each NOTIF_OPTIONS as option (option.value)}
      <button
        type="button"
        onclick={() => selectPref(option.value)}
        class="w-full text-left px-3 py-1.5 text-[12px] hover:bg-[var(--dropdown-hover)] hover:text-content transition-colors cursor-pointer flex items-center gap-2 {currentPref === option.value ? 'text-content font-medium' : 'text-content-dim'}"
      >
        <span class="w-1.5 h-1.5 rounded-full shrink-0 {currentPref === option.value ? 'bg-accent' : 'bg-transparent'}"></span>
        {option.label}
      </button>
    {/each}
  </div>

  <!-- Re-file this channel under a different PROJECT (not a channel). No
       "Unfiled" option — channels always belong to a project. Hidden entirely
       when there's no other project to move to. -->
  {#if projects.some((p) => p.id !== channel.projectId)}
    <div style="border-top: 1px solid var(--dropdown-border);" class="mt-1 pt-1">
      <div class="px-3 py-1.5 text-[11px] font-semibold text-content-dim uppercase tracking-wider">
        Move to project
      </div>
      {#each projects as project (project.id)}
        {#if project.id !== channel.projectId}
          <button
            type="button"
            onclick={() => onMoveToProject(project.id)}
            class="w-full text-left px-3 py-1.5 text-[12px] text-content-dim hover:bg-[var(--dropdown-hover)] hover:text-content transition-colors cursor-pointer flex items-center gap-2"
          >
            <span
              class="shrink-0 inline-flex items-center justify-center font-bold text-[7px]"
              style="width: 14px; height: 14px; border-radius: 3px; background-color: {project.color}; color: #0d0e10;"
            >{project.name[0]?.toUpperCase() ?? "?"}</span>
            <span class="truncate">{project.name}</span>
          </button>
        {/if}
      {/each}
    </div>
  {/if}

  {#if onDelete}
    <!-- Destructive: deletes the channel + its history. Quick affordance (was
         only reachable via Edit → settings before). -->
    <div style="border-top: 1px solid var(--dropdown-border);" class="mt-1 pt-1">
      <button
        type="button"
        onclick={onDelete}
        class="w-full text-left px-3 py-1.5 text-[12px] text-error hover:bg-[var(--dropdown-hover)] transition-colors cursor-pointer"
      >
        Delete channel
      </button>
    </div>
  {/if}
</div>
