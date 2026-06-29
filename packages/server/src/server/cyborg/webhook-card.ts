// Structured "card" payloads attached to a message (messages.card jsonb).
//
// A card is a first-class rich embed rendered by the client INSTEAD of (or in
// addition to) the plain `text` body — Slack-Block-Kit / Discord-embed style. The
// first (and currently only) variant is a GitHub release card, synthesized from a
// `release` webhook delivery. Every card also produces a plain-`text` fallback so
// clients that don't understand the variant still show something useful.
//
// This module is the testable CORE of the webhook feature: `synthesizeReleaseCard`
// turns a raw GitHub `release` webhook payload into a `{ card, text }` pair. It has
// no I/O and no relay/DB dependencies so it can be unit-tested in isolation.

/** A GitHub release card, rendered by ReleaseCard.svelte. */
export interface ReleaseCard {
  kind: "release";
  /** "owner/repo" (repository.full_name). */
  repo: string;
  /** Link to the repository (repository.html_url). */
  repoUrl: string;
  /** release.tag_name, e.g. "v2.4.0". */
  tag: string;
  /** release.name (the human title), if any — often equals the tag. */
  name: string | null;
  /** release.body — the markdown changelog. */
  body: string | null;
  /** release.html_url — the "View release" link. */
  url: string;
  /** release.prerelease — drives the "Pre-release" pill. */
  prerelease: boolean;
  /** release.draft — drafts are not normally broadcast, but carried for fidelity. */
  draft: boolean;
  /** Release author login + avatar (release.author). */
  author: { login: string; avatarUrl: string | null } | null;
  /** ISO timestamp (release.published_at), for the author row date. */
  publishedAt: string | null;
}

/** A signed interactive button on a card (#600). `token` is an opaque blob the
 * client echoes back verbatim via `cyborg:message_action`; the server verifies it
 * (signed-actions.ts) before executing — the button's authority lives ENTIRELY in
 * the token, never in these client-visible fields. */
export interface SignedCardAction {
  /** Button id (matches the token's `aid`; cross-checked server-side). */
  id: string;
  label: string;
  style?: "primary" | "danger" | "default";
  /** The signed action envelope (see signAction). Echoed back verbatim. */
  token: string;
  /** RENDER HINT ONLY — the UI disables the button for other users. Authorization
   * is the token's actor-lock, server-side; this is never trusted for authz. */
  forActor?: string;
}

/** An in-channel tool-approval card (#600, consumer A3). Synthesized when a
 * channel-bound (mention-summoned) agent hits a permission request, so the
 * otherwise-invisible ghost session's risky action is governable where the
 * conversation lives. Synthesis + resolution land in PR2; PR1 defines the type
 * the signed-action primitive operates on. */
export interface ApprovalCard {
  kind: "approval";
  /** e.g. "Apex wants to run a tool". */
  title: string;
  /** The tool / permission being requested. */
  toolName: string;
  /** Tool args / context — HOSTILE content; fenced + capped at synthesis time. */
  detail: string | null;
  /** The summoned cybo's display name, for the card header. */
  agentName: string | null;
  /** The signed buttons (approve / deny). Cleared on resolution. */
  actions?: SignedCardAction[];
  /** Set once resolved → the card re-renders settled, buttons gone for everyone. */
  resolution?: {
    state: "approved" | "denied" | "expired";
    byUserId: string | null;
    byName?: string | null;
    at: number;
  } | null;
}

/** Union of all card variants: the rich release card, the generic event card
 * (every other GitHub event), and the interactive approval card (#600). */
export type MessageCard = ReleaseCard | EventCard | ApprovalCard;

/** The synthesized result: the structured card plus its plain-text fallback. */
export interface SynthesizedCard {
  card: MessageCard;
  /** Markdown fallback so old clients (no card support) still render something. */
  text: string;
  /** Display name for the message sender (the bot/repo identity). */
  fromName: string;
  /** Per-message avatar override (the release author's GitHub avatar). */
  avatarUrl: string | null;
}

