// Shared create-task store (WS0 foundation, frozen). openCreateTask(init) opens
// the ONE mounted CreateTaskSheet (mounted once in the tasks layout), seeded with
// the initial field values. Mirrors detailStore.svelte.ts — a single instance, no
// route navigation, props threaded in via this reactive store.
//
// FILENAME NOTE: the WS0 brief names this `openCreate.ts`, but it owns rune
// ($state) reactive state, which Svelte requires to live in a `.svelte.ts`
// module (same convention as the existing detailStore.svelte.ts). Consumers
// import from `$lib/tasks/openCreate.svelte.js`. The exported function name
// (`openCreateTask`) and its signature match the frozen contract exactly.

export interface CreateTaskInit {
  stateId?: string;
  status?: string;
  assigneeId?: string;
  priority?: string;
  dueAt?: number | null;
  projectId?: string;
}

export const createTaskSheet = $state<{ open: boolean; init: CreateTaskInit }>({
  open: false,
  init: {},
});

export function openCreateTask(init: CreateTaskInit = {}): void {
  createTaskSheet.init = init;
  createTaskSheet.open = true;
}

export function closeCreateTask(): void {
  createTaskSheet.open = false;
}
