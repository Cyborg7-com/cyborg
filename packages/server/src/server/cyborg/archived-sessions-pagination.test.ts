import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { CyborgAuth } from "./auth.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { MessageRouter, type BroadcastFn } from "./message-router.js";
import { CyborgDispatcher } from "./dispatcher.js";
import type { CyborgAuthContext } from "./auth.js";
import type { AgentManager } from "../agent/agent-manager.js";
import {
  encodeArchivedSessionCursor,
  decodeArchivedSessionCursor,
  finalizeMergedArchivedPage,
} from "./archived-session-ordering.js";

// PAGINATION regression: the archived-sessions list was unbounded end-to-end
// (server query had no LIMIT, the daemon returned ALL rows, every render site
// `{#each}`-ed the full list). These tests prove the keyset (archived_at DESC,
// id DESC) limit+cursor pagination: a page is capped to `limit`, carries a
// next-cursor, and the next page resumes strictly AFTER it with no gaps/dups —
// and that omitting the limit keeps the legacy full-list behavior.

interface DaemonArchivedResponse {
  sessions: Array<{ id: string; archivedAt: number }>;
  nextCursor: string | null;
}

// Faithfully mirrors relay-standalone.ts finalizeArchivedList for N daemon
// responses: dedup by id, OR the per-daemon nextCursors into daemonHasMore, sort
// newest-first, then run the SAME pure paginator the relay uses. Lets us
// regression-test the relay fan-out (esp. the single-daemon path the WS server
// makes awkward to stand up) without a live relay.
function simulateRelayFinalize(
  responses: DaemonArchivedResponse[],
  limit?: number,
): { sessions: Array<{ id: string; archivedAt: number }>; nextCursor: string | null } {
  const map = new Map<string, { id: string; archivedAt: number }>();
  let daemonHasMore = false;
  for (const r of responses) {
    for (const s of r.sessions) if (!map.has(s.id)) map.set(s.id, s);
    if (typeof r.nextCursor === "string" && r.nextCursor.length > 0) daemonHasMore = true;
  }
  const rows = [...map.values()].sort((a, b) => {
    if (b.archivedAt !== a.archivedAt) return b.archivedAt - a.archivedAt;
    if (b.id < a.id) return -1;
    if (b.id > a.id) return 1;
    return 0;
  });
  return finalizeMergedArchivedPage(rows, { limit, daemonHasMore });
}

describe("archived-session cursor codec", () => {
  it("round-trips a row and rejects garbage as 'first page'", () => {
    const token = encodeArchivedSessionCursor({ archivedAt: 1717000000000, id: "as_xyz" });
    expect(decodeArchivedSessionCursor(token)).toEqual({
      archivedAt: 1717000000000,
      id: "as_xyz",
    });
    expect(decodeArchivedSessionCursor(undefined)).toBeUndefined();
    expect(decodeArchivedSessionCursor("not-base64-json")).toBeUndefined();
    // A token that decodes to JSON but with the wrong shape degrades to undefined.
    expect(
      decodeArchivedSessionCursor(Buffer.from('{"x":1}').toString("base64url")),
    ).toBeUndefined();
  });
});

