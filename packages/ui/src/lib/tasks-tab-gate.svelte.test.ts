import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shellConfig, TASKS_RAIL_ITEM } from "./core/plugin.svelte.js";

// #619 — the Tasks rail item is toggle-gated (default OFF). Verify the gate:
// it's absent until setTasksTabVisible(true), present after, and removable again.
// This is the data-driven mechanism +layout.svelte's $effect drives from the
// `showTasksTab` preference.

function hasTasksRail(): boolean {
  return shellConfig.navItems.some((i) => i.id === "tasks");
}

beforeEach(() => {
  shellConfig.setTasksTabVisible(false);
});

afterEach(() => {
  shellConfig.setTasksTabVisible(false);
});

describe("Tasks rail item gate (#619)", () => {
  it("is hidden by default (not in the shell's nav items)", () => {
    expect(hasTasksRail()).toBe(false);
  });

  it("setTasksTabVisible(true) surfaces the Tasks rail item at /tasks", () => {
    shellConfig.setTasksTabVisible(true);
    const item = shellConfig.navItems.find((i) => i.id === "tasks");
    expect(item).toBeDefined();
    expect(item?.path).toBe("/tasks");
    expect(item?.label).toBe("Tasks");
  });

  it("setTasksTabVisible(false) removes it again", () => {
    shellConfig.setTasksTabVisible(true);
    expect(hasTasksRail()).toBe(true);
    shellConfig.setTasksTabVisible(false);
    expect(hasTasksRail()).toBe(false);
  });

  it("is idempotent — repeated enables don't duplicate the rail item", () => {
    shellConfig.setTasksTabVisible(true);
    shellConfig.setTasksTabVisible(true);
    const count = shellConfig.navItems.filter((i) => i.id === "tasks").length;
    expect(count).toBe(1);
  });

  it("sits after Agents (order 3)", () => {
    // Activity used to sit at order 4 (after Tasks) but was relocated to a
    // top-bar bell button, so Tasks is now the last nav-position rail item.
    expect(TASKS_RAIL_ITEM.order).toBe(3);
    shellConfig.setTasksTabVisible(true);
    const ids = shellConfig.navItems.map((i) => i.id);
    const agentsIdx = ids.indexOf("agents");
    const tasksIdx = ids.indexOf("tasks");
    expect(agentsIdx).toBeLessThan(tasksIdx);
    expect(ids).not.toContain("activity");
  });
});
