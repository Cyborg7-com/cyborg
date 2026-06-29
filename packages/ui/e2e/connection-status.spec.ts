import { test, expect } from "./helpers/fixtures.ts";

test.describe("Connection status", () => {
  test("connected state hides the status bar", async ({ page, loginAs }) => {
    await loginAs(page, "conn@e2e.dev", "Conn Tester");

    await expect(page.getByText("Reconnecting")).not.toBeVisible();
    await expect(page.getByText("Disconnected")).not.toBeVisible();
  });

  test("shows disconnected when not logged in", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByText("Disconnected")).toBeVisible();
  });
});
