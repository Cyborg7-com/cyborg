// Lightweight liveness RPC (presence auto-heal, Part A).
//
// A `cyborg:ping` is a pure round-trip on an AUTHENTICATED guest socket: the
// relay answers immediately with `cyborg:pong` carrying the same requestId. It
// deliberately does NOT touch Postgres and does NOT require a workspace
// subscription/membership — its only job is to prove the socket is still alive
// so the client can detect a half-open / zombie connection and reconnect.
//
// Kept as a small pure function (no `pg`, no relay closures) so it is trivially
// testable and so the "no database" guarantee is enforced by its signature: it
// has no way to reach Postgres.

export interface PingPongResponse {
  type: "cyborg:pong";
  payload: { requestId?: string };
}

// Build the pong response for a `cyborg:ping`. Echoes back the same requestId
// (may be undefined for a fire-and-forget ping — the client matches on it, so
// pass it through unchanged rather than inventing one).
export function buildPingResponse(requestId: string | undefined): PingPongResponse {
  return { type: "cyborg:pong", payload: { requestId } };
}
