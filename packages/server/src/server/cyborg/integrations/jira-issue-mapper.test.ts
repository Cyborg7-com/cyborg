import { describe, it, expect } from "vitest";
import {
  adfToMarkdown,
  buildExternalProjectId,
  mapJiraIssueToEvent,
  mapJiraIssueToItem,
  mapJiraPriority,
  mapJiraStatusCategory,
  mapJiraWebhookToEvents,
} from "./jira-issue-mapper.js";

// The PURE Jira payload -> normalized mappers (no I/O). These pin the field extraction,
// the ADF -> markdown conversion (incl. nested + unknown nodes), the statusCategory /
// cancelled-by-name + priority normalization, and the webhook envelope dispatch, against
// canned Jira Cloud (REST v3) payloads.

const CLOUD_ID = "11111111-2222-3333-4444-555555555555";

// A representative Jira issue object (trimmed to the fields the mapper reads). Real payloads
// carry far more; the mapper is permissive.
function issuePayload() {
  return {
    id: "10042",
    key: "ENG-42",
    self: "https://acme.atlassian.net/rest/api/3/issue/10042",
    fields: {
      summary: "Login button does nothing on Safari",
      description: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Steps to " },
              { type: "text", text: "reproduce", marks: [{ type: "strong" }] },
              { type: "text", text: "." },
            ],
          },
        ],
      },
      status: { id: "3", name: "In Progress", statusCategory: { key: "indeterminate" } },
      priority: { id: "2", name: "High" },
      assignee: { accountId: "acc-1", emailAddress: "dev@acme.io", displayName: "Dev One" },
      labels: ["bug", "safari", "bug", "  "],
      duedate: "2026-07-15",
      issuetype: { name: "Bug" },
      project: { id: "10000", key: "ENG", name: "Engineering" },
    },
  };
}

describe("mapJiraStatusCategory", () => {
  it("maps the three native Jira category keys", () => {
    expect(mapJiraStatusCategory("new", "To Do")).toBe("unstarted");
    expect(mapJiraStatusCategory("indeterminate", "In Progress")).toBe("started");
    expect(mapJiraStatusCategory("done", "Done")).toBe("completed");
  });

  it("maps a Done status literally named cancelled / won't do to cancelled (by-name)", () => {
    expect(mapJiraStatusCategory("done", "Cancelled")).toBe("cancelled");
    expect(mapJiraStatusCategory("done", "Won't Do")).toBe("cancelled");
    expect(mapJiraStatusCategory("done", "WONT FIX")).toBe("cancelled");
  });

  it("degrades an unknown/absent category to unstarted", () => {
    expect(mapJiraStatusCategory("undefined", "Whatever")).toBe("unstarted");
    expect(mapJiraStatusCategory(null, null)).toBe("unstarted");
  });
});

describe("mapJiraPriority", () => {
  it("maps the five standard Jira priorities", () => {
    expect(mapJiraPriority("Highest")).toBe("urgent");
    expect(mapJiraPriority("High")).toBe("high");
    expect(mapJiraPriority("Medium")).toBe("medium");
    expect(mapJiraPriority("Low")).toBe("low");
    expect(mapJiraPriority("Lowest")).toBe("none");
  });

  it("degrades an unrecognized/absent priority to none", () => {
    expect(mapJiraPriority("Critical")).toBe("none");
    expect(mapJiraPriority(null)).toBe("none");
  });
});