// Minimal structural shape of the bits of a GitHub `release` webhook payload we
// read. Kept permissive (everything optional) because we validate at the edges.
interface GithubReleasePayload {
  action?: string;
  release?: {
    tag_name?: string;
    name?: string | null;
    body?: string | null;
    html_url?: string;
    prerelease?: boolean;
    draft?: boolean;
    published_at?: string | null;
    author?: { login?: string; avatar_url?: string | null } | null;
  } | null;
  repository?: {
    full_name?: string;
    html_url?: string;
  } | null;
}

// Release actions that should post a card. GitHub fires several `release` actions
// (created/edited/deleted/prereleased/released/published); we render the two that
// mean "a release went live": `published` (default) and `released` (a prerelease
// promoted to a full release).
const RENDERED_RELEASE_ACTIONS = new Set(["published", "released"]);

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// The plain-text fallback: a compact one-line markdown summary. Old clients
// render this as ordinary markdown; new clients hide it in favor of the card.
function buildFallbackText(card: ReleaseCard): string {
  const label = card.prerelease ? "pre-released" : "released";
  const titlePart = card.name && card.name !== card.tag ? `${card.tag} — ${card.name}` : card.tag;
  return card.url
    ? `🏷 **${card.repo}** ${label} [${titlePart}](${card.url})`
    : `🏷 **${card.repo}** ${label} **${titlePart}**`;
}

/**
 * Turn a raw GitHub `release` webhook payload into a structured release card plus
 * a plain-text fallback. Returns `null` when the payload isn't a renderable
 * release (wrong/absent action, or missing the minimum tag + repo fields), so the
 * caller can fall back to the generic `{ text }` path.
 */
export function synthesizeReleaseCard(payload: unknown): SynthesizedCard | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as GithubReleasePayload;

  // Only render the "went live" actions. An absent action (someone hand-posting a
  // release-shaped body) is allowed through so manual replays still work.
  if (p.action !== undefined && !RENDERED_RELEASE_ACTIONS.has(p.action)) return null;

  const release = p.release;
  const repository = p.repository;
  if (!release || !repository) return null;

  const tag = asString(release.tag_name).trim();
  const repo = asString(repository.full_name).trim();
  // Minimum viable card: a tag and a repo. Without these there's nothing to show.
  if (!tag || !repo) return null;

  const name = asString(release.name).trim() || null;
  const body = typeof release.body === "string" && release.body.trim() ? release.body : null;
  const url = asString(release.html_url).trim() || asString(repository.html_url).trim();
  const repoUrl = asString(repository.html_url).trim();
  const prerelease = release.prerelease === true;
  const draft = release.draft === true;

  const authorLogin = asString(release.author?.login).trim();
  const authorAvatar = asString(release.author?.avatar_url).trim() || null;
  const author = authorLogin ? { login: authorLogin, avatarUrl: authorAvatar } : null;

  const publishedAt = asString(release.published_at).trim() || null;

  const card: ReleaseCard = {
    kind: "release",
    repo,
    repoUrl,
    tag,
    name,
    body,
    url,
    prerelease,
    draft,
    author,
    publishedAt,
  };

  // Sender identity: show the repo as the poster (not the token owner's name), and
  // override the avatar to the release author's GitHub photo when available.
  return { card, text: buildFallbackText(card), fromName: repo, avatarUrl: authorAvatar };
}

// ─── Generic event cards (pull_request, issues, push, CI, deploy, …) ──────────
//
// Every non-release event renders through ONE shape (EventCard) + EventCard.svelte.
// `kind` + `icon` give the event its identity; `accent` is a STATE key (open/merged/
// closed/success/failure/pending/neutral) that the client maps to GitHub's own state
// colors so cards read "correctly" to anyone who's used GitHub. `fields` is the
// compact metadata row. Each synthesizer is pure + null-safe and returns null when
// the event/action isn't one we render richly (caller then 202-ignores it).

