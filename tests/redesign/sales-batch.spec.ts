import { test, expect, type Page } from "@playwright/test";
import { E2E_PASSWORD, E2E_READY_LOGIN } from "../../scripts/test/e2e-config";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("ユーザー名").fill(E2E_READY_LOGIN);
  await page.getByLabel("パスワード").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
}

test("チェック操作領域・ボタン整列・PCの6行表示・スマホの展開を確認する", async ({
  page,
}, info) => {
  await page.setViewportSize(
    info.project.name === "desktop" ? { width: 1280, height: 800 } : { width: 360, height: 800 },
  );
  await login(page);
  await page.goto("/sales/batch");
  await page.getByLabel("ファイルから追加", { exact: true }).setInputFiles({
    name: "layout.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "商品ID,商品名,商品代金,販売手数料,配送料,購入日時,更新日時\n" +
        Array.from(
          { length: 10 },
          (_, i) =>
            `layout-${i},長い商品名でも一覧で確認できる30枚セット${i},2480,248,215,2026-11-01,2026-11-05`,
        ).join("\n"),
    ),
  });
  await expect(page.locator(".sales-batch-row")).toHaveCount(10);
  const geometry = await page.getByLabel("1行目の選択", { exact: true }).evaluate((input) => {
    const box = input.getBoundingClientRect(),
      hit = input.closest("label")!.getBoundingClientRect();
    return { width: box.width, height: box.height, hitWidth: hit.width, hitHeight: hit.height };
  });
  expect(geometry.width).toBeGreaterThanOrEqual(18);
  expect(geometry.width).toBeLessThanOrEqual(20);
  expect(geometry.height).toBeLessThanOrEqual(20);
  expect(geometry.hitWidth).toBeGreaterThanOrEqual(44);
  expect(geometry.hitHeight).toBeGreaterThanOrEqual(44);
  const file = await page.locator(".file-button").boundingBox(),
    manual = await page.getByRole("button", { name: "手入力の行を追加" }).boundingBox();
  expect(Math.abs(file!.y - manual!.y)).toBeLessThanOrEqual(1);
  expect(manual!.x - file!.x - file!.width).toBeGreaterThanOrEqual(12);
  if (info.project.name === "desktop") {
    const sixth = await page.locator(".sales-batch-row").nth(5).boundingBox();
    expect(sixth!.y + sixth!.height).toBeLessThanOrEqual(800);
  } else {
    await expect(page.getByLabel("1行目の金額", { exact: true })).toBeHidden();
    await page.getByRole("button", { name: "1行目の詳細", exact: true }).click();
    await expect(page.getByLabel("1行目の金額", { exact: true })).toBeVisible();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `.tmp/redesign-ui/${info.project.name}-ux-batch-layout.png`,
    fullPage: true,
  });
});
test("758件のCSVを候補にし、更新日を初期表示し自動保存・再開する", async ({ page }, info) => {
  test.setTimeout(90000);
  await login(page);
  await page.goto("/sales");
  await page.getByRole("link", { name: "まとめて入力", exact: true }).click();
  const csv =
    "商品ID,商品名,商品代金,販売手数料,配送料,購入日時,更新日時\n" +
    Array.from(
      { length: 758 },
      (_, i) =>
        `candidate-${i},CSV候補${String(i).padStart(3, "0")},2480,248,215,2026-11-01 10:00:00,2026-11-05 12:00:00`,
    ).join("\n");
  await page
    .getByLabel("ファイルから追加", { exact: true })
    .setInputFiles({ name: "sales.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(page.locator(".sales-batch-counts")).toContainText("758件");
  await expect(page.getByLabel("1行目の完了日", { exact: true })).toHaveValue("2026-11-05");
  await page.getByRole("button", { name: "1行目の詳細", exact: true }).click();
  await expect(page.getByLabel("1行目の取引完了済み", { exact: true })).not.toBeChecked();
  await expect(page.getByLabel("1行目の金額", { exact: true })).toHaveValue("2480");
  await expect(page.getByLabel("1行目の金額の意味", { exact: true })).toHaveValue("TOTAL");
  await page.getByLabel("1行目の選択", { exact: true }).check();
  await page
    .getByRole("navigation", { name: "上部の入力ページ送り" })
    .getByRole("button", { name: "次へ" })
    .click();
  await page.getByRole("button", { name: "51行目の詳細", exact: true }).click();
  await expect(page.getByLabel("51行目の金額", { exact: true })).toHaveValue("2480");
  await page
    .getByRole("navigation", { name: "上部の入力ページ送り" })
    .getByRole("button", { name: "前へ" })
    .click();
  await expect(page.getByLabel("1行目の選択", { exact: true })).toBeChecked();
  await expect(page.locator(".draft-indicator")).toHaveText("途中保存済み");
  const saved = page.url();
  await page.reload();
  await page.getByRole("button", { name: "1行目の詳細", exact: true }).click();
  await expect(page.getByLabel("1行目の完了日", { exact: true })).toHaveValue("2026-11-05");
  await expect(page.getByLabel("1行目の選択", { exact: true })).toBeChecked();
  await page.getByLabel("商品名・商品IDで絞り込む").fill("CSV候補757");
  await page.getByRole("button", { name: "758行目の詳細", exact: true }).click();
  await expect(page.getByLabel("758行目の金額", { exact: true })).toHaveValue("2480");
  await expect(page).toHaveURL(saved);
  await page.getByLabel("758行目の販売商品", { exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "758行目の販売商品を検索", exact: true }),
  ).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `.tmp/redesign-ui/${info.project.name}-sales-batch-csv.png`,
    fullPage: true,
  });
});

