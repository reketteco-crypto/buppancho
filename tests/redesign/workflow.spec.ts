import { test, expect } from "@playwright/test";
import { E2E_PASSWORD, E2E_READY_LOGIN } from "../../scripts/test/e2e-config";
import { confirmReturnPreview } from "../e2e/helpers/workflow";

test("別端末の途中保存と手元入力を比較し、確定せず新下書きへ引き継ぐ", async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  await page.goto("/login");
  await page.getByLabel("ユーザー名").fill(E2E_READY_LOGIN);
  await page.getByLabel("パスワード").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/purchases/new");
  await page.getByLabel("取引先", { exact: true }).fill("途中保存の比較");
  await page.getByLabel("商品名", { exact: true }).fill("比較する商品");
  await page.getByLabel("単価（円）").fill("100");
  await expect(page.getByRole("status").filter({ hasText: "途中保存済み" })).toBeVisible();
  const original = page.url();
  const other = await context.newPage();
  await other.goto(original);
  await other.getByLabel("数量", { exact: true }).fill("3");
  await expect(other.getByRole("status").filter({ hasText: "途中保存済み" })).toBeVisible();
  await page.getByLabel("数量", { exact: true }).fill("5");
  await page.getByRole("button", { name: "保存内容と手元の入力を比較", exact: true }).click();
  await expect(page.getByRole("heading", { name: "続ける内容を選択", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "手元の入力で続ける", exact: true }).click();
  await expect(page).not.toHaveURL(original);
  await expect(page.getByLabel("数量", { exact: true })).toHaveValue("5");
  await expect(page.getByLabel("取引先", { exact: true })).toHaveValue("途中保存の比較");
  await expect(page.getByRole("button", { name: "保存して入庫", exact: true })).toBeVisible();
  await other.close();
});