/** State key → the client maps this to a color (GitHub Primer palette). */
export type CardAccent =
  | "open"
  | "merged"
  | "closed"
  | "neutral"
  | "success"
  | "failure"
  | "pending";

/** One compact metadata field on an event card (e.g. "Branch: feat → main"). */
export interface CardField {
  label: string;
  value: string;
  href?: string | null;
}

/** A generic GitHub event card, rendered by EventCard.svelte. */
export interface EventCard {
  kind:
    | "pull_request"
    | "pull_request_review"
    | "issues"
    | "push"
    | "workflow_run"
    | "deployment"
    | "generic";
  /** "owner/repo". */
  repo: string;
  repoUrl: string;
  /** Header glyph (emoji). */
  icon: string;
  /** Header label after the repo, e.g. "Pull request #123". */
  eventLabel: string;
  /** State-based accent; the client maps it to a color. */
  accent: CardAccent;
  /** Small state pill text (e.g. "Merged", "Failed"), or null for no pill. */
  badge: string | null;
  title: string;
  url: string;
  /** Optional markdown/text body (PR/issue body excerpt, commit list, …). */
  body: string | null;
  fields: CardField[];
  author: { login: string; avatarUrl: string | null } | null;
  /** ISO timestamp for the footer date, if known. */
  timestamp: string | null;
  /** Slack-style actor verb for the header subtitle, e.g. "opened", "merged",
   * "approved the changes". Combined with `author` → "{actorAction} by @login".
   * Null/absent when there's no meaningful actor phrasing (e.g. deploy cards). */
  actorAction?: string | null;
}

// ── tiny null-safe payload helpers ──
function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function repoInfo(p: Record<string, unknown>): { repo: string; repoUrl: string } | null {
  const repository = obj(p.repository);
  const repo = asString(repository?.full_name).trim();
  if (!repo) return null;
  return { repo, repoUrl: asString(repository?.html_url).trim() };
}
function actorFrom(v: unknown): { login: string; avatarUrl: string | null } | null {
  const o = obj(v);
  const login = asString(o?.login).trim();
  if (!login) return null;
  return { login, avatarUrl: asString(o?.avatar_url).trim() || null };
}
/** The per-event actor, falling back to the always-present top-level `sender`. */
function actorOrSender(
  p: Record<string, unknown>,
  primary: unknown,
): {
  login: string;
  avatarUrl: string | null;
} | null {
  return actorFrom(primary) ?? actorFrom(p.sender);
}
function branchFromRef(ref: string): string {
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("refs/tags/")) return ref.slice("refs/tags/".length);
  return ref;
}
function firstLine(s: string): string {
  const nl = s.indexOf("\n");
  return (nl === -1 ? s : s.slice(0, nl)).trim();
}
function bodyOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}
function nonEmpty(s: string): string | null {
  const t = s.trim();
  return t || null;
}

/** Assemble the shared `SynthesizedCard` envelope from a finished EventCard. */
function envelope(card: EventCard, text: string): SynthesizedCard {
  return { card, text, fromName: card.repo, avatarUrl: card.author?.avatarUrl ?? null };
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ") : s;
}
/** First non-blank string among the candidates (drains the `a || b || c` chains). */
function firstNonEmpty(...vals: unknown[]): string {
  for (const v of vals) {
    const s = asString(v).trim();
    if (s) return s;
  }
  return "";
}
const FAILURE_STATES = new Set([
  "failure",
  "error",
  "timed_out",
  "action_required",
  "startup_failure",
]);
const PENDING_STATES = new Set(["pending", "in_progress", "queued"]);
/** Map a CI/deploy `state`/`conclusion` to an accent (success/failure/pending/neutral). */
function accentFromState(s: string): CardAccent {
  if (s === "success") return "success";
  if (FAILURE_STATES.has(s)) return "failure";
  if (PENDING_STATES.has(s)) return "pending";
  return "neutral";
}

