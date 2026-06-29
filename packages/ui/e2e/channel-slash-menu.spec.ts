import { expect, test } from "./helpers/fixtures.js";

test("slash menu renders in channel composer", async ({ page, loginAs }) => {
  test.setTimeout(60_000);
  await loginAs(page, "slash@e2e.dev", "Slash Tester");
  const wsCard = page.getByText("My Workspace", { exact: true }).first();
  if (await wsCard.isVisible({ timeout: 4000 }).catch(() => false)) await wsCard.click();
  const skip = page.getByText("Skip for now").first();
  if (await skip.isVisible({ timeout: 4000 }).catch(() => false)) {
    await skip.click();
    const wsCard2 = page.getByText("My Workspace", { exact: true }).first();
    if (await wsCard2.isVisible({ timeout: 4000 }).catch(() => false)) await wsCard2.click();
  }
  await page.getByText("Chat", { exact: true }).first().click();
  const composer = page.locator("textarea").first();
  await expect(composer).toBeVisible({ timeout: 10_000 });

  await composer.click();
  await composer.fill("/");
  await composer.dispatchEvent("input");
  await expect(page.getByText("Channel commands")).toBeVisible({ timeout: 5000 });
  await expect(page.getByText("/summarize")).toBeVisible();

  // Enter selects → fills "/summarize "
  await composer.press("Enter");
  await expect(composer).toHaveValue("/summarize ");
  // menu closed once args mode begins
  await expect(page.getByText("Channel commands")).toBeHidden();
});
