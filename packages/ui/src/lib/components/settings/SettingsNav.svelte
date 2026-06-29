<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { shellConfig } from "$lib/core/plugin.svelte.js";
  import { cn } from "$lib/utils.js";
  import type { SettingsTab } from "$lib/core/plugin.svelte.js";

  let { basePath }: { basePath: string } = $props();

  const tabs = $derived(shellConfig.settingsTabs);

  // Desktop dual-pane: group tabs by their `group` label, preserving the config
  // order. Tabs without a group fall under "" (rendered headerless), so a config
  // with no groups at all degrades gracefully to a single flat list.
  const groups = $derived.by(() => {
    const out: { label: string; tabs: SettingsTab[] }[] = [];
    for (const tab of tabs) {
      const label = tab.group ?? "";
      let bucket = out.find((g) => g.label === label);
      if (!bucket) {
        bucket = { label, tabs: [] };
        out.push(bucket);
      }
      bucket.tabs.push(tab);
    }
    return out;
  });

  function isActive(tab: { id: string; href: string }): boolean {
    const path = page.url.pathname;
    if (tab.href === "") {
      return path === basePath || path === basePath + "/";
    }
    return path.startsWith(basePath + tab.href);
  }

  function navigate(href: string) {
    goto(basePath + href);
  }

  const iconPaths: Record<string, string> = {
    general: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
    members: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2",
    providers: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
    backend: "M22 12H2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0zM12 22c1.66 0 3-4.48 3-10S13.66 2 12 2 9 6.48 9 12s1.34 10 3 10z",
    daemon: "",
    about: "",
  };
</script>

{#snippet tabIcon(tab: SettingsTab)}
  <svg class="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    {#if tab.id === "general"}
      <circle cx="12" cy="12" r="3"/>
      <path d={iconPaths.general}/>
    {:else if tab.id === "workspace"}
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
      <line x1="8" y1="21" x2="16" y2="21"/>
      <line x1="12" y1="17" x2="12" y2="21"/>
    {:else if tab.id === "members"}
      <path d={iconPaths.members}/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    {:else if tab.id === "backend"}
      <path d={iconPaths.backend}/>
    {:else if tab.id === "daemon"}
      <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>
      <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
      <line x1="6" y1="6" x2="6.01" y2="6"/>
      <line x1="6" y1="18" x2="6.01" y2="18"/>
    {:else if tab.id === "ai"}
      <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/>
      <path d="M19 15l.7 1.8L21.5 17.5l-1.8.7L19 20l-.7-1.8L16.5 18.5l1.8-.7z"/>
    {:else if tab.id === "providers"}
      <path d={iconPaths.providers}/>
    {:else if tab.id === "integrations"}
      <!-- Integrations = a plug (connect external services like GitHub). -->
      <path d="M12 22v-5"/>
      <path d="M9 8V2"/>
      <path d="M15 8V2"/>
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z"/>
    {:else if tab.id === "mcp"}
      <!-- MCP = pluggable tool/extension servers → puzzle. Was falling through
           to the {:else} info-circle, identical to the About tab. -->
      <path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z"/>
    {:else if tab.id === "notifications"}
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
    {:else if tab.id === "billing"}
      <!-- credit card -->
      <rect x="1" y="4" width="22" height="16" rx="2" ry="2"/>
      <line x1="1" y1="10" x2="23" y2="10"/>
    {:else if tab.id === "logs"}
      <!-- Logs = lined document / activity feed (matches the recovered LogsPane). -->
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="8" y1="13" x2="16" y2="13"/>
      <line x1="8" y1="17" x2="16" y2="17"/>
      <line x1="8" y1="9" x2="10" y2="9"/>
    {:else if tab.id === "about"}
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="16" x2="12" y2="12"/>
      <line x1="12" y1="8" x2="12.01" y2="8"/>
    {:else}
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="16" x2="12" y2="12"/>
      <line x1="12" y1="8" x2="12.01" y2="8"/>
    {/if}
  </svg>
{/snippet}

{#snippet tabButton(tab: SettingsTab)}
  <button
    onclick={() => navigate(tab.href)}
    class={cn(
      "touch-target-row flex w-full shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors",
      isActive(tab)
        ? "bg-[var(--sidebar-active)] text-[var(--sidebar-active-text)] font-medium"
        : "text-sidebar-gray hover:bg-[var(--sidebar-hover)]",
    )}
    aria-current={isActive(tab) ? "page" : undefined}
  >
    {@render tabIcon(tab)}
    <span>{tab.label}</span>
  </button>
{/snippet}

<!-- Desktop-only fixed-width vertical sidebar. The settings layout does not
     render this on mobile (S8): phones get the iOS Settings root list
     (settings/+page.svelte) + per-sub-page header bar instead of the old
     horizontal tab strip. -->
<div
  class="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-edge bg-sidebar-bg"
  style="scrollbar-width: none;"
>
  <div class="px-4 py-3 border-b border-edge">
    <span class="text-sm font-bold text-content">Settings</span>
  </div>

  <!-- Grouped dual-pane nav with category headers. -->
  <nav class="flex flex-1 flex-col gap-0 p-2">
    {#each groups as g, gi (g.label || gi)}
      {#if g.label}
        <div class={cn("px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-content-muted", gi > 0 && "pt-3")}>
          {g.label}
        </div>
      {/if}
      <div class="flex flex-col gap-0 space-y-0.5">
        {#each g.tabs as tab (tab.id)}
          {@render tabButton(tab)}
        {/each}
      </div>
    {/each}
  </nav>
</div>