// ── pull_request ──
const RENDERED_PR_ACTIONS = new Set([
  "opened",
  "reopened",
  "ready_for_review",
  "closed",
  "review_requested",
]);
// State → accent/badge/verb. merged=purple, closed-unmerged=red, draft=gray, open=green.
function prDecision(
  pr: Record<string, unknown>,
  action: string,
): { accent: CardAccent; badge: string; verb: string; closed: boolean } {
  const closed = asString(pr.state) === "closed";
  if (pr.merged === true) return { accent: "merged", badge: "Merged", verb: "merged", closed };
  if (closed) return { accent: "closed", badge: "Closed", verb: "closed", closed };
  if (pr.draft === true) {
    const verb = action === "ready_for_review" ? "marked ready" : "opened";
    return { accent: "neutral", badge: "Draft", verb, closed };
  }
  let verb: string;
  if (action === "reopened") verb = "reopened";
  else if (action === "review_requested") verb = "requested review on";
  else verb = "opened";
  return { accent: "open", badge: "Open", verb, closed };
}
function prFields(pr: Record<string, unknown>): CardField[] {
  const fields: CardField[] = [];
  const head = asString(obj(pr.head)?.ref).trim();
  const base = asString(obj(pr.base)?.ref).trim();
  if (head && base) fields.push({ label: "Branch", value: `${head} → ${base}` });
  const additions = num(pr.additions);
  const deletions = num(pr.deletions);
  const changed = num(pr.changed_files);
  if (additions !== null || deletions !== null) {
    const parts: string[] = [`+${additions ?? 0} −${deletions ?? 0}`];
    if (changed !== null) parts.push(`${changed} file${changed === 1 ? "" : "s"}`);
    fields.push({ label: "Changes", value: parts.join(" · ") });
  }
  const labels = arr(pr.labels)
    .map((l) => asString(obj(l)?.name).trim())
    .filter(Boolean);
  if (labels.length) fields.push({ label: "Labels", value: labels.slice(0, 6).join(", ") });
  // Requested reviewers (Slack surfaces these on review-request): individual
  // users AND requested teams, comma-joined as @handles. Reuses the generic
  // fields rendering, no card-type change needed.
  const reviewerUsers = arr(pr.requested_reviewers)
    .map((rv) => asString(obj(rv)?.login).trim())
    .filter(Boolean);
  const reviewerTeams = arr(pr.requested_teams)
    .map((t) => asString(obj(t)?.name).trim() || asString(obj(t)?.slug).trim())
    .filter(Boolean);
  const reviewers = [...reviewerUsers, ...reviewerTeams];
  if (reviewers.length) {
    fields.push({
      label: "Reviewers",
      value: reviewers
        .slice(0, 6)
        .map((handle) => `@${handle}`)
        .join(", "),
    });
  }
  return fields;
}
function synthesizePullRequest(p: Record<string, unknown>): SynthesizedCard | null {
  const action = asString(p.action);
  if (action && !RENDERED_PR_ACTIONS.has(action)) return null;
  const r = repoInfo(p);
  const pr = obj(p.pull_request);
  if (!r || !pr) return null;
  const number = num(pr.number);
  const title = asString(pr.title).trim();
  const url = asString(pr.html_url).trim() || r.repoUrl;
  if (number === null || !title) return null;

  const d = prDecision(pr, action);
  // On a merge, attribute the actor to whoever merged it (pull_request.merged_by),
  // not the PR opener — Slack shows "merged by @x". Otherwise the PR author/sender.
  const primaryActor = pr.merged === true ? (pr.merged_by ?? pr.user) : pr.user;
  const card: EventCard = {
    kind: "pull_request",
    repo: r.repo,
    repoUrl: r.repoUrl,
    icon: "🔀",
    eventLabel: `Pull request #${number}`,
    accent: d.accent,
    badge: d.badge,
    title,
    url,
    // Body only on the "opened"-ish actions; closes/merges stay compact.
    body: d.closed ? null : bodyOrNull(pr.body),
    fields: prFields(pr),
    author: actorOrSender(p, primaryActor),
    timestamp: asString(pr.updated_at).trim() || null,
    actorAction: d.verb,
  };
  return envelope(card, `🔀 **${r.repo}** PR [#${number} ${d.verb}: ${title}](${url})`);
}

