// A short client-generated id for OPTIMISTIC local rows (a posted comment,
// attachment, or link) before the persist RPC exists. `crypto.randomUUID()` is
// only defined in SECURE contexts; the dev app is served over plain HTTP on a
// LAN IP / localhost where `crypto.randomUUID` is undefined, so calling it
// directly throws a TypeError. Guard it and fall back to a timestamp-free random
// token (these ids only need to be unique within the session, never persisted).
export function uid(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2);
}
