import { describe, it, expect } from "vitest";
import { buildTasksProjectList } from "./cyborg7-mcp-tools.js";

// Pure-logic tests for the cyborg7_list_projects projection. No DB / no MCP harness:
// buildTasksProjectList is a pure mapping over the tasks_projects rows + a chat-
// project name lookup, so behavior is fully deterministic from its inputs.

// A minimal row matching buildTasksProjectList's structural param (a subset of
// StoredTasksProject). Defaults model an active, chat-linked project.
interface TasksProjectRow {
  id: string;
  identifier: string;
  chat_project_id: string | null;
  color: string | null;
  archived_at: number | null;
}

function row(over: Partial<TasksProjectRow> = {}): TasksProjectRow {
  return {
    id: "tproj_1",
    identifier: "ENG",
    chat_project_id: "proj_chat_1",
    color: "#abcdef",
    archived_at: null,
    ...over,
  };
}

describe("buildTasksProjectList", () => {
  it("names the synthetic catch-all 'Inbox' and flags isInbox when chat_project_id is null", () => {
    const out = buildTasksProjectList(
      [row({ id: "tproj_inbox", identifier: "INBOX", chat_project_id: null, color: null })],
      new Map(),
      false,
    );
    expect(out).toEqual([
      {
        id: "tproj_inbox",
        identifier: "INBOX",
        name: "Inbox",
        color: null,
        isInbox: true,
        chatProjectId: null,
      },
    ]);
  });

  it("derives a chat-linked project's name from the chat-project lookup", () => {
    const out = buildTasksProjectList(
      [row({ chat_project_id: "proj_chat_1" })],
      new Map([["proj_chat_1", "Engineering"]]),
      false,
    );
    expect(out[0]).toMatchObject({
      name: "Engineering",
      isInbox: false,
      chatProjectId: "proj_chat_1",
      color: "#abcdef",
    });
  });

  it("falls back to the identifier when the chat project's name is missing from the lookup", () => {
    const out = buildTasksProjectList(
      [row({ identifier: "OPS", chat_project_id: "proj_chat_unknown" })],
      new Map(),
      false,
    );
    expect(out[0].name).toBe("OPS");
  });

  it("excludes archived projects by default and includes them when includeArchived is true", () => {
    const rows = [
      row({ id: "active", chat_project_id: "c_active", archived_at: null }),
      row({ id: "archived", chat_project_id: "c_archived", archived_at: 1_700_000_000_000 }),
    ];
    const names = new Map([
      ["c_active", "Active"],
      ["c_archived", "Archived"],
    ]);

    const activeOnly = buildTasksProjectList(rows, names, false);
    expect(activeOnly.map((p) => p.id)).toEqual(["active"]);

    const all = buildTasksProjectList(rows, names, true);
    expect(all.map((p) => p.id)).toEqual(["active", "archived"]);
  });

  it("preserves input order", () => {
    const rows = [
      row({ id: "a", chat_project_id: "ca" }),
      row({ id: "b", chat_project_id: null }),
      row({ id: "c", chat_project_id: "cc" }),
    ];
    const out = buildTasksProjectList(rows, new Map(), true);
    expect(out.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });
});
