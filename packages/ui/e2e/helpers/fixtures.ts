import { test as base, type Page } from "@playwright/test";
import { startTestDaemon, createDevToken, type TestDaemon } from "./daemon.ts";

interface CyborgFixtures {
  daemon: TestDaemon;
  loginAs: (page: Page, email: string, name?: string) => Promise<void>;
}

// oxlint-disable eslint-plugin-react-hooks(rules-of-hooks), eslint(no-empty-pattern)
export const test = base.extend<object, CyborgFixtures>({
  daemon: [
    async ({}, use) => {
      const daemon = await startTestDaemon();
      await use(daemon);
      await daemon.stop();
    },
    { scope: "worker" },
  ],

  loginAs: [
    async ({ daemon }, use) => {
      const fn = async (page: Page, email: string, name?: string) => {
        const token = createDevToken(email, name ?? email);
        const params = new URLSearchParams({
          server: daemon.wsUrl,
          token,
          name: name ?? email,
          email,
        });
        await page.goto(`/login?${params.toString()}`);
        await page.waitForURL(/\/workspace/, { timeout: 15_000 });
      };
      await use(fn);
    },
    { scope: "worker" },
  ],
});

export { expect } from "@playwright/test";
