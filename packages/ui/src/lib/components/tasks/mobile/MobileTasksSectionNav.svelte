<script lang="ts">
  // Tier-2 section strip (WS0 foundation, frozen). Horizontally-scrollable
  // segmented strip under the header. LOCKED DECISION: only Work Items + Pages
  // (matching the desktop TasksTopNav VIEWS) — NO Cycles / Modules / Overview as
  // browse sections. Active = accent underline. Labels are whitespace-nowrap with
  // a token-driven --tab-label-size (never an inline text-[10.5px], Rule 14).
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { cn } from "$lib/utils.js";

  let {
    pagesEnabled = true,
  }: {
    // SEAM: gate the Pages section per project. Defaults true to match the current
    // desktop TasksTopNav (which shows Work items + Pages unconditionally — there
    // is no per-project pagesEnabled flag in the warm projects cache yet). WS5
    // wires the real flag from cyborg:fetch_tasks_projects once confirmed.
    pagesEnabled?: boolean;
  } = $props();

  const wsId = $derived(page.params.id ?? "");
  const projectId = $derived(page.params.projectId ?? "");

  // Active section = the route segment right after the projectId (static segment,
  // not a param). Work Items is the default landing.
  const activeSection = $derived.by(() => {
    if (!projectId) return "work-items";
    const segs = page.url.pathname.split("/").filter(Boolean);
    const i = segs.indexOf(projectId);
    return i >= 0 ? (segs[i + 1] ?? "work-items") : "work-items";
  });

  type SectionKey = "work-items" | "pages";
  const sections = $derived<{ key: SectionKey; label: string }[]>(
    pagesEnabled
      ? [
          { key: "work-items", label: "Work items" },
          { key: "pages", label: "Pages" },
        ]
      : [{ key: "work-items", label: "Work items" }],
  );

  function openSection(key: SectionKey): void {
    if (!wsId || !projectId) return;
    void goto(`/workspace/${wsId}/tasks/${projectId}/${key}`);
  }
</script>

{#if projectId}
  <nav class="flex items-center gap-1 overflow-x-auto px-2 pb-1.5" aria-label="Project sections">
    {#each sections as s (s.key)}
      {@const active = s.key === activeSection}
      <button
        type="button"
        onclick={() => openSection(s.key)}
        aria-current={active ? "page" : undefined}
        class={cn(
          "relative flex shrink-0 items-center whitespace-nowrap px-2.5 py-1.5 font-medium transition-colors focus-ring",
          active
            ? "text-content after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent"
            : "text-content-dim hover:text-content",
        )}
      >
        <span class="sec-label">{s.label}</span>
      </button>
    {/each}
  </nav>
{/if}

<style>
  .sec-label {
    font-size: var(--tab-label-size, 0.8125rem);
    line-height: 1;
  }
</style>
