// Group-DM member-picker rules (#608) — extracted from the dialog so the 2–8
// constraint and the candidate filter are unit-testable without a component.
// Mirrors the server cap (MAX_GROUP_DM_OTHERS = 8 others, the creator implicit).

// The creator is implicit, so the picker selects the OTHER members: at least 1,
// at most 8. (A single other member is technically a 1:1; we still allow it so
// the surface is one flow — the server treats 1 other as a valid group_dm. The
// dialog copy nudges toward 2+.)
export const MIN_GROUP_DM_OTHERS = 1;
export const MAX_GROUP_DM_OTHERS = 8;

// A selection is submittable when it has between MIN and MAX other members.
export function canCreateGroupDm(selectedCount: number): boolean {
  return selectedCount >= MIN_GROUP_DM_OTHERS && selectedCount <= MAX_GROUP_DM_OTHERS;
}

export interface GroupDmCandidate {
  userId: string;
  name: string | null;
  email: string;
  membershipType: "active" | "invited";
}

// Candidate OTHER members for a group DM: active workspace members, excluding
// the creator (self) and anyone already selected, matched against the search.
// Invited (not-yet-active) members are excluded — they can't receive messages.
export function groupDmCandidates(args: {
  members: readonly GroupDmCandidate[];
  selfId: string | undefined;
  selectedIds: ReadonlySet<string>;
  query: string;
}): GroupDmCandidate[] {
  const q = args.query.trim().toLowerCase();
  return args.members
    .filter((m) => m.membershipType === "active")
    .filter((m) => m.userId !== args.selfId)
    .filter((m) => !args.selectedIds.has(m.userId))
    .filter((m) => {
      if (!q) return true;
      return (m.name?.toLowerCase().includes(q) ?? false) || m.email.toLowerCase().includes(q);
    });
}
