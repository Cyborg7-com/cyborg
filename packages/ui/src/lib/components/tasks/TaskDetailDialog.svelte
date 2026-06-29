<script lang="ts">
  // The in-board "peek": Plane-style issue-peek panel that frames the editable
  // <TaskDetailCard>. Plane lets the peek open in three shapes — a right-side
  // slide-over, a centered modal, or full-screen — and remembers the last choice.
  // The DEFAULT is full-screen: the WIDE work-item layout is the prominent reading
  // experience, with the card body centered into a bounded reading column. A
  // mode-toggle in the peek header reads/writes preferences.tasksPeekMode and
  // applies the matching geometry to the panel.
  // Mounted ONCE by the Tasks page and driven by the shared taskDetail store, so
  // clicking any board card opens this single panel instead of navigating. Closes
  // on Esc / backdrop (Dialog's built-in behavior) and clears the store id on
  // close so the board click can re-open the same task.
  import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
  } from "$lib/components/ui/dialog/index.js";
  import TaskDetailCard from "$lib/components/tasks/TaskDetailCard.svelte";
  import { taskDetail, closeTaskDetail } from "$lib/tasks/detailStore.svelte.js";
  import { preferencesState } from "$lib/state/preferences.svelte.js";
  import type { TasksPeekMode } from "$lib/state/preferences.svelte.js";
  import { cn } from "$lib/utils.js";

  let { workspaceId }: { workspaceId: string } = $props();

  const open = $derived(taskDetail.openId != null);
  // The side/modal/full mode now lives in the card HEADER (it owns the toggle);
  // this shell only reads the persisted choice to re-frame the panel geometry.
  const mode = $derived(preferencesState.tasksPeekMode);

  function onOpenChange(next: boolean): void {
    if (!next) closeTaskDetail();
  }

  // Plane peek geometry: the DialogContent portals to <body> and is positioned
  // `fixed`, so each mode's panel geometry is built here (the ui.ts peekSide is
  // authored for an `absolute` host; the ui.ts peek* tokens describe the same
  // shapes but this surface composes the fixed-position equivalents). All
  // colors/borders/shadow resolve through tokens; only geometry/timing utilities
  // are literal. The default DialogContent transform (centering translate) is
  // overridden per mode.
  const PANEL_BASE = "z-50 m-0 flex flex-col gap-0 overflow-hidden bg-surface p-0 text-content";

  // side  → flush right-edge slide-over (full-width mobile, half desktop)
  // modal → centered card at 5/6 of the viewport
  // full  → fills the whole viewport, no border/radius
  const PANEL_BY_MODE: Record<TasksPeekMode, string> = {
    side:
      "fixed inset-y-0 right-0 left-auto top-0 h-dvh w-full max-w-none translate-x-0 " +
      "translate-y-0 rounded-none border-0 border-l border-edge " +
      "shadow-peek md:w-[64vw] md:max-w-[1200px]",
    modal:
      "fixed left-1/2 top-1/2 h-5/6 w-5/6 max-w-4xl -translate-x-1/2 -translate-y-1/2 " +
      "rounded-lg border border-edge shadow-peek",
    full: "fixed inset-0 h-dvh w-full max-w-none translate-x-0 translate-y-0 rounded-none border-0",
  };

  const peekPanel = $derived(cn(PANEL_BASE, PANEL_BY_MODE[mode]));
</script>

<Dialog {open} onOpenChange={onOpenChange}>
  <DialogContent class={peekPanel} showCloseButton={false}>
    <DialogHeader class="sr-only">
      <DialogTitle>Task detail</DialogTitle>
    </DialogHeader>

    <!-- The card owns its own header (state pill, key, copy-link, subscribe, the
         side/modal/full mode toggle, and the "…" overflow) AND its own reading
         column in the wide/full layout, so full mode drops the horizontal frame
         padding and lets the card center itself. The close affordance stays
         Esc / backdrop. -->
    {#if taskDetail.openId}
      <div class={cn("flex-1 overflow-hidden py-4", mode === "full" ? "px-0" : "px-4")}>
        <TaskDetailCard taskId={taskDetail.openId} {workspaceId} onclose={closeTaskDetail} />
      </div>
    {/if}
  </DialogContent>
</Dialog>
