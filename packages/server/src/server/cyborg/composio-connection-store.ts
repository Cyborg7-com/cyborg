// Storage for Composio connected-account references (the IDENTITY half of the
// ownership model in composio-types.ts). A connection is a per-(workspace, owner,
// toolkit) pointer to an OAuth'd account that lives in Composio's vault — we persist
// only the `connectedAccountId` reference + status, NEVER any tokens. One connection
// per owner+toolkit is enforced by upsert (replace-on-conflict).

import { and, eq } from "drizzle-orm";
import type { ComposioConnection, ConnectionOwnerKind } from "./composio-types.js";
import type { getDb } from "./db/connection.js";
import { composioConnections } from "./db/schema.js";

// The Drizzle handle the daemon's PG connection factory (getDb) produces. Typed
// off getDb so the store accepts the real schema-typed db without an `any` cast —
// it only ever issues explicit-table queries, so the schema generic is irrelevant.
type DaemonDb = ReturnType<typeof getDb>;

export interface ComposioConnectionQuery {
  workspaceId: string;
  ownerKind: ConnectionOwnerKind;
  ownerId: string;
  toolkit: string;
}

export interface ComposioConnectionListQuery {
  workspaceId: string;
  ownerKind?: ConnectionOwnerKind;
  ownerId?: string;
}

export interface ComposioConnectionStore {
  // The one connection for this exact owner+toolkit, or null.
  get(query: ComposioConnectionQuery): Promise<ComposioConnection | null>;
  // All connections in a workspace, optionally narrowed by ownerKind/ownerId.
  list(query: ComposioConnectionListQuery): Promise<ComposioConnection[]>;
  // Insert or replace the connection for its (workspace, owner, toolkit) key.
  upsert(connection: ComposioConnection): Promise<void>;
  // Delete the connection for this owner+toolkit (no-op if absent).
  remove(query: ComposioConnectionQuery): Promise<void>;
  // True iff there is a connection AND its status is 'active'.
  hasActive(query: ComposioConnectionQuery): Promise<boolean>;
}

// Build the unique key for a (workspace, owner, toolkit) tuple.
function connectionKey(query: ComposioConnectionQuery): string {
  return JSON.stringify([query.workspaceId, query.ownerKind, query.ownerId, query.toolkit]);
}

// In-memory store — used by tests and as a building block (e.g. a solo daemon
// without PG). Keyed by the unique (workspace, owner, toolkit) tuple, so upsert
// naturally replaces an existing connection for the same identity+toolkit.
export class InMemoryComposioConnectionStore implements ComposioConnectionStore {
  private readonly byKey = new Map<string, ComposioConnection>();

  async get(query: ComposioConnectionQuery): Promise<ComposioConnection | null> {
    return this.byKey.get(connectionKey(query)) ?? null;
  }

  async list(query: ComposioConnectionListQuery): Promise<ComposioConnection[]> {
    const result: ComposioConnection[] = [];
    for (const conn of this.byKey.values()) {
      if (conn.workspaceId !== query.workspaceId) continue;
      if (query.ownerKind !== undefined && conn.ownerKind !== query.ownerKind) continue;
      if (query.ownerId !== undefined && conn.ownerId !== query.ownerId) continue;
      result.push(conn);
    }
    return result;
  }

  async upsert(connection: ComposioConnection): Promise<void> {
    this.byKey.set(connectionKey(connection), connection);
  }

  async remove(query: ComposioConnectionQuery): Promise<void> {
    this.byKey.delete(connectionKey(query));
  }

  async hasActive(query: ComposioConnectionQuery): Promise<boolean> {
    const conn = await this.get(query);
    return conn !== null && conn.status === "active";
  }
}

// Map a DB row to the domain `ComposioConnection`.
function rowToConnection(row: typeof composioConnections.$inferSelect): ComposioConnection {
  return {
    workspaceId: row.workspaceId,
    ownerKind: row.ownerKind as ConnectionOwnerKind,
    ownerId: row.ownerId,
    toolkit: row.toolkit,
    connectedAccountId: row.connectedAccountId,
    status: row.status as ComposioConnection["status"],
    createdAt: row.createdAt,
  };
}

// PostgreSQL-backed store against the `composio_connections` table. Mirrors the
// Drizzle query idiom in pg-sync.ts (eq/and filters, onConflictDoUpdate upsert).
export class DrizzleComposioConnectionStore implements ComposioConnectionStore {
  constructor(private readonly db: DaemonDb) {}

  async get(query: ComposioConnectionQuery): Promise<ComposioConnection | null> {
    const [row] = await this.db
      .select()
      .from(composioConnections)
      .where(
        and(
          eq(composioConnections.workspaceId, query.workspaceId),
          eq(composioConnections.ownerKind, query.ownerKind),
          eq(composioConnections.ownerId, query.ownerId),
          eq(composioConnections.toolkit, query.toolkit),
        ),
      )
      .limit(1);
    return row ? rowToConnection(row) : null;
  }

  async list(query: ComposioConnectionListQuery): Promise<ComposioConnection[]> {
    const filters = [eq(composioConnections.workspaceId, query.workspaceId)];
    if (query.ownerKind !== undefined) {
      filters.push(eq(composioConnections.ownerKind, query.ownerKind));
    }
    if (query.ownerId !== undefined) {
      filters.push(eq(composioConnections.ownerId, query.ownerId));
    }
    const rows = await this.db
      .select()
      .from(composioConnections)
      .where(and(...filters));
    return rows.map(rowToConnection);
  }

  async upsert(connection: ComposioConnection): Promise<void> {
    const now = Date.now();
    await this.db
      .insert(composioConnections)
      .values({
        id: `${connection.workspaceId}:${connection.ownerKind}:${connection.ownerId}:${connection.toolkit}`,
        workspaceId: connection.workspaceId,
        ownerKind: connection.ownerKind,
        ownerId: connection.ownerId,
        toolkit: connection.toolkit,
        connectedAccountId: connection.connectedAccountId,
        status: connection.status,
        createdAt: connection.createdAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          composioConnections.workspaceId,
          composioConnections.ownerKind,
          composioConnections.ownerId,
          composioConnections.toolkit,
        ],
        set: {
          connectedAccountId: connection.connectedAccountId,
          status: connection.status,
          updatedAt: now,
        },
      });
  }

  async remove(query: ComposioConnectionQuery): Promise<void> {
    await this.db
      .delete(composioConnections)
      .where(
        and(
          eq(composioConnections.workspaceId, query.workspaceId),
          eq(composioConnections.ownerKind, query.ownerKind),
          eq(composioConnections.ownerId, query.ownerId),
          eq(composioConnections.toolkit, query.toolkit),
        ),
      );
  }

  async hasActive(query: ComposioConnectionQuery): Promise<boolean> {
    const conn = await this.get(query);
    return conn !== null && conn.status === "active";
  }
}
