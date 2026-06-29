// GitHub `issues` webhook payload → Tasks task fields (one-way: GH → Cyborg7).
//
// This is the testable CORE of the GitHub→Tasks sync, mirroring webhook-card.ts:
// it has NO I/O and no relay/DB dependency, so it can be unit-tested against a
// canned GitHub payload. The receiver (routes/github.ts) calls `mapIssueToTask`,
// then persists the result (create a task + an issue↔task back-link) — but the
// extraction logic, the open/closed mapping, and the label set live HERE.
//
// Field extraction mirrors webhook-card.ts:synthesizeIssues (number / title /
// html_url / state / state_reason / labels[].name / body / user) so the card and
// the task agree on what a GitHub issue "is".

// ── permissive extraction helpers (same shape as webhook-card.ts's privates) ──

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

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** The GitHub `state` values an issue payload carries. */
export type GithubIssueState = "open" | "closed";

/** What a synced GitHub issue maps to, before persistence. The receiver turns this
 * into a task create/update + a github_issue_syncs back-link. */
export interface MappedIssue {
  /** The GitHub `action` (opened | reopened | closed | edited | …), lowercased. */
  action: string;
  /** issue.number — the human "#N", the per-repo de-dup key. */
  number: number;
  /** issue.id — GitHub's globally-unique numeric issue id, as text. */
  githubIssueId: string;
  /** issue.title — the task title. */
  title: string;
  /** issue.body (markdown) — the task description. NULL when empty. */
  body: string | null;
  /** issue.html_url — the canonical issue link (stored on the sync row). */
  url: string;
  /** issue.state — open | closed; drives the task's open vs completed state. */
  state: GithubIssueState;
  /** issue.state_reason (completed | not_planned | reopened | null) — distinguishes
   * a "done" close from a "won't do" close (parity with the card's accent). */
  stateReason: string | null;
  /** issue.labels[].name — the label set, de-duped, empty-stripped. */
  labels: string[];
  /** issue.user.login — the GitHub author, for activity attribution. NULL if absent. */
  authorLogin: string | null;
}

// Issue actions worth acting on. We CREATE on opened/reopened, MOVE on closed, and
// REFRESH fields on edited; other actions (assigned, milestoned, …) carry no
// task-shape change and return null so the receiver can ack-and-skip.
const HANDLED_ISSUE_ACTIONS = new Set(["opened", "reopened", "closed", "edited"]);

/**
 * Map a raw GitHub `issues` webhook payload to the task fields it implies, or null
 * when the payload isn't a renderable/handled issue event (missing repo/issue, no
 * number/title, or an action we don't act on). PURE — no I/O.
 */
export function mapIssueToTask(payload: Record<string, unknown>): MappedIssue | null {
  const action = asString(payload.action).trim().toLowerCase();
  if (action && !HANDLED_ISSUE_ACTIONS.has(action)) return null;

  const issue = obj(payload.issue);
  if (!issue) return null;

  const number = num(issue.number);
  const title = asString(issue.title).trim();
  if (number === null || !title) return null;

  const githubIssueId = num(issue.id) !== null ? String(num(issue.id)) : "";
  const url = asString(issue.html_url).trim();
  const rawState = asString(issue.state).trim().toLowerCase();
  const state: GithubIssueState = rawState === "closed" ? "closed" : "open";
  const stateReasonRaw = asString(issue.state_reason).trim();
  const stateReason = stateReasonRaw ? stateReasonRaw : null;

  const bodyRaw = asString(issue.body);
  const body = bodyRaw.trim() ? bodyRaw : null;

  // labels[].name, de-duped + empty-stripped (same extraction as synthesizeIssues).
  const labels = Array.from(
    new Set(
      arr(issue.labels)
        .map((l) => asString(obj(l)?.name).trim())
        .filter(Boolean),
    ),
  );

  const authorLoginRaw = asString(obj(issue.user)?.login).trim();
  const authorLogin = authorLoginRaw ? authorLoginRaw : null;

  return {
    action,
    number,
    githubIssueId,
    title,
    body,
    url,
    state,
    stateReason,
    labels,
    authorLogin,
  };
}

/** The inputs `resolveIssueTargetState` weighs to pick the task state an inbound
 * issue lands in: the binding's per-repo override (github_repo_syncs
 * issue_open/closed_state_id — Image #4 "Configure Issue Sync State", NULL when
 * unset) and the project's default open/closed states (getGithubSyncStates). */
export interface IssueStateResolution {
  /** github_repo_syncs.issue_open_state_id — the configured open override (null). */
  overrideOpenStateId: string | null;
  /** github_repo_syncs.issue_closed_state_id — the configured closed override. */
  overrideClosedStateId: string | null;
  /** getGithubSyncStates open fallback (project default/backlog state). */
  fallbackOpenStateId: string | null;
  /** getGithubSyncStates closed fallback (project's first completed state). */
  fallbackClosedStateId: string | null;
}

/**
 * The task state id an inbound GitHub issue should be written to, given its
 * open/closed state: the binding's configured override when set, else the
 * project's default open/closed state (the 0034 behavior). PURE — the receiver
 * resolves both override + fallback, this only chooses. Either side may be null
 * (a project with no states), in which case the receiver leaves the state as-is.
 */
export function resolveIssueTargetState(
  issueState: GithubIssueState,
  r: IssueStateResolution,
): string | null {
  if (issueState === "closed") {
    return r.overrideClosedStateId ?? r.fallbackClosedStateId;
  }
  return r.overrideOpenStateId ?? r.fallbackOpenStateId;
}

/** What an `issue_comment` payload maps to: the issue it's on + the rendered
 * comment body. The receiver appends a task_activity row from this. NULL when the
 * payload isn't a created comment on a resolvable issue. */
export interface MappedComment {
  issueNumber: number;
  authorLogin: string | null;
  /** comment.body (markdown). NULL when empty (nothing to record). */
  body: string | null;
  /** comment.html_url — the link back to the GitHub comment. */
  url: string;
}

// We append activity only on a NEW comment; edits/deletes don't add feed rows.
const HANDLED_COMMENT_ACTIONS = new Set(["created"]);

/** Map an `issue_comment` payload to the activity it implies, or null. PURE. */
export function mapComment(payload: Record<string, unknown>): MappedComment | null {
  const action = asString(payload.action).trim().toLowerCase();
  if (action && !HANDLED_COMMENT_ACTIONS.has(action)) return null;

  const issue = obj(payload.issue);
  const comment = obj(payload.comment);
  if (!issue || !comment) return null;

  const issueNumber = num(issue.number);
  if (issueNumber === null) return null;

  const bodyRaw = asString(comment.body);
  const body = bodyRaw.trim() ? bodyRaw : null;
  if (!body) return null;

  const authorLoginRaw = asString(obj(comment.user)?.login).trim();
  const authorLogin = authorLoginRaw ? authorLoginRaw : null;
  const url = asString(comment.html_url).trim();

  return { issueNumber, authorLogin, body, url };
}