test("購入からSKU一括登録、直接販売までを一画面ずつ記録する", async ({ page }, testInfo) => {
  test.setTimeout(90000);
  const name = `ボトル-${testInfo.project.name}-${Date.now()}`;
  await page.goto("/login");
  await page.getByLabel("ユーザー名").fill(E2E_READY_LOGIN);
  await page.getByLabel("パスワード").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/purchases/new");
  await page.getByLabel("取引先", { exact: true }).fill("テストの取引先");
  await page.getByLabel("商品名", { exact: true }).fill(name);
  await page.getByLabel("数量", { exact: true }).fill("10");
  await page.getByLabel("単価（円）").fill("100");
  await page.getByText("送料・手数料・税額", { exact: false }).click();
  await page.getByRole("button", { name: "費用を追加", exact: true }).click();
  await page.getByLabel("金額（円）", { exact: true }).fill("100");
  await page.getByRole("button", { name: "保存して入庫", exact: true }).click();
  await expect(page.getByRole("heading", { name: "テストの取引先", exact: true })).toBeVisible({
    timeout: 20000,
  });
  await expect(page.getByText("1点 ¥110.00", { exact: true })).toBeVisible();
  await expect(page.getByText("受取済み", { exact: true })).toBeVisible();
  await page.goto(`/products?q=${encodeURIComponent(name)}`);
  await page.locator(".commerce-select-row input[type=checkbox]").check();
  await page.getByRole("button", { name: "単品の販売商品を一括登録", exact: true }).click();
  await expect(page).toHaveURL(/tab=skus/);
  await page.getByRole("link", { name, exact: true }).click();
  await page.getByLabel("標準の販売価格（円）").fill("500");
  await page.getByRole("button", { name: "販売商品を保存", exact: true }).click();
  await expect(page).toHaveURL(/tab=skus/);
  const row = page
    .locator(".commerce-row")
    .filter({ has: page.getByRole("link", { name, exact: true }) });
  await row.getByRole("link", { name: "販売を記録", exact: true }).click();
  await expect(page.getByLabel("商品代金（円）")).toHaveValue("500");
  await page.getByLabel("販売手数料（円）").fill("50");
  await page.getByLabel("送料（円）", { exact: true }).fill("100");
  await page.getByRole("button", { name: "販売を記録", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible({ timeout: 20000 });
  await expect(page.getByText("¥240", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "返品を記録", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: `.tmp/redesign-ui/${testInfo.project.name}-recorded-sale.png`,
    fullPage: true,
    caret: "initial",
  });
  const sale = page.url();
  await page.getByRole("link", { name: "返金を記録", exact: true }).click();
  await page.getByLabel("売上返金（円）", { exact: true }).fill("100");
  await page.getByLabel("手数料返還（円）", { exact: true }).fill("0");
  await page.getByLabel("送料返還（円）", { exact: true }).fill("0");
  await page.getByLabel("返金・返還の理由", { exact: true }).fill("一部を返金");
  await confirmReturnPreview(page);
  await page.getByRole("button", { name: "在庫を変えずに返金を記録する", exact: true }).click();
  await expect(page.getByText("¥140", { exact: true })).toBeVisible({ timeout: 20000 });
  await page.goto(`/products?tab=skus&q=${encodeURIComponent(name)}`);
  await expect(
    page
      .locator(".commerce-row")
      .filter({ has: page.getByRole("link", { name, exact: true }) })
      .getByText("9 点", { exact: true }),
  ).toBeVisible();
  await page.goto(sale);
  await page.getByRole("link", { name: "返品を記録", exact: true }).click();
  await page.getByRole("combobox", { name: new RegExp("の処理$") }).selectOption("RESTOCK");
  await page.getByLabel("売上返金（円）", { exact: true }).fill("400");
  await page.getByLabel("手数料返還（円）", { exact: true }).fill("50");
  await page.getByLabel("送料返還（円）", { exact: true }).fill("0");
  await confirmReturnPreview(page);
  await page.getByRole("button", { name: "返品を記録する", exact: true }).click();
  await expect(page.getByText("¥-100", { exact: true })).toBeVisible({ timeout: 20000 });
  await page.goto(`/products?tab=skus&q=${encodeURIComponent(name)}`);
  await expect(
    page
      .locator(".commerce-row")
      .filter({ has: page.getByRole("link", { name, exact: true }) })
      .getByText("10 点", { exact: true }),
  ).toBeVisible();
});

test("誤登録の購入を履歴を残して取り消し、詳細を読み取り専用にする", async ({ page }, info) => {
  test.setTimeout(90000);
  await page.goto("/login");
  await page.getByLabel("ユーザー名").fill(E2E_READY_LOGIN);
  await page.getByLabel("パスワード").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  const name = `取消-${info.project.name}-${Date.now()}`;
  await page.goto("/purchases/new");
  await page.getByLabel("取引先", { exact: true }).fill(name);
  await page.getByLabel("商品名", { exact: true }).fill(name);
  await page.getByLabel("単価（円）").fill("100");
  const row = page.locator(".commerce-line-editor");
  await row.locator(".commerce-line-meta > details > summary").click();
  await row.getByLabel("用途・管理方法").selectOption("UNIQUE");
  await page.getByLabel("単品の販売商品も登録する", { exact: true }).check();
  await page.screenshot({
    path: `.tmp/redesign-ui/${info.project.name}-purchase-editor.png`,
    fullPage: true,
    caret: "initial",
  });
  await page.getByRole("button", { name: "保存して入庫", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible({ timeout: 20000 });
  const purchase = page.url(),
    detail = page.locator('details:has(> summary:text-is("誤って登録した購入を取り消す"))');
  await page.goto(`/products?tab=skus&q=${encodeURIComponent(name)}`);
  await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
  await page.goto(purchase);
  await page.getByRole("link", { name: "続けて購入を記録", exact: true }).click();
  await expect(page.getByLabel("取引先", { exact: true })).toHaveValue(name);
  await expect(page.getByLabel("単価（円）", { exact: true })).toHaveValue("");
  await page.goto(purchase);
  await detail.locator(":scope > summary").click();
  await detail.getByLabel("取消理由", { exact: true }).fill("重複して入力した");
  await detail.getByRole("checkbox").check();
  await detail.getByRole("button", { name: "購入を取り消す", exact: true }).click();
  await expect(page.getByText("取消済み", { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(page).toHaveURL(purchase);
  await page.reload();
  await expect(page.getByText("取消済み", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "配送を追加", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "支払を記録", exact: true })).toHaveCount(0);
  await page.getByText("記録の履歴", { exact: true }).click();
  await expect(page.getByText("購入を取消", { exact: true })).toBeVisible();
});
