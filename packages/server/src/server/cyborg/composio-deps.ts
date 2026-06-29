// Construction point for the OPTIONAL Composio dependency the spawn path consumes
// (knowledge: composio-ownership-and-permissions). Gated entirely on
// COMPOSIO_API_KEY: when it's unset the factory returns `undefined`, so a daemon
// without it is byte-identical — no client is built, no connection store is
// touched, and a cybo's Composio tools simply never mount (spawnCybo treats the
// absent dep as a strict no-op). This is the single place env → deps happens, so
// every spawn call site shares one wiring decision via a memoizing getter.

import {
  type ComposioConnectionStore,
  DrizzleComposioConnectionStore,
  InMemoryComposioConnectionStore,
} from "./composio-connection-store.js";
import { HttpComposioClient } from "./composio.js";
import type { ComposioClient } from "./composio-types.js";
import { getDb } from "./db/connection.js";
import type { DualStorage } from "./dual-storage.js";

// Transport B (consumer router, internal docs): a `ck_…` consumer key + the router
// MCP URL. No daemon client/connection store — Composio's router mediates discovery,
// connection and execution itself, restricting to the toolkits the consumer has an
// ACTIVE connection for (toolkit-level native restriction; see composio-router-client.ts).
export interface ComposioRouterConfig {
  consumerKey: string;
  routerUrl?: string;
}

// Two transports can be wired independently (internal docs). Transport A (Platform
// API) carries a client + connection store for per-action scoped MCP minting;
// transport B (consumer router) carries only the router config and is injected as a
// single MCP server. A daemon may have neither (feature off), one, or both — the
// spawn path prefers the router when present (the decided v1 path).
export interface ComposioDeps {
  // Transport A (COMPOSIO_API_KEY): per-action scoped MCP minting.
  client?: ComposioClient;
  connections?: ComposioConnectionStore;
  // Transport B (COMPOSIO_CONSUMER_KEY / ck_): toolkit-level router injection.
  router?: ComposioRouterConfig;
}

// Build the wired deps from the environment, or `undefined` when the feature is OFF
// (neither COMPOSIO_API_KEY nor COMPOSIO_CONSUMER_KEY set — a daemon without either
// is byte-identical, no client built, no router injected). Transport A's connection
// store is Drizzle-backed whenever PG is present (connected mode) so caller
// connections persist across restarts; a solo daemon (SQLite only) falls back to an
// in-memory store. Transport B needs no store — the router owns connection state.
export function createComposioDeps(storage: DualStorage): ComposioDeps | undefined {
  const apiKey = process.env.COMPOSIO_API_KEY;
  const consumerKey = process.env.COMPOSIO_CONSUMER_KEY;
  if (!apiKey && !consumerKey) return undefined;
  const deps: ComposioDeps = {};
  if (apiKey) {
    deps.client = new HttpComposioClient({ apiKey });
    deps.connections = storage.pg
      ? new DrizzleComposioConnectionStore(getDb())
      : new InMemoryComposioConnectionStore();
  }
  if (consumerKey) {
    deps.router = { consumerKey, routerUrl: process.env.COMPOSIO_ROUTER_URL || undefined };
  }
  return deps;
}
