<script lang="ts">
  // Plane's "Delete issue" confirmation modal, ported to our shadcn Dialog. A
  // calm, constrained card that names the task being deleted, warns the action is
  // permanent, and offers a secondary Cancel + a DESTRUCTIVE Delete. On confirm
  // it calls client.deleteTask; the board drops the row live via the
  // cyborg:tasks_changed "deleted" broadcast (no manual refetch here), so we just
  // close on success. While in-flight the Delete button shows "Deleting…" and
  // both buttons disable; on failure the modal stays open and surfaces the error.
  //
  // Visual is composed from $lib/tasks/ui.ts (the single source of the Plane
  // look) — this component only adds stateful classes at the call site. The
  // destructive button uses the app.css `error` token (bg-error / hover
  // bg-error/80, text-accent-foreground) exactly like ConfirmDialog's destructive
  // path; there are no raw color literals, so dark + light both resolve.
  import { client } from "$lib/state/client.js";
  import type { Task } from "$lib/core/types.js";
  import { cn } from "$lib/utils.js";
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
  } from "$lib/components/ui/dialog/index.js";
  import { btnSecondary, modalBody, modalFooter, modalHeader, modalPanel } from "$lib/tasks/ui.js";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";

  let {
    open = $bindable(false),
    workspaceId,
    task,
    onDeleted,
  }: {
    open?: boolean;
    workspaceId: string;
    task: Task;
    // Optional hook for the host (e.g. the peek) to react after a successful
    // delete — the board itself already drops the row via the broadcast, so this
    // is purely for surfaces that need to do more (close a peek, etc.).
    onDeleted?: () => void;
  } = $props();

  let deleting = $state(false);
  let error = $state<string | null>(null);

  // Reset transient state each time the dialog opens so a prior error / spinner
  // never leaks into a fresh confirmation.
  $effect(() => {
    if (!open) return;
    error = null;
    deleting = false;
  });

  async function confirm(): Promise<void> {
    if (deleting) return;
    deleting = true;
    error = null;
    try {
      await client.deleteTask(workspaceId, task.id);
      // The tasks_changed "deleted" broadcast removes the row from the board;
      // just close here and let the host react.
      open = false;
      onDeleted?.();
    } catch (err) {
      error = err instanceof Error ? err.message : "Couldn't delete the task.";
    } finally {
      deleting = false;
    }
  }
</script>

<Dialog bind:open>
  <DialogContent class={cn(modalPanel, "max-w-md p-0 sm:max-w-md")} showCloseButton={false}>
    <!-- Header: title (Plane's "Delete issue") + no close X — Cancel/Delete are the closes. -->
    <div class={modalHeader}>
      <DialogTitle class="flex items-center gap-2 text-[15px] font-semibold text-content">
        <TriangleAlertIcon class="size-4 text-error" />
        Delete task
      </DialogTitle>
    </div>

    <!-- Body: the permanent-action warning, naming the task title. -->
    <div class={modalBody}>
      <DialogDescription class="text-[13px] leading-relaxed text-content-dim">
        Are you sure you want to delete <span class="font-medium text-content">{task.title}</span>?
        This action is permanent and cannot be undone.
      </DialogDescription>

      {#if error}
        <p class="text-[12px] text-error" role="alert">{error}</p>
      {/if}
    </div>

    <!-- Footer: right-aligned Cancel (secondary) + Delete (destructive). -->
    <div class={modalFooter}>
      <button
        type="button"
        class={btnSecondary}
        disabled={deleting}
        onclick={() => {
          open = false;
        }}
      >
        Cancel
      </button>
      <button
        type="button"
        class={cn(
          "inline-flex h-8 items-center rounded-md bg-error px-4 text-[13px] font-medium",
          "text-accent-foreground transition-colors hover:bg-error/80 disabled:opacity-50",
        )}
        disabled={deleting}
        onclick={confirm}
      >
        {deleting ? "Deleting…" : "Delete"}
      </button>
    </div>
  </DialogContent>
</Dialog>
