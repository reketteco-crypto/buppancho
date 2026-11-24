import { test, expect } from "@playwright/test";
import { E2E_PASSWORD, E2E_READY_LOGIN } from "../../scripts/test/e2e-config";
import { workbookFixture } from "./import-fixtures";
test.use({ actionTimeout: 15000 });

test("取込値を保持して商品名を統一し、重量を補完して元名称の配送書類を照合する", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const name = `重量商品-${info.project.name}-${Date.now()}`,
    source = "尺寸:活動支架",
    reference = `R-${Date.now()}`;
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
  const costs = page.locator('details:has(> summary:has-text("送料・手数料・税額"))');
  await costs.locator(":scope > summary").click();
  await costs.getByRole("button", { name: "費用を追加", exact: true }).click();
  await costs.getByLabel("金額（円）", { exact: true }).fill("10");
  await costs.locator('details:has(> summary:has-text("配分・原価への反映")) > summary').click();
  await costs.getByRole("combobox", { name: "配分方法", exact: true }).selectOption("WEIGHT");
  await costs.getByLabel(`${name} · 1個の重量(g)`, { exact: true }).fill("25.5");
  await page.getByLabel("受取済み", { exact: true }).uncheck();
  await page.getByRole("button", { name: "購入を保存", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible({ timeout: 20000 });
  await page.goto("/purchases/new");
  const importer = page.locator('details:has(> summary:text-is("ファイルから入力"))');
  await importer.locator(":scope > summary").click();
  await importer.getByLabel("Excel・PDF").setInputFiles({
    name: "購入明細.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: workbookFixture("購入", [
      ["商品名", "数量", "単価", "通貨"],
      [source, "7", "12.34", "CNY"],
    ]),
  });
  await importer.getByRole("button", { name: "入力欄に反映", exact: true }).click();
  await page.getByLabel("取引先", { exact: true }).fill(name);
  const exchange = page.locator(
    'details:has(> summary:has-text("商品代金の通貨・換算・注文番号"))',
  );
  await expect(exchange).toHaveAttribute("open", "");
  await exchange.getByLabel(/^商品代金の換算レート/).fill("20");
  await exchange.getByLabel("注文番号", { exact: true }).fill(reference);
  await costs.locator(":scope > summary").click();
  await costs.getByRole("button", { name: "費用を追加", exact: true }).click();
  await costs.getByLabel("金額（CNY）", { exact: true }).fill("50");
  await costs.locator('details:has(> summary:has-text("配分・原価への反映")) > summary').click();
  await costs.getByRole("combobox", { name: "配分方法", exact: true }).selectOption("WEIGHT");
  await page.locator('details:has(> summary:has-text("支払")) > summary').click();
  await page.getByRole("combobox", { name: "支払方法", exact: true }).selectOption("PERSONAL");
  await page.getByLabel("支払額（円）", { exact: true }).fill("100");
  await page.getByLabel("受取済み", { exact: true }).uncheck();
  const financial = async () => ({
    quantity: await page.getByLabel("数量", { exact: true }).inputValue(),
    amount: await page.getByLabel("単価（CNY）", { exact: true }).inputValue(),
    currency: await exchange.getByLabel("通貨", { exact: true }).inputValue(),
    rate: await exchange.getByLabel(/^商品代金の換算レート/).inputValue(),
    reference: await exchange.getByLabel("注文番号", { exact: true }).inputValue(),
    fee: await costs.getByLabel("金額（CNY）", { exact: true }).inputValue(),
    method: await costs.getByRole("combobox", { name: "配分方法", exact: true }).inputValue(),
    payment: await page.getByLabel("支払額（円）", { exact: true }).inputValue(),
  });
  const before = await financial();
  let failures = 0;
  await page.route("**/api/commerce", async (route) => {
    const data = route.request().postDataJSON();
    if (data.action === "purchase-choices" && data.payload.q === name && failures < 2) {
      failures++;
      if (failures === 1) {
        await route.abort("internetdisconnected");
        return;
      }
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "検索を再読み込みしてください。" }),
      });
      return;
    }
    await route.continue();
  });
  const picker = page.locator(".commerce-product-selection");
  await picker.locator("summary").focus();
  await page.keyboard.press("Enter");
  await picker.getByLabel("商品名・コード・取引先を検索").fill(name);
  await expect(picker.getByRole("alert")).toContainText("通信できませんでした");
  await picker.getByRole("button", { name: "再読み込み", exact: true }).click();
  await expect(picker.getByRole("alert")).toContainText("再読み込み");
  await picker.getByRole("button", { name: "再読み込み", exact: true }).click();
  await expect(picker.locator(".commerce-product-choice")).toHaveCount(1);
  await picker.getByRole("tab", { name: "登録商品", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(picker.locator(".commerce-product-choice")).toContainText("2点 · 単価 100 JPY");
  await picker.locator(".commerce-product-picker").screenshot({
    path: `.tmp/redesign-ui/${info.project.name}-purchase-picker.png`,
    caret: "initial",
  });
  await picker.locator(".commerce-product-choice").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("商品名", { exact: true })).toHaveValue(name);
  await expect(costs.getByLabel(`${name} · 1個の重量(g)`, { exact: true })).toHaveValue("25.5");
  expect(await financial()).toEqual(before);
  await expect(page.getByText(`取込名 ${source}`, { exact: true })).toBeVisible();
  await page.screenshot({
    path: `.tmp/redesign-ui/${info.project.name}-purchase-product.png`,
    fullPage: true,
    caret: "initial",
  });
  const request = page.waitForRequest(
    (r) =>
      r.url().endsWith("/api/commerce") &&
      r.method() === "POST" &&
      r.postDataJSON().action === "save" &&
      r.postDataJSON().kind === "BUY",
  );
  await page.getByRole("button", { name: "購入を保存", exact: true }).click();
  const payload = (await request).postDataJSON().payload;
  expect(payload.lines[0]).toMatchObject({
    name,
    sourceName: source,
    quantity: 7,
    amount: "12.34",
    weight: "25.5",
    priceBasis: "UNIT",
  });
  expect(payload).toMatchObject({
    currency: "CNY",
    exchangeRate: "20",
    externalReference: reference,
    payment: { method: "PERSONAL", amount: "100" },
  });
  await expect(page.getByText(`取込名 ${source}`, { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(page).toHaveURL(/purchases\/[a-f0-9-]+$/);
  await page.getByRole("link", { name: "配送明細を取り込む", exact: true }).click();
  await expect(page).toHaveURL(/deliveries\/new\?purchase=[a-f0-9-]+&import=1$/);
  const deliveryImport = page.locator("[data-candidate-import]");
  await deliveryImport.getByLabel("Excel・PDF").setInputFiles({
    name: "配送明細.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: workbookFixture("配送依頼書詳細", [
      ["P0001", "1", reference, "", "", source, "", "", "7", "12.34"],
      ["", "", "", "", "", "", "", "", "", "国際運賃（円）", "100"],
    ]),
  });
  await deliveryImport.getByRole("button", { name: "入力欄に反映", exact: true }).click();
  await expect(page.getByLabel(`${name}の配送数量`)).toHaveValue("7");
  const deliveryCost = page.getByRole("group", { name: "国際運賃", exact: true });
  await deliveryCost
    .getByRole("combobox", { name: "配分方法", exact: true })
    .selectOption("WEIGHT");
  await expect(deliveryCost.getByLabel(`${name} · 1点の重量(g)`, { exact: true })).toHaveValue(
    "25.5",
  );
  await page.getByRole("button", { name: "配送を保存", exact: true }).click();
  await expect(page).toHaveURL(/deliveries\/[a-f0-9-]+$/, { timeout: 20000 });
  const additional = page.locator('details:has(> summary:text-is("費用を追加"))');
  await additional.locator(":scope > summary").click();
  await additional.getByRole("combobox", { name: "配分方法", exact: true }).selectOption("WEIGHT");
  await expect(additional.getByLabel(`${name} · 1点の重量(g)`, { exact: true })).toHaveValue(
    "25.5",
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