describe("adfToMarkdown", () => {
  it("returns null for null/undefined/empty and passes a plain string through", () => {
    expect(adfToMarkdown(null)).toBeNull();
    expect(adfToMarkdown(undefined)).toBeNull();
    expect(adfToMarkdown({ type: "doc", version: 1, content: [] })).toBeNull();
    expect(adfToMarkdown("  already text  ")).toBe("already text");
  });

  it("renders text marks: bold, italic, code, strike, link", () => {
    const adf = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "b", marks: [{ type: "strong" }] },
            { type: "text", text: "i", marks: [{ type: "em" }] },
            { type: "text", text: "c", marks: [{ type: "code" }] },
            { type: "text", text: "s", marks: [{ type: "strike" }] },
            {
              type: "text",
              text: "link",
              marks: [{ type: "link", attrs: { href: "https://x.io" } }],
            },
          ],
        },
      ],
    };
    expect(adfToMarkdown(adf)).toBe("**b***i*`c`~~s~~[link](https://x.io)");
  });

  it("renders headings, hardBreaks, and a code block", () => {
    const adf = {
      type: "doc",
      version: 1,
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Title" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "one" },
            { type: "hardBreak" },
            { type: "text", text: "two" },
          ],
        },
        {
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [{ type: "text", text: "const x = 1;" }],
        },
      ],
    };
    expect(adfToMarkdown(adf)).toBe("## Title\n\none\ntwo\n\n```ts\nconst x = 1;\n```");
  });

  it("renders bullet + ordered lists including nesting", () => {
    const adf = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }],
            },
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "b" }] },
                {
                  type: "orderedList",
                  content: [
                    {
                      type: "listItem",
                      content: [{ type: "paragraph", content: [{ type: "text", text: "b1" }] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    // A nested list is separated from its parent item's text by a blank line (valid
    // loose-list markdown); the sub-list is indented under the parent item.
    expect(adfToMarkdown(adf)).toBe("- a\n- b\n\n  1. b1");
  });

  it("degrades an UNKNOWN block node to the text it contains", () => {
    const adf = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "expand",
          attrs: { title: "More" },
          content: [{ type: "paragraph", content: [{ type: "text", text: "hidden detail" }] }],
        },
      ],
    };
    expect(adfToMarkdown(adf)).toBe("hidden detail");
  });

  it("degrades an UNKNOWN inline node to its attrs.text and renders mention/emoji", () => {
    const adf = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "mention", attrs: { text: "@Jane" } },
            { type: "text", text: " " },
            { type: "status", attrs: { text: "DONE" } },
            { type: "emoji", attrs: { shortName: ":tada:", text: "🎉" } },
          ],
        },
      ],
    };
    expect(adfToMarkdown(adf)).toBe("@Jane DONE🎉");
  });
});

describe("buildExternalProjectId", () => {
  it("prefixes the cloudId when known, else emits the bare project key", () => {
    expect(buildExternalProjectId(CLOUD_ID, "ENG")).toBe(`${CLOUD_ID}:ENG`);
    expect(buildExternalProjectId(null, "ENG")).toBe("ENG");
  });
});

describe("mapJiraIssueToEvent", () => {
  it("maps the full field bag with the cloudId-prefixed externalProjectId", () => {
    const e = mapJiraIssueToEvent(issuePayload(), { cloudId: CLOUD_ID, actor: "Actor A" });
    expect(e).not.toBeNull();
    if (!e) return;
    expect(e.itemType).toBe("issue");
    expect(e.externalProjectId).toBe(`${CLOUD_ID}:ENG`);
    expect(e.itemNumber).toBe("ENG-42");
    expect(e.providerItemId).toBe("10042");
    expect(e.itemUrl).toBe("https://acme.atlassian.net/browse/ENG-42");
    expect(e.actor).toBe("Actor A");
    expect(e.title).toBe("Login button does nothing on Safari");
    expect(e.description).toBe("Steps to **reproduce**.");
    expect(e.sourceStatusId).toBe("3");
    expect(e.sourceStatusName).toBe("In Progress");
    expect(e.statusCategory).toBe("started");
    expect(e.priority).toBe("high");
    expect(e.assigneeEmail).toBe("dev@acme.io");
    expect(e.labels).toEqual(["bug", "safari"]); // de-duped + blank-stripped
    expect(e.dueAt).toBe(Date.parse("2026-07-15"));
    expect(e.startAt).toBeUndefined(); // Jira has no native start date
  });

  it("emits assigneeEmail null when unassigned and a bare project key when cloudId absent", () => {
    const p = issuePayload();
    p.fields.assignee = null as unknown as typeof p.fields.assignee;
    const e = mapJiraIssueToEvent(p);
    expect(e?.assigneeEmail).toBeNull();
    expect(e?.externalProjectId).toBe("ENG");
    expect(e?.actor).toBeNull();
  });

  it("returns null when key or project is missing", () => {
    expect(mapJiraIssueToEvent({ id: "1", fields: { summary: "x" } })).toBeNull();
    expect(mapJiraIssueToEvent(null)).toBeNull();
  });
});

