import { test, expect } from "./helpers/fixtures.ts";

test.describe("Login flow", () => {
  test("login page renders with form fields", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator("h1")).toContainText("Cyborg7");
    await expect(page.locator('input[id="server"]')).toBeVisible();
    await expect(page.locator('input[id="name"]')).toBeVisible();
    await expect(page.locator('input[id="email"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });

  test("connect button disabled without name and email", async ({ page }) => {
    await page.goto("/login");
    const btn = page.locator('button[type="submit"]');
    await expect(btn).toBeDisabled();
  });

  test("auto-login via token query param redirects to workspace", async ({ page, daemon }) => {
    const { createDevToken } = await import("./helpers/daemon.ts");
    const token = createDevToken("test@e2e.dev", "E2E Tester");
    const params = new URLSearchParams({
      server: daemon.wsUrl,
      token,
      name: "E2E Tester",
      email: "test@e2e.dev",
    });
    await page.goto(`/login?${params.toString()}`);
    await page.waitForURL(/\/workspace/, { timeout: 15_000 });
    await expect(page).toHaveURL(/\/workspace/);
  });

  test("loginAs fixture works and shows workspace list", async ({ page, loginAs }) => {
    await loginAs(page, "rodrigo@e2e.dev", "Rodrigo");
    await expect(page).toHaveURL(/\/workspace/);
  });
});