// ── pull_request_review ──
// A submitted review on a PR. We render the terminal "submitted" action, mapping
// the review state to an accent: approved → green, changes_requested → red,
// commented/dismissed → neutral. Skipped otherwise (edited/dismissed-noise).
function reviewDecision(state: string): { accent: CardAccent; badge: string; verb: string } | null {
  switch (state) {
    case "approved":
      return { accent: "success", badge: "Approved", verb: "approved" };
    case "changes_requested":
      return { accent: "failure", badge: "Changes requested", verb: "requested changes on" };
    case "commented":
      return { accent: "neutral", badge: "Commented", verb: "reviewed" };
    default:
      return null;
  }
}
function synthesizePullRequestReview(p: Record<string, unknown>): SynthesizedCard | null {
  if (asString(p.action) !== "submitted") return null;
  const r = repoInfo(p);
  const pr = obj(p.pull_request);
  const review = obj(p.review);
  if (!r || !pr || !review) return null;
  const number = num(pr.number);
  const title = asString(pr.title).trim();
  if (number === null || !title) return null;
  const d = reviewDecision(asString(review.state).trim().toLowerCase());
  if (!d) return null;
  const url = asString(review.html_url).trim() || asString(pr.html_url).trim() || r.repoUrl;

  const card: EventCard = {
    kind: "pull_request_review",
    repo: r.repo,
    repoUrl: r.repoUrl,
    icon: "👀",
    eventLabel: `Review on #${number}`,
    accent: d.accent,
    badge: d.badge,
    title,
    url,
    body: bodyOrNull(review.body),
    fields: [],
    author: actorOrSender(p, review.user),
    timestamp: asString(review.submitted_at).trim() || asString(pr.updated_at).trim() || null,
    actorAction: d.verb,
  };
  return envelope(card, `👀 **${r.repo}** PR [#${number} ${d.verb}: ${title}](${url})`);
}

// ── issues ──
const RENDERED_ISSUE_ACTIONS = new Set(["opened", "reopened", "closed"]);
function synthesizeIssues(p: Record<string, unknown>): SynthesizedCard | null {
  const action = asString(p.action);
  if (action && !RENDERED_ISSUE_ACTIONS.has(action)) return null;
  const r = repoInfo(p);
  const issue = obj(p.issue);
  if (!r || !issue) return null;
  const number = num(issue.number);
  const title = asString(issue.title).trim();
  const url = asString(issue.html_url).trim() || r.repoUrl;
  if (number === null || !title) return null;

  const closed = asString(issue.state) === "closed";
  const reason = asString(issue.state_reason);
  let accent: CardAccent;
  let badge: string;
  let verb: string;
  if (closed) {
    accent = reason === "not_planned" ? "neutral" : "merged"; // completed → purple (done)
    badge = "Closed";
    verb = "closed";
  } else {
    accent = "open";
    badge = "Open";
    verb = action === "reopened" ? "reopened" : "opened";
  }

  const labels = arr(issue.labels)
    .map((l) => asString(obj(l)?.name).trim())
    .filter(Boolean);
  const comments = num(issue.comments);
  const fields: CardField[] = [];
  if (labels.length) fields.push({ label: "Labels", value: labels.slice(0, 6).join(", ") });
  if (comments !== null && comments > 0) {
    fields.push({ label: "Comments", value: String(comments) });
  }

  const card: EventCard = {
    kind: "issues",
    repo: r.repo,
    repoUrl: r.repoUrl,
    icon: "📋",
    eventLabel: `Issue #${number}`,
    accent,
    badge,
    title,
    url,
    body: closed ? null : bodyOrNull(issue.body),
    fields,
    author: actorOrSender(p, issue.user),
    timestamp: asString(issue.updated_at).trim() || null,
  };
  return envelope(card, `📋 **${r.repo}** issue [#${number} ${verb}: ${title}](${url})`);
}

