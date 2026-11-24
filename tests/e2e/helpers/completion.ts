import { expect, type Page } from "@playwright/test";
export async function confirmCompletionPreview(page: Page) {
  const button = page.getByRole("button", { name: /完了を記録する$/ });
  const order = page.getByRole("combobox", { name: /同日の計算順序で/ });
  await expect
    .poll(
      async () =>
        (await button.isEnabled()) ? "READY" : (await order.isVisible()) ? "ORDER" : "WAIT",
      { timeout: 15000 },
    )
    .not.toBe("WAIT");
  if (await order.isVisible()) await order.selectOption("LAST");
  await expect(button).toBeEnabled();
}
export async function ensureTestContext(page: Page) {
  const selector = page.locator("details.context-selector");
  await expect(selector.locator("form")).toHaveAttribute("aria-busy", "false");
  const currentUnit = selector.locator("summary .context-unit");
  const currentYear = selector.locator("summary .context-year");
  if (
    (await currentUnit.innerText()) === "E2E販売部門" &&
    (await currentYear.innerText()).includes("2026年")
  )
    return;
  await selector.locator("summary").click();
  await selector.locator('select[name="year"]').selectOption("2026");
  await selector.locator('select[name="businessUnitId"]').selectOption({ label: "E2E販売部門" });
  await selector.getByRole("button", { name: "切り替え", exact: true }).click();
  await expect(currentUnit).toHaveText("E2E販売部門");
  await expect(currentYear).toContainText("2026年");
}
