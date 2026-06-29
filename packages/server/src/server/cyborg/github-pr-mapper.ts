// GitHub `pull_request` webhook → task state move (Plane-parity "Pull Request State
// Mapping", Image #3). A PR's lifecycle event derives one of the 6 PR-state tokens;
// the project's github_pr_state_mappings[pr_state] names the task state to move the
// LINKED task into. Mirrors github-issue-mapper.ts: the PURE derivation/linking
// logic is exported + unit-tested; handlePullRequest is the thin I/O receiver the
// webhook dispatch calls.
//
// Linking a PR → task (first match wins, all already project-scoped):
//   1. an existing github_pr_syncs row (stickiness — a `closed`/`merged` event whose
//      body no longer references the issue still moves the same task);
//   2. an issue reference (`#N`, or a closing keyword "closes/fixes/resolves #N") in
//      the title/body/branch, resolved through github_issue_syncs for this binding;
//   3. a task-key reference (`<IDENT>-<N>`, the project's identifier + sequence) in
//      the branch — the Plane-style "branch name contains the work item id".
//
// Best-effort, like every webhook handler: a failure logs + returns; the receiver
// still 2xx-acks so GitHub doesn't retry-storm.

import { randomUUID } from "node:crypto";
import type { PgSync, StoredGithubRepoSync } from "./db/pg-sync.js";

// ── permissive extraction (untrusted JSON; same shape as the sibling mappers) ──

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

// ── PR-state derivation (pure) ──

/** The 6 PR-state tokens the mapping editor maps (plane en/integration.json). */
export type PrStateToken =
  | "DRAFT_MR_OPENED"
  | "MR_OPENED"
  | "MR_REVIEW_REQUESTED"
  | "MR_READY_FOR_MERGE"
  | "MR_MERGED"
  | "MR_CLOSED";

/**
 * The PR-state token a `pull_request` (action, draft, merged) implies, or null for
 * an action that carries no state change we map. PURE.
 *
 * - opened / reopened → DRAFT_MR_OPENED when draft, else MR_OPENED.
 * - ready_for_review (left draft) → MR_OPENED; converted_to_draft → DRAFT_MR_OPENED.
 * - review_requested → MR_REVIEW_REQUESTED.
 * - closed → MR_MERGED when merged, else MR_CLOSED.
 *
 * MR_READY_FOR_MERGE has no direct `pull_request` action trigger (it corresponds to
 * an approving `pull_request_review`, out of scope here) — a mapping row for it is
 * simply never matched by these events.
 */
export function derivePrState(
  action: string,
  draft: boolean,
  merged: boolean,
): PrStateToken | null {
  switch (action) {
    case "opened":
    case "reopened":
      return draft ? "DRAFT_MR_OPENED" : "MR_OPENED";
    case "ready_for_review":
      return "MR_OPENED";
    case "converted_to_draft":
      return "DRAFT_MR_OPENED";
    case "review_requested":
      return "MR_REVIEW_REQUESTED";
    case "closed":
      return merged ? "MR_MERGED" : "MR_CLOSED";
    default:
      return null;
  }
}

/** What a `pull_request` payload maps to, before persistence/linking. NULL when the
 * payload isn't a handled PR event (missing PR/number, or an unmapped action). */
export interface MappedPullRequest {
  action: string;
  prNumber: number;
  githubPrId: string;
  prUrl: string;
  /** head.ref — the source branch, scanned for issue + task-key references. */
  headRef: string;
  title: string;
  body: string;
  prState: PrStateToken;
}

