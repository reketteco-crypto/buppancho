import { expect, type Locator, type Page } from "@playwright/test";
import type { WorkflowResult } from "@/lib/sales/workflow-result";

/** Use the logged-in browser, including its loopback Secure-cookie handling.
 * Never weaken the application's production cookie policy for an HTTP-only test runner.
 */
export async function readWorkflowRequest(page: Page, key: string): Promise<WorkflowResult> {
  if (!/^[a-f0-9-]{36}$/i.test(key)) throw new Error("保存要求IDを確認できません。");
  return page.evaluate(async (id) => {
    const response = await fetch(`/api/workflow-requests/${encodeURIComponent(id)}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    return response.json();
  }, key);
}

/** Confirm an explicitly requested same-day order instead of bypassing a disabled commit. */
export async function confirmStockPreview(button: Locator) {
  const form = button.locator("xpath=ancestor::form[1]");
  const order = form.getByRole("combobox", { name: "同日の計算順序", exact: true });
  await expect
    .poll(
      async () =>
        (await button.isEnabled()) ? "READY" : (await order.isVisible()) ? "ORDER" : "WAIT",
      { timeout: 15000 },
    )
    .not.toBe("WAIT");
  if (await order.isVisible()) await order.selectOption("LAST");
  await expect(button).toBeEnabled();
}

/** Returns use the same explicit ordering review when a same-day position matters. */
export async function confirmReturnPreview(page: Page) {
  const review = page.getByRole("button", { name: "内容と在庫・損益を確認する", exact: true });
  const heading = page.getByRole("heading", { name: "確定する内容", exact: true });
  const order = page.getByRole("combobox", { name: "同日の計算順序", exact: true });
  await review.click();
  await expect
    .poll(
      async () =>
        (await heading.isVisible()) ? "READY" : (await order.isVisible()) ? "ORDER" : "WAIT",
      { timeout: 15000 },
    )
    .not.toBe("WAIT");
  if (await order.isVisible()) {
    await order.selectOption("LAST");
    await review.click();
  }
  await expect(heading).toBeVisible();
}

/** Every run owns its stock; never replenish or reset shared seed inventory. */
export async function createQuantityStock(
  page: Page,
  name: string,
  quantity = 3,
  totalCost?: string,
) {
  await page.goto("/purchases/new");
  await page.getByRole("button", { name: "3. 内容確認", exact: true }).click();
  await page.getByRole("button", { name: "新しい商品を作成", exact: true }).click();
  await page.getByLabel("商品名", { exact: true }).fill(name);
  await page.getByRole("button", { name: "組合せを生成", exact: true }).click();
  await page.getByRole("button", { name: "商品を作成して仕入れに追加", exact: true }).click();
  await page.getByLabel("商品・色やサイズ").selectOption({ label: `新規: ${name} / 標準` });
  await page.getByRole("spinbutton", { name: "数量", exact: true }).fill(String(quantity));
  const cost = totalCost ?? (100n * BigInt(quantity)).toString();
  await page.getByLabel("明細原価総額（円）").fill(cost);
  await page.getByLabel("仕入総額（円）").fill(cost);
  await page.getByRole("button", { name: "内容を保存して入庫確認へ", exact: true }).click();
  await expect(page).toHaveURL(/\/purchases\/[a-f0-9-]+\?recorded=1$/);
  const receive = page.getByRole("button", { name: "入庫して在庫に加える", exact: true });
  await confirmStockPreview(receive);
  await receive.click();
  await expect(page.getByText("確定", { exact: true }).first()).toBeVisible();
}

export async function openPendingListingReturn(page: Page, name: string) {
  await createQuantityStock(page, name, 3);
  await page.goto("/sales/listings/new");
  await page.getByLabel("売り方").selectOption("bundle");
  await page.getByLabel("商品名・色・サイズ・個体コードで検索").fill(name);
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await page.getByLabel("この出品に含める数").fill("3");
  await page.getByLabel("セット名").fill(name);
  await page
    .getByLabel("出品URLまたは商品ID")
    .fill("m" + Date.now() + Math.floor(Math.random() * 10000));
  await page.getByLabel("出品価格（円）").fill("980");
  await page.getByRole("button", { name: "出品を記録して在庫を確保", exact: true }).click();
  await expect(page.getByText("出品用に確保：3個", { exact: true })).toBeVisible();
  const listingUrl = page.url().split("?")[0]!;
  await page.getByText("終了・キャンセル・返送／一時停止・再開", { exact: true }).click();
  await page
    .getByRole("combobox", { name: "起きたこと", exact: true })
    .selectOption("RETURN_PENDING");
  await page.getByLabel("理由・確認内容（必須）").fill("発送後キャンセル・返送確認待ち");
  await page.getByRole("button", { name: "出来事を記録する", exact: true }).click();
  await page.getByRole("link", { name: "返送を数量ごとに確認する", exact: true }).click();
  return listingUrl;
}
