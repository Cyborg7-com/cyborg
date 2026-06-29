import { describe, it, expect } from "vitest";
import { synthesizeReleaseCard, synthesizeEventCard } from "./webhook-card.js";

// A realistic GitHub `release` (action: published) webhook payload (trimmed to
// the fields we read). Mirrors the shape GitHub actually sends.
const RELEASE_PUBLISHED = {
  action: "published",
  release: {
    tag_name: "v2.4.0",
    name: "Spring cleaning",
    body: "## Changelog\n\n- Fixed the thing\n- Added the other thing\n- Bumped deps",
    html_url: "https://github.com/octocat/hello-world/releases/tag/v2.4.0",
    prerelease: false,
    draft: false,
    published_at: "2026-06-11T12:00:00Z",
    author: { login: "octocat", avatar_url: "https://avatars.githubusercontent.com/u/583231?v=4" },
  },
  repository: {
    full_name: "octocat/hello-world",
    html_url: "https://github.com/octocat/hello-world",
  },
};

describe("synthesizeReleaseCard", () => {
  it("synthesizes a release card + text fallback from a published release", () => {
    const result = synthesizeReleaseCard(RELEASE_PUBLISHED);
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.card).toEqual({
      kind: "release",
      repo: "octocat/hello-world",
      repoUrl: "https://github.com/octocat/hello-world",
      tag: "v2.4.0",
      name: "Spring cleaning",
      body: "## Changelog\n\n- Fixed the thing\n- Added the other thing\n- Bumped deps",
      url: "https://github.com/octocat/hello-world/releases/tag/v2.4.0",
      prerelease: false,
      draft: false,
      author: {
        login: "octocat",
        avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
      },
      publishedAt: "2026-06-11T12:00:00Z",
    });

    // Text fallback: a compact one-line markdown summary linking to the release.
    expect(result.text).toBe(
      "🏷 **octocat/hello-world** released [v2.4.0 — Spring cleaning](https://github.com/octocat/hello-world/releases/tag/v2.4.0)",
    );
    // Sender identity = the repo; avatar override = the release author's photo.
    expect(result.fromName).toBe("octocat/hello-world");
    expect(result.avatarUrl).toBe("https://avatars.githubusercontent.com/u/583231?v=4");
  });

  it("marks a prerelease and labels the text accordingly", () => {
    const result = synthesizeReleaseCard({
      ...RELEASE_PUBLISHED,
      release: { ...RELEASE_PUBLISHED.release, prerelease: true, name: null },
    });
    expect(result?.card.prerelease).toBe(true);
    // No distinct name → text uses just the tag and the pre-release verb.
    expect(result?.text).toBe(
      "🏷 **octocat/hello-world** pre-released [v2.4.0](https://github.com/octocat/hello-world/releases/tag/v2.4.0)",
    );
  });

  it("accepts the `released` action (prerelease promoted to full release)", () => {
    const result = synthesizeReleaseCard({ ...RELEASE_PUBLISHED, action: "released" });
    expect(result).not.toBeNull();
    expect(result?.card.tag).toBe("v2.4.0");
  });

  it("returns null for non-rendered release actions (edited/deleted)", () => {
    expect(synthesizeReleaseCard({ ...RELEASE_PUBLISHED, action: "edited" })).toBeNull();
    expect(synthesizeReleaseCard({ ...RELEASE_PUBLISHED, action: "deleted" })).toBeNull();
  });

  it("returns null when the minimum tag/repo fields are missing", () => {
    expect(synthesizeReleaseCard({ action: "published", release: {}, repository: {} })).toBeNull();
    expect(
      synthesizeReleaseCard({
        action: "published",
        release: { tag_name: "v1" },
        repository: {},
      }),
    ).toBeNull();
  });

  it("handles a missing author / empty body gracefully", () => {
    const result = synthesizeReleaseCard({
      action: "published",
      release: { tag_name: "v1.0.0", name: "v1.0.0", body: "", html_url: "https://x/r" },
      repository: { full_name: "a/b", html_url: "https://x" },
    });
    expect(result?.card.author).toBeNull();
    expect(result?.card.body).toBeNull();
    // name === tag → text doesn't duplicate the title.
    expect(result?.text).toBe("🏷 **a/b** released [v1.0.0](https://x/r)");
  });

  it("rejects non-object payloads", () => {
    expect(synthesizeReleaseCard(null)).toBeNull();
    expect(synthesizeReleaseCard("nope")).toBeNull();
    expect(synthesizeReleaseCard(42)).toBeNull();
  });
});

