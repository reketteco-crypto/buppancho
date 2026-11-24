import { confirmCompletionPreview, ensureTestContext } from "./helpers/completion";
import { expect, test, type Page } from "@playwright/test";
import { createQuantityStock } from "./helpers/workflow";

async function listing(page: Page, name: string, price: string) {
  await page.goto("/sales/listings/new");
  await page.getByLabel("商品名・色・サイズ・個体コードで検索").fill(name);
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await page
    .getByLabel("出品URLまたは商品ID")
    .fill("m" + Date.now().toString() + Math.floor(Math.random() * 10000).toString());
  await page.getByLabel("出品価格（円）").fill(price);
  await page.getByRole("button", { name: "出品を記録して在庫を確保", exact: true }).click();
  await expect(page.getByText("出品用に確保：1個")).toBeVisible();
  return page.url().split("?")[0]!;
}
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
test("AC-03 separate listings retain prices; completion uses the confirmed sale amount", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const name = `複数価格-${info.project.name}-${Date.now()}`;
  await createQuantityStock(page, name, 50);
  const first = await listing(page, name, "1280");
  await listing(page, name, "980");
  await page.getByRole("link", { name: "取引完了を記録", exact: true }).click();
  await page.getByLabel("実際に売れた金額").fill("900");
  await confirmCompletionPreview(page);
  await page.getByRole("button", { name: "完了を記録する", exact: true }).click();
  await expect(page).toHaveURL(/\/sales\/orders\/[0-9a-f-]+/);
  await expect(page.getByText("¥900", { exact: true })).toBeVisible();
  await page.goto(first);
  await expect(page.getByText("¥1,280", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("出品用に確保：1個")).toBeVisible();
});
test("AC-04/07 bundle listing reserves components and ending restores all holds", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const suffix = `${info.project.name}-${Date.now()}`;
  const names = [`セット用ケース-${suffix}`, `セット用フィルム-${suffix}`];
  await createQuantityStock(page, names[0]!, 7);
  await createQuantityStock(page, names[1]!, 14);
  await page.goto("/sales/listings/new");
  await page.getByLabel("売り方").selectOption("bundle");
  for (const label of names) {
    await page.getByLabel("商品名・色・サイズ・個体コードで検索").fill(label);
    await page.getByRole("button", { name: new RegExp(label) }).click();
  }
  await page.getByLabel("この出品に含める数").nth(1).fill("2");
  await page.getByLabel("セット名").fill("まとめ売り確認-" + info.project.name);
  await page
    .getByLabel("出品URLまたは商品ID")
    .fill("m" + Date.now().toString() + Math.floor(Math.random() * 10000).toString());
  await page.getByLabel("出品価格（円）").fill("5000");
  await page.getByRole("button", { name: "出品を記録して在庫を確保", exact: true }).click();
  await expect(page.getByText("出品用に確保：3個")).toBeVisible();
  const url = page.url().split("?")[0]!;
  await page.getByText("終了・キャンセル・返送／一時停止・再開", { exact: true }).click();
  await page.getByRole("combobox", { name: "起きたこと", exact: true }).selectOption("PAUSE");
  await page.getByLabel("理由・確認内容（必須）").fill("出品を停止した");
  await page.getByRole("button", { name: "出来事を記録する" }).click();
  await expect(page.getByText("一時停止", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("出品用に確保：3個")).toBeVisible();
  await page.goto(url);
  await page.getByText("終了・キャンセル・返送／一時停止・再開", { exact: true }).click();
  await page.getByRole("combobox", { name: "起きたこと", exact: true }).selectOption("END");
  await page.getByLabel("理由・確認内容（必須）").fill("商品を確認し販売をやめる");
  await page.getByLabel("構成商品すべての現物が手元にあることを確認した").check();
  await page.getByRole("button", { name: "出来事を記録する" }).click();
  await expect(page.getByText("終了", { exact: true })).toBeVisible();
  await expect(page.getByText("出品用に確保：0個")).toBeVisible();
  await page.goto(
    "/sales?filter=all&q=" + encodeURIComponent("まとめ売り確認-" + info.project.name),
  );
  await expect(page.locator(`a[href="${new URL(url).pathname}"]`)).toBeVisible();
});
