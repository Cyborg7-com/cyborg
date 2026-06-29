import { describe, it, expect, beforeEach } from "vitest";
import {
  markInbound,
  consumeInbound,
  planOutbound,
  emitTaskOutbound,
  isClosedTaskStatus,
  _resetEchoGuardForTest,
  type GithubIssueWriter,
  type IssuePatch,
  type TaskOutboundChange,
} from "./github-outbound.js";
import type { PgSync, GithubIssueSyncWithRepo } from "./db/pg-sync.js";

// The OUTBOUND write-back: the echo guard (loop prevention), the pure change→action
// plan, and emitTaskOutbound's bidirectional filter + echo suppression + octokit
// patch shape (over an injected writer, no network).

beforeEach(() => _resetEchoGuardForTest());

// ── echo guard ──

describe("echo guard — markInbound / consumeInbound", () => {
  it("consumes a fresh marker exactly once", () => {
    markInbound("task_1", "close");
    expect(consumeInbound("task_1", "close")).toBe(true);
    // A second consume finds nothing (a single inbound suppresses a single outbound).
    expect(consumeInbound("task_1", "close")).toBe(false);
  });

  it("is keyed by (task, action) — an unrelated action is not suppressed", () => {
    markInbound("task_1", "close");
    expect(consumeInbound("task_1", "title")).toBe(false);
    expect(consumeInbound("task_2", "close")).toBe(false);
  });

  it("treats an expired marker as not-recent", () => {
    const t0 = 1_000_000;
    markInbound("task_1", "reopen", t0);
    // 31s later (TTL is 30s) the marker has expired.
    expect(consumeInbound("task_1", "reopen", t0 + 31_000)).toBe(false);
  });
});

// ── planOutbound (pure) ──

function change(o: Partial<TaskOutboundChange>): TaskOutboundChange {
  return {
    taskId: "task_1",
    prevTitle: "T",
    nextTitle: "T",
    prevDescription: "B",
    nextDescription: "B",
    prevCompleted: false,
    nextCompleted: false,
    ...o,
  };
}

describe("planOutbound — a task change → GitHub issue actions", () => {
  it("entering a completed state closes the issue; leaving it reopens", () => {
    expect(planOutbound(change({ prevCompleted: false, nextCompleted: true })).stateAction).toBe(
      "close",
    );
    expect(planOutbound(change({ prevCompleted: true, nextCompleted: false })).stateAction).toBe(
      "reopen",
    );
  });

  it("an in-group state move makes no issue-state change", () => {
    expect(
      planOutbound(change({ prevCompleted: true, nextCompleted: true })).stateAction,
    ).toBeNull();
    expect(
      planOutbound(change({ prevCompleted: false, nextCompleted: false })).stateAction,
    ).toBeNull();
  });

  it("emits title/body only when they actually changed", () => {
    const p = planOutbound(change({ nextTitle: "New", nextDescription: "New body" }));
    expect(p.title).toBe("New");
    expect(p.body).toBe("New body");
    const none = planOutbound(change({}));
    expect(none.title).toBeNull();
    expect(none.body).toBeNull();
  });
});

// ── isClosedTaskStatus (pure) ──

describe("isClosedTaskStatus — which task statuses close the linked issue", () => {
  it("closes for BOTH the completed (done) and cancelled groups", () => {
    expect(isClosedTaskStatus("done")).toBe(true);
    expect(isClosedTaskStatus("cancelled")).toBe(true);
  });

  it("leaves the issue open for pending / in_progress / unknown / null / undefined", () => {
    expect(isClosedTaskStatus("pending")).toBe(false);
    expect(isClosedTaskStatus("in_progress")).toBe(false);
    expect(isClosedTaskStatus("whatever")).toBe(false);
    expect(isClosedTaskStatus(null)).toBe(false);
    expect(isClosedTaskStatus(undefined)).toBe(false);
  });

  it("a cancelled task drives a close action (the wired call-site semantics)", () => {
    // The relay derives prev/nextCompleted via isClosedTaskStatus, so a pending→cancelled
    // move plans a "close" — the regression this guards (cancelled left the issue open).
    const plan = planOutbound(
      change({
        prevCompleted: isClosedTaskStatus("pending"),
        nextCompleted: isClosedTaskStatus("cancelled"),
      }),
    );
    expect(plan.stateAction).toBe("close");
  });

  it("done→cancelled keeps the issue closed (no spurious reopen/close)", () => {
    const plan = planOutbound(
      change({
        prevCompleted: isClosedTaskStatus("done"),
        nextCompleted: isClosedTaskStatus("cancelled"),
      }),
    );
    expect(plan.stateAction).toBeNull();
  });
});

// ── emitTaskOutbound (over a fake pg + injected writer) ──

function makePg(links: GithubIssueSyncWithRepo[]): PgSync {
  return {
    async getIssueSyncsForTaskWithRepo() {
      return links;
    },
  } as unknown as PgSync;
}

function recordingWriter(): { writer: GithubIssueWriter; patches: IssuePatch[] } {
  const patches: IssuePatch[] = [];
  return {
    patches,
    writer: {
      async updateIssue(patch: IssuePatch) {
        patches.push(patch);
      },
    },
  };
}

const BIDI_LINK: GithubIssueSyncWithRepo = {
  repoSyncId: "ghrs_1",
  issueNumber: 42,
  githubIssueId: "200",
  issueUrl: "https://github.com/acme/app/issues/42",
  owner: "acme",
  name: "app",
  installationId: "999",
  syncDirection: "bidirectional",
};

describe("emitTaskOutbound — mirror a task change to the linked GitHub issue", () => {
  it("closes the issue when a bidirectionally-synced task is completed", async () => {
    const { writer, patches } = recordingWriter();
    await emitTaskOutbound(
      makePg([BIDI_LINK]),
      change({ prevCompleted: false, nextCompleted: true }),
      writer,
    );
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      owner: "acme",
      name: "app",
      issueNumber: 42,
      state: "closed",
    });
  });

  it("patches title + body when they changed", async () => {
    const { writer, patches } = recordingWriter();
    await emitTaskOutbound(
      makePg([BIDI_LINK]),
      change({ nextTitle: "New title", nextDescription: "New body" }),
      writer,
    );
    expect(patches[0]).toMatchObject({ title: "New title", body: "New body" });
    expect(patches[0]?.state).toBeUndefined();
  });

  it("does NOTHING for an inbound-only (unidirectional) link", async () => {
    const { writer, patches } = recordingWriter();
    const inbound: GithubIssueSyncWithRepo = { ...BIDI_LINK, syncDirection: "inbound" };
    await emitTaskOutbound(makePg([inbound]), change({ nextCompleted: true }), writer);
    expect(patches).toEqual([]);
  });

  it("SUPPRESSES a change that originated from GitHub (echo guard)", async () => {
    const { writer, patches } = recordingWriter();
    // The inbound receiver marked this exact change as GitHub-originated.
    markInbound("task_1", "close");
    await emitTaskOutbound(
      makePg([BIDI_LINK]),
      change({ prevCompleted: false, nextCompleted: true }),
      writer,
    );
    expect(patches).toEqual([]); // not re-emitted back to GitHub
  });

  it("does nothing when the task has no linked issue", async () => {
    const { writer, patches } = recordingWriter();
    await emitTaskOutbound(makePg([]), change({ nextCompleted: true }), writer);
    expect(patches).toEqual([]);
  });
});
