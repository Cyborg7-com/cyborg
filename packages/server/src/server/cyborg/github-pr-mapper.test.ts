import { describe, it, expect } from "vitest";
import {
  derivePrState,
  mapPullRequest,
  extractIssueRefs,
  extractTaskKeyRefs,
  groupRank,
  isBackwardBlocked,
  handlePullRequest,
} from "./github-pr-mapper.js";
import type { PgSync, StoredGithubRepoSync, StoredGithubPrStateMapping } from "./db/pg-sync.js";

// The PURE pull_request → PR-state derivation, the PR→task linking refs, and the
// skip_backward phase comparison — plus an end-to-end handlePullRequest over a typed
// fake pg (no live PG). Mirrors github-issue-mapper.test.ts's canned-payload style.

// ── derivePrState ──

describe("derivePrState — pull_request (action, draft, merged) → PR-state token", () => {
  it("opened (non-draft) → MR_OPENED; opened (draft) → DRAFT_MR_OPENED", () => {
    expect(derivePrState("opened", false, false)).toBe("MR_OPENED");
    expect(derivePrState("opened", true, false)).toBe("DRAFT_MR_OPENED");
  });

  it("reopened mirrors opened (draft-aware)", () => {
    expect(derivePrState("reopened", false, false)).toBe("MR_OPENED");
    expect(derivePrState("reopened", true, false)).toBe("DRAFT_MR_OPENED");
  });

  it("ready_for_review → MR_OPENED; converted_to_draft → DRAFT_MR_OPENED", () => {
    expect(derivePrState("ready_for_review", false, false)).toBe("MR_OPENED");
    expect(derivePrState("converted_to_draft", true, false)).toBe("DRAFT_MR_OPENED");
  });

  it("review_requested → MR_REVIEW_REQUESTED", () => {
    expect(derivePrState("review_requested", false, false)).toBe("MR_REVIEW_REQUESTED");
  });

  it("closed → MR_MERGED when merged, else MR_CLOSED", () => {
    expect(derivePrState("closed", false, true)).toBe("MR_MERGED");
    expect(derivePrState("closed", false, false)).toBe("MR_CLOSED");
  });

  it("an unmapped action (synchronize/labeled) → null", () => {
    expect(derivePrState("synchronize", false, false)).toBeNull();
    expect(derivePrState("labeled", false, false)).toBeNull();
  });
});

// ── mapPullRequest ──

function prPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "opened",
    installation: { id: 999 },
    repository: { id: 555, html_url: "https://github.com/acme/app" },
    pull_request: {
      id: 80808080,
      number: 7,
      title: "Fix the Safari login (closes #42)",
      body: "This resolves #42 and references #99.",
      html_url: "https://github.com/acme/app/pull/7",
      draft: false,
      merged: false,
      head: { ref: "fix/ENG-12-safari-login" },
      ...overrides,
    },
  };
}

describe("mapPullRequest — pull_request payload → mapped fields", () => {
  it("maps an opened PR to its number, id, url, branch, title, body, state", () => {
    const m = mapPullRequest(prPayload());
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.prNumber).toBe(7);
    expect(m.githubPrId).toBe("80808080");
    expect(m.prUrl).toBe("https://github.com/acme/app/pull/7");
    expect(m.headRef).toBe("fix/ENG-12-safari-login");
    expect(m.title).toContain("Safari login");
    expect(m.prState).toBe("MR_OPENED");
  });

  it("returns null for a missing pull_request object", () => {
    expect(mapPullRequest({ action: "opened", repository: { id: 1 } })).toBeNull();
  });

  it("returns null for an unmapped action (no state change)", () => {
    expect(mapPullRequest(prPayload())).not.toBeNull();
    const p = prPayload();
    p.action = "synchronize";
    expect(mapPullRequest(p)).toBeNull();
  });

  it("a merged close maps to MR_MERGED", () => {
    const p = prPayload({ merged: true });
    p.action = "closed";
    expect(mapPullRequest(p)?.prState).toBe("MR_MERGED");
  });
});

// ── linking refs ──

describe("extractIssueRefs / extractTaskKeyRefs — PR → task linking references", () => {
  it("pulls every #N from title + body + branch, de-duped", () => {
    expect(extractIssueRefs("closes #42", "also #99 and #42", "feature/#7-thing")).toEqual([
      42, 99, 7,
    ]);
  });

  it("ignores text with no issue references", () => {
    expect(extractIssueRefs("no refs here", "")).toEqual([]);
  });

  it("pulls <IDENT>-<N> task keys from a branch, uppercased + de-duped", () => {
    expect(extractTaskKeyRefs("fix/eng-12-login")).toEqual([{ identifier: "ENG", sequence: 12 }]);
    expect(extractTaskKeyRefs("ENG-12/ENG-12-dup")).toEqual([{ identifier: "ENG", sequence: 12 }]);
  });

  it("does not treat a long hashy segment as a task key (identifier <= 8 chars)", () => {
    expect(extractTaskKeyRefs("abcdefghijklmno-1")).toEqual([]);
  });
});

