import { expect, test, type Page } from "@playwright/test";
import { ensureTestContext } from "./helpers/completion";
import {
  confirmStockPreview,
  readWorkflowRequest,
  createQuantityStock,
  openPendingListingReturn,
} from "./helpers/workflow";

test.beforeEach(async ({ page }) => {
  test.skip(
    !process.env.E2E_LOGIN_NAME || !process.env.E2E_PASSWORD,
    "専用の認証済み環境が必要です",
  );
  await page.goto("/login");
  await page.getByLabel("ユーザー名").fill(process.env.E2E_LOGIN_NAME!);
  await page.getByLabel("パスワード").fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(page.getByRole("heading", { name: "ホーム", exact: true })).toBeVisible();
  await ensureTestContext(page);
});

async function fillPurchase(page: Page, name: string) {
  await page.goto("/purchases/new");
  await page.getByRole("button", { name: "3. 内容確認", exact: true }).click();
  await page.getByRole("button", { name: "新しい商品を作成", exact: true }).click();
  await page.getByLabel("商品名", { exact: true }).fill(name);
  await page.getByRole("button", { name: "組合せを生成", exact: true }).click();
  await page.getByRole("button", { name: "商品を作成して仕入れに追加", exact: true }).click();
  await page.getByLabel("商品・色やサイズ").selectOption({ label: `新規: ${name} / 標準` });
  await page.getByRole("spinbutton", { name: "数量", exact: true }).fill("3");
  await page.getByLabel("明細原価総額（円）").fill("300");
  await page.getByLabel("仕入総額（円）").fill("300");
}

