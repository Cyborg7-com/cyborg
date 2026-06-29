import { test, expect } from "./helpers/fixtures.ts";

test.describe("Task board", () => {
  test("tasks page shows three columns", async ({ page, loginAs }) => {
    await loginAs(page, "tasks@e2e.dev", "Task Tester");

    const wsButton = page.locator("button").filter({ hasText: "My Workspace" });
    await wsButton.click();
    await page.waitForURL(/\/workspace\//, { timeout: 10_000 });

    const url = page.url();
    const wsId = url.match(/\/workspace\/([^/]+)/)?.[1];
    expect(wsId).toBeTruthy();

    await page.goto(`/workspace/${wsId}/tasks`);

    await expect(page.getByText("To Do")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("In Progress")).toBeVisible();
    await expect(page.getByText("Done")).toBeVisible();
  });

  test("empty task board shows 'No tasks' in each column", async ({ page, loginAs }) => {
    await loginAs(page, "notasks@e2e.dev", "NoTask Tester");

    await page.locator("button").filter({ hasText: "My Workspace" }).click();
    await page.waitForURL(/\/workspace\//, { timeout: 10_000 });

    const url = page.url();
    const wsId = url.match(/\/workspace\/([^/]+)/)?.[1];
    await page.goto(`/workspace/${wsId}/tasks`);

    const noTaskLabels = page.getByText("No tasks");
    await expect(noTaskLabels.first()).toBeVisible({ timeout: 10_000 });
    expect(await noTaskLabels.count()).toBe(3);
  });
});
