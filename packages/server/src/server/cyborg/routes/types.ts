import type { MiddlewareHandler } from "hono";

// Hono per-request variables set by the relay's auth middleware. Shared by every
// extracted route module so their `Context` and `requireAuth` line up with the
// compositor in relay-standalone.ts.
export interface RelayEnv {
  Variables: { userId: string; userEmail: string };
}

// The relay's `requireAuth` middleware, injected into route factories so each
// module stays a pure sub-app (no closure over relay-standalone's scope).
export type RequireAuth = MiddlewareHandler<RelayEnv>;
