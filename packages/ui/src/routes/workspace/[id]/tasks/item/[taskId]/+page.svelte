<script lang="ts">
  // Deep-link / standalone view of a single task. The in-board flow opens the
  // editable card as a "peek" modal (see TaskDetailDialog), so this route is for
  // direct URLs and the back button. It reuses the SAME editable <TaskDetailCard>
  // but frames it as a calm, constrained card (max-w-2xl) centered in the pane,
  // not a full-bleed page.
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import Toolbar from "$lib/components/Toolbar.svelte";
  import TaskDetailCard from "$lib/components/tasks/TaskDetailCard.svelte";

  const taskId = $derived(page.params.taskId ?? "");
  const wsId = $derived(page.params.id ?? "");

  function back(): void {
    void goto(`/workspace/${wsId}/tasks`);
  }
</script>

<div class="flex h-full flex-col overflow-hidden bg-surface">
  <header class="flex items-center gap-3 border-b border-edge px-4 py-2.5">
    <button
      onclick={back}
      class="rounded-lg p-1 transition-colors hover:bg-hover-gray"
      aria-label="Back to tasks"
    >
      <svg class="h-5 w-5 text-content-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M19 12H5" /><polyline points="12 19 5 12 12 5" />
      </svg>
    </button>
    <h2 class="truncate text-sm font-semibold text-content">Task</h2>
    <div class="ml-auto flex items-center gap-2">
      <Toolbar />
    </div>
  </header>

  <div class="flex-1 overflow-y-auto px-4 py-6">
    <div class="mx-auto w-full max-w-2xl rounded-lg border border-edge bg-surface-alt p-5">
      <TaskDetailCard {taskId} workspaceId={wsId} onclose={back} />
    </div>
  </div>
</div>
