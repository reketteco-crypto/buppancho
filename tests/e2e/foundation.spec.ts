import { test, expect } from "@playwright/test";

test("login page is responsive and does not disclose account existence", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "物販帳" })).toBeVisible();
  await page.getByLabel("ユーザー名").fill("存在しない利用者");
  await page.getByLabel("パスワード").fill("wrong-password");
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: /ユーザー名またはパスワード|ログイン試行が一時的/ }),
  ).toBeVisible();
});

test("manifest and health endpoint are available", async ({ request }) => {
  expect((await request.get("/api/health/live")).ok()).toBe(true);
  expect((await request.get("/manifest.webmanifest")).ok()).toBe(true);
});

test("generic initial setup creates multiple departments and copies the next year", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop" || !process.env.E2E_LOGIN_NAME || !process.env.E2E_PASSWORD,
    "専用E2Eアカウントが設定されたdesktop実行で確認します。",
  );
  await page.goto("/login");
  await page.getByLabel("ユーザー名").fill(process.env.E2E_LOGIN_NAME!);
  await page.getByLabel("パスワード").fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page.getByRole("heading", { name: "物販帳を準備する" })).toBeVisible();
  await expect(page.locator('input[value="事業主"]').first()).toBeVisible();
  await expect(page.locator('input[value="アパレル担当"]').first()).toBeVisible();
  await page.getByLabel("消費税区分").selectOption("EXEMPT");
  await page.getByLabel("青色申告特別控除の目標").selectOption("DEDUCTION_650K");
  await page.getByLabel("棚卸資産の評価方法").selectOption("LAST_PURCHASE_COST");

  await page.getByRole("button", { name: "販売部門を追加" }).click();
  await page.locator('input[pattern="[A-Z0-9_]+"]:visible').nth(2).fill("DOMESTIC");
  await page.getByLabel("販売部門名").nth(2).fill("国内仕入");
  await page.getByRole("button", { name: "内容を確認して初期設定を完了" }).click();

  await expect(page.getByRole("heading", { name: "基盤の状態" })).toBeVisible();
  await page.goto("/settings/fiscal-years");
  await expect(page.getByRole("heading", { name: "2026年度" })).toBeVisible();
  await expect(page.getByRole("row", { name: /国内仕入 DOMESTIC/ })).toBeVisible();
  await page.getByRole("button", { name: "年度設定と割当をコピー" }).click();
  await expect(page.getByRole("heading", { name: "2027年度" })).toBeVisible();
  await expect(page.getByLabel("アパレルの主な入力者").last()).toHaveValue(/.+/);
});
