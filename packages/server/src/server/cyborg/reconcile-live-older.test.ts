import Database from "better-sqlite3";
import type { Logger } from "pino";
import { describe, expect, test, vi } from "vitest";
import type {
  AgentTimelineFetchResult,
  AgentTimelineStore,
} from "../agent/agent-timeline-store-types.js";
import { CyborgDispatcher } from "./dispatcher.js";
import { SqliteAgentTimelineStore } from "./sqlite-timeline-store.js";

// reconcileLiveOlder is the best-effort "arm scroll-up" probe the timeline handler
// runs on the LIVE-served-with-items path — a path that otherwise does ZERO durable
// I/O. These tests pin two contracts:
//   M1: a throwing durable store must NOT propagate (it would reach the handler's
//       non-Zod rethrow and HANG the fetch with no response). It degrades to the
//       pre-fix result (hasOlder unchanged) so the in-memory load still succeeds.
//   L3: the probe targets the durable store (which keys by seq, ignoring cursor.epoch
//       and always reporting "committed"), so the armed olderCursor carries the
//       durable epoch — not the live window's per-process randomUUID.

interface ReconcileArgs {
  agentId: string;
  isLive: boolean;
  wantOlder: boolean;
  hasOlder: boolean;
  olderCursor: string | null;
  itemCount: number;
  oldestHeldSeq: number | null;
  epoch: string | null;
}

interface ReconcileResult {
  hasOlder: boolean;
  olderCursor: string | null;
}

// reconcileLiveOlder only reads `this.durableTimelineStore` + `this.logger`, so we can
// invoke it on a bare prototype instance without standing up the whole dispatcher.
interface ReconcileHost {
  durableTimelineStore: AgentTimelineStore | null;
  logger: Logger | null;
  reconcileLiveOlder(args: ReconcileArgs): Promise<ReconcileResult>;
}

function hostWith(store: AgentTimelineStore | null, logger: Logger | null = null): ReconcileHost {
  const host = Object.create(CyborgDispatcher.prototype) as unknown as ReconcileHost;
  host.durableTimelineStore = store;
  host.logger = logger;
  return host;
}

// A live-served read holds the tail; the args mirror what handleFetchAgentTimeline
// passes (hasOlder is the live window's blind `false`).
function liveArgs(overrides: Partial<ReconcileArgs> = {}): ReconcileArgs {
  return {
    agentId: "live1",
    isLive: true,
    wantOlder: false,
    hasOlder: false,
    olderCursor: null,
    itemCount: 10,
    oldestHeldSeq: 451,
    epoch: "live-epoch-uuid",
    ...overrides,
  };
}

async function seededStore(n: number): Promise<SqliteAgentTimelineStore> {
  const s = new SqliteAgentTimelineStore(new Database(":memory:"));
  for (let i = 1; i <= n; i++) {
    await s.appendCommitted("live1", { type: "assistant_message", text: `row ${i}` });
  }
  return s;
}

describe("CyborgDispatcher.reconcileLiveOlder — durable probe guard", () => {
  test("a throwing durable store degrades to the unchanged result (no throw, M1)", async () => {
    class ThrowingStore extends SqliteAgentTimelineStore {
      async fetchCommitted(): Promise<AgentTimelineFetchResult> {
        throw new Error("SQLITE_BUSY: database is locked");
      }
    }
    const warn = vi.fn();
    const host = hostWith(new ThrowingStore(new Database(":memory:")), {
      warn,
    } as unknown as Logger);

    const result = await host.reconcileLiveOlder(liveArgs());

    // Unchanged → scroll-up stays disabled, but the fetch still succeeds.
    expect(result).toEqual({ hasOlder: false, olderCursor: null });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("arms hasOlder with a durable-epoch cursor when older rows exist (L3)", async () => {
    const host = hostWith(await seededStore(500)); // durable holds seq 1..500
    const result = await host.reconcileLiveOlder(liveArgs({ oldestHeldSeq: 451 }));

    expect(result.hasOlder).toBe(true);
    // The cursor targets the durable store, so it carries "committed" — NOT the live
    // window's per-process epoch.
    expect(result.olderCursor).toBe(JSON.stringify({ epoch: "committed", seq: 451 }));
  });

  test("no false-positive at the true floor (nothing older than seq 1)", async () => {
    const host = hostWith(await seededStore(40));
    const result = await host.reconcileLiveOlder(liveArgs({ oldestHeldSeq: 1 }));

    expect(result).toEqual({ hasOlder: false, olderCursor: null });
  });
});
