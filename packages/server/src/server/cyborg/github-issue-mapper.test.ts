import { describe, it, expect } from "vitest";
import { mapIssueToTask, mapComment, resolveIssueTargetState } from "./github-issue-mapper.js";

// The PURE GitHub `issues` → task field mapper (no I/O). These pin the field
// extraction (number / title / body / html_url / state / state_reason /
// labels[].name / user.login), the open/closed mapping, and the "unhandled action
// → null" / "malformed → null" contracts the receiver relies on, against canned
// GitHub webhook payloads (mirroring webhooks.route.test.ts's canned-payload style).

// A representative GitHub `issues.opened` delivery body (trimmed to the fields the
// mapper reads). Real GitHub payloads carry far more; the mapper is permissive.
function openedPayload() {
  return {
    action: "opened",
    issue: {
      id: 2000300400,
      number: 42,
      title: "Login button does nothing on Safari",
      body: "Steps:\n1. Open Safari\n2. Click Login\n3. Nothing happens",
      html_url: "https://github.com/acme/app/issues/42",
      state: "open",
      state_reason: null,
      user: { login: "octocat" },
      labels: [
        { name: "bug" },
        { name: "safari" },
        { name: "bug" }, // duplicate → de-duped
        { name: "  " }, // blank → stripped
      ],
    },
    repository: { id: 555, full_name: "acme/app", html_url: "https://github.com/acme/app" },
  };
}

describe("mapIssueToTask — GitHub issues.opened → task fields", () => {
  it("maps an opened issue to the full task field set", () => {
    const m = mapIssueToTask(openedPayload());
    expect(m).not.toBeNull();
    if (!m) return; // narrow for TS
    expect(m.action).toBe("opened");
    expect(m.number).toBe(42);
    expect(m.githubIssueId).toBe("2000300400");
    expect(m.title).toBe("Login button does nothing on Safari");
    expect(m.body).toContain("Open Safari");
    expect(m.url).toBe("https://github.com/acme/app/issues/42");
    expect(m.state).toBe("open");
    expect(m.stateReason).toBeNull();
    expect(m.authorLogin).toBe("octocat");
    // labels[].name — de-duped + blank-stripped, order preserved.
    expect(m.labels).toEqual(["bug", "safari"]);
  });

  it("maps a closed (completed) issue to state=closed + state_reason", () => {
    const p = openedPayload();
    p.action = "closed";
    p.issue.state = "closed";
    (p.issue as { state_reason: string | null }).state_reason = "completed";
    const m = mapIssueToTask(p);
    expect(m?.state).toBe("closed");
    expect(m?.stateReason).toBe("completed");
    expect(m?.action).toBe("closed");
  });

  it("maps a not_planned close (carries the distinguishing state_reason)", () => {
    const p = openedPayload();
    p.action = "closed";
    p.issue.state = "closed";
    (p.issue as { state_reason: string | null }).state_reason = "not_planned";
    const m = mapIssueToTask(p);
    expect(m?.state).toBe("closed");
    expect(m?.stateReason).toBe("not_planned");
  });

  it("treats an empty body as null (no description)", () => {
    const p = openedPayload();
    p.issue.body = "   ";
    expect(mapIssueToTask(p)?.body).toBeNull();
  });

  it("returns null for an action we don't act on (e.g. assigned)", () => {
    const p = openedPayload();
    p.action = "assigned";
    expect(mapIssueToTask(p)).toBeNull();
  });

  it("returns null when the issue is missing", () => {
    expect(mapIssueToTask({ action: "opened", repository: { id: 1 } })).toBeNull();
  });

  it("returns null when number or title is missing", () => {
    const noNumber = openedPayload();
    (noNumber.issue as { number?: number }).number = undefined;
    expect(mapIssueToTask(noNumber)).toBeNull();

    const noTitle = openedPayload();
    noTitle.issue.title = "   ";
    expect(mapIssueToTask(noTitle)).toBeNull();
  });

  it("an absent action (defaulted) still maps when the issue is well-formed", () => {
    const p = openedPayload() as Record<string, unknown>;
    delete p.action;
    const m = mapIssueToTask(p);
    expect(m?.number).toBe(42);
    expect(m?.action).toBe(""); // no action header → empty, still handled
  });
});

describe("resolveIssueTargetState — per-binding state overrides vs project default", () => {
  it("uses the configured open/closed override when set", () => {
    const r = {
      overrideOpenStateId: "st_triage",
      overrideClosedStateId: "st_shipped",
      fallbackOpenStateId: "st_backlog",
      fallbackClosedStateId: "st_done",
    };
    expect(resolveIssueTargetState("open", r)).toBe("st_triage");
    expect(resolveIssueTargetState("closed", r)).toBe("st_shipped");
  });

  it("falls back to the project default when an override is null", () => {
    const r = {
      overrideOpenStateId: null,
      overrideClosedStateId: null,
      fallbackOpenStateId: "st_backlog",
      fallbackClosedStateId: "st_done",
    };
    expect(resolveIssueTargetState("open", r)).toBe("st_backlog");
    expect(resolveIssueTargetState("closed", r)).toBe("st_done");
  });

  it("mixes a configured open override with a default closed fallback", () => {
    const r = {
      overrideOpenStateId: "st_triage",
      overrideClosedStateId: null,
      fallbackOpenStateId: "st_backlog",
      fallbackClosedStateId: "st_done",
    };
    expect(resolveIssueTargetState("open", r)).toBe("st_triage");
    expect(resolveIssueTargetState("closed", r)).toBe("st_done");
  });

  it("returns null when neither override nor fallback exists (a project with no states)", () => {
    const r = {
      overrideOpenStateId: null,
      overrideClosedStateId: null,
      fallbackOpenStateId: null,
      fallbackClosedStateId: null,
    };
    expect(resolveIssueTargetState("open", r)).toBeNull();
    expect(resolveIssueTargetState("closed", r)).toBeNull();
  });
});

describe("mapComment — GitHub issue_comment.created → activity", () => {
  function commentPayload() {
    return {
      action: "created",
      issue: { number: 42 },
      comment: {
        body: "I can reproduce this on Safari 17.",
        html_url: "https://github.com/acme/app/issues/42#issuecomment-1",
        user: { login: "hubot" },
      },
    };
  }

  it("maps a created comment to its issue number + body + author", () => {
    const m = mapComment(commentPayload());
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.issueNumber).toBe(42);
    expect(m.body).toBe("I can reproduce this on Safari 17.");
    expect(m.authorLogin).toBe("hubot");
    expect(m.url).toContain("#issuecomment-1");
  });

  it("returns null for an edited/deleted comment action", () => {
    const p = commentPayload();
    p.action = "deleted";
    expect(mapComment(p)).toBeNull();
  });

  it("returns null when the comment body is empty", () => {
    const p = commentPayload();
    p.comment.body = "  ";
    expect(mapComment(p)).toBeNull();
  });
});
