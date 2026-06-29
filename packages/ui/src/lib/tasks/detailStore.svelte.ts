// Tiny shared store that decouples "a task card was clicked" from "the detail
// card is shown". The board (owned by another surface) only needs to call
// openTaskDetail(id) from its single click handler; the Tasks page mounts the
// <TaskDetailDialog> once and binds it to this store. This keeps the modal a
// single instance (not one-per-card) and avoids a route navigation for the
// in-board peek, while the /tasks/[taskId] route still works for deep links.
export const taskDetail = $state<{ openId: string | null }>({ openId: null });

export function openTaskDetail(taskId: string): void {
  taskDetail.openId = taskId;
}

export function closeTaskDetail(): void {
  taskDetail.openId = null;
}
