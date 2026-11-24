import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { ensureTestContext } from "./helpers/completion";
import { confirmStockPreview } from "./helpers/workflow";
test.beforeEach(async ({ page }) => {
  test.skip(!process.env.E2E_LOGIN_NAME || !process.env.E2E_PASSWORD, "専用テスト環境が必要です");
  await page.goto("/login");
  await page.getByLabel("ユーザー名").fill(process.env.E2E_LOGIN_NAME!);
  await page.getByLabel("パスワード").fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(page.getByRole("heading", { name: "ホーム", exact: true })).toBeVisible();
  await ensureTestContext(page);
});
async function makePurchase(page: Page) {
  await page.goto("/purchases/new");
  await page.getByRole("button", { name: "3. 内容確認", exact: true }).click();
  await page.getByRole("button", { name: "同じ商品を数量で管理する", exact: true }).click();
  await page.getByLabel("明細原価総額（円）").fill("100");
  await page.getByLabel("仕入総額（円）").fill("100");
  await page.getByRole("button", { name: "内容を保存して入庫確認へ", exact: true }).click();
  await expect(page).toHaveURL(/\/purchases\/[a-f0-9-]+\?recorded=1$/);
  return page.url().split("?")[0]!;
}
for (const choice of ["LOCAL", "LATEST"] as const)
  test(`purchase conflict chooses ${choice} without confirmation and survives a lost resolution acknowledgement`, async ({
    page,
    context,
  }, info) => {
    test.setTimeout(120000);
    const purchase = await makePurchase(page);
    await page.goto(`${purchase}/edit`);
    await page.getByLabel("注文番号（任意）").fill("編集開始");
    await expect(page).toHaveURL(/draft=/);
    const other = await context.newPage();
    await other.goto(page.url());
    await other.route("**/purchases/**", async (route) => {
      if (
        route.request().method() === "POST" &&
        route.request().postData()?.includes('"requestId"')
      )
        await route.abort();
      else await route.continue();
    });
    await other.getByLabel("注文番号（任意）").fill("残す手元の注文");
    await page.getByLabel("注文番号（任意）").fill("別端末で保存した注文");
    await page.getByRole("button", { name: "3. 内容確認", exact: true }).click();
    await page.getByRole("button", { name: "内容を保存して入庫確認へ", exact: true }).click();
    await expect(page).toHaveURL(`${purchase}?recorded=1`);
    await other.unrouteAll({ behavior: "wait" });
    await expect(
      other.getByRole("heading", { name: "仕入れの変更を確認してください", exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      other.getByText("現在の保存内容：別端末で保存した注文", { exact: true }),
    ).toBeVisible();
    await expect(other.getByText("手元の入力：残す手元の注文", { exact: true })).toBeVisible();
    expect(await other.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await other.screenshot({ path: info.outputPath(`purchase-${choice}.png`), fullPage: true });
    let requests = 0;
    await other.route("**/api/workflow", async (route) => {
      if (route.request().postDataJSON()?.kind === "PURCHASE_REBASE") {
        requests++;
        await route.fetch();
        await route.abort();
      } else await route.continue();
    });
    await other
      .getByRole("button", {
        name: choice === "LOCAL" ? "手元の入力を引き継いで再確認する" : "最新の保存内容を使う",
        exact: true,
      })
      .click();
    await expect(
      other.getByRole("button", { name: "保存結果を確認する", exact: true }),
    ).toBeVisible();
    const recovering = other.url();
    if (choice === "LOCAL") {
      await context.clearCookies();
      await other.goto(recovering);
      await expect(other).toHaveURL(/\/login/);
      await other.getByLabel("ユーザー名").fill(process.env.E2E_LOGIN_NAME!);
      await other.getByLabel("パスワード").fill(process.env.E2E_PASSWORD!);
      await other.getByRole("button", { name: "ログイン", exact: true }).click();
      await ensureTestContext(other);
      await other.goto(recovering);
    }
    await other.reload();
    await expect(other).toHaveURL(/\/edit\?draft=/);
    expect(other.url()).not.toBe(recovering);
    expect(requests).toBe(1);
    await expect(other.getByLabel("注文番号（任意）")).toHaveValue(
      choice === "LOCAL" ? "残す手元の注文" : "別端末で保存した注文",
    );
    await page.reload();
    await expect(page.getByText("別端末で保存した注文", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "入庫して在庫に加える", exact: true }),
    ).toBeVisible();
    await other.unrouteAll({ behavior: "wait" });
    await other.getByRole("button", { name: "内容を保存して入庫確認へ", exact: true }).click();
    await expect(other).toHaveURL(`${purchase}?recorded=1`);
    await other.close();
  });

test("an editor retains local input after another device receives and later cancels the purchase", async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  const purchase = await makePurchase(page);
  const editor = await context.newPage();
  await editor.goto(`${purchase}/edit`);
  await editor.getByLabel("注文番号（任意）").fill("入庫後も残す入力");
  await expect(editor).toHaveURL(/draft=/);
  const editUrl = editor.url();
  await confirmStockPreview(
    page.getByRole("button", { name: "入庫して在庫に加える", exact: true }),
  );
  await page.getByRole("button", { name: "入庫して在庫に加える", exact: true }).click();
  await expect(page.getByText("確定", { exact: true }).first()).toBeVisible();
  await editor.goto(editUrl);
  await expect(
    editor.getByRole("heading", { name: "仕入れの変更を確認してください", exact: true }),
  ).toBeVisible();
  await expect(editor.getByText("手元の入力：入庫後も残す入力", { exact: true })).toBeVisible();
  await expect(
    editor.getByRole("button", { name: "手元の入力を引き継いで再確認する", exact: true }),
  ).toHaveCount(0);
  await page.getByPlaceholder("取消理由").fill("競合確認のため取消");
  await confirmStockPreview(page.getByRole("button", { name: "仕入れを取り消す", exact: true }));
  await page.getByRole("button", { name: "仕入れを取り消す", exact: true }).click();
  await expect(page.getByText("取消", { exact: true }).first()).toBeVisible();
  await editor.reload();
  await expect(editor.getByText("手元の入力：入庫後も残す入力", { exact: true })).toBeVisible();
  await expect(editor.getByRole("alert").filter({ hasText: "取消済み" })).toBeVisible();
  await editor.close();
});

test("a lost autosave acknowledgement is settled before resolving a purchase conflict", async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  const purchase = await makePurchase(page);
  const other = await context.newPage();
  await other.goto(`${purchase}/edit`);
  let acknowledgementsLost = 0;
  await other.route("**/purchases/**", async (route) => {
    if (
      route.request().method() === "POST" &&
      route.request().postData()?.includes('"requestId"')
    ) {
      acknowledgementsLost++;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await other.getByLabel("注文番号（任意）").fill("応答欠落でも残す手元入力");
  await expect(other.getByRole("status").filter({ hasText: "通信を確認中" })).toBeVisible({
    timeout: 15000,
  });
  await page.goto(`${purchase}/edit`);
  await page.getByLabel("注文番号（任意）").fill("別端末の保存内容");
  await page.getByRole("button", { name: "3. 内容確認", exact: true }).click();
  await page.getByRole("button", { name: "内容を保存して入庫確認へ", exact: true }).click();
  await expect(page).toHaveURL(`${purchase}?recorded=1`);
  await other.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    other.getByRole("heading", { name: "仕入れの変更を確認してください", exact: true }),
  ).toBeVisible();
  await other.unrouteAll({ behavior: "wait" });
  await other
    .getByRole("button", { name: "手元の入力を引き継いで再確認する", exact: true })
    .click();
  await expect(other).toHaveURL(/\/edit\?draft=/);
  await expect(other.getByLabel("注文番号（任意）")).toHaveValue("応答欠落でも残す手元入力");
  await page.reload();
  await expect(page.getByText("別端末の保存内容", { exact: true })).toBeVisible();
  expect(acknowledgementsLost).toBeGreaterThan(0);
  await other.getByText("選び直す前の手元入力を確認する", { exact: true }).click();
  await expect(
    other.getByText("手元の入力：応答欠落でも残す手元入力", { exact: true }),
  ).toBeVisible();
  await other.close();
});

for (const kind of ["PURCHASE_RECEIVE", "PURCHASE_CANCEL"] as const)
  test(`${kind} requires explicit reconfirmation after another device edits the target`, async ({
    page,
    context,
  }, info) => {
    test.setTimeout(90000);
    const purchase = await makePurchase(page);
    let original: Record<string, unknown> | undefined;
    page.on("request", (request) => {
      if (request.url().endsWith("/api/workflow/preview") && request.method() === "POST") {
        const body = request.postDataJSON();
        if (body.kind === kind && !original) original = body.payload;
      }
    });
    await page.reload();
    await expect.poll(() => !!original).toBe(true);
    const editor = await context.newPage();
    await editor.goto(`${purchase}/edit`);
    await editor.getByLabel("注文番号（任意）").fill("対象変更の確認");
    await editor.getByRole("button", { name: "3. 内容確認", exact: true }).click();
    await editor.getByRole("spinbutton", { name: "数量", exact: true }).fill("2");
    await editor.getByLabel("明細原価総額（円）").fill("200");
    await editor.getByLabel("仕入総額（円）").fill("200");
    await editor.getByRole("button", { name: "内容を保存して入庫確認へ", exact: true }).click();
    await expect(editor).toHaveURL(`${purchase}?recorded=1`);
    if (kind === "PURCHASE_CANCEL") {
      await page.getByText("この仕入れを取り消す（在庫変更なし）", { exact: true }).click();
      await page.getByPlaceholder("取消理由").fill("手元の取消理由");
    }
    const button = kind === "PURCHASE_RECEIVE" ? "入庫して在庫に加える" : "仕入れを取り消す";
    // The preview now detects the change before a commit can be attempted.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const form = page
      .locator("form")
      .filter({ has: page.getByRole("button", { name: button, exact: true }) });
    await expect(
      form.getByRole("heading", { name: "対象の仕入れが変更されています" }),
    ).toBeVisible();
    await expect(form.getByText("現在の保存内容：対象変更の確認", { exact: true })).toBeVisible();
    await expect(
      form.getByRole("heading", { name: "対象の仕入れが変更されています" }),
    ).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath(`${kind}-reconfirm.png`), fullPage: true });
    await expect(form.getByRole("button", { name: button, exact: true })).toBeDisabled();
    // Simulate an old request that was already in flight when the other device saved.
    // It must be rejected durably, then restore the original date/reason after reload.
    const operation = randomUUID();
    const rejected = await page.evaluate(
      async ({ kind, payload, key }) => {
        const response = await fetch("/api/workflow", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, payload: { ...payload, idempotencyKey: key } }),
        });
        return response.json();
      },
      {
        kind,
        key: operation,
        payload: { ...original, reason: kind === "PURCHASE_CANCEL" ? "手元の取消理由" : "" },
      },
    );
    expect(rejected).toMatchObject({ status: "REJECTED", code: "CONFLICT" });
    const recoveryUrl = new URL(page.url());
    recoveryUrl.searchParams.set("operation", operation);
    recoveryUrl.searchParams.set("operationKind", kind);
    await page.goto(recoveryUrl.toString());
    if (kind === "PURCHASE_CANCEL")
      await page.getByText("この仕入れを取り消す（在庫変更なし）", { exact: true }).click();
    await expect(
      form.getByRole("heading", { name: "対象の仕入れが変更されています" }),
    ).toBeVisible();
    await expect(
      form.getByRole("alert").filter({ hasText: "仕入れが更新されました" }),
    ).toBeVisible();
    await form
      .getByRole("button", { name: "最新の仕入れを確認して入力を引き継ぐ", exact: true })
      .press("Enter");
    await expect(form.getByText("最新の仕入れを確認しました。", { exact: false })).toBeVisible();
    await editor.reload();
    await expect(editor.getByText("下書き", { exact: true }).first()).toBeVisible();
    if (kind === "PURCHASE_CANCEL")
      await expect(form.getByPlaceholder("取消理由")).toHaveValue("手元の取消理由");
    await confirmStockPreview(form.getByRole("button", { name: button, exact: true }));
    await form.getByRole("button", { name: button, exact: true }).click();
    await expect(page).toHaveURL(`${purchase}?recorded=1`);
    await expect(
      page.getByText(kind === "PURCHASE_RECEIVE" ? "確定" : "取消", { exact: true }).first(),
    ).toBeVisible();
    await editor.close();
  });
