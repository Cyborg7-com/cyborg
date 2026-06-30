<script lang="ts">
  // WS1 — the mobile "Display" sheet (the phone form of the work-items Display
  // popover). Three sections, mirroring the real web Display menu:
  //   • Group by — Status / Assignee / Priority (the exact set the web Display
  //     menu exposes; the wider facets live only in Filters). Writes the page's
  //     page-local groupBy via onGroupByChange.
  //   • Order by — LOCKED / read-only. The board + server hard-code created-at
  //     order, so mobile shows the active ordering but does not let it change
  //     (changing it is a desktop affordance). Rendered disabled per the brief.
  //   • Display properties — which chips a row renders (Status / Priority /
  //     Assignee / Due date / ID). Writes the device-global preferencesState,
  //     exactly like the desktop Display menu, so the list re-renders live.
  //
  // Exported as a foundation surface: reusable by every Work-Items layout (List
  // here, Board/Agenda/Timeline in their workstreams). Token-only; the picker
  // bodies are plain rows inside this MobileSheet — no portal'd dropdown.
  import MobileSheet from "$lib/components/MobileSheet.svelte";
  import SegmentedControl from "$lib/components/ui/SegmentedControl.svelte";
  import { preferencesState } from "$lib/state/preferences.svelte.js";
  import {
    GROUP_BY_OPTIONS,
    ORDER_BY_OPTIONS,
    DISPLAY_PROPERTY_OPTIONS,
  } from "$lib/tasks/constants.js";
  import { type DisplayKey, type GroupBy } from "$lib/tasks/view.js";
  import CheckIcon from "@lucide/svelte/icons/check";
  import LockIcon from "@lucide/svelte/icons/lock";

  let {
    open = $bindable(false),
    groupBy,
    onGroupByChange,
    onclose,
  }: {
    open?: boolean;
    groupBy: GroupBy;
    onGroupByChange?: (next: GroupBy) => void;
    onclose?: () => void;
  } = $props();

  // The web Display menu's group-by set (status / assignee / priority). We pull
  // those three out of the shared GROUP_BY_OPTIONS so labels never drift.
  const MOBILE_GROUP_KEYS: GroupBy[] = ["status", "assignee", "priority"];
  const groupOptions = $derived(
    MOBILE_GROUP_KEYS.map((k) => {
      const meta = GROUP_BY_OPTIONS.find((o) => o.value === k);
      return { value: k as string, label: meta?.label ?? k };
    }),
  );

  // Ordering + display read reactively off the persisted singleton.
  const orderBy = $derived(preferencesState.tasksOrderBy);
  const display = $derived(preferencesState.tasksDisplay);

  function selectGroup(v: string): void {
    onGroupByChange?.(v as GroupBy);
  }
</script>

<MobileSheet bind:open title="Display" {onclose} ariaLabel="Display options">
  <div class="flex flex-col gap-5 pb-2">
    <!-- GROUP BY -->
    <section class="flex flex-col gap-2">
      <span class="px-1 text-xs font-medium uppercase tracking-wide text-content-muted">Group by</span>
      <SegmentedControl
        options={groupOptions}
        value={groupBy}
        onChange={selectGroup}
        ariaLabel="Group work items by"
      />
    </section>

    <!-- ORDER BY (locked / read-only) -->
    <section class="flex flex-col gap-1">
      <span class="flex items-center gap-1.5 px-1 text-xs font-medium uppercase tracking-wide text-content-muted">
        Order by
        <LockIcon class="size-3" />
      </span>
      <div class="flex flex-col">
        {#each ORDER_BY_OPTIONS as o (o.value)}
          <div
            class="flex w-full items-center gap-3 rounded-[var(--radius-md)] px-2 py-2.5 text-left opacity-60"
            aria-disabled="true"
          >
            <span class="grid size-5 shrink-0 place-items-center text-accent">
              {#if o.value === orderBy}<CheckIcon class="size-4" />{/if}
            </span>
            <span class="min-w-0 flex-1 truncate text-sm text-content">{o.label}</span>
          </div>
        {/each}
      </div>
      <span class="px-2 text-xs text-content-muted">Ordering is fixed to creation order on mobile.</span>
    </section>

    <!-- DISPLAY PROPERTIES -->
    <section class="flex flex-col gap-1">
      <span class="px-1 text-xs font-medium uppercase tracking-wide text-content-muted">Display properties</span>
      <div class="flex flex-col">
        {#each DISPLAY_PROPERTY_OPTIONS as d (d.value)}
          {@const on = display[d.value]}
          <button
            type="button"
            onclick={() => preferencesState.toggleTasksDisplay(d.value as DisplayKey)}
            aria-pressed={on}
            class="touch-target-row pressable-row flex w-full items-center gap-3 rounded-[var(--radius-md)] px-2 py-2.5 text-left"
          >
            <span class="min-w-0 flex-1 truncate text-sm text-content">{d.label}</span>
            <span
              class={[
                "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
                on ? "bg-accent" : "bg-deeper",
              ]}
              aria-hidden="true"
            >
              <span
                class={[
                  "inline-block size-4 rounded-full bg-surface shadow-sm transition-transform",
                  on ? "translate-x-4" : "translate-x-0.5",
                ]}
              ></span>
            </span>
          </button>
        {/each}
      </div>
    </section>
  </div>
</MobileSheet>
