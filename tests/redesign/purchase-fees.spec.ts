import { test, expect, type Page } from "@playwright/test";
import { E2E_PASSWORD, E2E_READY_LOGIN } from "../../scripts/test/e2e-config";
import { invoicePdfFixture, workbookFixture } from "./import-fixtures";

async function newPurchase(page: Page, name: string) {
  await page.goto("/login");
  await page.getByLabel("ユーザー名").fill(E2E_READY_LOGIN);
  await page.getByLabel("パスワード").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/purchases/new");
  await page.getByLabel("取引先", { exact: true }).fill(name);
  await page.getByLabel("商品名", { exact: true }).fill(name);
  await page.getByLabel("数量", { exact: true }).fill("2");
  await page.getByLabel("単価（円）", { exact: true }).fill("100");
  await page.getByLabel("受取済み", { exact: true }).uncheck();
}

test("購入の費用を枠で区切り、PDFの追加・費用別換算・削除を確認する", async ({ page }, info) => {
  test.setTimeout(120000);
  const name = `費用表示-${info.project.name}-${Date.now()}`;
  await newPurchase(page, name);
  const importer = page.locator('details:has(> summary:text-is("送料・税額のファイルから追加"))');
  await importer.locator(":scope > summary").focus();
  await page.keyboard.press("Enter");
  await importer.getByLabel("Excel・PDF").setInputFiles({
    name: "通関費用.pdf",
    mimeType: "application/pdf",
    buffer: invoicePdfFixture(),
  });
  await expect(importer.getByRole("heading", { name: "読み取った入力候補" })).toBeVisible({
    timeout: 20000,
  });
  await expect(page.getByRole("group", { name: "関税", exact: true })).toHaveCount(0);
  await importer.getByRole("button", { name: "費用の入力欄に反映", exact: true }).click();
  const costs = page.locator('details:has(> summary:has-text("送料・手数料・税額"))');
  const tax = costs.getByRole("group", { name: "関税", exact: true });
  await expect(tax.getByLabel("金額（円）", { exact: true })).toHaveValue("1002");
  if (info.project.name === "mobile") {
    const nameBox = await tax.getByLabel("費用名", { exact: true }).boundingBox();
    const amountBox = await tax.getByLabel("金額（円）", { exact: true }).boundingBox();
    expect(amountBox!.y).toBeGreaterThan(nameBox!.y + nameBox!.height);
    expect(amountBox!.x).toBe(nameBox!.x);
  }
  await expect(page.getByLabel("商品名", { exact: true })).toHaveValue(name);
  await costs.getByRole("button", { name: "費用を追加", exact: true }).click();
  await costs
    .getByRole("group", { name: "手数料", exact: true })
    .getByLabel("費用名", { exact: true })
    .fill("国際送料");
  const shipping = costs.getByRole("group", { name: "国際送料", exact: true });
  await shipping.getByText("この費用の通貨・換算", { exact: true }).click();
  await shipping.getByLabel("通貨", { exact: true }).fill("CNY");
  await shipping.getByLabel("1通貨あたりの円").fill("20");
  await shipping.getByLabel("金額（CNY）", { exact: true }).fill("40");
  await expect(tax.getByLabel("金額（円）", { exact: true })).toHaveValue("1002");
  await expect(page.locator(".commerce-total")).toHaveText("¥2,002");
  const remove = shipping.getByRole("button", { name: "国際送料を削除", exact: true });
  const removeBox = await remove.boundingBox(),
    inputBox = await shipping.getByLabel("費用名", { exact: true }).boundingBox();
  expect(removeBox!.y + removeBox!.height).toBeLessThan(inputBox!.y);
  await page.screenshot({
    path: `.tmp/redesign-ui/${info.project.name}-purchase-fees.png`,
    fullPage: true,
    caret: "initial",
  });
  await tax.getByRole("button", { name: "関税を削除", exact: true }).click();
  await expect(costs.locator(".commerce-charge-group")).toHaveCount(1);
  await expect(shipping.getByLabel("金額（CNY）", { exact: true })).toHaveValue("40");
  await expect(page.locator(".commerce-total")).toHaveText("¥1,000");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "購入を保存", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible({ timeout: 20000 });
  await expect(
    page
      .locator(".commerce-charge-editor > .commerce-summary-line")
      .filter({ hasText: "国際送料" }),
  ).toContainText("¥800");
});

