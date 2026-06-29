<script lang="ts">
  // The "Sub-work-items" widget of the work-item detail body — our own Svelte 5
  // reimplementation of Plane's sub-issues group (STRUCTURE + UX + colorimetry,
  // NOT a port of Plane's React). It lists the child tasks (every task whose
  // `parentId` is this task), shows a done/total progress RING + fraction in the
  // section header, lets a child open in the peek on click, and exposes an inline
  // "Add sub-work-item" row that creates a child via client.createTask(parentId).
  //
  // Presentation + RPC only: children are read straight from the live
  // workspaceState.tasks array (so a board move / broadcast reflects instantly),
  // and a newly created child lands in that same array via the tasks_changed
  // broadcast — this widget never holds its own copy of the list. Token-only
  // (lib/tasks/ui.ts), so dark + light both resolve with zero raw colors.
  import { client } from "$lib/state/client.js";
  import { workspaceState } from "$lib/state/app.svelte.js";
  import { openTaskDetail } from "$lib/tasks/detailStore.svelte.js";
  import { toast } from "svelte-sonner";
  import Collapsible from "$lib/components/tasks/Collapsible.svelte";
  import StateGroupIcon from "$lib/components/tasks/StateGroupIcon.svelte";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import { taskKey, stateGroupForStatus } from "$lib/tasks/detail.js";
  import { subItemRow, subItemId, subItemTitle, subItemAdd, collapsibleAddBtn } from "$lib/tasks/ui.js";
  import type { Task } from "$lib/core/types.js";
  import { cn } from "$lib/utils.js";

  let { task, workspaceId }: { task: Task; workspaceId: string } = $props();

  // The live children of this task, ordered by their sequence number so the list
  // reads in creation order (matching the board). Read from the shared array, so
  // it tracks broadcasts without a local fetch.
  const subItems = $derived(
    workspaceState.tasks
      .filter((t) => t.parentId === task.id)
      .sort((a, b) => (a.sequenceId ?? 0) - (b.sequenceId ?? 0)),
  );
  const total = $derived(subItems.length);
  const done = $derived(subItems.filter((c) => c.status === "done").length);

  // The progress-ring geometry (SVG circle): radius + circumference drive the
  // dash offset so the accent arc fills the completion ratio. Done/total === 0
  // renders an empty ring (no crash on divide-by-zero).
  const RING_R = 7;
  const RING_C = 2 * Math.PI * RING_R;
  const ringOffset = $derived(total > 0 ? RING_C * (1 - done / total) : RING_C);

  // ── Inline add ─────────────────────────────────────────────────────────────
  // A child is created with parentId set; the relay broadcasts tasks_changed
  // "created", so the new row appears in the list via the shared array. We keep
  // the input optimistic-free (the broadcast is the source of truth) and only
  // guard against an empty/duplicate submit.
  let adding = $state(false);
  let draft = $state("");
  let saving = $state(false);

  async function submit(): Promise<void> {
    const title = draft.trim();
    if (!title || saving) return;
    saving = true;
    try {
      await client.createTask(workspaceId, title, { parentId: task.id });
      draft = "";
      adding = false;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't add the sub-work-item");
    } finally {
      saving = false;
    }
  }
</script>

<Collapsible title="Sub-work items" {done} {total}>
  {#snippet actions()}
    <button
      type="button"
      title="Add sub-work-item"
      aria-label="Add sub-work-item"
      onclick={() => {
        adding = true;
      }}
      class={collapsibleAddBtn}
    >
      <PlusIcon class="size-3.5" />
    </button>
  {/snippet}

  {#snippet children()}
    <div class="flex flex-col">
      {#if total > 0}
        <!-- Done/total ring above the list, mirroring Plane's progress affordance. -->
        <div class="flex items-center gap-2 px-1 py-1 text-[12px] text-content-muted">
          <svg width="18" height="18" viewBox="0 0 18 18" class="-rotate-90" aria-hidden="true">
            <circle cx="9" cy="9" r={RING_R} fill="none" stroke="currentColor" stroke-width="2" class="text-edge" />
            <circle
              cx="9"
              cy="9"
              r={RING_R}
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-dasharray={RING_C}
              stroke-dashoffset={ringOffset}
              class="text-accent transition-[stroke-dashoffset]"
            />
          </svg>
          <span class="tabular-nums">{done} of {total} done</span>
        </div>

        {#each subItems as child (child.id)}
          <button
            type="button"
            onclick={() => openTaskDetail(child.id)}
            class={cn(subItemRow, "w-full text-left")}
          >
            <StateGroupIcon group={stateGroupForStatus(child.status)} size={14} />
            <span class={subItemId}>{taskKey(child.sequenceId, child.id)}</span>
            <span class={subItemTitle}>{child.title}</span>
          </button>
        {/each}
      {:else if !adding}
        <p class="px-1 py-1.5 text-[12px] text-content-muted">No sub-work-items yet.</p>
      {/if}

      <!-- Inline add: a borderless input that commits on Enter, cancels on Escape
           or blur. The "+ Add sub-work-item" affordance reveals it. -->
      {#if adding}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          bind:value={draft}
          autofocus
          placeholder="Sub-work-item title…"
          disabled={saving}
          onkeydown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              adding = false;
              draft = "";
            }
          }}
          onblur={() => {
            if (!draft.trim()) adding = false;
          }}
          class="ml-4 mr-2 mt-1 rounded-[4px] bg-transparent px-1 py-1 text-[13px] text-content outline-none ring-1 ring-accent placeholder:text-content-muted"
        />
      {:else}
        <button type="button" onclick={() => (adding = true)} class={subItemAdd}>
          <PlusIcon class="size-3.5" />
          Add sub-work-item
        </button>
      {/if}
    </div>
  {/snippet}
</Collapsible>