// ── push ──
function synthesizePush(p: Record<string, unknown>): SynthesizedCard | null {
  const r = repoInfo(p);
  if (!r) return null;
  const ref = asString(p.ref).trim();
  if (!ref) return null;
  const branch = branchFromRef(ref);
  const deleted = p.deleted === true;
  const created = p.created === true;
  const forced = p.forced === true;
  const compare = asString(p.compare).trim() || r.repoUrl;
  const commits = arr(p.commits)
    .map((c) => obj(c))
    .filter((c): c is Record<string, unknown> => c !== null);

  let title: string;
  let body: string | null = null;
  if (deleted) {
    title = `Deleted branch ${branch}`;
  } else if (created && commits.length === 0) {
    title = `Created branch ${branch}`;
  } else {
    const n = commits.length;
    title = `${n} commit${n === 1 ? "" : "s"} to ${branch}${forced ? " (force-push)" : ""}`;
    const lines = commits.slice(0, 5).map((c) => {
      const sha = asString(c.id).slice(0, 7);
      const msg = firstLine(asString(c.message));
      const who = asString(obj(c.author)?.name).trim();
      return `- \`${sha}\` ${msg}${who ? ` — ${who}` : ""}`;
    });
    if (commits.length > 5) lines.push(`- … +${commits.length - 5} more`);
    body = nonEmpty(lines.join("\n"));
  }

  const fields: CardField[] = [{ label: "Branch", value: branch }];
  const card: EventCard = {
    kind: "push",
    repo: r.repo,
    repoUrl: r.repoUrl,
    icon: "⬆️",
    eventLabel: `Push`,
    accent: forced ? "failure" : "neutral",
    badge: forced ? "Force-push" : null,
    title,
    url: compare,
    body,
    fields,
    author: actorOrSender(p, obj(p.pusher)),
    timestamp: asString(obj(p.head_commit)?.timestamp).trim() || null,
  };
  return envelope(card, `⬆️ **${r.repo}** ${title}`);
}

// ── workflow_run (CI) ──
function synthesizeWorkflowRun(p: Record<string, unknown>): SynthesizedCard | null {
  // Only the terminal "completed" event — skip queued/in_progress to avoid spam.
  if (asString(p.action) !== "completed") return null;
  const r = repoInfo(p);
  const wr = obj(p.workflow_run);
  if (!r || !wr) return null;
  const name = asString(wr.name).trim() || "Workflow";
  const conclusion = asString(wr.conclusion).trim() || "completed";
  const runNumber = num(wr.run_number);
  const url = asString(wr.html_url).trim() || r.repoUrl;

  const accent = accentFromState(conclusion);
  const badge = capitalize(conclusion);
  const fields: CardField[] = [];
  const branch = asString(wr.head_branch).trim();
  const trigger = asString(wr.event).trim();
  if (branch) fields.push({ label: "Branch", value: branch });
  if (trigger) fields.push({ label: "Trigger", value: trigger });

  const title = `${name}${runNumber !== null ? ` #${runNumber}` : ""}`;
  const card: EventCard = {
    kind: "workflow_run",
    repo: r.repo,
    repoUrl: r.repoUrl,
    icon: "⚙️",
    eventLabel: "CI",
    accent,
    badge,
    title,
    url,
    body: null,
    fields,
    author: actorOrSender(p, wr.actor),
    timestamp: asString(wr.updated_at).trim() || null,
  };
  return envelope(card, `⚙️ **${r.repo}** ${title} — **${conclusion}**`);
}