/** Map a raw `pull_request` payload to the fields the receiver needs, or null. PURE. */
export function mapPullRequest(payload: Record<string, unknown>): MappedPullRequest | null {
  const action = asString(payload.action).trim().toLowerCase();
  const pr = obj(payload.pull_request);
  if (!pr) return null;

  const prNumber = num(pr.number);
  if (prNumber === null) return null;

  const draft = pr.draft === true;
  const merged = pr.merged === true;
  const prState = derivePrState(action, draft, merged);
  if (!prState) return null; // an action we don't map (synchronize, labeled, …).

  const githubPrId = num(pr.id) !== null ? String(num(pr.id)) : "";
  const prUrl = asString(pr.html_url).trim();
  const headRef = asString(obj(pr.head)?.ref).trim();
  const title = asString(pr.title).trim();
  const body = asString(pr.body);

  return { action, prNumber, githubPrId, prUrl, headRef, title, body, prState };
}

// ── PR → task linking references (pure) ──

/** An issue reference (`#N`) scanned from PR text. */
export function extractIssueRefs(...texts: string[]): number[] {
  const out = new Set<number>();
  for (const text of texts) {
    // `#<digits>` — catches a bare "#42" and the closing-keyword forms ("closes
    // #42", "fixes #42", "resolves #42"), which all contain "#42".
    const re = /#(\d+)/g;
    let m: RegExpExecArray | null = re.exec(text);
    while (m !== null) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) out.add(n);
      m = re.exec(text);
    }
  }
  return [...out];
}

/** A task-key reference (`<IDENT>-<N>`, the project identifier + sequence number)
 * scanned from a branch name. Identifiers are uppercase, ≤8 chars (tasks_projects
 * convention). Returns {identifier, sequence} pairs. PURE. */
export interface TaskKeyRef {
  identifier: string;
  sequence: number;
}
export function extractTaskKeyRefs(branch: string): TaskKeyRef[] {
  const out: TaskKeyRef[] = [];
  const seen = new Set<string>();
  // Bounded to a 1–8 char uppercase identifier so it can't greedily swallow a long
  // hash-y branch segment. Case-insensitive match, identifier normalized to upper.
  const re = /\b([A-Za-z][A-Za-z0-9]{0,7})-(\d+)\b/g;
  let m: RegExpExecArray | null = re.exec(branch);
  while (m !== null) {
    const identifier = (m[1] ?? "").toUpperCase();
    const sequence = Number(m[2]);
    const key = `${identifier}-${sequence}`;
    if (Number.isFinite(sequence) && sequence > 0 && !seen.has(key)) {
      seen.add(key);
      out.push({ identifier, sequence });
    }
    m = re.exec(branch);
  }
  return out;
}

// ── skip-backward (pure) ──

// The canonical task-state phase order (schema.ts task_states_group_valid). A move's
// "direction" is the rank delta; skip_backward blocks a move to a LOWER rank.
const GROUP_ORDER = ["backlog", "unstarted", "started", "completed", "cancelled"];

/** The phase rank of a task-state group (−1 for an unknown group). PURE. */
export function groupRank(group: string | null): number {
  return group ? GROUP_ORDER.indexOf(group) : -1;
}

/**
 * Should this state move be BLOCKED because skip_backward is set and the target is
 * an earlier phase than the task's current state? PURE. A null/unknown current group
 * never blocks (we can't prove it's backward); an equal-or-forward move is allowed.
 */
export function isBackwardBlocked(
  skipBackward: boolean,
  currentGroup: string | null,
  targetGroup: string | null,
): boolean {
  if (!skipBackward) return false;
  const cur = groupRank(currentGroup);
  const tgt = groupRank(targetGroup);
  if (cur < 0 || tgt < 0) return false; // unknown ranks → don't block (fail-open move).
  return tgt < cur;
}

// ── I/O receiver ──

// Installation id (text) from the PR payload's `installation.id`.
function installationIdOf(payload: Record<string, unknown>): string | null {
  const id = num(obj(payload.installation)?.id);
  return id !== null ? String(id) : null;
}

// The PR's repo numeric id (text), the binding lookup key.
function repoIdOf(payload: Record<string, unknown>): string | null {
  const id = num(obj(payload.repository)?.id);
  return id !== null ? String(id) : null;
}