const REPO = {
  full_name: "octocat/hello-world",
  html_url: "https://github.com/octocat/hello-world",
};
const SENDER = { login: "octocat", avatar_url: "https://avatars.githubusercontent.com/u/1?v=4" };

describe("synthesizeEventCard — pull_request", () => {
  const PR = {
    action: "opened",
    pull_request: {
      number: 123,
      title: "Add the new dashboard",
      html_url: "https://github.com/octocat/hello-world/pull/123",
      state: "open",
      merged: false,
      draft: false,
      user: SENDER,
      head: { ref: "feat/dashboard" },
      base: { ref: "main" },
      additions: 482,
      deletions: 37,
      changed_files: 12,
      labels: [{ name: "feature" }],
      body: "Adds the dashboard.",
      updated_at: "2026-06-11T12:00:00Z",
    },
    repository: REPO,
    sender: SENDER,
  };

  it("opened → green/open card with branch, diff and labels fields", () => {
    const r = synthesizeEventCard("pull_request", PR);
    expect(r).not.toBeNull();
    expect(r?.card).toMatchObject({
      kind: "pull_request",
      repo: "octocat/hello-world",
      icon: "🔀",
      eventLabel: "Pull request #123",
      accent: "open",
      badge: "Open",
      title: "Add the new dashboard",
      url: "https://github.com/octocat/hello-world/pull/123",
      body: "Adds the dashboard.",
      author: { login: "octocat", avatarUrl: SENDER.avatar_url },
      timestamp: "2026-06-11T12:00:00Z",
    });
    const card = r!.card as { fields: { label: string; value: string }[] };
    expect(card.fields.find((f) => f.label === "Branch")?.value).toBe("feat/dashboard → main");
    expect(card.fields.find((f) => f.label === "Changes")?.value).toContain("+482");
    expect(card.fields.find((f) => f.label === "Changes")?.value).toContain("12 files");
    expect(card.fields.find((f) => f.label === "Labels")?.value).toBe("feature");
    expect(r?.text).toBe(
      "🔀 **octocat/hello-world** PR [#123 opened: Add the new dashboard](https://github.com/octocat/hello-world/pull/123)",
    );
    expect(r?.fromName).toBe("octocat/hello-world");
  });

  it("merged → purple/merged; closed-unmerged → red/closed; draft → gray", () => {
    const merged = synthesizeEventCard("pull_request", {
      ...PR,
      action: "closed",
      pull_request: { ...PR.pull_request, state: "closed", merged: true },
    });
    expect(merged?.card).toMatchObject({ accent: "merged", badge: "Merged", body: null });

    const closed = synthesizeEventCard("pull_request", {
      ...PR,
      action: "closed",
      pull_request: { ...PR.pull_request, state: "closed", merged: false },
    });
    expect(closed?.card).toMatchObject({ accent: "closed", badge: "Closed" });

    const draft = synthesizeEventCard("pull_request", {
      ...PR,
      pull_request: { ...PR.pull_request, draft: true },
    });
    expect(draft?.card).toMatchObject({ accent: "neutral", badge: "Draft" });
  });

  it("ignores noisy actions (synchronize/labeled) and missing pull_request", () => {
    expect(synthesizeEventCard("pull_request", { ...PR, action: "synchronize" })).toBeNull();
    expect(synthesizeEventCard("pull_request", { ...PR, action: "labeled" })).toBeNull();
    expect(synthesizeEventCard("pull_request", { action: "opened", repository: REPO })).toBeNull();
  });

  it("merged → attributes the actor to merged_by (not the opener), verb 'merged'", () => {
    const merger = {
      login: "maintainer",
      avatar_url: "https://avatars.githubusercontent.com/u/999?v=4",
    };
    const r = synthesizeEventCard("pull_request", {
      ...PR,
      action: "closed",
      pull_request: { ...PR.pull_request, state: "closed", merged: true, merged_by: merger },
    });
    expect(r?.card).toMatchObject({
      accent: "merged",
      badge: "Merged",
      actorAction: "merged",
      author: { login: "maintainer", avatarUrl: merger.avatar_url },
    });
  });

  it("surfaces requested_reviewers as a 'Reviewers' field (@logins)", () => {
    const r = synthesizeEventCard("pull_request", {
      ...PR,
      pull_request: {
        ...PR.pull_request,
        requested_reviewers: [{ login: "alice" }, { login: "bob" }],
      },
    });
    const card = r!.card as { fields: { label: string; value: string }[] };
    expect(card.fields.find((f) => f.label === "Reviewers")?.value).toBe("@alice, @bob");
  });

  it("renders a card for review_requested with the 'requested review on' verb", () => {
    const r = synthesizeEventCard("pull_request", {
      ...PR,
      action: "review_requested",
      pull_request: { ...PR.pull_request, requested_reviewers: [{ login: "alice" }] },
    });
    expect(r).not.toBeNull();
    expect(r?.card).toMatchObject({ kind: "pull_request", actorAction: "requested review on" });
  });
});

