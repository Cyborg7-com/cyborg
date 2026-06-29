import { defineConfig } from "@playwright/test";

const port = Number(process.env.VITE_PORT ?? 5174);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "list",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `pnpm vite dev --port ${port}`,
    port,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
