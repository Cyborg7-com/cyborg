import type { Project } from "$lib/ws-client.js";

// The six GitHub pull-request states Plane maps onto a project's task states
// (Image #3 "Pull Request State Mapping"). `value` is the server enum the
// /api/github/pr-mappings endpoint validates against (routes/github.ts PR_STATES);
// `label` is the verbatim Plane integration copy (en/integration.json). Keep this
// list and its order in lockstep with the server's PR_STATES set.
export interface GithubPrStateOption {
  value: string;
  label: string;
  // True when NO `pull_request` webhook action emits this state yet, so a mapping for
  // it can be persisted (forward-compat) but is currently inert. The editor labels it
  // "(not yet active)" so the operator isn't misled. MR_READY_FOR_MERGE needs an
  // approving `pull_request_review` event (out of scope of github-pr-mapper.ts), so
  // derivePrState never emits it today.
  notYetActive?: boolean;
}

export const GITHUB_PR_STATES: GithubPrStateOption[] = [
  { value: "DRAFT_MR_OPENED", label: "Draft Open" },
  { value: "MR_OPENED", label: "Open" },
  { value: "MR_READY_FOR_MERGE", label: "Ready for Merge", notYetActive: true },
  { value: "MR_REVIEW_REQUESTED", label: "Review Requested" },
  { value: "MR_MERGED", label: "Merged" },
  { value: "MR_CLOSED", label: "Closed" },
];

// Resolve the display name of a Tasks (Plane) project from a repo-sync / PR-mapping's
// stored `tasksProjectId`. That id is the tasks_projects.id — the deterministic
// `tp_<chatProjectId>` (provisionTasksProject) — but the UI's `projects` list is keyed
// by the bare CHAT project id. Strip the `tp_` prefix to match; fall back to a raw
// match for any non-prefixed id (e.g. a create-mode chat id). Returns `fallback` when
// no project matches. Single source of truth for both the edit modal's read-only
// "Plane Project" row and the "Project Issue Sync" list.
export function projectNameForTasksId(
  projects: Project[],
  tasksProjectId: string | null | undefined,
  fallback = "",
): string {
  // Guard a null/undefined/empty id before .startsWith — a missing binding id must
  // resolve to the fallback, not throw.
  if (!tasksProjectId) return fallback;
  const chatId = tasksProjectId.startsWith("tp_") ? tasksProjectId.slice(3) : tasksProjectId;
  return projects.find((p) => p.id === chatId || p.id === tasksProjectId)?.name ?? fallback;
}

// Sync direction is stored as 'inbound' (Unidirectional, GitHub → Plane only) or
// 'bidirectional' (both ways). The radio copy is verbatim Plane (en/integration.json).
export type GithubSyncDirection = "inbound" | "bidirectional";

export const GITHUB_SYNC_DIRECTIONS: { value: GithubSyncDirection; label: string }[] = [
  {
    value: "bidirectional",
    label: "Bidirectional - Sync issues and comments both ways between GitHub and Plane",
  },
  {
    value: "inbound",
    label: "Unidirectional - Sync issues and comments from GitHub to Plane only",
  },
];
