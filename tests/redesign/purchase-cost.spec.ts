import { test, expect } from "@playwright/test";
import { E2E_PASSWORD, E2E_READY_LOGIN } from "../../scripts/test/e2e-config";

test("今回の原価と補充後平均を並べ、参考値・再取得・古い応答を確認する", async ({ page }, info) => {
  test.setTimeout(120000);
  const name = `原価表示-${info.project.name}-${Date.now()}`;
  await page.goto("/login");
  await page.getByLabel("ユーザー名").fill(E2E_READY_LOGIN);
  await page.getByLabel("パスワード").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/purchases/new");
  await page.getByLabel("取引先", { exact: true }).fill(name);
  await page.getByLabel("商品名", { exact: true }).fill(name);
  await page.getByLabel("数量", { exact: true }).fill("10");
  await page.getByLabel("単価（円）", { exact: true }).fill("100");
  const summary = page.locator(".purchase-cost-summary");
  await expect(summary.locator("tbody td").nth(1).locator("strong")).toHaveText("¥100");
  await page.getByRole("button", { name: "保存して入庫", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible({ timeout: 20000 });
  await page.goto("/purchases/new");
  await page.getByLabel("取引先", { exact: true }).fill(name);
  await page.getByLabel("商品名", { exact: true }).fill(name);
  await page.getByLabel("数量", { exact: true }).fill("5");
  await page.getByLabel("単価（円）", { exact: true }).fill("160");
  const picker = page.locator('details:has(> summary:text-is("商品・履歴から選ぶ"))');
  await picker.locator(":scope > summary").click();
  await picker.getByLabel("商品名・コード・取引先を検索").fill(name);
  await expect(picker.locator(".commerce-product-choice")).toHaveCount(1);
  await picker.locator(".commerce-product-choice").click();
  const own = summary.locator("tbody td").nth(0).locator("strong");
  const average = summary.locator("tbody td").nth(1).locator("strong");
  await expect(own).toHaveText("¥160");
  await expect(average).toHaveText("¥120");
  await summary.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(summary.getByText("10個", { exact: true })).toBeVisible();
  await expect(summary.getByText("¥1,800", { exact: true })).toBeVisible();
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await summary.screenshot({ path: `.tmp/redesign-ui/${info.project.name}-purchase-cost.png` });
  await page.getByLabel("受取済み", { exact: true }).uncheck();
  await expect(average).toHaveText("¥120");
  await expect(summary).toContainText("実際の平均原価は受取時に決まります。");

  let failNext = true;
  let releaseOld: (() => void) | undefined;
  let oldStarted: (() => void) | undefined;
  const oldRequest = new Promise<void>((resolve) => {
    oldStarted = resolve;
  });
  await page.route("**/api/commerce", async (route) => {
    const body = route.request().postDataJSON();
    if (body.action !== "purchase-cost-preview") return route.continue();
    if (failNext) {
      failNext = false;
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "原価の取得を再試行してください。", code: "TEST_RETRY" }),
      });
    }
    if (body.payload.lines[0].amount === "170") {
      const response = await route.fetch();
      const responseBody = await response.body();
      oldStarted!();
      await new Promise<void>((resolve) => {
        releaseOld = resolve;
      });
      await route.fulfill({ response, body: responseBody }).catch(() => {});
      return;
    }
    return route.continue();
  });
  await page.getByLabel("単価（円）", { exact: true }).fill("161");
  await expect(average).toHaveText("要確認");
  await expect(own).toHaveText("¥161");
  await summary.getByRole("button", { name: "平均原価を再取得", exact: true }).click();
  await expect(average).toHaveText("約¥120.33");
  await page.getByLabel("単価（円）", { exact: true }).fill("170");
  await oldRequest;
  await page.getByLabel("単価（円）", { exact: true }).fill("200");
  await expect(average).toHaveText("約¥133.33");
  releaseOld!();
  await expect(average).toHaveText("約¥133.33");
  await expect(page.getByLabel("単価（円）", { exact: true })).toHaveValue("200");
  await expect(page.getByLabel("数量", { exact: true })).toHaveValue("5");
  const denied = await page.request.post("/api/commerce", {
    headers: { Origin: new URL(page.url()).origin },
    data: {
      action: "purchase-cost-preview",
      kind: "BUY",
      payload: {
        context: {
          businessUnitId: "00000000-0000-4000-8000-000000000001",
          operatorId: "00000000-0000-4000-8000-000000000002",
          year: 2026,
        },
      },
    },
  });
  expect(denied.status()).toBe(409);
});
