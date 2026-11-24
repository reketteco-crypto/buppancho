import { confirmCompletionPreview, ensureTestContext } from "./helpers/completion";
import { expect, test } from "@playwright/test";
import { confirmStockPreview, confirmReturnPreview, createQuantityStock } from "./helpers/workflow";
test.beforeEach(async ({ page }) => {
  test.skip(
    !process.env.E2E_LOGIN_NAME || !process.env.E2E_PASSWORD,
    "Dedicated authenticated test environment required",
  );
  await page.goto("/login");
  await page.getByLabel("ユーザー名").fill(process.env.E2E_LOGIN_NAME!);
  await page.getByLabel("パスワード").fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(page.getByRole("heading", { name: "ホーム", exact: true })).toBeVisible();
  await ensureTestContext(page);
});
test("record listing, complete with unknown shipping, then supplement without another stock issue", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const name = `送料補完-${info.project.name}-${Date.now()}`;
  await createQuantityStock(page, name);
  await page.goto("/sales/listings/new");
  await page.getByLabel("商品名・色・サイズ・個体コードで検索").fill(name);
  await page.getByRole("button", { name: new RegExp(name) }).click();
  const external = `m${Date.now()}${info.project.name === "mobile" ? "1" : "2"}`;
  await page.getByLabel("出品URLまたは商品ID").fill(external);
  await page.getByLabel("出品価格（円）").fill("1280");
  await page.getByRole("button", { name: "出品を記録して在庫を確保", exact: true }).click();
  await expect(page.getByText("出品用に確保：1個")).toBeVisible();
  const listing = page.url().split("?")[0]!;
  await page.getByRole("link", { name: "取引完了を記録", exact: true }).click();
  await page.getByLabel("実際に売れた金額").fill("980");
  await page.getByLabel("販売手数料（円）").fill("98");
  await page.getByLabel("梱包費（円）").fill("0");
  await page.getByLabel("その他費用（円）").fill("0");
  await confirmCompletionPreview(page);
  await page.getByRole("button", { name: "完了を記録する", exact: true }).click();
  await expect(page).toHaveURL(/\/sales\/orders\/[a-f0-9-]+/);
  await expect(page.getByText("計算に必要な情報が不足", { exact: true })).toBeVisible();
  await page.getByLabel("負担送料（円）").fill("210");
  await page.getByLabel("補完・訂正の理由").fill("メルカリの送料を確認");
  await page.getByRole("button", { name: "金額を補完・訂正する" }).click();
  await expect(page.getByText("管理利益", { exact: true })).toBeVisible();
  await page.goto(listing);
  await expect(page.getByText("完了記録済み", { exact: true })).toBeVisible();
  await page.goto(`/sales?filter=all&q=${external}`);
  await expect(page.getByText(external, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("sales-all.png"), fullPage: true });
});
test("incomplete purchase survives leaving and resuming without receiving inventory", async ({
  page,
}, info) => {
  await page.goto("/purchases/new");
  const reference = `到着待ち-${Date.now()}-${info.project.name}`;
  await page.getByLabel("注文番号（任意）").fill(reference);
  await page.getByLabel("仕入総額（円）").fill("1234");
  await expect(page.getByRole("status").filter({ hasText: "保存済み" })).toBeVisible();
  await expect(page).toHaveURL(/draft=/);
  const draft = page.url();
  await page.goto("/");
  await page.goto(draft);
  await expect(page.getByLabel("注文番号（任意）")).toHaveValue(reference);
  await expect(page.getByLabel("仕入総額（円）")).toHaveValue("1234");
  await page.screenshot({ path: info.outputPath("purchase-draft.png"), fullPage: true });
});