/**
 * `pull_request` receiver: derive the PR state, then for EACH project bound to the
 * PR's repo, look up its mapping for that state and move the linked task (respecting
 * skip_backward), recording the PR↔task link. Best-effort — a per-binding failure is
 * logged and the others still run; the caller always 2xx-acks GitHub.
 */
export async function handlePullRequest(
  pg: PgSync,
  payload: Record<string, unknown>,
): Promise<void> {
  const mapped = mapPullRequest(payload);
  if (!mapped) return;
  const installationId = installationIdOf(payload);
  const repoId = repoIdOf(payload);
  if (!installationId || !repoId) return;

  const bindings = await pg.getRepoSyncsForRepo(installationId, repoId);
  if (bindings.length === 0) return; // repo not bound to any project — nothing to do.

  for (const binding of bindings) {
    try {
      await applyPrToBinding(pg, binding, mapped);
    } catch (err) {
      // Best-effort per binding: one project's move failing must not skip the rest or
      // throw to the webhook ack. Logged (not silent) for observability.
      console.error(
        `[github-pr] failed to apply PR #${mapped.prNumber} to project ${binding.tasksProjectId}`,
        err,
      );
    }
  }
}

// Move the LINKED task for one repo binding, if the binding's project maps this PR
// state to a task state and skip_backward permits the move. Records the PR↔task link.
async function applyPrToBinding(
  pg: PgSync,
  binding: StoredGithubRepoSync,
  mapped: MappedPullRequest,
): Promise<void> {
  // 1. The project's mapping for this PR state (a project maps each state at most
  // once). No mapping, or a mapping with no chosen target state → nothing to move.
  const mappings = await pg.getPrStateMappingsForProject(binding.tasksProjectId);
  const mapping = mappings.find((m) => m.prState === mapped.prState);
  const targetStateId = mapping?.taskStateId ?? null;

  // 2. Resolve the linked task (stickiness → issue ref → task-key ref).
  const taskId = await resolveLinkedTask(pg, binding, mapped);
  if (!taskId) return; // no task we can attribute this PR to — skip.

  // 3. Always record/refresh the PR↔task link (stickiness for later PR events), even
  // when there's no state move to make.
  await pg.upsertPrSync({
    id: `ghprs_${randomUUID()}`,
    repoSyncId: binding.id,
    taskId,
    prNumber: mapped.prNumber,
    githubPrId: mapped.githubPrId,
    prUrl: mapped.prUrl,
  });

  if (!targetStateId) return; // mapping absent or "Set State" not chosen — no move.

  // 4. skip_backward: never regress to an earlier phase due to a PR update.
  if (mapping?.skipBackward) {
    const groups = await pg.getMoveGroups(taskId, targetStateId);
    if (isBackwardBlocked(true, groups.currentGroup, groups.targetGroup)) return;
  }

  await pg.updateTask(taskId, { stateId: targetStateId });
}

// First-match PR→task resolution; every path is already scoped to this binding's
// project, so no extra ownership check is needed.
async function resolveLinkedTask(
  pg: PgSync,
  binding: StoredGithubRepoSync,
  mapped: MappedPullRequest,
): Promise<string | null> {
  // 1. Stickiness: an existing link for this (binding, PR number).
  const existing = await pg.getPrSyncByNumber(binding.id, mapped.prNumber);
  if (existing) return existing.taskId;

  // 2. Issue refs (`#N`) in title/body/branch → the synced task for this binding.
  const issueRefs = extractIssueRefs(mapped.title, mapped.body, mapped.headRef);
  for (const issueNumber of issueRefs) {
    const link = await pg.getTaskByIssue(binding.id, issueNumber);
    if (link) return link.taskId;
  }

  // 3. Task-key refs (`<IDENT>-<N>`) in the branch → a task in this binding's project
  // whose identifier + sequence match.
  for (const ref of extractTaskKeyRefs(mapped.headRef)) {
    const id = await pg.getTaskIdByRef(binding.tasksProjectId, ref.identifier, ref.sequence);
    if (id) return id;
  }

  return null;
}