// ── skip_backward ──

describe("groupRank / isBackwardBlocked — skip_backward phase comparison", () => {
  it("ranks the canonical phase order", () => {
    expect(groupRank("backlog")).toBeLessThan(groupRank("started"));
    expect(groupRank("started")).toBeLessThan(groupRank("completed"));
    expect(groupRank("unknown")).toBe(-1);
  });

  it("blocks a backward move only when skip_backward is set", () => {
    // started → backlog is backward.
    expect(isBackwardBlocked(true, "started", "backlog")).toBe(true);
    expect(isBackwardBlocked(false, "started", "backlog")).toBe(false);
  });

  it("allows an equal or forward move even with skip_backward", () => {
    expect(isBackwardBlocked(true, "backlog", "completed")).toBe(false); // forward
    expect(isBackwardBlocked(true, "started", "started")).toBe(false); // equal
  });

  it("never blocks when a group is unknown (fail-open move)", () => {
    expect(isBackwardBlocked(true, null, "backlog")).toBe(false);
    expect(isBackwardBlocked(true, "started", "mystery")).toBe(false);
  });
});

// ── handlePullRequest (I/O over a typed fake pg) ──

const BINDING: StoredGithubRepoSync = {
  id: "ghrs_1",
  workspaceId: "ws_1",
  installationId: "999",
  tasksProjectId: "tp_1",
  repoId: "555",
  owner: "acme",
  name: "app",
  repoUrl: "https://github.com/acme/app",
  syncDirection: "inbound",
  issueOpenStateId: null,
  issueClosedStateId: null,
  createdBy: "u_1",
  createdAt: 0,
};

function mapping(
  prState: string,
  taskStateId: string | null,
  skipBackward = false,
): StoredGithubPrStateMapping {
  return {
    id: `ghprm_${prState}`,
    workspaceId: "ws_1",
    tasksProjectId: "tp_1",
    prState,
    taskStateId,
    skipBackward,
    createdBy: "u_1",
    createdAt: 0,
  };
}

interface FakePgState {
  bindings?: StoredGithubRepoSync[];
  mappings?: StoredGithubPrStateMapping[];
  // issueNumber → taskId (the github_issue_syncs resolution for this binding).
  issueToTask?: Record<number, string>;
  // existing PR link (stickiness): prNumber → taskId.
  prToTask?: Record<number, string>;
  // taskId → current state group (for skip_backward).
  taskCurrentGroup?: Record<string, string>;
  // stateId → group (target state group).
  stateGroup?: Record<string, string>;
  // <IDENT>-<seq> → taskId (branch task-key resolution).
  refToTask?: Record<string, string>;
}

interface Recorded {
  moves: Array<{ taskId: string; stateId: string | null | undefined }>;
  prSyncs: Array<{ repoSyncId: string; taskId: string; prNumber: number }>;
}

function makeFakePg(state: FakePgState): { pg: PgSync; recorded: Recorded } {
  const recorded: Recorded = { moves: [], prSyncs: [] };
  const pg = {
    async getRepoSyncsForRepo() {
      return state.bindings ?? [BINDING];
    },
    async getPrStateMappingsForProject() {
      return state.mappings ?? [];
    },
    async getPrSyncByNumber(_repoSyncId: string, prNumber: number) {
      const taskId = state.prToTask?.[prNumber];
      return taskId ? { taskId } : null;
    },
    async getTaskByIssue(_repoSyncId: string, issueNumber: number) {
      const taskId = state.issueToTask?.[issueNumber];
      return taskId ? { syncId: `s_${issueNumber}`, taskId } : null;
    },
    async getTaskIdByRef(_tasksProjectId: string, identifier: string, sequence: number) {
      return state.refToTask?.[`${identifier}-${sequence}`] ?? null;
    },
    async getMoveGroups(taskId: string, targetStateId: string) {
      return {
        currentGroup: state.taskCurrentGroup?.[taskId] ?? null,
        targetGroup: state.stateGroup?.[targetStateId] ?? null,
      };
    },
    async upsertPrSync(opts: { repoSyncId: string; taskId: string; prNumber: number }) {
      recorded.prSyncs.push({
        repoSyncId: opts.repoSyncId,
        taskId: opts.taskId,
        prNumber: opts.prNumber,
      });
    },
    async updateTask(taskId: string, updates: { stateId?: string | null }) {
      recorded.moves.push({ taskId, stateId: updates.stateId });
    },
  } as unknown as PgSync;
  return { pg, recorded };
}

