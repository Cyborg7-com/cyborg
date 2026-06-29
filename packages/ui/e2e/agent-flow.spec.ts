import { test, expect, type Page } from "@playwright/test";
import { createHmac } from "node:crypto";

const DEV_JWT_SECRET = "cyborg7-dev-secret-change-in-production";
const DAEMON_WS = process.env.DAEMON_WS ?? "ws://127.0.0.1:6767/ws";

function makeToken(email: string, name: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    email,
    name,
    exp: Math.floor(Date.now() / 1000) + 86400,
    iat: Math.floor(Date.now() / 1000),
  };
  const h = Buffer.from(JSON.stringify(header)).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", DEV_JWT_SECRET).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${sig}`;
}

async function login(page: Page, email: string, name: string) {
  const token = makeToken(email, name);
  const params = new URLSearchParams({
    server: DAEMON_WS,
    token,
    name,
    email,
  });
  await page.goto(`/login?${params.toString()}`);
  await page.waitForURL(/\/workspace/, { timeout: 15_000 });
}

async function enterWorkspace(page: Page) {
  await page.locator("button").filter({ hasText: "My Workspace" }).click();
  await page.waitForURL(/\/workspace\//, { timeout: 15_000 });
}

test.describe.serial("Agent creation and interaction", () => {
  test("1: navigate to new agent page and see providers", async ({ page }) => {
    await login(page, "agent-e2e@test.dev", "Agent Tester");
    await enterWorkspace(page);

    const sidebar = page.locator("aside");
    await expect(sidebar).toBeVisible();

    await sidebar.locator('button[title="New agent"]').click();
    await page.waitForURL(/\/agent\/new/, { timeout: 5_000 });

    // Header should say "New Agent"
    await expect(page.locator("header").getByText("New Agent")).toBeVisible();

    // Wait for providers to load (isAvailable checks)
    await expect(page.locator('[class*="grid"]').first()).toBeVisible({
      timeout: 45_000,
    });

    const cards = page.locator('[class*="grid"] button');
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);

    // Each card has Available/Not Installed badge
    for (let i = 0; i < count; i++) {
      const text = await cards.nth(i).textContent();
      expect(text!.includes("Available") || text!.includes("Not Installed")).toBe(true);
    }
  });

  test("2: launch agent with opencode-go/glm-5.1, ping pong", async ({ page }) => {
    await login(page, "agent-ping@test.dev", "Ping Tester");
    await enterWorkspace(page);

    await page.locator("aside").locator('button[title="New agent"]').click();
    await page.waitForURL(/\/agent\/new/, { timeout: 5_000 });

    // Wait for providers
    await expect(page.locator('[class*="grid"]').first()).toBeVisible({
      timeout: 45_000,
    });

    // Select OpenCode provider
    const cards = page.locator('[class*="grid"] button');
    await cards.filter({ hasText: "OpenCode" }).first().click();

    // Wait for model dropdown to populate, then select opencode-go/glm-5.1
    const modelSelect = page.locator("#agent-model");
    await expect(modelSelect).toBeVisible({ timeout: 5_000 });
    await expect(async () => {
      const options = await modelSelect.locator("option").count();
      expect(options).toBeGreaterThan(0);
    }).toPass({ timeout: 30_000 });
    await modelSelect.selectOption("opencode-go/glm-5.1");

    // Composer should appear
    await expect(page.locator("textarea")).toBeVisible({ timeout: 5_000 });

    // Type prompt and launch
    await page.locator("textarea").fill('Respond with exactly "pong" and nothing else.');
    await page.locator("button").filter({ hasText: "Launch" }).click();

    // Should navigate to agent view
    await page.waitForURL(/\/agent\/(?!new)/, { timeout: 30_000 });

    // Wait for agent response containing "pong"
    await expect(page.getByText("pong", { exact: false })).toBeVisible({ timeout: 90_000 });

    // Verify agent appears in sidebar
    const sidebar = page.locator("aside");
    const agentButtons = sidebar.locator("button").filter({ hasText: /[a-f0-9]{8}-[a-f0-9]/ });
    await expect(agentButtons.first()).toBeVisible({ timeout: 5_000 });
  });

  test("3: navigate between channel and agent in sidebar", async ({ page }) => {
    await login(page, "nav-e2e@test.dev", "Nav Tester");
    await enterWorkspace(page);

    const sidebar = page.locator("aside");

    await expect(sidebar.locator("button", { hasText: "general" })).toBeVisible({
      timeout: 10_000,
    });
    await expect(sidebar.getByText("Agents")).toBeVisible();

    // Click #general
    await sidebar.locator("button", { hasText: "general" }).click();
    await page.waitForURL(/\/channel\//, { timeout: 5_000 });

    // Click New Agent
    await sidebar.locator('button[title="New agent"]').click();
    await page.waitForURL(/\/agent\/new/, { timeout: 5_000 });
    await expect(page.locator("header").getByText("New Agent")).toBeVisible();

    // Back to channel
    await sidebar.locator("button", { hasText: "general" }).click();
    await page.waitForURL(/\/channel\//, { timeout: 5_000 });
  });

  test("4: send message in channel and see it appear", async ({ page }) => {
    await login(page, "chat-e2e@test.dev", "Chat Tester");
    await enterWorkspace(page);

    await page.locator("aside button", { hasText: "general" }).click();
    await page.waitForURL(/\/channel\//, { timeout: 5_000 });

    const textarea = page.locator("textarea");
    await expect(textarea).toBeVisible({ timeout: 5_000 });

    const ts = Date.now();
    const msg1 = `E2E hello ${ts}`;
    const msg2 = `E2E second ${ts}`;

    await textarea.fill(msg1);
    await page.locator("button").filter({ hasText: "Send" }).click();

    await expect(page.getByText(msg1)).toBeVisible({ timeout: 10_000 });

    await textarea.fill(msg2);
    await page.locator("button").filter({ hasText: "Send" }).click();
    await expect(page.getByText(msg2)).toBeVisible({ timeout: 10_000 });
  });

  test("5: two tabs exchange messages in real time", async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    try {
      // Same user = same workspace
      await login(page1, "realtime@test.dev", "Realtime User");
      await enterWorkspace(page1);
      await page1.locator("aside button", { hasText: "general" }).click();
      await page1.waitForURL(/\/channel\//, { timeout: 5_000 });

      await login(page2, "realtime@test.dev", "Realtime User");
      await enterWorkspace(page2);
      await page2.locator("aside button", { hasText: "general" }).click();
      await page2.waitForURL(/\/channel\//, { timeout: 5_000 });

      // Use unique messages to avoid matching previous test's persisted messages
      const ts = Date.now();
      const msg1 = `Realtime tab1 ${ts}`;
      const msg2 = `Realtime tab2 ${ts}`;

      // Tab1 sends a message
      await page1.locator("textarea").fill(msg1);
      await page1.locator("button").filter({ hasText: "Send" }).click();

      // Both tabs should see it
      await expect(page1.getByText(msg1)).toBeVisible({ timeout: 10_000 });
      await expect(page2.getByText(msg1)).toBeVisible({ timeout: 10_000 });

      // Tab2 sends a message
      await page2.locator("textarea").fill(msg2);
      await page2.locator("button").filter({ hasText: "Send" }).click();

      await expect(page2.getByText(msg2)).toBeVisible({ timeout: 10_000 });
      await expect(page1.getByText(msg2)).toBeVisible({ timeout: 10_000 });
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });
});