describe("synthesizeEventCard — issues", () => {
  const ISSUE = {
    action: "opened",
    issue: {
      number: 42,
      title: "Dark mode flickers",
      html_url: "https://github.com/octocat/hello-world/issues/42",
      state: "open",
      user: SENDER,
      labels: [{ name: "bug" }, { name: "ui" }],
      comments: 3,
      body: "Steps to reproduce…",
    },
    repository: REPO,
    sender: SENDER,
  };

  it("opened → open card with labels + comments", () => {
    const r = synthesizeEventCard("issues", ISSUE);
    expect(r?.card).toMatchObject({
      kind: "issues",
      eventLabel: "Issue #42",
      accent: "open",
      badge: "Open",
      title: "Dark mode flickers",
    });
    const card = r!.card as { fields: { label: string; value: string }[] };
    expect(card.fields.find((f) => f.label === "Labels")?.value).toBe("bug, ui");
    expect(card.fields.find((f) => f.label === "Comments")?.value).toBe("3");
  });

  it("closed completed → purple (done); closed not_planned → neutral", () => {
    const done = synthesizeEventCard("issues", {
      ...ISSUE,
      action: "closed",
      issue: { ...ISSUE.issue, state: "closed", state_reason: "completed" },
    });
    expect(done?.card).toMatchObject({ accent: "merged", badge: "Closed", body: null });

    const notPlanned = synthesizeEventCard("issues", {
      ...ISSUE,
      action: "closed",
      issue: { ...ISSUE.issue, state: "closed", state_reason: "not_planned" },
    });
    expect(notPlanned?.card).toMatchObject({ accent: "neutral" });
  });
});