describe("handlePullRequest — move the linked task per the project's PR-state mapping", () => {
  it("links via a #N issue ref and moves the task to the mapped state", async () => {
    const { pg, recorded } = makeFakePg({
      mappings: [mapping("MR_OPENED", "state_inprogress")],
      issueToTask: { 42: "task_a" },
    });
    await handlePullRequest(pg, prPayload());
    expect(recorded.moves).toEqual([{ taskId: "task_a", stateId: "state_inprogress" }]);
    expect(recorded.prSyncs).toEqual([{ repoSyncId: "ghrs_1", taskId: "task_a", prNumber: 7 }]);
  });

  it("links via an existing PR sync (stickiness) when the body has no ref", async () => {
    const p = prPayload({ body: "No references here.", title: "Tidy up", head: { ref: "tidy" } });
    p.action = "closed";
    (p.pull_request as Record<string, unknown>).merged = true;
    const { pg, recorded } = makeFakePg({
      mappings: [mapping("MR_MERGED", "state_done")],
      prToTask: { 7: "task_sticky" },
    });
    await handlePullRequest(pg, p);
    expect(recorded.moves).toEqual([{ taskId: "task_sticky", stateId: "state_done" }]);
  });

  it("links via a <IDENT>-<N> branch task-key when there is no issue ref", async () => {
    const p = prPayload({ title: "no issue ref", body: "", head: { ref: "fix/ENG-12-thing" } });
    const { pg, recorded } = makeFakePg({
      mappings: [mapping("MR_OPENED", "state_inprogress")],
      refToTask: { "ENG-12": "task_keyed" },
    });
    await handlePullRequest(pg, p);
    expect(recorded.moves).toEqual([{ taskId: "task_keyed", stateId: "state_inprogress" }]);
  });

  it("records the PR↔task link but makes NO move when the mapping has no target state", async () => {
    const { pg, recorded } = makeFakePg({
      mappings: [mapping("MR_OPENED", null)],
      issueToTask: { 42: "task_a" },
    });
    await handlePullRequest(pg, prPayload());
    expect(recorded.moves).toEqual([]);
    expect(recorded.prSyncs).toHaveLength(1);
  });

  it("skip_backward BLOCKS a regress to an earlier phase", async () => {
    const { pg, recorded } = makeFakePg({
      mappings: [mapping("MR_OPENED", "state_backlog", true)],
      issueToTask: { 42: "task_a" },
      taskCurrentGroup: { task_a: "started" }, // already started…
      stateGroup: { state_backlog: "backlog" }, // …mapping would regress to backlog.
    });
    await handlePullRequest(pg, prPayload());
    expect(recorded.moves).toEqual([]); // blocked
    expect(recorded.prSyncs).toHaveLength(1); // link still recorded
  });

  it("skip_backward ALLOWS a forward move", async () => {
    const { pg, recorded } = makeFakePg({
      mappings: [mapping("MR_MERGED", "state_done", true)],
      issueToTask: { 42: "task_a" },
      taskCurrentGroup: { task_a: "started" },
      stateGroup: { state_done: "completed" },
    });
    const p = prPayload({ merged: true });
    p.action = "closed";
    await handlePullRequest(pg, p);
    expect(recorded.moves).toEqual([{ taskId: "task_a", stateId: "state_done" }]);
  });

  it("is a no-op when the repo is bound to no project", async () => {
    const { pg, recorded } = makeFakePg({ bindings: [] });
    await handlePullRequest(pg, prPayload());
    expect(recorded.moves).toEqual([]);
    expect(recorded.prSyncs).toEqual([]);
  });

  it("fans out to MULTIPLE bound projects independently", async () => {
    const binding2: StoredGithubRepoSync = { ...BINDING, id: "ghrs_2", tasksProjectId: "tp_2" };
    const { pg, recorded } = makeFakePg({
      bindings: [BINDING, binding2],
      // Both projects map MR_OPENED; the issue resolves to a different task per binding
      // is not modeled here (getTaskByIssue is binding-agnostic in the fake), so both
      // resolve to task_a — the point is both bindings are visited + recorded.
      mappings: [mapping("MR_OPENED", "state_inprogress")],
      issueToTask: { 42: "task_a" },
    });
    await handlePullRequest(pg, prPayload());
    expect(recorded.prSyncs.map((p) => p.repoSyncId).sort()).toEqual(["ghrs_1", "ghrs_2"]);
  });
});