describe("mapJiraIssueToItem", () => {
  it("maps an issue to a NormalizedTaskItem (import shape)", () => {
    const item = mapJiraIssueToItem(issuePayload());
    expect(item).not.toBeNull();
    if (!item) return;
    expect(item.itemType).toBe("issue");
    expect(item.itemNumber).toBe("ENG-42");
    expect(item.providerItemId).toBe("10042");
    expect(item.title).toBe("Login button does nothing on Safari");
    expect(item.statusCategory).toBe("started");
    expect(item.priority).toBe("high");
  });

  it("falls back to the issue key as title when the summary is blank", () => {
    const p = issuePayload();
    p.fields.summary = "   ";
    expect(mapJiraIssueToItem(p)?.title).toBe("ENG-42");
  });
});

describe("mapJiraWebhookToEvents", () => {
  it("maps jira:issue_created to one issue event with actor + cloudId", () => {
    const events = mapJiraWebhookToEvents({
      webhookEvent: "jira:issue_created",
      cloudId: CLOUD_ID,
      user: { displayName: "Creator" },
      issue: issuePayload(),
    });
    expect(events).toHaveLength(1);
    expect(events[0].itemType).toBe("issue");
    expect(events[0].externalProjectId).toBe(`${CLOUD_ID}:ENG`);
    expect(events[0].actor).toBe("Creator");
  });

  it("maps jira:issue_updated the same way", () => {
    const events = mapJiraWebhookToEvents({
      webhookEvent: "jira:issue_updated",
      cloudId: CLOUD_ID,
      issue: issuePayload(),
    });
    expect(events).toHaveLength(1);
    expect(events[0].itemNumber).toBe("ENG-42");
  });

  it("maps jira:issue_deleted to a deleted event", () => {
    const events = mapJiraWebhookToEvents({
      webhookEvent: "jira:issue_deleted",
      cloudId: CLOUD_ID,
      user: { displayName: "Deleter" },
      issue: issuePayload(),
    });
    expect(events).toHaveLength(1);
    expect(events[0].itemType).toBe("deleted");
    expect(events[0].itemNumber).toBe("ENG-42");
    expect(events[0].providerItemId).toBe("10042");
    expect(events[0].actor).toBe("Deleter");
  });

  it("maps comment_created to a comment event on the parent issue", () => {
    const events = mapJiraWebhookToEvents({
      webhookEvent: "comment_created",
      cloudId: CLOUD_ID,
      issue: { key: "ENG-42", self: "https://acme.atlassian.net/rest/api/3/issue/10042" },
      comment: {
        id: "9001",
        author: { displayName: "Commenter" },
        body: {
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: "LGTM" }] }],
        },
      },
    });
    expect(events).toHaveLength(1);
    const [c] = events;
    expect(c.itemType).toBe("comment");
    expect(c.itemNumber).toBe("ENG-42"); // parent issue key (project derived from key)
    expect(c.externalProjectId).toBe(`${CLOUD_ID}:ENG`);
    expect(c.providerItemId).toBe("9001");
    expect(c.commentBody).toBe("LGTM");
    expect(c.actor).toBe("Commenter");
  });

  it("returns [] for an unhandled webhook event and for a non-object body", () => {
    expect(
      mapJiraWebhookToEvents({ webhookEvent: "jira:worklog_updated", issue: issuePayload() }),
    ).toEqual([]);
    expect(mapJiraWebhookToEvents("nonsense")).toEqual([]);
    expect(mapJiraWebhookToEvents(null)).toEqual([]);
  });
});