// ── deployment_status / deployment ──
function synthesizeDeployment(
  githubEvent: string,
  p: Record<string, unknown>,
): SynthesizedCard | null {
  const r = repoInfo(p);
  if (!r) return null;
  // Dereference the nested objects once (non-null) so the field reads below aren't
  // a forest of optional chains (keeps cyclomatic complexity in budget).
  const status: Record<string, unknown> = obj(p.deployment_status) ?? {};
  const deployment: Record<string, unknown> = obj(p.deployment) ?? {};
  const environment = firstNonEmpty(status.environment, deployment.environment) || "environment";
  const state = asString(status.state).trim() || (githubEvent === "deployment" ? "created" : "");
  const url = firstNonEmpty(status.environment_url, status.target_url, status.log_url) || r.repoUrl;

  const fields: CardField[] = [{ label: "Environment", value: environment }];
  const refName = asString(deployment.ref).trim();
  if (refName) fields.push({ label: "Ref", value: refName });

  const title = `Deploy to ${environment}${state ? ` — ${state}` : ""}`;
  const card: EventCard = {
    kind: "deployment",
    repo: r.repo,
    repoUrl: r.repoUrl,
    icon: "🚀",
    eventLabel: "Deployment",
    accent: accentFromState(state),
    badge: state ? capitalize(state) : null,
    title,
    url,
    body: bodyOrNull(status.description),
    fields,
    author: actorOrSender(p, status.creator ?? deployment.creator),
    // Slack-style "deployed by @actor" header line — rendered only when an actor
    // is present (CI payloads that omit creator/sender stay actor-less).
    actorAction: "deployed",
    timestamp: firstNonEmpty(status.created_at, deployment.created_at) || null,
  };
  return envelope(card, `🚀 **${r.repo}** ${title}`);
}

// ── generic fallback for any other GitHub event ──
function synthesizeGeneric(
  githubEvent: string,
  p: Record<string, unknown>,
): SynthesizedCard | null {
  const r = repoInfo(p);
  if (!r) return null;
  const action = asString(p.action).trim();
  const pretty = githubEvent.replace(/_/g, " ");
  const title = action ? `${pretty} ${action}` : pretty;
  const card: EventCard = {
    kind: "generic",
    repo: r.repo,
    repoUrl: r.repoUrl,
    icon: "🔔",
    eventLabel: pretty.charAt(0).toUpperCase() + pretty.slice(1),
    accent: "neutral",
    badge: null,
    title: title.charAt(0).toUpperCase() + title.slice(1),
    url: r.repoUrl,
    body: null,
    fields: [],
    author: actorFrom(p.sender),
    timestamp: null,
  };
  return envelope(card, `🔔 **${r.repo}** ${title}`);
}

/**
 * Synthesize a card for a non-release GitHub event. Returns null when the event or
 * action isn't one we render (so the caller 202-ignores it). `ping` is handled by
 * the caller (acknowledged, never carded); release uses `synthesizeReleaseCard`.
 */
export function synthesizeEventCard(githubEvent: string, payload: unknown): SynthesizedCard | null {
  const p = obj(payload);
  if (!p) return null;
  switch (githubEvent) {
    case "pull_request":
    case "pull_request_target":
      return synthesizePullRequest(p);
    case "pull_request_review":
      return synthesizePullRequestReview(p);
    case "issues":
      return synthesizeIssues(p);
    case "push":
      return synthesizePush(p);
    case "workflow_run":
      return synthesizeWorkflowRun(p);
    case "deployment":
    case "deployment_status":
      return synthesizeDeployment(githubEvent, p);
    default:
      return synthesizeGeneric(githubEvent, p);
  }
}
