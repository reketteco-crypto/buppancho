import { test, expect } from "@playwright/test";
import { E2E_PASSWORD, E2E_READY_LOGIN } from "../../scripts/test/e2e-config";

test("販売商品の検索・手入力金額の保持・移動前の途中保存・エラーからの修正を確認する", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await page.goto("/login");
  await page.getByLabel("ユーザー名").fill(E2E_READY_LOGIN);
  await page.getByLabel("パスワード").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  const name = `入力体験-${info.project.name}-${Date.now()}`;
  await page.goto("/purchases/new");
  await page.getByLabel("取引先", { exact: true }).fill(name);
  await page.getByLabel("商品名", { exact: true }).fill(name);
  await page.getByLabel("数量", { exact: true }).fill("3");
  await page.getByLabel("単価（円）", { exact: true }).fill("100");
  await page.getByLabel("単品の販売商品も登録する", { exact: true }).check();
  await page.getByRole("button", { name: "保存して入庫", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible({ timeout: 20000 });
  await page.goto(`/products?tab=skus&q=${encodeURIComponent(name)}`);
  const skuId = (await page.getByRole("link", { name, exact: true }).getAttribute("href"))!
    .split("/")
    .at(-1)!;
  await page.goto(`/sales/new?sku=${skuId}`);
  await page.getByRole("button", { name: "販売する商品を検索", exact: true }).click();
  await page.getByLabel("販売する商品の検索語", { exact: true }).fill(name);
  await page.getByLabel("商品代金（円）", { exact: true }).fill("700");
  await page.getByLabel("販売手数料（円）", { exact: true }).fill("0");
  await page.getByLabel("送料（円）", { exact: true }).fill("");
  await page.getByRole("combobox", { name: "販売する商品", exact: true }).selectOption("");
  await page.getByRole("combobox", { name: "販売する商品", exact: true }).selectOption(skuId);
  await page.getByRole("combobox", { name: "販路", exact: true }).selectOption({ index: 1 });
  await expect(page.getByLabel("商品代金（円）", { exact: true })).toHaveValue("700");
  await expect(page.getByLabel("販売手数料（円）", { exact: true })).toHaveValue("0");
  await expect(page.getByLabel("送料（円）", { exact: true })).toHaveValue("");
  await expect(page.getByRole("status").filter({ hasText: "途中保存済み" })).toBeVisible();
  const draft = page.url();
  await page.getByLabel("商品代金（円）", { exact: true }).fill("710");
  await page.getByRole("link", { name: "ホーム", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto(draft);
  await expect(page.getByLabel("商品代金（円）", { exact: true })).toHaveValue("710");
  await page.route("**/api/commerce", async (route) => {
    if (route.request().postDataJSON().action === "preview")
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          status: "REJECTED",
          code: "VALIDATION",
          error: "入力項目を確認してください。",
          fields: { memo: "メモを確認してください。" },
        }),
      });
    else await route.continue();
  });
  await page.getByRole("button", { name: "販売を記録", exact: true }).click();
  await page.getByRole("button", { name: "メモを確認してください。", exact: true }).click();
  const memo = page.getByLabel("メモ", { exact: true });
  await expect(memo).toBeVisible();
  await expect(memo).toBeFocused();
  await expect(memo).toHaveAttribute("aria-invalid", "true");
  await expect(memo).toHaveAttribute("aria-describedby", /.+/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `.tmp/redesign-ui/${info.project.name}-ux-sale-editor.png`,
    fullPage: true,
  });
});
