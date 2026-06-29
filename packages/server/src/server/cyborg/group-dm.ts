// Group DMs (#608) — shared, side-effect-free helpers used by BOTH routing
// paths (the relay's PG-direct guest switch and the local-daemon dispatcher), so
// the auto-name and the validation rules can't drift between them and are
// unit-testable without a database (mirrors db/pg-sync.ts → parseProviderModel).

// Max OTHER participants in a group DM (9 total including the creator). Mattermost
// uses the same 8-others cap. Keep in sync with CreateGroupDmRequest validation.
export const MAX_GROUP_DM_OTHERS = 8;

export interface GroupDmMember {
  userId: string;
  name: string | null;
  email: string | null;
}

// A member's display name for the auto-generated group-DM title: prefer the
// real name, fall back to the email local-part, then a generic "Someone" so a
// nameless/emailless row never produces an empty segment.
export function groupDmMemberLabel(member: GroupDmMember): string {
  const name = member.name?.trim();
  if (name) return name;
  const email = member.email?.trim();
  if (email) return email.split("@")[0] || email;
  return "Someone";
}

// Auto-name = the members' display names, sorted (case-insensitive, stable),
// comma-joined. Includes the creator so the title reads the same for everyone.
// Deterministic regardless of participant order on the wire.
export function deriveGroupDmName(members: GroupDmMember[]): string {
  return members
    .map(groupDmMemberLabel)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .join(", ");
}

export type ValidateGroupDmResult =
  | { ok: true; participantIds: string[] }
  | { ok: false; error: string };

// Validate a create_group_dm request against the workspace roster. Rules (#608):
//   - at least ONE other participant (a group DM of just yourself is a no-op);
//   - at most MAX_GROUP_DM_OTHERS others (the creator doesn't count);
//   - every participant is a real, distinct workspace member;
//   - the creator is implicit and removed from the others list.
// Returns the de-duped OTHERS list (excludes the creator) on success.
export function validateGroupDmParticipants(args: {
  creatorId: string;
  participants: string[];
  memberIds: Set<string>;
}): ValidateGroupDmResult {
  const { creatorId, participants, memberIds } = args;
  // De-dupe and drop the creator (implicit member) before counting/validating.
  const others = [...new Set(participants)].filter((p) => p !== creatorId);

  if (others.length === 0) {
    return { ok: false, error: "a group DM needs at least one other member" };
  }
  if (others.length > MAX_GROUP_DM_OTHERS) {
    return {
      ok: false,
      error: `a group DM can have at most ${MAX_GROUP_DM_OTHERS} other members`,
    };
  }
  for (const id of others) {
    if (!memberIds.has(id)) {
      return { ok: false, error: "all participants must be members of this workspace" };
    }
  }
  return { ok: true, participantIds: others };
}
