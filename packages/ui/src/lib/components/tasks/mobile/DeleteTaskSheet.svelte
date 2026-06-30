<script lang="ts">
  // WS3 (final) — destructive delete confirm. LOCKED PLAN DECISION: destructive
  // confirms stay CENTERED DIALOGS even on mobile (NOT a bottom sheet), so this
  // delegates to the shared DeleteTaskDialog, which is exactly that centered card.
  // Flow: confirm → client.deleteTask → the cyborg:tasks_changed "deleted"
  // broadcast removes the row from workspaceState.tasks → onDeleted fires (the
  // detail screen uses it to pop back to the originating list). No extra mobile
  // chrome is correct here: the body IS the dialog. Prop contract is frozen.
  import DeleteTaskDialog from "$lib/components/tasks/DeleteTaskDialog.svelte";
  import type { Task } from "$lib/core/types.js";

  let {
    open = $bindable(false),
    workspaceId,
    task,
    onDeleted,
  }: {
    open?: boolean;
    workspaceId: string;
    task: Task;
    onDeleted?: () => void;
  } = $props();
</script>

<DeleteTaskDialog bind:open {workspaceId} {task} {onDeleted} />