test("saved purchase editing resumes in the same purchase without receiving stock", async ({
  page,
}) => {
  await page.goto("/purchases/new");
  await page.getByRole("button", { name: "3. 内容確認", exact: true }).click();
  await page.getByRole("button", { name: "同じ商品を数量で管理する", exact: true }).click();
  await page.getByLabel("明細原価総額（円）").fill("100");
  await page.getByLabel("仕入総額（円）").fill("100");
  await page.getByRole("button", { name: "内容を保存して入庫確認へ", exact: true }).click();
  await expect(page).toHaveURL(/\/purchases\/[a-f0-9-]+(?:\?recorded=1)?$/);
  const purchase = page.url().split("?")[0]!;
  await page.goto(`${purchase}/edit`);
  await page.getByLabel("注文番号（任意）").fill("編集の途中保存確認");
  await expect(page).toHaveURL(/draft=/);
  const draft = page.url();
  await page.goto("/");
  await page.goto(draft);
  await expect(page.getByLabel("注文番号（任意）")).toHaveValue("編集の途中保存確認");
  await page.getByRole("button", { name: "3. 内容確認", exact: true }).click();
  await page.getByRole("button", { name: "内容を保存して入庫確認へ", exact: true }).click();
  await expect(page).toHaveURL(`${purchase}?recorded=1`);
  await expect(
    page.getByRole("button", { name: "入庫して在庫に加える", exact: true }),
  ).toBeVisible();
});

test("unique item completes and a confirmed good return restores the individual", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  // This scenario must create its own individual, rather than depend on another spec running first.
  const name = `個体返品-${info.project.name}-${Date.now()}`;
  await page.goto("/purchases/new");
  await page.getByRole("button", { name: "3. 内容確認", exact: true }).click();
  await page.getByRole("button", { name: "新しい商品を作成", exact: true }).click();
  await page.getByLabel("商品名", { exact: true }).fill(name);
  await page.getByRole("button", { name: "組合せを生成", exact: true }).click();
  await page.getByRole("button", { name: "商品を作成して仕入れに追加", exact: true }).click();
  await page.getByLabel("商品・色やサイズ").selectOption({ label: `新規: ${name} / 標準` });
  await page.getByRole("combobox", { name: "管理方法", exact: true }).selectOption("UNIQUE");
  await page.getByLabel("個別原価（円）").fill("10000");
  await page.getByLabel("状態", { exact: true }).fill("個体返品の実機相当検証");
  await page.getByLabel("仕入総額（円）").fill("10000");
  await page.getByRole("button", { name: "内容を保存して入庫確認へ", exact: true }).click();
  await expect(page).toHaveURL(/\/purchases\/[a-f0-9-]+\?recorded=1$/);
  const receive = page.getByRole("button", { name: "入庫して在庫に加える", exact: true });
  await confirmStockPreview(receive);
  await receive.click();
  await expect(page.getByText("確定", { exact: true }).first()).toBeVisible();
  await page.goto("/sales/listings/new");
  await page.getByLabel("商品名・色・サイズ・個体コードで検索").fill(name);
  const unit = page.getByRole("button", { name: /UNIT-.*出品に使える 1/ }).first();
  await expect(unit).toBeEnabled();
  const label = await unit.innerText();
  const code = label.match(/UNIT-\d+/)![0];
  await unit.click();
  await page.getByLabel("出品URLまたは商品ID").fill(`m${Date.now()}9`);
  await page.getByLabel("出品価格（円）").fill("15000");
  await page.getByRole("button", { name: "出品を記録して在庫を確保", exact: true }).click();
  await expect(page.getByText("出品用に確保：1個")).toBeVisible();
  await page.getByRole("link", { name: "取引完了を記録", exact: true }).click();
  await confirmCompletionPreview(page);
  await page.getByRole("button", { name: "完了を記録する", exact: true }).click();
  await expect(page).toHaveURL(/\/sales\/orders\/[a-f0-9-]+/);
  await page.getByRole("link", { name: "返品を記録", exact: true }).click();
  await page.getByRole("combobox", { name: /の処理$/ }).selectOption("RESTOCK");
  await page.getByLabel("売上返金の確認", { exact: true }).selectOption("AMOUNT");
  await page.getByLabel("売上返金（円）", { exact: true }).fill("15000");
  await page.getByLabel("手数料返還の確認", { exact: true }).selectOption("NONE");
  await page.getByLabel("送料返還の確認", { exact: true }).selectOption("NONE");
  await confirmReturnPreview(page);
  await page.getByRole("button", { name: "返品を記録する", exact: true }).click();
  await expect(page).toHaveURL(/\/sales\/orders\/[a-f0-9-]+\?return=/);
  await expect(page.getByRole("heading", { name: "返品・返金履歴" })).toBeVisible();
  await page.goto("/sales/listings/new");
  await page.getByLabel("商品名・色・サイズ・個体コードで検索").fill(code);
  await expect(
    page.getByRole("button", { name: new RegExp(`${code}.*出品に使える 1`) }),
  ).toBeEnabled();
});
