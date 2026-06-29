import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { SqliteAgentTimelineStore } from "./sqlite-timeline-store.js";

// rewriteImageUrl backs the agent-image inline render (#845): after the daemon
// uploads a Codex/skill-generated image, the persisted `![alt](/tmp/...)` token
// must be rewritten to the reachable S3 URL so a reload / lazy-load serves an
// embeddable URL (not a dead local path).
describe("SqliteAgentTimelineStore.rewriteImageUrl", () => {
  function store() {
    return new SqliteAgentTimelineStore(new Database(":memory:"));
  }

  test("rewrites the local path to the S3 URL in a persisted assistant message", async () => {
    const s = store();
    await s.appendCommitted("a1", {
      type: "assistant_message",
      text: "here ![diag](/tmp/paseo-attachments/d.png) done",
    });
    const changed = s.rewriteImageUrl(
      "a1",
      "/tmp/paseo-attachments/d.png",
      "https://cyborg7-shared-assets.s3.us-east-1.amazonaws.com/agent-images/d.png",
    );
    expect(changed).toBe(1);
    const rows = await s.getCommittedRows("a1");
    const text = (rows[0].item as { text: string }).text;
    expect(text).toContain(
      "![diag](https://cyborg7-shared-assets.s3.us-east-1.amazonaws.com/agent-images/d.png)",
    );
    expect(text).not.toContain("/tmp/paseo-attachments/d.png");
  });

  test("is scoped to the agent — never touches another agent's rows", async () => {
    const s = store();
    await s.appendCommitted("a1", { type: "assistant_message", text: "![x](/tmp/p/x.png)" });
    await s.appendCommitted("a2", { type: "assistant_message", text: "![x](/tmp/p/x.png)" });
    s.rewriteImageUrl("a1", "/tmp/p/x.png", "https://b.s3.us-east-1.amazonaws.com/x.png");
    const a2 = await s.getCommittedRows("a2");
    expect((a2[0].item as { text: string }).text).toBe("![x](/tmp/p/x.png)");
  });

  test("no-op (0 rows) when the path isn't present", async () => {
    const s = store();
    await s.appendCommitted("a1", { type: "assistant_message", text: "no image here" });
    expect(
      s.rewriteImageUrl("a1", "/tmp/p/missing.png", "https://b.s3.x.amazonaws.com/y.png"),
    ).toBe(0);
  });
});

// The "before probe" the dispatcher uses to FIX agent-session "load older": a live
// agent's in-memory window starts at the reattach seed seq (not the true history
// floor), so its hasOlder is blind to older committed rows. The dispatcher reconciles
// by probing the durable store for ANY row before the oldest row it served — this pins
// that primitive (and the floor case where there's genuinely nothing older).
describe("SqliteAgentTimelineStore — older-history before-probe (agent-session load-older fix)", () => {
  async function seeded(n: number) {
    const s = new SqliteAgentTimelineStore(new Database(":memory:"));
    for (let i = 1; i <= n; i++) {
      await s.appendCommitted("live1", { type: "assistant_message", text: `row ${i}` });
    }
    return s;
  }

  test("detects older committed rows below a live-window floor (arms hasOlder)", async () => {
    const s = await seeded(500); // durable holds seq 1..500
    // The resident agent's in-memory window only holds the tail (e.g. seq 451); the
    // probe must see committed rows BEFORE that → hasOlder should arm.
    const probe = await s.fetchCommitted("live1", {
      direction: "before",
      cursor: { epoch: "committed", seq: 451 },
      limit: 1,
    });
    expect(probe.rows.length).toBe(1);
    expect((probe.rows[0].item as { text: string }).text).toBe("row 450");
  });

  test("no false-positive at the true floor (nothing older than seq 1)", async () => {
    const s = await seeded(40); // a genuinely complete short session, seq 1..40
    const probe = await s.fetchCommitted("live1", {
      direction: "before",
      cursor: { epoch: "committed", seq: 1 },
      limit: 1,
    });
    expect(probe.rows.length).toBe(0); // hasOlder stays false — correct, no older rows
  });
});

// Windows paths store backslashes JSON-escaped (`\\`) in item_json; rewriteImageUrl
// matches the JSON-encoded form so the durable rewrite works cross-platform.
describe("SqliteAgentTimelineStore.rewriteImageUrl — Windows paths", () => {
  test("rewrites a backslash path stored JSON-escaped", async () => {
    const s = new SqliteAgentTimelineStore(new Database(":memory:"));
    await s.appendCommitted("w1", {
      type: "assistant_message",
      text: "![p](C:\\Users\\seb\\AppData\\Local\\Temp\\paseo-attachments\\d.png)",
    });
    const changed = s.rewriteImageUrl(
      "w1",
      "C:\\Users\\seb\\AppData\\Local\\Temp\\paseo-attachments\\d.png",
      "https://cyborg7-shared-assets.s3.us-east-1.amazonaws.com/agent-images/d.png",
    );
    expect(changed).toBe(1);
    const rows = await s.getCommittedRows("w1");
    const text = (rows[0].item as { text: string }).text;
    expect(text).toContain("cyborg7-shared-assets.s3");
    expect(text).not.toContain("AppData");
  });
});
