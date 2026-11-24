import { confirmCompletionPreview, ensureTestContext } from "./helpers/completion";
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createQuantityStock, readWorkflowRequest } from "./helpers/workflow";

test.beforeEach(async ({ page }) => {
  test.skip(
    !process.env.E2E_LOGIN_NAME || !process.env.E2E_PASSWORD,
    "Dedicated authenticated environment required",
  );
  await page.goto("/login");
  await page.getByLabel("ユーザー名").fill(process.env.E2E_LOGIN_NAME!);
  await page.getByLabel("パスワード").fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(page.getByRole("heading", { name: "ホーム", exact: true })).toBeVisible();
  await ensureTestContext(page);
});
async function makeListing(page: Page, project: string) {
  const name = `通信復帰-${project}-${randomUUID()}`;
  await createQuantityStock(page, name);
  await page.goto("/sales/listings/new");
  await page.getByLabel("商品名・色・サイズ・個体コードで検索").fill(name);
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await page
    .getByLabel("出品URLまたは商品ID")
    .fill(`m${Date.now()}${project === "mobile" ? "7" : "8"}`);
  await page.getByLabel("出品価格（円）").fill("980");
  await page.getByRole("button", { name: "出品を記録して在庫を確保", exact: true }).click();
  await expect(page.getByText("出品用に確保：1個")).toBeVisible();
  await page.getByRole("link", { name: "取引完了を記録", exact: true }).click();
  await confirmCompletionPreview(page);
}
test("lost completion acknowledgement is recovered by lookup without another completion", async ({
  page,
}, info) => {
  test.setTimeout(90000);
  await makeListing(page, info.project.name);
  let interrupted = false;
  await page.route("**/api/workflow", async (route) => {
    if (
      !interrupted &&
      route.request().method() === "POST" &&
      route.request().postData()?.includes('"COMPLETE"')
    ) {
      interrupted = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await confirmCompletionPreview(page);
  await page.getByRole("button", { name: "完了を記録する", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存結果を確認する", exact: true })).toBeVisible();
  expect(interrupted).toBe(true);
  await page.getByRole("button", { name: "保存結果を確認する", exact: true }).click();
  await expect(page).toHaveURL(/\/sales\/orders\/[a-f0-9-]+/);
  const saved = page.url();
  await page.reload();
  expect(page.url()).toBe(saved);
  await expect(page.getByText("計算に必要な情報が不足", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("lost-ack-result.png"), fullPage: true });
});
test("undelivered completion is explicitly cancelled before editing and resubmitting", async ({
  page,
}, info) => {
  test.setTimeout(90000);
  await makeListing(page, info.project.name);
  let interrupted = false;
  await page.route("**/api/workflow", async (route) => {
    if (
      !interrupted &&
      route.request().method() === "POST" &&
      route.request().postData()?.includes('"COMPLETE"')
    ) {
      interrupted = true;
      await route.abort("failed");
    } else await route.continue();
  });
  await confirmCompletionPreview(page);
  await page.getByRole("button", { name: "完了を記録する", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存結果を確認する", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "保存結果を確認する", exact: true }).click();
  await page
    .getByRole("button", { name: "未確定の要求を取り消して入力へ戻る", exact: true })
    .click();
  await page.getByLabel("実際に売れた金額").fill("900");
  await confirmCompletionPreview(page);
  await page.getByRole("button", { name: "完了を記録する", exact: true }).click();
  await expect(page).toHaveURL(/\/sales\/orders\/[a-f0-9-]+/);
  await expect(page.getByText("¥900", { exact: true })).toBeVisible();
});

test("lost completion result survives reload and a new login without another stock issue", async ({
  page,
  context,
}, info) => {
  test.setTimeout(90000);
  await makeListing(page, info.project.name);
  let completionRequests = 0;
  await page.route("**/api/workflow", async (route) => {
    if (route.request().method() === "POST" && route.request().postData()?.includes('"COMPLETE"')) {
      completionRequests++;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "完了を記録する", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存結果を確認する", exact: true })).toBeVisible();
  const recoveryUrl = page.url(),
    operation = new URL(recoveryUrl).searchParams.get("operation")!;
  const saved = await readWorkflowRequest(page, operation);
  expect(saved).toMatchObject({ status: "APPLIED", saved: true });
  await page.reload();
  await expect(page.getByText("この出品の完了は記録済みです。", { exact: true })).toBeVisible();
  await context.clearCookies();
  await page.goto(recoveryUrl);
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("ユーザー名").fill(process.env.E2E_LOGIN_NAME!);
  await page.getByLabel("パスワード").fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(page.getByRole("heading", { name: "ホーム", exact: true })).toBeVisible();
  await ensureTestContext(page);
  await page.goto(recoveryUrl);
  await page.getByRole("link", { name: "完了実績を確認する", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/sales/orders/${saved.id}`));
  const replay = await readWorkflowRequest(page, operation);
  expect(replay).toMatchObject({ status: "APPLIED", id: saved.id });
  expect(completionRequests).toBe(1);
});
test("lost draft acknowledgement retries the same save and survives reload", async ({
  page,
}, info) => {
  await page.goto("/purchases/new");
  let interrupted = false;
  await page.route("**/purchases/new**", async (route) => {
    if (
      !interrupted &&
      route.request().method() === "POST" &&
      route.request().postData()?.includes('"requestId"')
    ) {
      interrupted = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  const memo = `応答欠落-${Date.now()}`;
  await page.getByLabel("注文番号（任意）").fill(memo);
  await expect(page.getByRole("status").filter({ hasText: "保存済み" })).toBeVisible({
    timeout: 15000,
  });
  expect(interrupted).toBe(true);
  await expect(page).toHaveURL(/draft=/);
  await page.reload();
  await expect(page.getByLabel("注文番号（任意）")).toHaveValue(memo);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("draft-restored.png"), fullPage: true });
});
test("two devices show a three-way draft conflict and keep local input only after confirmation", async ({
  page,
  context,
}, info) => {
  await page.goto("/purchases/new");
  await page.getByLabel("注文番号（任意）").fill("入力開始時の注文");
  await expect(page).toHaveURL(/draft=/);
  const other = await context.newPage();
  await other.goto(page.url());
  await expect(other.getByLabel("注文番号（任意）")).toHaveValue("入力開始時の注文");
  await page.getByLabel("注文番号（任意）").fill("別端末で変更した注文");
  await expect
    .poll(async () => {
      await other.reload();
      return other.getByLabel("注文番号（任意）").inputValue();
    })
    .toBe("別端末で変更した注文");
  // Reload establishes the baseline, then the first device changes it again.
  await page.getByLabel("注文番号（任意）").fill("現在のサーバーの注文");
  await expect(page.getByRole("status").filter({ hasText: "保存済み" })).toBeVisible();
  await other.getByLabel("注文番号（任意）").fill("手元に残す注文");
  await expect(other.getByRole("heading", { name: "仕入れの変更を確認してください" })).toBeVisible({
    timeout: 15000,
  });
  await expect(other.getByText("現在のサーバーの注文", { exact: false }).first()).toBeVisible();
  await expect(other.getByText("作成中の商品", { exact: true })).toHaveCount(0);
  await other.screenshot({ path: info.outputPath("three-way-conflict.png"), fullPage: true });
  await other
    .getByRole("button", { name: "手元の入力を引き継いで再確認する", exact: true })
    .click();
  await expect(other.getByRole("status").filter({ hasText: "保存済み" })).toBeVisible();
  await other.reload();
  await expect(other.getByLabel("注文番号（任意）")).toHaveValue("手元に残す注文");
  await other.close();
});
