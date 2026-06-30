<script lang="ts">
  // The sticky-bottom BULK action bar for the Tasks LIST view (faithful to Plane's
  // `sticky bottom-0` bulk toolbar). It appears ONLY while ≥1 row is multi-selected
  // (the selection store gates its render), and offers a "Move to status" dropdown
  // that bulk-updates every selected task's status in ONE round-trip
  // (client.bulkUpdateTasks → the relay's cyborg:bulk_update_tasks handler).
  //
  // OPTIMISTIC PATCH: the selected rows flip status immediately, the RPC reconciles
  // with the server rows it echoes back, and the selection clears. A failure reverts
  // workspaceState.tasks to its pre-edit snapshot and surfaces a toast.
  import { toast } from "svelte-sonner";
  import { client } from "$lib/state/client.js";
  import { workspaceState } from "$lib/state/app.svelte.js";
  import { COLUMNS } from "$lib/tasks/board.js";
  import { clearSelection, selectedCount, selectedIds } from "$lib/tasks/selection.svelte.js";
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
  } from "$lib/components/ui/dropdown-menu/index.js";
  import { controlBtn, orderDirToggle } from "$lib/tasks/ui.js";
  import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
  import XIcon from "@lucide/svelte/icons/x";

  let { workspaceId }: { workspaceId: string } = $props();

  // Local in-flight guard so a second pick can't fire a parallel bulk move while
  // the first is still resolving (the optimistic patch would race the reconcile).
  let busy = $state(false);

  // Bulk-move every selected task to `status`: optimistic patch → RPC → reconcile
  // with the echoed rows → clear selection. Revert + toast on failure.
  async function moveTo(status: string): Promise<void> {
    if (busy) return;
    const ids = selectedIds();
    if (ids.length === 0) return;
    busy = true;
    const idSet = new Set(ids);
    const prev = workspaceState.tasks;
    workspaceState.tasks = workspaceState.tasks.map((t) =>
      idSet.has(t.id) ? { ...t, status } : t,
    );
    try {
      const updated = await client.bulkUpdateTasks(workspaceId, ids, { status });
      const byId = new Map(updated.map((t) => [t.id, t]));
      workspaceState.tasks = workspaceState.tasks.map((t) => byId.get(t.id) ?? t);
      clearSelection();
    } catch (err) {
      workspaceState.tasks = prev; // revert
      toast.error(err instanceof Error ? err.message : "Couldn't move the tasks");
    } finally {
      busy = false;
    }
  }
</script>

{#if selectedCount() > 0}
  <div
    class="sticky bottom-0 z-20 flex shrink-0 items-center justify-center gap-3 border-t border-edge bg-surface-alt px-4 py-2 shadow-[var(--dropdown-shadow)]"
  >
    <span class="text-[13px] text-content">{selectedCount()} selected</span>

    <DropdownMenu>
      <DropdownMenuTrigger
        class={controlBtn}
        disabled={busy}
        aria-label="Move selected work items to status"
      >
        <span>Move to status</span>
        <ChevronDownIcon class="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-44">
        {#each COLUMNS as column (column.key)}
          <DropdownMenuItem class="cursor-pointer" onclick={() => moveTo(column.key)}>
            {column.label}
          </DropdownMenuItem>
        {/each}
      </DropdownMenuContent>
    </DropdownMenu>

    <button type="button" class={orderDirToggle} onclick={() => clearSelection()} aria-label="Clear selection">
      <XIcon class="size-3.5" />
      <span>Clear</span>
    </button>
  </div>
{/if}
