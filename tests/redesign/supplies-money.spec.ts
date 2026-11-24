import { test, expect } from "@playwright/test";
import { E2E_PASSWORD, E2E_READY_LOGIN } from "../../scripts/test/e2e-config";
test("資材・備品の購入と販売、追加使用、経費、口座間振替を記録する", async ({ page }, info) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(15000);
  const token = `${info.project.name}-${Date.now()}`,
    wallet = `口座-${token}`,
    deposit = `預け金-${token}`,
    product = `商品-${token}`,
    material = `資材-${token}`;
  await page.goto("/login");
  await page.getByLabel("ユーザー名").fill(E2E_READY_LOGIN);
  await page.getByLabel("パスワード").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  for (const [name, balance] of [
    [wallet, "1000"],
    [deposit, "0"],
  ] as const) {
    await page.goto("/money");
    const detail = page.locator('details:has(> summary:text-is("口座を追加"))');
    await detail.locator(":scope > summary").click();
    await detail.getByLabel("口座名").fill(name);
    await detail.getByLabel("開始残高（円）").fill(balance);
    await detail.getByRole("button", { name: "口座を保存", exact: true }).click();
    await expect(
      page.locator(".commerce-row").filter({ has: page.getByText(name, { exact: true }) }),
    ).toBeVisible({ timeout: 20000 });
  }
  await page.getByRole("link", { name: "その他の経費を記録", exact: true }).click();
  await page.getByLabel("項目", { exact: true }).fill(`経費-${token}`);
  await page.getByLabel("項目", { exact: true }).press("Tab");
  await expect(page.getByLabel("金額（円）", { exact: true })).toBeFocused();
  await page.getByLabel("金額（円）", { exact: true }).fill("1");
  await page
    .getByRole("combobox", { name: "口座", exact: true })
    .selectOption({ label: `${wallet} · ¥1,000` });
  await page.getByLabel("金額（円）", { exact: true }).press("Enter");
  await expect(page).toHaveURL(/\/money(?:\?|$)/);
  await expect(
    page.locator(".commerce-row").filter({ has: page.getByText(wallet, { exact: true }) }),
  ).toContainText("¥999");
  await page.getByRole("link", { name: /^口座間の移動/ }).click();
  const transfer = page.locator(".commerce-editor > form");
  await transfer
    .getByRole("combobox", { name: "振替元", exact: true })
    .selectOption({ label: `${wallet} · ¥999` });
  await transfer
    .getByRole("combobox", { name: "振替先", exact: true })
    .selectOption({ label: deposit });
  await transfer.getByLabel("金額（円）", { exact: true }).fill("100");
  await transfer.getByLabel("振込手数料（円）").fill("10");
  await transfer.getByRole("button", { name: "振替を記録", exact: true }).click();
  await expect(
    page.locator(".commerce-row").filter({ has: page.getByText(wallet, { exact: true }) }),
  ).toContainText("¥889");
  await page.goto("/purchases/new");
  await page.getByLabel("取引先", { exact: true }).fill(`取引先-${token}`);
  const rows = page.locator(".commerce-line-editor");
  await rows.nth(0).getByLabel("商品名", { exact: true }).fill(product);
  await rows.nth(0).getByLabel("数量", { exact: true }).fill("2");
  await rows.nth(0).getByLabel("単価（円）", { exact: true }).fill("100");
  for (const [i, name, purpose, quantity, amount] of [
    [1, material, "MATERIAL", "100", "10"],
    [2, `備品-${token}`, "EQUIPMENT", "1", "500"],
  ] as const) {
    await page.getByRole("button", { name: "明細を追加", exact: true }).click();
    const row = rows.nth(i);
    await row.locator(".commerce-line-meta > details > summary").click();
    await row.getByLabel("用途・管理方法").selectOption(purpose);
    await row.getByLabel("商品名", { exact: true }).fill(name);
    await row.getByLabel("数量", { exact: true }).fill(quantity);
    await row.getByLabel("単価（円）", { exact: true }).fill(amount);
  }
  await page.getByRole("button", { name: "保存して入庫", exact: true }).click();
  await expect(page.getByRole("heading", { name: `取引先-${token}`, exact: true })).toBeVisible({
    timeout: 20000,
  });
  await page.goto(`/products?tab=supplies&q=${encodeURIComponent(material)}`);
  await page.getByRole("link", { name: material, exact: true }).click();
  await page.getByRole("link", { name: "編集", exact: true }).click();
  await page.getByLabel("メモ", { exact: true }).fill("手動編集を確認");
  await page.getByRole("button", { name: "変更を保存", exact: true }).click();
  await expect(page).toHaveURL(/tab=supplies/);
  await page.goto(`/products?q=${encodeURIComponent(product)}`);
  await page.locator(".commerce-select-row input[type=checkbox]").check();
  await page.getByRole("button", { name: "単品の販売商品を一括登録", exact: true }).click();
  await expect(page).toHaveURL(/tab=skus/);
  await page.getByRole("link", { name: product, exact: true }).click();
  await page.getByLabel("標準の販売価格（円）").fill("500");
  const supplies = page.locator('details:has(> summary:has-text("資材・梱包"))');
  await supplies.locator(":scope > summary").click();
  await supplies.getByRole("button", { name: "資材を追加", exact: true }).click();
  await supplies
    .getByRole("combobox", { name: "資材", exact: true })
    .selectOption({ label: material });
  await supplies.getByLabel("1販売単位あたりの使用量").fill("2");
  await page.getByRole("button", { name: "販売商品を保存", exact: true }).click();
  await expect(page).toHaveURL(/tab=skus/);
  await page
    .locator(".commerce-row")
    .filter({ has: page.getByRole("link", { name: product, exact: true }) })
    .getByRole("link", { name: "販売を記録", exact: true })
    .click();
  await page.getByLabel("販売手数料（円）").fill("50");
  await page.getByLabel("送料（円）", { exact: true }).fill("100");
  await expect(page.locator('details:has(> summary:has-text("資材の使用"))')).toContainText("¥20");
  await page.getByRole("button", { name: "販売を記録", exact: true }).click();
  await expect(page.getByRole("heading", { name: product, exact: true })).toBeVisible({
    timeout: 20000,
  });
  await expect(page.getByText("¥230", { exact: true })).toBeVisible();
  const sale = page.url(),
    extra = page.locator('details:has(> summary:text-is("資材の追加使用"))');
  await extra.locator(":scope > summary").click();
  await extra
    .getByRole("combobox", { name: "資材", exact: true })
    .selectOption({ label: material });
  await extra.getByLabel("理由", { exact: true }).fill("梱包をやり直した");
  await extra.getByRole("button", { name: "資材使用を保存", exact: true }).click();
  await expect(page.getByText("¥220", { exact: true })).toBeVisible({ timeout: 20000 });
  await page.getByRole("link", { name: "再送料・追加費用", exact: true }).click();
  await page.getByLabel("金額（円）", { exact: true }).fill("25");
  await page
    .getByRole("combobox", { name: "口座", exact: true })
    .selectOption({ label: `${wallet} · ¥889` });
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page).toHaveURL(/\/money(?:\?|$)/);
  await expect(
    page.locator(".commerce-row").filter({ has: page.getByText(wallet, { exact: true }) }),
  ).toContainText("¥864");
  await page.goto(sale);
  await expect(page.getByText("¥195", { exact: true })).toBeVisible();
  await page.screenshot({
    path: `.tmp/redesign-ui/${info.project.name}-materials-sale.png`,
    fullPage: true,
    caret: "initial",
  });
  await page.goto("/money/reports");
  await expect(page.getByRole("heading", { name: "収支・残高", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `.tmp/redesign-ui/${info.project.name}-business-report.png`,
    fullPage: true,
    caret: "initial",
  });
});