test("購入詳細の入口から配送Excelと通関PDFを配送へ追加する", async ({ page }, info) => {
  test.setTimeout(120000);
  const name = `書類取込-${info.project.name}-${Date.now()}`;
  const reference = `ORDER-${Date.now()}`;
  await newPurchase(page, name);
  await page.getByText("商品代金の通貨・換算・注文番号", { exact: false }).click();
  await page.getByLabel("注文番号", { exact: true }).fill(reference);
  await page.getByRole("button", { name: "購入を保存", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible({ timeout: 20000 });
  await page.getByRole("link", { name: "配送明細を取り込む", exact: true }).click();
  await expect(page).toHaveURL(/deliveries\/new\?purchase=[a-f0-9-]+&import=1$/);
  const importer = page.locator(
    'details:has(> summary:text-is("配送明細・送料のファイルから入力"))',
  );
  await expect(importer.getByLabel("Excel・PDF")).toBeVisible();
  const rows = [
    ["P0001", "1", reference, "", "", name, "", "", "2", "100"],
    ["", "", "", "", "", "", "", "", "", "国際運賃（円）", "300"],
    ["", "", "", "", "", "", "", "", "", "代行手数料（円）", "25"],
  ];
  await importer.getByLabel("Excel・PDF").setInputFiles({
    name: "配送依頼書.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: workbookFixture("配送依頼書詳細", rows),
  });
  await expect(importer.getByRole("heading", { name: "読み取った入力候補" })).toBeVisible();
  await expect(page.getByLabel(`${name}の配送数量`)).toHaveValue("0");
  await importer.getByRole("button", { name: "入力欄に反映", exact: true }).click();
  await expect(page.getByLabel(`${name}の配送数量`)).toHaveValue("2");
  await expect(page.getByRole("group", { name: "代行手数料", exact: true })).toHaveCount(0);
  await expect(
    page
      .getByRole("group", { name: "国際運賃", exact: true })
      .getByLabel("金額（JPY）", { exact: true }),
  ).toHaveValue("300");
  await page.getByRole("button", { name: "配送を保存", exact: true }).click();
  await expect(page).toHaveURL(/deliveries\/[a-f0-9-]+$/, { timeout: 20000 });
  const importButton = page.getByRole("button", { name: "ファイルから費用を追加", exact: true });
  await expect(importButton).toBeEnabled();
  await importButton.focus();
  await page.keyboard.press("Enter");
  const costs = page.locator('details:has(> summary:text-is("費用を追加"))');
  const file = costs.getByLabel("Excel・PDF");
  await expect(file).toBeFocused();
  await file.setInputFiles({
    name: "関税請求書.pdf",
    mimeType: "application/pdf",
    buffer: invoicePdfFixture(),
  });
  await expect(costs.getByRole("heading", { name: "読み取った入力候補" })).toBeVisible({
    timeout: 20000,
  });
  await costs.getByRole("button", { name: "費用の入力欄に反映", exact: true }).click();
  await costs.getByLabel("理由", { exact: true }).fill("通関費用の請求を確認");
  await costs.getByRole("button", { name: "費用を保存", exact: true }).click();
  await expect(
    page.locator(".commerce-charge-editor > .commerce-summary-line").filter({ hasText: /^関税/ }),
  ).toContainText("¥1,002", { timeout: 20000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("購入への国際送料追加で代行手数料を重複させず、入力済み費用を保つ", async ({ page }, info) => {
  const name = `送料重複確認-${info.project.name}-${Date.now()}`;
  await newPurchase(page, name);
  const costs = page.locator('details:has(> summary:has-text("送料・手数料・税額"))');
  await costs.locator(":scope > summary").click();
  await costs.getByRole("button", { name: "費用を追加", exact: true }).click();
  await costs
    .getByRole("group", { name: "送料", exact: true })
    .getByLabel("費用名")
    .fill("代行手数料");
  const fee = costs.getByRole("group", { name: "代行手数料", exact: true });
  await fee.getByLabel("金額（円）", { exact: true }).fill("25");
  const importer = page.locator('details:has(> summary:text-is("送料・税額のファイルから追加"))');
  await importer.locator(":scope > summary").click();
  await importer.getByLabel("Excel・PDF").setInputFiles({
    name: "国際送料.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: workbookFixture("配送依頼書詳細", [
      ["P0001", "1", "ORDER001", "", "", name, "", "", "2", "100"],
      ["", "", "", "", "", "", "", "", "", "国際運賃（円）", "300"],
      ["", "", "", "", "", "", "", "", "", "代行手数料（円）", "25"],
    ]),
  });
  await expect(importer.getByRole("heading", { name: "読み取った入力候補" })).toBeVisible();
  await expect(importer).not.toContainText("代行手数料");
  await importer.getByRole("button", { name: "費用の入力欄に反映", exact: true }).click();
  await expect(costs.getByRole("group", { name: "代行手数料", exact: true })).toHaveCount(1);
  await expect(fee.getByLabel("金額（円）", { exact: true })).toHaveValue("25");
  await expect(
    costs
      .getByRole("group", { name: "国際運賃", exact: true })
      .getByLabel("金額（円）", { exact: true }),
  ).toHaveValue("300");
  await expect(page.locator(".commerce-total")).toHaveText("¥525");
});
