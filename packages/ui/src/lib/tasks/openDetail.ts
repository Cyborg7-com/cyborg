// Single shared entry point for opening a task's detail (WS0 foundation, frozen).
//
//   • Mobile  → push the full-screen detail ROUTE (/tasks/item/<id>). We record
//     the list we're opening FROM (navOrigin) so the swipeBack `case "tasks"` and
//     the header back button return to that exact list (e.g. the project's
//     work-items board), not a hard-coded parent.
//   • Desktop → the existing in-board peek (detailStore.openTaskDetail).
//
// Every task open in the mobile module MUST go through this so the route-vs-peek
// decision lives in one place. The current workspace id is read from
// workspaceState.current (the only workspace whose tasks are in state).

import { goto } from "$app/navigation";
import { viewportState } from "$lib/state/viewport.svelte.js";
import { workspaceState } from "$lib/state/app.svelte.js";
import { openTaskDetail } from "$lib/tasks/detailStore.svelte.js";
import { setNavOrigin } from "$lib/mobile/navOrigin.js";

export function openTaskDetailMobileAware(taskId: string): void {
  if (!taskId) return;
  if (viewportState.isMobile) {
    const wsId = workspaceState.current?.id;
    if (!wsId) return;
    if (typeof window !== "undefined") {
      setNavOrigin(window.location.pathname + window.location.search);
    }
    void goto(`/workspace/${wsId}/tasks/item/${taskId}`);
    return;
  }
  openTaskDetail(taskId);
}
