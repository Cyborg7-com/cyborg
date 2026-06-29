// OUTBOUND write-back: a SYNCED task changes in Cyborg7 → mirror it to the linked
// GitHub issue (close / reopen / patch title+body), but ONLY when the repo binding
// is bidirectional (github_repo_syncs.sync_direction === "bidirectional"). The
// inbound path (routes/github.ts) is the reverse: GitHub issue → task.
//
// Two concerns live here, split so the decision logic + the loop guard are pure and
// unit-testable while the GitHub I/O is injected:
//   1. The ECHO GUARD — a short-lived in-memory marker set by the INBOUND handler
//      when it applies a GitHub-driven change to a task, consumed here so we never
//      re-emit a change that originated FROM GitHub (an A→B→A loop). The two paths
//      are already architecturally separated (inbound writes via the DAL directly;
//      outbound only fires from the relay's client-message handler), so the guard is
//      defense-in-depth — but it is the explicit, testable mechanism the contract
//      asks for, and it also covers a future unification of the two write paths.
//   2. The OUTBOUND emit — resolve a task's bidirectional issue link(s), mint an
//      installation token, and PATCH the issue via @octokit/rest. Best-effort: a
//      mint/network failure logs + returns; it never throws to the task mutation
//      that triggered it.

import type { PgSync, GithubIssueSyncWithRepo } from "./db/pg-sync.js";
import { mintInstallationToken } from "./github-app.js";

// ─── Echo guard (shared with the inbound receiver) ───────────────────────────

// How long an inbound marker stays "fresh". A GitHub→task change and the resulting
// task-mutation broadcast happen within the same request; 30s is comfortably longer
// than that round trip while short enough that an UNRELATED human edit of the same
// task minutes later is NOT mistaken for an echo.
const ECHO_TTL_MS = 30_000;

// key (`<taskId>:<action>`) → expiry epoch ms. Module-level so the inbound receiver
// (which marks) and the outbound emit (which consumes) share one registry within the
// relay process. Bounded by pruning on every write.
const echoMarks = new Map<string, number>();

/** The kinds of change the echo guard / outbound emit distinguish. */
export type OutboundAction = "close" | "reopen" | "title" | "body";

/** The registry key for a (task, action) echo marker. */
export function echoKey(taskId: string, action: OutboundAction): string {
  return `${taskId}:${action}`;
}

// Drop expired markers so the Map can't grow unbounded across a long-lived relay.
function pruneEcho(now: number): void {
  for (const [k, exp] of echoMarks) {
    if (exp <= now) echoMarks.delete(k);
  }
}

/**
 * Mark a (task, action) as having JUST originated from a GitHub webhook, so a
 * subsequent outbound emit for the same change is suppressed. Called by the inbound
 * receiver right after it applies a GitHub-driven task change.
 */
export function markInbound(taskId: string, action: OutboundAction, now = Date.now()): void {
  pruneEcho(now);
  echoMarks.set(echoKey(taskId, action), now + ECHO_TTL_MS);
}

/**
 * Was this (task, action) recently driven by a GitHub webhook? Consumes the marker
 * (a single inbound change suppresses a single outbound emit) and returns true only
 * when a still-fresh marker existed. PURE aside from the registry side effect.
 */
export function consumeInbound(taskId: string, action: OutboundAction, now = Date.now()): boolean {
  const key = echoKey(taskId, action);
  const exp = echoMarks.get(key);
  if (exp === undefined) return false;
  echoMarks.delete(key);
  return exp > now;
}

/** TEST-ONLY: clear the echo registry between cases. */
export function _resetEchoGuardForTest(): void {
  echoMarks.clear();
}

// ─── Outbound change detection (pure) ────────────────────────────────────────

/** A before/after snapshot of the task fields the outbound emit mirrors. */
export interface TaskOutboundChange {
  taskId: string;
  prevTitle: string | null;
  nextTitle: string | null;
  prevDescription: string | null;
  nextDescription: string | null;
  // Whether the task's state should CLOSE the linked issue before/after. The caller
  // derives this from the task's mirrored `status` via isClosedTaskStatus — BOTH the
  // completed group ("done") and the cancelled group ("cancelled") close the issue, so
  // a cancelled task doesn't leave its GitHub issue open. (Field name kept for
  // back-compat; it means "issue-should-be-closed", not strictly "completed".)
  prevCompleted: boolean;
  nextCompleted: boolean;
}

/** The GitHub issue mutations a task change implies, BEFORE the echo guard. */
export interface PlannedOutbound {
  /** "close" when the task entered a completed state, "reopen" when it left one. */
  stateAction: "close" | "reopen" | null;
  /** The new title to PATCH, or null when unchanged. */
  title: string | null;
  /** The new body to PATCH, or null when unchanged. */
  body: string | null;
}

/**
 * The GitHub issue mutations a task change implies. PURE. State: entering a
 * completed group closes the issue; leaving one reopens it; an in-group move is a
 * no-op. Title/body: emitted only when the value actually changed.
 */
export function planOutbound(change: TaskOutboundChange): PlannedOutbound {
  let stateAction: "close" | "reopen" | null = null;
  if (!change.prevCompleted && change.nextCompleted) stateAction = "close";
  else if (change.prevCompleted && !change.nextCompleted) stateAction = "reopen";

  const title = change.nextTitle !== change.prevTitle ? change.nextTitle : null;
  const body =
    (change.nextDescription ?? "") !== (change.prevDescription ?? "")
      ? (change.nextDescription ?? "")
      : null;

  return { stateAction, title, body };
}