test("複数行を一括確認し、応答消失を照会してから残りを再確認する", async ({ page }, info) => {
  test.setTimeout(120000);
  await login(page);
  const name = `一括販売-${info.project.name}-${Date.now()}`;
  await page.goto("/purchases/new");
  await page.getByLabel("取引先", { exact: true }).fill(name);
  await page.getByLabel("商品名", { exact: true }).fill(name);
  await page.getByLabel("数量", { exact: true }).fill("10");
  await page.getByLabel("単価（円）").fill("100");
  await page.getByRole("button", { name: "保存して入庫", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible({ timeout: 20000 });
  await page.goto(`/products?q=${encodeURIComponent(name)}`);
  await page.locator(".commerce-select-row input[type=checkbox]").check();
  await page.getByRole("button", { name: "単品の販売商品を一括登録", exact: true }).click();
  await expect(page).toHaveURL(/tab=skus/);
  await page.goto("/sales/batch");
  await page.getByRole("button", { name: "手入力の行を追加" }).click();
  await page.getByRole("button", { name: "手入力の行を追加" }).click();
  await page.getByRole("button", { name: "1行目の詳細", exact: true }).click();
  await page.getByRole("button", { name: "1行目の販売商品を検索", exact: true }).click();
  await page.getByLabel("1行目の販売商品の検索語").fill(name);
  const actualSkuId = await page
    .getByLabel("1行目の販売商品", { exact: true })
    .locator("option")
    .filter({ hasText: name })
    .getAttribute("value");
  const date = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  for (const index of [1, 2]) {
    const detail = page.getByRole("button", { name: `${index}行目の詳細`, exact: true });
    if ((await detail.getAttribute("aria-expanded")) !== "true") await detail.click();
    await page.getByLabel(`${index}行目の元商品名`).fill(name);
    if (index === 2) {
      await page.getByRole("button", { name: "2行目の販売商品を検索", exact: true }).click();
      await page.getByLabel("2行目の販売商品の検索語", { exact: true }).fill(name);
    }
    await page.getByLabel(`${index}行目の販売商品`, { exact: true }).selectOption(actualSkuId!);
    await page.getByLabel(`${index}行目の販路`).selectOption({ index: 1 });
    await page.getByLabel(`${index}行目の完了日`).fill(date);
    await page.getByLabel(`${index}行目の金額`, { exact: true }).fill("500");
    await page.getByLabel(`${index}行目の手数料`).fill("50");
    await page.getByLabel(`${index}行目の送料`).fill("0");
    await page.getByLabel(`${index}行目の取引完了済み`).check();
    await page.getByLabel(`${index}行目の選択`).check();
  }
  await page.getByRole("button", { name: "この商品名と販売商品の対応を記憶" }).first().click();
  await expect(page.locator(".sales-batch > .commerce-note[role=status]")).toContainText(
    "対応を記憶しました",
  );
  await page.getByRole("button", { name: "選択行の在庫・原価を確認" }).click();
  await expect(page.getByRole("heading", { name: "在庫・原価・利益をまとめて確認" })).toBeVisible({
    timeout: 30000,
  });
  for (const index of [1, 2]) {
    const position = page.getByLabel(`${index}行目の計算順序`, { exact: true });
    if (await position.count()) {
      await position.selectOption("LAST");
      await page.getByRole("button", { name: "選択行の在庫・原価を確認" }).click();
      await expect(
        page.getByRole("heading", { name: "在庫・原価・利益をまとめて確認" }),
      ).toBeVisible({ timeout: 30000 });
    }
  }
  await expect(page.locator(".sales-batch-result")).toHaveCount(2);
  await expect(page.locator(".sales-batch-result").first()).toContainText("商品原価 100円");
  await expect(page.locator(".sales-batch-result").last()).toContainText("在庫 8点");
  let lost = false;
  await page.route("**/api/commerce/sales-batch", async (route) => {
    if (route.request().postDataJSON().action === "save" && !lost) {
      lost = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "確認した販売を順次保存" }).click();
  await expect(page.getByRole("button", { name: "元の保存結果を照会" })).toBeVisible();
  await expect(page.getByRole("button", { name: "元の保存結果を照会" })).toBeEnabled();
  expect(
    await page
      .locator(".sales-batch-recovery .commerce-action-row")
      .evaluate((group) => getComputedStyle(group).gap),
  ).toBe("12px");
  await page.getByRole("button", { name: "元の保存結果を照会" }).click();
  await expect(page.locator(".sales-batch > .commerce-note[role=status]")).toContainText(
    "保存済みでした",
  );
  await expect(page.getByRole("link", { name: "保存済みの販売" })).toHaveCount(1);
  await page.getByRole("button", { name: "選択行の在庫・原価を確認" }).click();
  await expect(page.locator(".sales-batch-result")).toHaveCount(1);
  await page.getByRole("button", { name: "確認した販売を順次保存" }).click();
  await expect(page.locator(".sales-batch > .commerce-note[role=status]")).toContainText(
    "選択した販売を保存しました",
  );
  await expect(page.getByRole("link", { name: "保存済みの販売" })).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `.tmp/redesign-ui/${info.project.name}-sales-batch-saved.png`,
    fullPage: true,
  });
});

test("自動保存中の追加入力を保持し、応答消失は同じ下書き要求で再確認する", async ({ page }) => {
  test.setTimeout(90000);
  await login(page);
  await page.goto("/sales/batch");
  const attempts: { key: string; revision: number; data: unknown }[] = [];
  const actions: string[] = [];
  let releaseFirst!: () => void;
  const firstReply = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  await page.route("**/api/commerce/sales-batch", async (route) => {
    const body = route.request().postDataJSON();
    actions.push(body.action);
    if (body.action !== "draft") return route.continue();
    attempts.push({ key: body.key, revision: body.revision, data: body.data });
    if (attempts.length === 1) {
      const result = await route.fetch();
      await firstReply;
      await route.fulfill({ response: result });
    } else if (attempts.length === 2) {
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "手入力の行を追加", exact: true }).click();
  const name = page.getByLabel("1行目の元商品名", { exact: true });
  await name.fill("保存を待ちながら入力");
  await expect.poll(() => attempts.length).toBe(1);
  await expect(name).toBeEnabled();
  await name.fill("応答待ちの間に追加した内容");
  releaseFirst();
  await expect(
    page.getByRole("button", { name: "同じ内容で途中保存の結果を再確認", exact: true }),
  ).toBeVisible();
  await expect(name).toBeDisabled();
  expect(attempts).toHaveLength(2);
  await page.getByRole("button", { name: "同じ内容で途中保存の結果を再確認", exact: true }).click();
  await expect(page.locator(".draft-indicator")).toHaveText("途中保存済み");
  expect(attempts[2]).toEqual(attempts[1]);
  expect(attempts[1]!.data).toHaveProperty("changedRows");
  expect(actions).not.toContain("save");
  await page.reload();
  await page.getByRole("button", { name: "1行目の詳細", exact: true }).click();
  await expect(name).toHaveValue("応答待ちの間に追加した内容");
});
