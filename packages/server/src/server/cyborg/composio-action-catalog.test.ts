import { describe, expect, it } from "vitest";
import {
  buildActionCatalog,
  classifyComposioAction,
  humanizeActionLabel,
} from "./composio-action-catalog.js";

// Real Gmail slugs pulled live from Composio's COMPOSIO_SEARCH_TOOLS (2026-06-24),
// so the classifier is validated against the actual vocabulary, not invented slugs.
const REAL_GMAIL = {
  read: [
    "GMAIL_FETCH_EMAILS",
    "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
    "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
    "GMAIL_LIST_LABELS",
    "GMAIL_LIST_THREADS",
  ],
  write: ["GMAIL_BATCH_MODIFY_MESSAGES", "GMAIL_SEND_EMAIL"],
  destructive: ["GMAIL_BATCH_DELETE_MESSAGES", "GMAIL_DELETE_DRAFT", "GMAIL_MOVE_TO_TRASH"],
};

describe("classifyComposioAction (validated on real Composio slugs)", () => {
  it("classifies FETCH/LIST as read with NO default approval", () => {
    for (const slug of REAL_GMAIL.read) {
      const info = classifyComposioAction(slug);
      expect(info.group).toBe("read");
      expect(info.destructive).toBe(false);
      expect(info.defaultApproval).toBe(false);
    }
  });

  it("classifies SEND/MODIFY as write WITH default approval", () => {
    for (const slug of REAL_GMAIL.write) {
      const info = classifyComposioAction(slug);
      expect(info.group).toBe("write");
      expect(info.destructive).toBe(false);
      expect(info.defaultApproval).toBe(true);
    }
  });

  it("classifies DELETE/TRASH as destructive write (approval); destructive wins over a co-occurring write verb", () => {
    for (const slug of REAL_GMAIL.destructive) {
      const info = classifyComposioAction(slug);
      expect(info.group).toBe("write");
      expect(info.destructive).toBe(true);
      expect(info.defaultApproval).toBe(true);
    }
    // MOVE_TO_TRASH has both MOVE (write) and TRASH (destructive) — destructive wins.
    expect(classifyComposioAction("GMAIL_MOVE_TO_TRASH").destructive).toBe(true);
  });

  it("an UNKNOWN verb fails safe → write + approval (never silently auto-allowed)", () => {
    const info = classifyComposioAction("GMAIL_FROBNICATE_WIDGET");
    expect(info.group).toBe("write");
    expect(info.defaultApproval).toBe(true);
  });

  it("classifies a CONNECT/AUTH action as manage", () => {
    expect(classifyComposioAction("GITHUB_CONNECT_ACCOUNT").group).toBe("manage");
    expect(classifyComposioAction("SLACK_AUTH_TEST").group).toBe("manage");
  });
});

describe("humanizeActionLabel", () => {
  it("strips the toolkit prefix and title-cases the rest", () => {
    expect(humanizeActionLabel("GMAIL_SEND_EMAIL")).toBe("Send email");
    expect(humanizeActionLabel("GMAIL_MOVE_TO_TRASH")).toBe("Move to trash");
    expect(humanizeActionLabel("GMAIL_BATCH_DELETE_MESSAGES")).toBe("Batch delete messages");
  });
});

describe("buildActionCatalog", () => {
  it("buckets a toolkit's actions by group for the Integrations tab", () => {
    const cat = buildActionCatalog([
      ...REAL_GMAIL.read,
      ...REAL_GMAIL.write,
      ...REAL_GMAIL.destructive,
    ]);
    expect(cat.read).toHaveLength(REAL_GMAIL.read.length);
    expect(cat.write).toHaveLength(REAL_GMAIL.write.length + REAL_GMAIL.destructive.length);
    expect(cat.manage).toHaveLength(0);
    // Every destructive lands in write and is flagged for approval.
    expect(cat.write.filter((a) => a.destructive)).toHaveLength(REAL_GMAIL.destructive.length);
  });
});
