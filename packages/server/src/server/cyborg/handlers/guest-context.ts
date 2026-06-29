import type { PgSync } from "../db/pg-sync.js";

// Per-message context handed to extracted guest WS handlers. It carries the
// slice of relay-standalone's handleGuestMessage scope each domain needs, so a
// domain module never imports the god-file (no cycle) and stays unit-testable.
// `respond`/`respondError` are the same closures the relay defines per message
// (they carry the request's `requestId`), so behaviour is identical.
export interface GuestHandlerCtx {
  pg: PgSync;
  userId: string;
  workspaceId: string | undefined;
  respond: (responseType: string, data: Record<string, unknown>) => void;
  respondError: (message: string) => void;
}