async function loseAcknowledgement(page: Page, kind: string, button: string) {
  let attempts = 0;
  await page.route("**/api/workflow", async (route) => {
    const body = route.request().postDataJSON();
    if (body?.kind === kind) {
      attempts++;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  const commit = page.getByRole("button", { name: button, exact: true });
  if (
    ["PURCHASE_RECEIVE", "PURCHASE_CANCEL", "INVENTORY", "STOCKTAKE", "LISTING_RETURN"].includes(
      kind,
    )
  )
    await confirmStockPreview(commit);
  await commit.click();
  await expect(page.getByRole("button", { name: "保存結果を確認する", exact: true })).toBeVisible();
  const operation = new URL(page.url()).searchParams.get("operation")!;
  expect(operation).toBeTruthy();
  const result = await readWorkflowRequest(page, operation);
  expect(result).toMatchObject({ status: "APPLIED", saved: true });
  await page.getByRole("button", { name: "保存結果を確認する", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${result.id}\\?recorded=1$`));
  expect(attempts).toBe(1);
  await page.unroute("**/api/workflow");
  return { operation, id: result.id as string };
}

test("purchase save, receipt and cancellation recover lost acknowledgements without replaying stock", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const name = `仕入復帰-${info.project.name}-${Date.now()}`;
  await fillPurchase(page, name);
  const saved = await loseAcknowledgement(page, "PURCHASE_SAVE", "内容を保存して入庫確認へ");
  await expect(
    page.getByRole("button", { name: "入庫して在庫に加える", exact: true }),
  ).toBeVisible();
  const received = await loseAcknowledgement(page, "PURCHASE_RECEIVE", "入庫して在庫に加える");
  expect(received.id).toBe(saved.id);
  await expect(page.getByText("確定", { exact: true }).first()).toBeVisible();
  await page.getByPlaceholder("取消理由").fill("復帰確認のため取消");
  const cancelled = await loseAcknowledgement(page, "PURCHASE_CANCEL", "仕入れを取り消す");
  expect(cancelled.id).toBe(saved.id);
  await page.reload();
  await expect(page.getByText("取消", { exact: true }).first()).toBeVisible();
  for (const request of [saved, received, cancelled]) {
    expect(await readWorkflowRequest(page, request.operation)).toMatchObject({
      status: "APPLIED",
      id: saved.id,
    });
  }
});

test("observed quantity records one adjustment after acknowledgement loss and preserves a zero difference", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const name = `数量実測-${info.project.name}-${Date.now()}`;
  await fillPurchase(page, name);
  await page.getByRole("button", { name: "内容を保存して入庫確認へ", exact: true }).click();
  await expect(page).toHaveURL(/\/purchases\/[a-f0-9-]+\?recorded=1$/);
  const receive = page.getByRole("button", { name: "入庫して在庫に加える", exact: true });
  await confirmStockPreview(receive);
  await receive.click();
  await expect(page.getByText("確定", { exact: true }).first()).toBeVisible();
  await page.goto("/inventory/stocktake/new");
  const variant = page.getByRole("combobox", { name: "数えた商品（数量管理）", exact: true });
  await variant.selectOption(
    (await variant.locator("option").filter({ hasText: name }).getAttribute("value"))!,
  );
  const location = page.getByRole("combobox", { name: "数えた保管場所", exact: true });
  await location.selectOption(
    (await location.locator("option").filter({ hasText: "主保管場所" }).getAttribute("value"))!,
  );
  await page.getByLabel("確認した実測数量（個）").fill("2");
  await page.getByLabel("数量を確認した理由（必須）").fill("管理対象の数え直し");
  const saved = await loseAcknowledgement(page, "STOCKTAKE", "実測数量と影響を確認して記録する");
  await expect(page.getByText("帳簿 3個 → 実測 2個", { exact: false })).toBeVisible();
  await page.reload();
  await expect(page.getByText("帳簿 3個 → 実測 2個", { exact: false })).toHaveCount(1);
  await page.getByRole("link", { name: "数えた数量を訂正", exact: true }).click();
  await page
    .getByRole("combobox", { name: "数えた保管場所", exact: true })
    .selectOption(
      (await page
        .getByRole("combobox", { name: "数えた保管場所", exact: true })
        .locator("option")
        .filter({ hasText: "主保管場所" })
        .getAttribute("value"))!,
    );
  await page.getByLabel("確認した実測数量（個）").fill("2");
  await page.getByLabel("数量を確認した理由（必須）").fill("差がないことを再確認");
  const confirm = page.getByRole("button", {
    name: "実測数量と影響を確認して記録する",
    exact: true,
  });
  await confirmStockPreview(confirm);
  await confirm.click();
  await expect(page).toHaveURL(new RegExp(`/inventory/${saved.id}\\?recorded=1$`));
  await expect(page.getByText("帳簿 2個 → 実測 2個", { exact: false })).toHaveCount(1);
});

for (const mode of ["MIXED", "GOOD"] as const)
  test(`listing partial returns ${mode} preserve unresolved holds and close explicitly`, async ({
    page,
  }, info) => {
    test.setTimeout(120000);
    const name = `返送確認-${mode}-${info.project.name}-${Date.now()}`;
    await createQuantityStock(page, name, 3);
    await page.goto("/sales/listings/new");
    await page.getByLabel("売り方").selectOption("bundle");
    await page.getByLabel("商品名・色・サイズ・個体コードで検索").fill(name);
    await page.getByRole("button", { name: new RegExp(name) }).click();
    await page.getByLabel("この出品に含める数").fill("3");
    await page.getByLabel("セット名").fill(name);
    await page
      .getByLabel("出品URLまたは商品ID")
      .fill(`m${Date.now()}${mode === "GOOD" ? "1" : "2"}`);
    await page.getByLabel("出品価格（円）").fill("980");
    await page.getByRole("button", { name: "出品を記録して在庫を確保", exact: true }).click();
    await expect(page.getByText("出品用に確保：3個", { exact: true })).toBeVisible();
    await page.getByText("終了・キャンセル・返送／一時停止・再開", { exact: true }).click();
    await page
      .getByRole("combobox", { name: "起きたこと", exact: true })
      .selectOption("RETURN_PENDING");
    await page.getByLabel("理由・確認内容（必須）").fill("発送後キャンセル・返送確認待ち");
    await page.getByRole("button", { name: "出来事を記録する", exact: true }).click();
    await page.getByRole("link", { name: "返送を数量ごとに確認する", exact: true }).click();
    await page
      .getByLabel("良品として今回確認した数量", { exact: true })
      .fill(mode === "GOOD" ? "3" : "1");
    if (mode === "MIXED")
      await page.getByLabel("不良（販売不可）として今回確認した数量", { exact: true }).fill("1");
    await page.getByLabel("確認理由・メモ（必須）").fill("届いた商品の状態を確認");
    if (mode === "MIXED")
      await loseAcknowledgement(page, "LISTING_RETURN", "今回確認した返送分を記録する");
    else {
      const commit = page.getByRole("button", {
        name: "今回確認した返送分を記録する",
        exact: true,
      });
      await confirmStockPreview(commit);
      await commit.click();
    }
    await expect(
      page.getByText(`出品用に確保：${mode === "GOOD" ? 3 : 2}個`, { exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "返送を数量ごとに確認する", exact: true }).click();
    if (mode === "MIXED") {
      await expect(
        page.getByRole("button", { name: "確認して返送案件を閉じる", exact: true }),
      ).toHaveCount(0);
      await expect(page.getByText("未処理：1個", { exact: true })).toBeVisible();
      await page.getByLabel("返送不要・紛失として今回確認した数量", { exact: true }).fill("1");
      await page.getByLabel("確認理由・メモ（必須）").fill("残り1個は返送不要・紛失を確認");
      const commit = page.getByRole("button", {
        name: "今回確認した返送分を記録する",
        exact: true,
      });
      await confirmStockPreview(commit);
      await commit.click();
      await expect(page.getByText("出品用に確保：1個", { exact: true })).toBeVisible();
      await page.getByRole("link", { name: "返送を数量ごとに確認する", exact: true }).click();
      await expect(
        page
          .getByRole("combobox", { name: "返送案件を閉じる方法", exact: true })
          .locator('option[value="RESUME"]'),
      ).toHaveCount(0);
    } else
      await page
        .getByRole("combobox", { name: "返送案件を閉じる方法", exact: true })
        .selectOption("RESUME");
    await page.getByLabel("確認理由・メモ（必須）").fill("全数の処理結果と現物・メルカリを確認");
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "確認して返送案件を閉じる", exact: true }).click();
    await expect(
      page.getByText(`出品用に確保：${mode === "GOOD" ? 3 : 0}個`, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(mode === "GOOD" ? "完了未記録" : "終了", { exact: true }).first(),
    ).toBeVisible();
  });

test("incomplete listing return draft resumes from home without releasing inventory", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const listing = await openPendingListingReturn(
    page,
    "返送下書き-" + info.project.name + "-" + Date.now(),
  );
  await page.getByLabel("返送を確認した日").fill("");
  await page.getByLabel("確認理由・メモ（必須）").fill("まだ未確認の返送入力を保存");
  await expect(page.getByRole("status").filter({ hasText: "保存済み" })).toBeVisible();
  await expect(page).toHaveURL(/draft=/);
  const draft = new URL(page.url()).searchParams.get("draft")!;
  await page.goto("/");
  await page
    .locator('a[href="' + new URL(listing).pathname + "/return?draft=" + draft + '"]')
    .click();
  await expect(page.getByLabel("確認理由・メモ（必須）")).toHaveValue("まだ未確認の返送入力を保存");
  await expect(page.getByLabel("返送を確認した日")).toHaveValue("");
  await page.goto(listing);
  await expect(page.getByText("出品用に確保：3個", { exact: true })).toBeVisible();
});
for (const choice of ["LOCAL", "NEW"] as const)
  test(
    "listing return draft conflict " +
      choice +
      " selects only a new draft and recovers lost acknowledgement",
    async ({ page, context }, info) => {
      test.setTimeout(120000);
      const listing = await openPendingListingReturn(
        page,
        "返送競合-" + choice + "-" + info.project.name + "-" + Date.now(),
      );
      await page.getByLabel("良品として今回確認した数量", { exact: true }).fill("2");
      await page.getByLabel("確認理由・メモ（必須）").fill("残す手元の返送入力");
      await expect(page.getByRole("status").filter({ hasText: "保存済み" })).toBeVisible();
      await expect(page).toHaveURL(/draft=/);
      const source = new URL(page.url()).searchParams.get("draft")!;
      const other = await context.newPage();
      await other.goto(listing + "/return");
      await other.getByLabel("良品として今回確認した数量", { exact: true }).fill("1");
      await other.getByLabel("確認理由・メモ（必須）").fill("別端末の良品確認");
      const confirm = other.getByRole("button", {
        name: "今回確認した返送分を記録する",
        exact: true,
      });
      await confirmStockPreview(confirm);
      await confirm.click();
      await expect(other.getByText("出品用に確保：3個", { exact: true })).toBeVisible();
      await page
        .getByRole("button", { name: "手元入力を保持して最新の返送状況を読む", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "返送入力の変更を確認してください", exact: true }),
      ).toBeFocused();
      let resolutions = 0;
      await page.route("**/api/workflow", async (route) => {
        if (route.request().postDataJSON()?.kind === "LISTING_RETURN_REBASE") {
          resolutions++;
          await route.fetch();
          await route.abort("failed");
        } else await route.continue();
      });
      await page
        .getByRole("button", {
          name:
            choice === "LOCAL"
              ? "手元入力を引き継いで再確認する"
              : "手元入力を退避して新しく入力する",
          exact: true,
        })
        .click();
      await expect(
        page.getByRole("button", { name: "保存結果を確認する", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "保存結果を確認する", exact: true }).click();
      await expect.poll(() => new URL(page.url()).searchParams.get("draft")).not.toBe(source);
      await expect(page.getByLabel("確認理由・メモ（必須）")).toHaveValue(
        choice === "LOCAL" ? "残す手元の返送入力" : "",
      );
      await expect(page.getByLabel("良品として今回確認した数量", { exact: true })).toHaveValue(
        choice === "LOCAL" ? "2" : "",
      );
      expect(resolutions).toBe(1);
      await page.unrouteAll({ behavior: "wait" });
      const previous = page
        .locator("details")
        .filter({ has: page.getByText("選び直す前の手元入力を確認する", { exact: true }) });
      await previous.locator("summary").click();
      await expect(previous).toContainText("残す手元の返送入力");
      await other.goto(listing + "/return");
      await expect(other.getByText("未処理：2個", { exact: true })).toBeVisible();
      await other.close();
    },
  );

test("inventory movement recovers a lost acknowledgement and keeps the recorded result after reload", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const name = `在庫復帰-${info.project.name}-${Date.now()}`;
  await fillPurchase(page, name);
  await page.getByRole("button", { name: "内容を保存して入庫確認へ", exact: true }).click();
  await expect(page).toHaveURL(/\/purchases\/[a-f0-9-]+\?recorded=1$/);
  await page.getByRole("button", { name: "入庫して在庫に加える", exact: true }).click();
  await expect(page.getByText("確定", { exact: true }).first()).toBeVisible();
  await page.goto("/inventory/operations/new");
  const variant = page.locator("#inventory-operation-variant");
  const option = variant.locator("option").filter({ hasText: name });
  await expect(option).toHaveCount(1);
  await variant.selectOption((await option.getAttribute("value"))!);
  const source = page.getByLabel("移動元");
  await source.selectOption(
    (await source.locator("option").filter({ hasText: "主保管場所" }).getAttribute("value"))!,
  );
  const destination = page.getByLabel("移動先");
  await destination.selectOption(
    (await destination.locator("option").filter({ hasText: "副保管場所" }).getAttribute("value"))!,
  );
  await page.getByRole("spinbutton", { name: "数量", exact: true }).fill("1");
  await confirmStockPreview(page.getByRole("button", { name: "在庫操作を記録", exact: true }));
  await loseAcknowledgement(page, "INVENTORY", "在庫操作を記録");
  await page.reload();
  await expect(
    page.getByRole("status").filter({ hasText: "在庫操作を記録しました" }),
  ).toBeVisible();
  await expect(page.getByText("3点", { exact: true })).toBeVisible();
});