describe("CyborgStorage.getArchivedSessionsPage (keyset pagination)", () => {
  let storage: CyborgStorage;
  let workspaceId: string;

  beforeEach(() => {
    storage = new CyborgStorage(":memory:");
    storage.upsertUser("owner@test.com", "Owner");
    const owner = storage.getUserByEmail("owner@test.com");
    if (!owner) throw new Error("no owner");
    workspaceId = storage.createWorkspace("Page WS", owner.id).id;
  });

  afterEach(() => {
    storage.close();
  });

  function seed(n: number): void {
    for (let i = 0; i < n; i++) {
      storage.archiveSession({
        workspaceId,
        provider: "claude",
        providerHandleId: `h-${i}`,
        title: `Chat ${i}`,
        model: "sonnet",
      });
    }
  }

  // Ground truth: the full list under the SAME (archived_at DESC, id DESC) order
  // the paged query uses, so page concatenation can be compared deterministically
  // even when rows share an archived_at millisecond.
  function fullOrder(): string[] {
    return storage.getArchivedSessionsPage(workspaceId).sessions.map((r) => r.id);
  }

  it("no limit ⇒ the full list and a null cursor (back-compat)", () => {
    seed(5);
    const page = storage.getArchivedSessionsPage(workspaceId);
    expect(page.sessions.length).toBe(5);
    expect(page.nextCursor).toBeNull();
  });

  it("caps each page to `limit` and returns a next-cursor until the tail", () => {
    seed(7);
    const expected = fullOrder();
    expect(expected.length).toBe(7);

    const collected: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    // Walk pages of 3: expect sizes 3, 3, 1 with a cursor on the first two only.
    for (;;) {
      const page = storage.getArchivedSessionsPage(workspaceId, { limit: 3, cursor });
      pages++;
      expect(page.sessions.length).toBeLessThanOrEqual(3);
      collected.push(...page.sessions.map((r) => r.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      if (pages > 10) throw new Error("pagination did not terminate");
    }

    expect(pages).toBe(3);
    // Full coverage, in order, with NO duplicates and NO gaps.
    expect(collected).toEqual(expected);
    expect(new Set(collected).size).toBe(collected.length);
  });

  it("a full final page still reports no further cursor", () => {
    seed(6);
    const first = storage.getArchivedSessionsPage(workspaceId, { limit: 3 });
    expect(first.sessions.length).toBe(3);
    expect(first.nextCursor).not.toBeNull();
    const second = storage.getArchivedSessionsPage(workspaceId, {
      limit: 3,
      cursor: first.nextCursor!,
    });
    expect(second.sessions.length).toBe(3);
    // Exactly 6 rows ⇒ the second page is the tail, no third page.
    expect(second.nextCursor).toBeNull();
  });

  it("a stale/garbage cursor degrades to the first page (never throws)", () => {
    seed(4);
    const page = storage.getArchivedSessionsPage(workspaceId, { limit: 2, cursor: "garbage" });
    expect(page.sessions.length).toBe(2);
    expect(page.sessions.map((r) => r.id)).toEqual(fullOrder().slice(0, 2));
  });
});

interface Emitted {
  type: string;
  payload: Record<string, unknown>;
}

interface ArchivedListPayload {
  sessions: Array<{ id: string }>;
  nextCursor?: string | null;
}

describe("cyborg:list_archived_sessions honors limit + cursor (dispatcher)", () => {
  let storage: DualStorage;
  let auth: CyborgAuth;
  let dispatcher: CyborgDispatcher;
  let tmpDir: string;
  let owner: CyborgAuthContext;
  let workspaceId: string;

  async function dispatch(msg: Record<string, unknown>): Promise<Emitted[]> {
    const out: Emitted[] = [];
    await dispatcher.dispatch(msg as never, owner, (m) => out.push(m as Emitted));
    return out;
  }

  async function listPage(opts?: {
    limit?: number;
    cursor?: string;
  }): Promise<ArchivedListPayload> {
    const out = await dispatch({
      type: "cyborg:list_archived_sessions",
      requestId: `list-${Math.random()}`,
      workspaceId,
      ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts?.cursor ? { cursor: opts.cursor } : {}),
    });
    const resp = out.find((m) => m.type === "cyborg:list_archived_sessions_response");
    if (!resp) throw new Error("no list response");
    return resp.payload as unknown as ArchivedListPayload;
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cyborg7-arch-page-"));
    storage = new DualStorage(new CyborgStorage(path.join(tmpDir, "test.db")), null);
    auth = new CyborgAuth(storage);
    const workspaceManager = new WorkspaceManager(storage);
    const broadcast: BroadcastFn = { toWorkspace() {}, toUser() {} };
    const messageRouter = new MessageRouter(storage, workspaceManager, broadcast);
    dispatcher = new CyborgDispatcher(messageRouter, workspaceManager, storage);
    dispatcher.setAgentManager({
      getAgent: () => undefined,
      archiveAgent: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentManager);

    owner = auth.validateToken(auth.createToken("owner@test.com", "Owner"))!;
    const ws = await dispatch({
      type: "cyborg:create_workspace",
      name: "Arch Page WS",
      requestId: "w1",
    });
    workspaceId = (ws[0].payload.workspace as { id: string }).id;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seed(n: number): void {
    for (let i = 0; i < n; i++) {
      storage.archiveSession({
        workspaceId,
        provider: "claude",
        providerHandleId: `h-${i}`,
        title: `Chat ${i}`,
        model: "sonnet",
      });
    }
  }

  it("no limit ⇒ full list + null cursor (back-compat for old clients)", async () => {
    seed(5);
    const page = await listPage();
    expect(page.sessions.length).toBe(5);
    expect(page.nextCursor ?? null).toBeNull();
  });

  it("returns the page + a next-cursor, and the next page continues correctly", async () => {
    seed(7);
    // Full ordered ids via one unbounded fetch (server's own order).
    const all = (await listPage()).sessions.map((s) => s.id);
    expect(all.length).toBe(7);

    const first = await listPage({ limit: 4 });
    expect(first.sessions.length).toBe(4);
    expect(first.nextCursor).toBeTruthy();

    const second = await listPage({ limit: 4, cursor: first.nextCursor! });
    // 3 remaining ⇒ short tail page, no further cursor.
    expect(second.sessions.length).toBe(3);
    expect(second.nextCursor ?? null).toBeNull();

    const paged = [...first.sessions, ...second.sessions].map((s) => s.id);
    expect(paged).toEqual(all);
    expect(new Set(paged).size).toBe(7);
  });

  it("pagination still terminates and covers all VISIBLE rows when one is hidden (resumed)", async () => {
    seed(5);
    // Hide the newest by resuming it into a live agent (binding present ⇒ active,
    // not history). nextCursor is keyed off the RAW page, so paging still advances.
    const newest = storage.getArchivedSessionsPage(workspaceId).sessions[0];
    storage.markArchivedSessionResumed(newest.id, "agent-live");
    storage.createAgentBinding({
      agentId: "agent-live",
      workspaceId,
      provider: "claude",
      model: "sonnet",
      initiatedBy: owner.user.id,
    });

    const collected: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const page = await listPage({ limit: 2, cursor });
      collected.push(...page.sessions.map((s) => s.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      if (++guard > 10) throw new Error("pagination did not terminate");
    }
    // The 4 still-archived rows are all reachable; the resumed one is excluded.
    expect(collected).not.toContain(newest.id);
    expect(new Set(collected).size).toBe(4);
  });

  // REGRESSION (PR #990 review): the cloud single-daemon "Show more" was DEAD.
  // The relay only emitted a cursor when the MERGED stream exceeded the page size,
  // but a lone daemon self-caps its response to `limit`, so the merge is always
  // ≤ limit → cursor permanently null → >limit archived sessions unreachable.
  // Here we drive the REAL daemon (dispatcher) and route its response through the
  // relay merge: the relay must emit a cursor and paging must cover everything.
  it("single-daemon-via-relay paginates (regression: cursor was always null)", async () => {
    seed(7);
    const all = (await listPage()).sessions.map((s) => s.id);
    expect(all.length).toBe(7);

    const collected: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      // The daemon answers limit=3; the relay merges this SINGLE response.
      const daemonResp = await listPage({ limit: 3, cursor });
      const relay = simulateRelayFinalize(
        [{ sessions: daemonResp.sessions, nextCursor: daemonResp.nextCursor ?? null }],
        3,
      );
      expect(relay.sessions.length).toBeLessThanOrEqual(3);
      collected.push(...relay.sessions.map((s) => s.id));
      // First two pages MUST carry a cursor (the bug made this null) — the relay
      // must propagate the daemon's "has more" even though the merge never grows.
      if (!relay.nextCursor) break;
      cursor = relay.nextCursor;
      if (++guard > 10) throw new Error("relay pagination did not terminate");
    }
    expect(guard).toBe(2); // pages of 3 over 7 rows ⇒ two cursors then the tail
    expect(collected).toEqual(all);
    expect(new Set(collected).size).toBe(7);
  });
});

describe("finalizeMergedArchivedPage (relay fan-out cursor)", () => {
  const rows = (n: number, base = 1000): Array<{ id: string; archivedAt: number }> =>
    Array.from({ length: n }, (_, i) => ({ id: `as_${i}`, archivedAt: base - i }));

  it("no limit ⇒ full list + null cursor (legacy)", () => {
    const out = finalizeMergedArchivedPage(rows(5), { daemonHasMore: false });
    expect(out.sessions.length).toBe(5);
    expect(out.nextCursor).toBeNull();
  });

  it("SINGLE daemon full page (merge == limit, daemonHasMore) ⇒ emits a cursor", () => {
    // The exact regression: one daemon self-capped to `limit`, so the merge is
    // NOT > limit, yet there ARE more rows — the cursor must NOT be null.
    const out = finalizeMergedArchivedPage(rows(3), { limit: 3, daemonHasMore: true });
    expect(out.sessions.length).toBe(3);
    expect(out.nextCursor).toBeTruthy();
    // Cursor is the keyset of the last returned row.
    expect(decodeArchivedSessionCursor(out.nextCursor!)).toEqual({
      archivedAt: 998,
      id: "as_2",
    });
  });

  it("SINGLE daemon tail (no daemon cursor, merge ≤ limit) ⇒ null cursor", () => {
    const out = finalizeMergedArchivedPage(rows(2), { limit: 3, daemonHasMore: false });
    expect(out.sessions.length).toBe(2);
    expect(out.nextCursor).toBeNull();
  });

  it("MULTI daemon merge overflow ⇒ caps to limit + cursor off the last kept row", () => {
    const out = finalizeMergedArchivedPage(rows(7), { limit: 4, daemonHasMore: true });
    expect(out.sessions.map((s) => s.id)).toEqual(["as_0", "as_1", "as_2", "as_3"]);
    expect(decodeArchivedSessionCursor(out.nextCursor!)).toEqual({
      archivedAt: 997,
      id: "as_3",
    });
  });

  it("empty merge ⇒ null cursor (no fabricated page)", () => {
    const out = finalizeMergedArchivedPage([], { limit: 3, daemonHasMore: true });
    expect(out.sessions.length).toBe(0);
    expect(out.nextCursor).toBeNull();
  });
});
