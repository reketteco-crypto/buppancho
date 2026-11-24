import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { ensureTestContext } from "./helpers/completion";
import { createQuantityStock } from "./helpers/workflow";
import { percentDisplay } from "@/lib/sales/money";

let db: PrismaClient;
test.beforeAll(() => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  if (!new URL(url).pathname.endsWith("_test")) throw new Error("専用DBが必要です。");
  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
});
test.afterAll(async () => {
  await db?.$disconnect();
});
async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("ユーザー名").fill(process.env.E2E_LOGIN_NAME!);
  await page.getByLabel("パスワード").fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(page.getByRole("heading", { name: "ホーム", exact: true })).toBeVisible();
  await ensureTestContext(page);
}
test.beforeEach(async ({ page }) => {
  test.skip(
    !db || !process.env.E2E_LOGIN_NAME || !process.env.E2E_PASSWORD,
    "専用テスト環境が必要です。",
  );
  await login(page);
});

test("bundle estimates keep the last yen, expenses remain unknown until explicit zero, and saved templates and relisting keep their meaning", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const name = `原価端数セット-${info.project.name}-${Date.now()}`;
  await createQuantityStock(page, name, 3, "1000");
  await page.goto("/sales/listings/new");
  await page.getByRole("combobox", { name: "売り方", exact: true }).selectOption("bundle");
  await page.getByLabel("商品名・色・サイズ・個体コードで検索", { exact: true }).fill(name);
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await page.getByLabel("この出品に含める数", { exact: true }).fill("3");
  await page.getByLabel("セット名", { exact: false }).fill(name);
  await page
    .getByLabel("出品URLまたは商品ID", { exact: false })
    .fill(`m${BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 16)}`)}`);
  await page.getByLabel("出品価格（円）", { exact: false }).fill("1280");
  await expect(page.getByText(/計算に必要な情報が不足：.*見込み送料/)).toBeVisible();
  await page.getByText("詳しい情報を追加", { exact: true }).click();
  for (const label of ["見込み送料（円）", "見込み梱包費（円）", "見込みその他費用（円）"])
    await page.getByLabel(label, { exact: true }).fill("0");
  await expect(page.getByText("見込み利益：¥152", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "出品を記録して在庫を確保", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByText("見込み利益：¥152", { exact: true })).toBeVisible();
  await page.getByText("終了・キャンセル・返送／一時停止・再開", { exact: true }).click();
  await page.getByRole("combobox", { name: "起きたこと", exact: true }).selectOption("END");
  await page
    .getByLabel("理由・確認内容（必須）", { exact: true })
    .fill("見込みと構成の再利用を確認");
  await page.getByLabel("構成商品すべての現物が手元にあることを確認した", { exact: true }).check();
  await page.getByRole("button", { name: "出来事を記録する", exact: true }).click();
  await expect(page.getByText("出品用に確保：0個", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "この内容で再出品を記録", exact: true }).click();
  await expect(page.getByLabel("出品URLまたは商品ID", { exact: false })).toHaveValue("");
  await page.getByText("詳しい情報を追加", { exact: true }).click();
  await expect(page.getByLabel("見込み梱包費（円）", { exact: true })).toHaveValue("0");
  await expect(page.getByText("見込み利益：¥152", { exact: true })).toBeVisible();
  await page.goto("/sales/listings/new");
  await page.getByText("保存したセット構成を使う", { exact: true }).click();
  await page.getByLabel("保存したセットを検索", { exact: true }).fill(name);
  await page.getByRole("button", { name: new RegExp(`${name}.*この構成を使う`) }).click();
  await expect(page.getByLabel("セット名", { exact: false })).toHaveValue(name);
  await expect(page.getByLabel("この出品に含める数", { exact: true })).toHaveValue("3");
});

test("missing fee settings save the listing input first and return to the same draft without reserving stock", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const name = `設定戻り-${info.project.name}-${Date.now()}`;
  await createQuantityStock(page, name, 1);
  const channel = await db.salesChannel.findFirstOrThrow({
    where: { workspace: { name: "物販帳E2E" }, type: "MERCARI" },
  });
  expect(channel.defaultFeeRate).not.toBeNull();
  const external = `m${BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 16)}`)}`;
  await db.salesChannel.update({ where: { id: channel.id }, data: { defaultFeeRate: null } });
  try {
    await page.goto("/sales/listings/new");
    await page.getByLabel("商品名・色・サイズ・個体コードで検索", { exact: true }).fill(name);
    await page.getByRole("button", { name: new RegExp(name) }).click();
    await page.getByLabel("出品価格（円）", { exact: false }).fill("980");
    await page.getByLabel("出品URLまたは商品ID", { exact: false }).fill(external);
    await page.getByRole("link", { name: "販路の手数料率を確認・保存する", exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/sales-channels\?returnTo=/);
    const form = page
      .locator("form")
      .filter({ has: page.getByRole("heading", { name: "メルカリ", exact: true }) });
    await form
      .getByLabel("既定手数料率（%）", { exact: true })
      .fill(percentDisplay(channel.defaultFeeRate!));
    await form.getByRole("button", { name: "設定を保存", exact: true }).click();
    await expect(form.getByText("設定を保存しました。", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "保存した入力へ戻る", exact: true }).click();
    await expect(page).toHaveURL(/\/sales\/listings\/new\?draft=/);
    await expect(page.getByLabel("出品価格（円）", { exact: false })).toHaveValue("980");
    await expect(page.getByLabel("出品URLまたは商品ID", { exact: false })).toHaveValue(external);
    await expect(
      page.getByRole("button", { name: "出品を記録して在庫を確保", exact: true }),
    ).toBeEnabled();
    expect(
      await db.listing.count({
        where: { salesChannelId: channel.id, externalListingId: external },
      }),
    ).toBe(0);
  } finally {
    await db.salesChannel.update({
      where: { id: channel.id },
      data: { defaultFeeRate: channel.defaultFeeRate },
    });
  }
});