describe("synthesizeEventCard — push", () => {
  const PUSH = {
    ref: "refs/heads/main",
    forced: false,
    compare: "https://github.com/octocat/hello-world/compare/abc...def",
    commits: [
      {
        id: "a1b2c3d4e5",
        message: "Fix the thing\n\nlong body",
        author: { name: "octocat" },
        url: "u",
      },
      { id: "f6g7h8i9j0", message: "Add the other", author: { name: "octocat" }, url: "u" },
    ],
    head_commit: { timestamp: "2026-06-11T12:00:00Z" },
    pusher: { name: "octocat" },
    repository: REPO,
    sender: SENDER,
  };

  it("renders a neutral push card with a commit list (first line only)", () => {
    const r = synthesizeEventCard("push", PUSH);
    expect(r?.card).toMatchObject({
      kind: "push",
      accent: "neutral",
      badge: null,
      title: "2 commits to main",
      url: PUSH.compare,
    });
    expect(r?.card.body).toContain("`a1b2c3d`");
    expect(r?.card.body).toContain("Fix the thing");
    expect(r?.card.body).not.toContain("long body"); // only the first line
    const card = r!.card as { fields: { label: string; value: string }[] };
    expect(card.fields.find((f) => f.label === "Branch")?.value).toBe("main");
  });

  it("force-push → red/failure with a Force-push badge", () => {
    const r = synthesizeEventCard("push", { ...PUSH, forced: true });
    expect(r?.card).toMatchObject({ accent: "failure", badge: "Force-push" });
    expect(r?.card.title).toContain("(force-push)");
  });

  it("branch delete → a one-line card, no body", () => {
    const r = synthesizeEventCard("push", { ...PUSH, deleted: true, commits: [] });
    expect(r?.card).toMatchObject({ title: "Deleted branch main", body: null });
  });
});

describe("synthesizeEventCard — workflow_run + deployment + generic", () => {
  const WF = {
    action: "completed",
    workflow_run: {
      name: "CI",
      status: "completed",
      conclusion: "success",
      html_url: "https://github.com/octocat/hello-world/actions/runs/1",
      head_branch: "main",
      run_number: 87,
      event: "push",
      actor: SENDER,
      updated_at: "2026-06-11T12:00:00Z",
    },
    repository: REPO,
    sender: SENDER,
  };

  it("workflow_run completed success → green; failure → red; non-completed → null", () => {
    expect(synthesizeEventCard("workflow_run", WF)?.card).toMatchObject({
      kind: "workflow_run",
      accent: "success",
      badge: "Success",
      title: "CI #87",
    });
    const fail = synthesizeEventCard("workflow_run", {
      ...WF,
      workflow_run: { ...WF.workflow_run, conclusion: "failure" },
    });
    expect(fail?.card).toMatchObject({ accent: "failure", badge: "Failure" });
    expect(
      synthesizeEventCard("workflow_run", {
        ...WF,
        action: "in_progress",
        workflow_run: { ...WF.workflow_run, status: "in_progress", conclusion: null },
      }),
    ).toBeNull();
  });

  it("deployment_status → colored by state + 'deployed by' actor attribution", () => {
    const ok = synthesizeEventCard("deployment_status", {
      deployment_status: { state: "success", environment: "production", creator: SENDER },
      deployment: { ref: "main", environment: "production" },
      repository: REPO,
      sender: SENDER,
    });
    expect(ok?.card).toMatchObject({
      kind: "deployment",
      accent: "success",
      badge: "Success",
      actorAction: "deployed",
      author: { login: "octocat", avatarUrl: SENDER.avatar_url },
    });
    expect(ok?.card.title).toContain("production");
  });

  it("deployment_status with no creator/sender → actor-less (no 'by @null')", () => {
    const noActor = synthesizeEventCard("deployment_status", {
      deployment_status: { state: "success", environment: "relay" },
      deployment: { ref: "main", environment: "relay" },
      repository: REPO,
    });
    expect(noActor?.card).toMatchObject({ kind: "deployment", author: null });
  });

  it("unknown event → a neutral generic card; missing repository → null", () => {
    const star = synthesizeEventCard("star", {
      action: "created",
      repository: REPO,
      sender: SENDER,
    });
    expect(star?.card).toMatchObject({ kind: "generic", accent: "neutral" });
    expect(synthesizeEventCard("push", { ref: "refs/heads/main" })).toBeNull();
    expect(synthesizeEventCard("pull_request", null)).toBeNull();
  });
});
