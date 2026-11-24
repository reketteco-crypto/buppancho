import { test, expect } from "@playwright/test";
import { E2E_PASSWORD, E2E_READY_LOGIN } from "../../scripts/test/e2e-config";
import { workbookFixture } from "./import-fixtures";

test("商品代金と費用の換算を区別し、計算待ちから必要な入力へ進める", async ({ page }, info) => {
  test.setTimeout(90000);
  const name = `換算確認-${info.project.name}-${Date.now()}`;
  await page.goto("/login");
  await page.getByLabel("ユーザー名").fill(E2E_READY_LOGIN);
  await page.getByLabel("パスワード").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/purchases/new");
  const importer = page.locator('details:has(> summary:text-is("ファイルから入力"))');
  await importer.locator(":scope > summary").click();
  await importer.getByLabel("Excel・PDF").setInputFiles({
    name: "商品.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: workbookFixture("購入", [
      ["商品名", "数量", "単価", "通貨"],
      [name, "2", "10", "CNY"],
    ]),
  });
  await importer.getByRole("button", { name: "入力欄に反映", exact: true }).click();
  const exchange = page.locator(
    'details:has(> summary:has-text("商品代金の通貨・換算・注文番号"))',
  );
  const rate = exchange.getByLabel(/^商品代金の換算レート/);
  await expect(rate).toBeVisible();
  await expect(page.locator(".commerce-total")).toHaveText("計算待ち");
  const currencyBox = await exchange.boundingBox(),
    goodsBox = await page.getByRole("heading", { name: "購入したもの", exact: true }).boundingBox();
  expect(currencyBox!.y).toBeLessThan(goodsBox!.y);
  const costs = page.locator('details:has(> summary:has-text("送料・手数料・税額"))');
  await costs.locator(":scope > summary").click();
  await costs.getByRole("button", { name: "費用を追加", exact: true }).click();
  await costs.getByLabel("金額（CNY）", { exact: true }).fill("5");
  await costs.getByText("この費用の通貨・換算", { exact: true }).click();
  await costs.getByLabel("1通貨あたりの円").fill("22");
  await expect(rate).toHaveValue("");
  await expect(
    page.getByRole("status").filter({ hasText: "商品代金（CNY）の換算レート" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "必要な入力欄へ移動", exact: true }).click();
  await expect(rate).toBeFocused();
  await rate.fill("20");
  await expect(exchange).toHaveAttribute("open", "");
  await expect(page.locator(".commerce-total")).toHaveText("¥510");
  await expect(page.locator(".commerce-line-meta .commerce-number")).toHaveText("¥400");
  await expect(page.getByLabel("単価（CNY）", { exact: true })).toHaveValue("10");
  await expect(page.getByLabel("数量", { exact: true })).toHaveValue("2");
  await costs.getByLabel("1通貨あたりの円").fill("");
  await expect(page.locator(".commerce-total")).toHaveText("¥500");
  await expect(costs.getByText("商品代金の換算レート 20 を使用", { exact: true })).toBeVisible();
  await costs.getByLabel("金額（CNY）", { exact: true }).fill("");
  await expect(page.locator(".commerce-save")).toContainText("暫定・金額未入力の費用があります");
  await costs.getByLabel("金額（CNY）", { exact: true }).fill("5");
  await costs.locator('details:has(> summary:has-text("配分・原価への反映")) > summary').click();
  await costs.getByRole("combobox", { name: "配分方法", exact: true }).selectOption("WEIGHT");
  await expect(page.locator(".commerce-total")).toHaveText("¥500");
  await expect(page.locator(".commerce-save")).toContainText("原価の配分待ち");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `.tmp/redesign-ui/${info.project.name}-purchase-calculation.png`,
    fullPage: true,
    caret: "initial",
  });
  await page.getByLabel("数量", { exact: true }).fill("");
  await expect(page.locator(".commerce-total")).toHaveText("計算待ち");
  await expect(
    page.getByRole("status").filter({ hasText: `${name}の数量を入力してください。` }),
  ).toBeVisible();
  await page.getByRole("button", { name: "必要な入力欄へ移動", exact: true }).click();
  await expect(page.getByLabel("数量", { exact: true })).toBeFocused();
  await page.getByLabel("数量", { exact: true }).fill("2");
  await rate.fill("");
  await exchange.locator(":scope > summary").click();
  await page.getByRole("button", { name: "必要な入力欄へ移動", exact: true }).click();
  await expect(rate).toBeVisible();
  await expect(rate).toBeFocused();
});