test("inventory filters and scroll position return from details without crossing input contexts", async ({
  page,
}) => {
  const query = new URLSearchParams({
    q: "ページング商品",
    type: "QUANTITY",
    stock: "no",
    status: "ACTIVE",
  });
  await page.goto(`/inventory?${query}`);
  const target = page.getByRole("link", { name: /ページング商品-/ }).nth(20);
  await target.scrollIntoViewIfNeeded();
  const y = await page.evaluate(() => window.scrollY);
  expect(y).toBeGreaterThan(100);
  await target.click();
  const back = page.getByRole("link", { name: "一覧へ", exact: true });
  await expect(back).toHaveAttribute("href", new RegExp("type=QUANTITY"));
  await back.click();
  await expect(page.getByLabel("検索", { exact: true })).toHaveValue("ページング商品");
  await expect
    .poll(async () => Math.abs((await page.evaluate(() => window.scrollY)) - y))
    .toBeLessThan(10);
  await page.getByRole("link", { name: "次へ", exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.getByRole("link", { name: /ページング商品-/ })).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("purchase search and status stay in the URL and the explicit back link", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const name = `仕入れ検索-${info.project.name}-${Date.now()}`;
  await createQuantityStock(page, name, 1);
  const detail = new URL(page.url()).pathname;
  await page.goto(`/purchases?q=${encodeURIComponent(name)}&status=FINALIZED`);
  await expect(page.getByLabel("商品名・仕入先・注文番号で検索", { exact: true })).toHaveValue(
    name,
  );
  await expect(page.getByRole("combobox", { name: "仕入れの状態", exact: true })).toHaveValue(
    "FINALIZED",
  );
  await page.locator(`a[href="${detail}"]:visible`).click();
  const back = page.getByRole("link", { name: "仕入一覧へ", exact: true });
  await expect(back).toHaveAttribute("href", new RegExp("status=FINALIZED"));
  await back.click();
  await expect(page.getByLabel("商品名・仕入先・注文番号で検索", { exact: true })).toHaveValue(
    name,
  );
  await expect(page.getByRole("combobox", { name: "仕入れの状態", exact: true })).toHaveValue(
    "FINALIZED",
  );
});
