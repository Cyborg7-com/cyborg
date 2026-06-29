import type { Cybo } from "./types.js";

// In-place roster ops for the create/delete broadcasts (#644). Both mutate the
// array directly (push / splice) so a Svelte 5 `$state` roster proxy reacts
// surgically — only the changed slot re-triggers, no whole-array reassignment
// (same in-place principle as #641's applyCyboUpdate). Both are idempotent: the
// actor (who already refetched/filtered locally) and every other member converge
// without duplicates or errors when the broadcast also reaches the actor.

/** Append a newly-created cybo, skipping if its id is already present. */
export function appendCybo(list: Cybo[], cybo: Cybo): void {
  if (list.some((c) => c.id === cybo.id)) return;
  list.push(cybo);
}

/** Remove a deleted cybo by id; no-op when it isn't in the list. */
export function removeCybo(list: Cybo[], cyboId: string): void {
  const idx = list.findIndex((c) => c.id === cyboId);
  if (idx !== -1) list.splice(idx, 1);
}