/**
 * Whether a task's mirrored `status` means its linked GitHub issue should be CLOSED.
 * BOTH the completed group (status "done") AND the cancelled group (status
 * "cancelled") close the issue — a cancelled task is no more "open" than a completed
 * one, so the linked issue must not be left open when a task is cancelled. Any other
 * status (pending / in_progress / unknown / null) keeps the issue open. PURE. The
 * group→status mirror this reads is pg-sync.mapStateGroupToStatus. Used by the relay's
 * task-mutation paths to derive TaskOutboundChange.prev/nextCompleted.
 */
export function isClosedTaskStatus(status: string | null | undefined): boolean {
  return status === "done" || status === "cancelled";
}

// ─── GitHub I/O (injectable) ─────────────────────────────────────────────────

/** One issue PATCH the outbound emit performs. `state` closes/reopens; `title`/
 * `body` edit fields. Any subset may be present. */
export interface IssuePatch {
  installationId: string;
  owner: string;
  name: string;
  issueNumber: number;
  state?: "open" | "closed";
  title?: string;
  body?: string;
}

/** The GitHub write surface, injected so the emit is unit-testable without network.
 * The default (defaultIssueWriter) mints an installation token + calls @octokit. */
export interface GithubIssueWriter {
  updateIssue(patch: IssuePatch): Promise<void>;
}

// The production writer: mint an installation token (gated — null when the App isn't
// configured) and PATCH the issue via @octokit/rest. Dynamic import mirrors
// github-app.ts so a bare typecheck never depends on the dep being installed.
const defaultIssueWriter: GithubIssueWriter = {
  async updateIssue(patch: IssuePatch): Promise<void> {
    const token = await mintInstallationToken(patch.installationId);
    if (!token) return; // App not configured / mint failed — degrade silently (gated).
    const { Octokit } = await import("@octokit/rest");
    const octokit = new Octokit({ auth: token });
    const fields: { state?: "open" | "closed"; title?: string; body?: string } = {};
    if (patch.state) fields.state = patch.state;
    if (patch.title !== undefined) fields.title = patch.title;
    if (patch.body !== undefined) fields.body = patch.body;
    await octokit.rest.issues.update({
      owner: patch.owner,
      repo: patch.name,
      issue_number: patch.issueNumber,
      ...fields,
    });
  },
};

// ─── The outbound emit ───────────────────────────────────────────────────────

/** The vetted action set (after echo-guard consumption) to apply to every link. */
interface EmitActions {
  state: "close" | "reopen" | null;
  title: string | null;
  body: string | null;
}

// Consume the echo markers for each planned action ONCE — a change that just arrived
// from GitHub is dropped so it can never bounce back. Side-effecting (consumes the
// markers); the result is applied to every linked issue.
function vetWithEchoGuard(taskId: string, plan: PlannedOutbound): EmitActions {
  const state =
    plan.stateAction !== null && !consumeInbound(taskId, plan.stateAction)
      ? plan.stateAction
      : null;
  const title = plan.title !== null && !consumeInbound(taskId, "title") ? plan.title : null;
  const body = plan.body !== null && !consumeInbound(taskId, "body") ? plan.body : null;
  return { state, title, body };
}

// Build the GitHub issue PATCH for one link from the vetted action set.
function buildIssuePatch(link: GithubIssueSyncWithRepo, actions: EmitActions): IssuePatch {
  const patch: IssuePatch = {
    installationId: link.installationId,
    owner: link.owner,
    name: link.name,
    issueNumber: link.issueNumber,
  };
  if (actions.state) patch.state = actions.state === "close" ? "closed" : "open";
  if (actions.title !== null) patch.title = actions.title;
  if (actions.body !== null) patch.body = actions.body;
  return patch;
}

/**
 * Mirror a task change to its linked GitHub issue(s), for bidirectional bindings
 * only. Best-effort + echo-guarded: each (close|reopen|title|body) action is
 * suppressed when the SAME change just arrived from GitHub. A mint/network failure
 * for one link logs + continues; this never throws to the caller.
 *
 * `writer` is injected for tests; production uses the octokit-backed default.
 */
export async function emitTaskOutbound(
  pg: PgSync,
  change: TaskOutboundChange,
  writer: GithubIssueWriter = defaultIssueWriter,
): Promise<void> {
  const plan = planOutbound(change);
  if (!plan.stateAction && plan.title === null && plan.body === null) return; // nothing to mirror.

  const links = await pg.getIssueSyncsForTaskWithRepo(change.taskId);
  const bidi = links.filter((l) => l.syncDirection === "bidirectional");
  if (bidi.length === 0) return;

  const actions = vetWithEchoGuard(change.taskId, plan);
  if (!actions.state && actions.title === null && actions.body === null) return;

  for (const link of bidi) {
    try {
      await writer.updateIssue(buildIssuePatch(link, actions));
    } catch (err) {
      // Best-effort: a single issue's write failing must not abort the rest or throw
      // to the task mutation. Logged (not silent) so a misconfigured App is visible.
      console.error(
        `[github-outbound] failed to write back task ${change.taskId} → ` +
          `${link.owner}/${link.name}#${link.issueNumber}`,
        err,
      );
    }
  }
}
