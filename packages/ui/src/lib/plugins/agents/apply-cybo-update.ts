import type { Cybo, CyboReadiness } from "./types.js";

// Payload of `cyborg:cybo_updated_broadcast` (#640): the editable display fields
// of a cybo after an edit, broadcast to every workspace member so rosters stop
// going stale until a reload. Mirrors the relay's broadcast shape.
export interface CyboUpdateBroadcast {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  avatar: string | null;
  role: string | null;
  provider: string;
  model: string | null;
  // #636: editing the provider can flip readiness — carry it so the banner
  // updates live alongside the other display fields. Absent on older relays.
  readiness?: CyboReadiness;
}

/**
 * Apply an edit broadcast onto a cybo IN PLACE (#640). Mutates the target's
 * display fields directly so, when `target` is an element of a Svelte 5 `$state`
 * roster proxy, reactivity is surgical — only the changed keys re-trigger,
 * leaving the array reference and sibling cybos untouched. Non-broadcast fields
 * (soul / isDefault / createdAt / id / slug) are preserved.
 */
export function applyCyboUpdate(target: Cybo, u: CyboUpdateBroadcast): void {
  target.name = u.name;
  target.description = u.description;
  target.avatar = u.avatar;
  target.role = u.role;
  target.provider = u.provider;
  target.model = u.model;
  if (u.readiness !== undefined) target.readiness = u.readiness;
}
