import { test, expect } from "@playwright/test";
import { E2E_PASSWORD, E2E_READY_LOGIN } from "../../scripts/test/e2e-config";

test("完了日の明示補完・ホームからの再開・現在地・目的別のお金と設定を確認する", async ({
  page,
}, info) => {
  test.setTimeout(90000);
  await page.setViewportSize(
    info.project.name === "desktop" ? { width: 1280, height: 800 } : { width: 360, height: 800 },
  );
  await page.goto("/login");
  await page.getByLabel("ユーザー名").fill(E2E_READY_LOGIN);
  await page.getByLabel("パスワード").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/sales/batch");
  const file = `再開確認-${info.project.name}-${Date.now()}.csv`;
  await page.getByLabel("ファイルから追加", { exact: true }).setInputFiles({
    name: file,
    mimeType: "text/csv",
    buffer: Buffer.from(
      "商品ID,商品名,商品代金,販売手数料,配送料,購入日時,更新日時\nresume-1,再開する商品1,100,0,0,2026-11-01,2026-11-05\nresume-2,再開する商品2,200,0,0,2026-11-01,2026-11-06",
    ),
  });
  for (const index of [1, 2])
    await page.getByRole("button", { name: `${index}行目の詳細`, exact: true }).click();
  await page.getByLabel("1行目の完了日", { exact: true }).fill("");
  await page.getByLabel("2行目の完了日", { exact: true }).fill("2026-11-03");
  await expect(page.locator(".draft-indicator")).toHaveText("途中保存済み");
  await page.reload();
  await expect(page.getByLabel("1行目の完了日", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("2行目の完了日", { exact: true })).toHaveValue("2026-11-03");
  await page.getByLabel("1行目の選択", { exact: true }).check();
  await page.getByLabel("2行目の選択", { exact: true }).check();
  await page.locator(".sales-batch-bulk > summary").click();
  await page.getByRole("button", { name: "空欄の完了日へ更新日を反映", exact: true }).click();
  await expect(page.getByLabel("1行目の完了日", { exact: true })).toHaveValue("2026-11-05");
  await expect(page.getByLabel("2行目の完了日", { exact: true })).toHaveValue("2026-11-03");
  await expect(page.locator(".draft-indicator")).toHaveText("途中保存済み");
  const draft = page.url();
  await page.getByRole("link", { name: "ホーム", exact: true }).click();
  const resume = page.getByRole("link", {
    name: new RegExp(`販売まとめ入力.*${file.replaceAll(".", "\\.")}`),
  });
  await expect(resume).toContainText("入力途中2件");
  await resume.click();
  await expect(page).toHaveURL(draft);
  await expect(page.locator(".sales-batch-row")).toHaveCount(2);
  await page.goto("/money");
  const nav =
    info.project.name === "desktop" ? page.locator(".sidebar nav") : page.locator(".mobile-nav");
  await expect(nav.locator('[aria-current="page"]')).toHaveText("お金");
  await expect(page.locator(".money-tasks > a")).toHaveCount(4);
  const payment = page.getByRole("link", { name: /^仕入の支払/ });
  await payment.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/purchases$/);
  await expect(nav.locator('[aria-current="page"]')).toHaveText("購入");
  await page.goto("/settings");
  for (const group of ["日常の入力", "事業・年度", "運用"])
    await expect(page.getByRole("heading", { name: group, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `.tmp/redesign-ui/${info.project.name}-ux-settings.png`,
    fullPage: true,
  });
  await page.goto("/inventory/stocktake/new");
  await expect(
    page.getByRole("heading", { name: "数えた数量を確認・訂正する", exact: true }),
  ).toBeVisible();
  await expect(nav.locator('[aria-current="page"]')).toHaveText("商品");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
