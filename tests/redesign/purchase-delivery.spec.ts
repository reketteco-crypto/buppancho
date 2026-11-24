import { test, expect } from "@playwright/test";
import { zipSync, strToU8 } from "fflate";
import { E2E_PASSWORD, E2E_READY_LOGIN } from "../../scripts/test/e2e-config";
import { invoicePdfFixture } from "./import-fixtures";
test("外貨購入を配送・分割受取し、後日費用を追加する", async ({ page }, info) => {
  test.setTimeout(120000);
  const name = `配送-${info.project.name}-${Date.now()}`;
  await page.goto("/login");
  await page.getByLabel("ユーザー名").fill(E2E_READY_LOGIN);
  await page.getByLabel("パスワード").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/purchases/new");
  await page.getByText("商品代金の通貨・換算・注文番号", { exact: false }).click();
  await page.getByLabel("通貨", { exact: true }).fill("USD");
  await page.getByLabel(/^商品代金の換算レート/).fill("10");
  await page.getByLabel("取引先", { exact: true }).fill(name);
  await page.getByLabel("商品名", { exact: true }).fill(name);
  await page.getByLabel("数量", { exact: true }).fill("10");
  await page.getByLabel("単価（USD）", { exact: true }).fill("10");
  await page.getByLabel("受取済み", { exact: true }).uncheck();
  await page.getByRole("button", { name: "購入を保存", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible({ timeout: 20000 });
  const purchase = page.url();
  await page.getByRole("link", { name: "配送を追加", exact: true }).click();
  await page.getByLabel(`${name}の配送数量`).fill("6");
  await page.getByText("配送費用を追加", { exact: false }).click();
  await page.getByRole("button", { name: "費用を追加", exact: true }).click();
  await page.getByLabel("金額（JPY）", { exact: true }).fill("60");
  await page.getByRole("button", { name: "配送を保存", exact: true }).click();
  await expect(page).toHaveURL(/deliveries\/[a-f0-9-]+$/, { timeout: 20000 });
  await page.goto(purchase);
  await page.locator('details:has(> summary:text-is("受取を記録")) > summary').click();
  await expect(page.getByLabel(`${name}の受取数量`)).toHaveValue("6");
  await page.getByRole("button", { name: "受取を記録", exact: true }).click();
  await expect(page.getByText("10 点 · 受取済み 6 点", { exact: true })).toBeVisible({
    timeout: 20000,
  });
  const cost = page.locator('details:has(> summary:text-is("費用を追加"))');
  await cost.locator(":scope > summary").click();
  await cost.getByLabel("費用名", { exact: true }).fill("検品料");
  await cost.getByLabel("金額（JPY）", { exact: true }).fill("100");
  await cost.getByLabel("理由", { exact: true }).fill("追加請求を確認");
  await cost.getByRole("button", { name: "費用を保存", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "原価への影響を確認", exact: true }),
  ).toBeVisible();
  await cost.getByRole("button", { name: "費用を保存", exact: true }).click();
  await expect(
    page
      .locator(".commerce-summary-line > span")
      .filter({ hasText: /^検品料/ })
      .first(),
  ).toBeVisible({ timeout: 20000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `.tmp/redesign-ui/${info.project.name}-delivery-cost.png`,
    fullPage: true,
    caret: "initial",
  });
});
test("Excelの内容は確認後に入力候補へ反映し、未確定のまま編集できる", async ({ page }) => {
  test.setTimeout(60000);
  await page.goto("/login");
  await page.getByLabel("ユーザー名").fill(E2E_READY_LOGIN);
  await page.getByLabel("パスワード").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/purchases/new");
  const xml =
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>商品名</t></is></c><c r="B1" t="inlineStr"><is><t>数量</t></is></c><c r="C1" t="inlineStr"><is><t>単価</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>取込候補</t></is></c><c r="B2"><v>3</v></c><c r="C2"><v>120</v></c></row></sheetData></worksheet>';
  const buffer = Buffer.from(zipSync({ "xl/worksheets/sheet1.xml": strToU8(xml) }));
  await page.locator('details:has(> summary:text-is("ファイルから入力")) > summary').click();
  await page
    .locator('details:has(> summary:text-is("ファイルから入力"))')
    .getByLabel("Excel・PDF")
    .setInputFiles({
      name: "candidate.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer,
    });
  await expect(page.getByRole("heading", { name: "読み取った入力候補" })).toBeVisible();
  await expect(page.getByLabel("商品名", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "入力欄に反映", exact: true }).click();
  await expect(page.getByLabel("商品名", { exact: true })).toHaveValue("取込候補");
  await expect(page.getByLabel("単価（円）", { exact: true })).toHaveValue("120");
  await expect(page.getByRole("button", { name: "保存して入庫", exact: true })).toBeVisible();
  await page.goto("/purchases/new");
  await page.locator('details:has(> summary:text-is("ファイルから入力")) > summary').click();
  await page
    .locator('details:has(> summary:text-is("ファイルから入力"))')
    .getByLabel("Excel・PDF")
    .setInputFiles({
      name: "invoice.pdf",
      mimeType: "application/pdf",
      buffer: invoicePdfFixture(),
    });
  await expect(page.getByRole("heading", { name: "読み取った入力候補" })).toBeVisible({
    timeout: 20000,
  });
  await expect(page.locator(".commerce-summary-line").filter({ hasText: "関税" })).toContainText(
    "1002 JPY",
  );
});
