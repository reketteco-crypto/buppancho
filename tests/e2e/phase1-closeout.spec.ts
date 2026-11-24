import { ensureTestContext } from "./helpers/completion";
import { expect, test, type Locator, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("ユーザー名").fill(process.env.E2E_LOGIN_NAME!);
  await page.getByLabel("パスワード").fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page.getByRole("heading", { name: "ホーム" })).toBeVisible();
  await ensureTestContext(page);
}

async function selectMatching(select: Locator, label: RegExp) {
  await expect(select).toContainText(label);
  const value = await select
    .locator("option")
    .evaluateAll(
      (options, pattern) =>
        options
          .find((option) => new RegExp(pattern).test(option.textContent ?? ""))
          ?.getAttribute("value"),
      label.source,
    );
  expect(value).toBeTruthy();
  await select.selectOption(value!);
  return value!;
}

test.beforeEach(async ({ page }) => {
  test.skip(
    !process.env.E2E_LOGIN_NAME || !process.env.E2E_PASSWORD,
    "認証済み画面用のE2Eアカウントが設定された実行で確認します。",
  );
  await login(page);
});

test("mixed purchase, location filter, cancellation guard and immutable item code", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const suffix = testInfo.project.name;
  const itemName = `混在仕入商品-${suffix}-${Date.now()}`;

  await page.goto("/purchases/new");
  await page.getByRole("button", { name: "3. 内容確認", exact: true }).click();
  await expect(page.getByRole("heading", { name: "仕入れを記録する" })).toBeVisible();
  await page.getByRole("button", { name: "新しい商品を作成" }).click();
  await page.getByLabel("商品名").fill(itemName);
  await page.getByRole("button", { name: "組合せを生成" }).click();
  await page.getByRole("button", { name: "商品を作成して仕入れに追加" }).click();
  await page.getByRole("button", { name: "1点ずつ状態・原価を管理する" }).click();
  const variantOption = page.getByLabel("商品・色やサイズ");
  await variantOption.nth(0).selectOption({ label: `新規: ${itemName} / 標準` });
  await variantOption.nth(1).selectOption({ label: `新規: ${itemName} / 標準` });
  await page.getByLabel("仕入時の商品名").nth(0).fill(`${itemName} 新品`);
  await page.getByLabel("仕入時の商品名").nth(1).fill(`${itemName} 中古`);
  await page.getByRole("spinbutton", { name: "数量", exact: true }).fill("50");
  await page.getByLabel("明細原価総額（円）").fill("50000");
  await page.getByLabel("個別原価（円）").fill("10000");
  await page.getByLabel("状態", { exact: true }).nth(1).fill("使用感あり");
  await page.getByLabel("仕入総額（円）").fill("60000");
  await page.getByRole("button", { name: "内容を保存して入庫確認へ" }).click();

  await expect(page).toHaveURL(/\/purchases\/[0-9a-f-]+(?:\?recorded=1)?$/);
  await expect(page.getByRole("heading", { name: "仕入れ", exact: true })).toBeVisible();
  const purchaseUrl = page.url();
  await page.getByRole("button", { name: "入庫して在庫に加える" }).click();
  await expect(page.getByText("確定", { exact: true }).first()).toBeVisible();

  await page.goto("/inventory");
  await page.getByLabel("検索").fill(itemName);
  await page.getByRole("button", { name: "検索" }).click();
  await expect(page.getByRole("link", { name: new RegExp(itemName) })).toBeVisible();
  await page.getByRole("link", { name: new RegExp(itemName) }).click();
  await expect(page.getByText("51点")).toBeVisible();
  await page.locator("summary").filter({ hasText: "基本情報を編集" }).click();
  await expect(page.getByText("商品コードは登録後に変更できません。")).toBeVisible();
  await expect(page.getByLabel("商品コード")).toHaveCount(0);

  await page.goto("/inventory/operations/new");
  await selectMatching(
    page.locator("#inventory-operation-variant"),
    new RegExp(`${itemName}.*数量`),
  );
  await selectMatching(page.getByLabel("移動元"), /主保管場所/);
  const subLocationId = await selectMatching(page.getByLabel("移動先"), /副保管場所/);
  await page.getByRole("spinbutton", { name: "数量", exact: true }).fill("1");
  await page.getByRole("button", { name: "在庫操作を記録" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "在庫操作を記録しました" }),
  ).toBeVisible();

  await page.goto(`/inventory?location=${subLocationId}`);
  await expect(page.getByRole("link", { name: new RegExp(itemName) })).toBeVisible();

  await page.goto(purchaseUrl);
  await page.getByPlaceholder("取消理由").fill("後続移動確認");
  await page.getByRole("button", { name: "仕入れを取り消す" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "取消できません" })).toBeVisible();
});

test("inventory list keeps filters and supports page 2", async ({ page }) => {
  await page.goto(
    "/inventory?q=%E3%83%9A%E3%83%BC%E3%82%B8%E3%83%B3%E3%82%B0%E5%95%86%E5%93%81&type=QUANTITY&stock=no&status=ACTIVE&page=2",
  );
  await expect(page.getByLabel("検索")).toHaveValue("ページング商品");
  await expect(page.getByLabel("管理種別")).toHaveValue("QUANTITY");
  await expect(page.getByLabel("在庫")).toHaveValue("no");
  await expect(page.getByLabel("状態")).toHaveValue("ACTIVE");
  await expect(page.getByText("51件")).toBeVisible();
  await expect(page.getByText(/2 \/ 2ページ/)).toBeVisible();
  await expect(page.getByRole("link", { name: /ページング商品-/ })).toHaveCount(1);
  const previousHref = await page.getByRole("link", { name: "前へ" }).getAttribute("href");
  expect(previousHref).toContain("q=");
  expect(previousHref).toContain("type=QUANTITY");
  expect(previousHref).toContain("stock=no");
  expect(previousHref).not.toContain("page=");
});

test("untouched finalized purchase can be cancelled", async ({ page }, testInfo) => {
  const sourceName = `取消確認-${testInfo.project.name}`;
  await page.goto("/purchases/new");
  await page.getByRole("button", { name: "3. 内容確認", exact: true }).click();
  await page.getByRole("button", { name: "同じ商品を数量で管理する" }).click();
  await expect(page.getByLabel("商品・色やサイズ")).toContainText("ページング商品-001");
  await page.getByLabel("仕入時の商品名").fill(sourceName);
  await page.getByRole("spinbutton", { name: "数量", exact: true }).fill("1");
  await page.getByLabel("明細原価総額（円）").fill("1000");
  await page.getByLabel("仕入総額（円）").fill("1000");
  await page.getByRole("button", { name: "内容を保存して入庫確認へ" }).click();
  await expect(page).toHaveURL(/\/purchases\/[0-9a-f-]+(?:\?recorded=1)?$/);

  await page.getByRole("button", { name: "入庫して在庫に加える" }).click();
  await expect(page.getByText("確定", { exact: true }).first()).toBeVisible();
  await page.getByPlaceholder("取消理由").fill("E2E取消成功確認");
  await page.getByRole("button", { name: "仕入れを取り消す" }).click();
  await expect(page.getByText("取消", { exact: true }).first()).toBeVisible();
});
