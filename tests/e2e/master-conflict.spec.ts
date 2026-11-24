import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { ensureTestContext } from "./helpers/completion";

let db: PrismaClient;
test.beforeAll(() => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  if (!new URL(url).pathname.endsWith("_test")) throw new Error("専用テストDBが必要です。");
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

test("two settings editors reject a stale save and retain the local input with keyboard focus", async ({
  page,
  browser,
}) => {
  await page.goto("/settings/operators");
  const first = page.locator('form:has(input[name="revision"])').first();
  const id = await first.locator('input[name="id"]').inputValue();
  const original = await first.getByLabel("表示名", { exact: true }).inputValue();
  const otherContext = await browser.newContext({ viewport: page.viewportSize()! });
  const other = await otherContext.newPage();
  try {
    await login(other);
    await other.goto("/settings/operators");
    const stale = other.locator(`form:has(input[value="${id}"])`);
    await first.getByLabel("表示名", { exact: true }).fill(`${original}・先に保存`);
    await first.getByRole("button", { name: "保存", exact: true }).click();
    await expect(first.getByText("設定を保存しました。", { exact: true })).toBeVisible();
    await stale.getByLabel("表示名", { exact: true }).fill(`${original}・手元入力`);
    await stale.getByRole("button", { name: "保存", exact: true }).click();
    await expect(
      stale.getByRole("heading", { name: "設定を確認してください", exact: true }),
    ).toBeFocused();
    await expect(stale.getByText(/別の端末で設定が更新されました/)).toBeVisible();
    await expect(stale.getByLabel("表示名", { exact: true })).toHaveValue(`${original}・手元入力`);
    expect((await db.operator.findUniqueOrThrow({ where: { id } })).displayName).toBe(
      `${original}・先に保存`,
    );
    expect(
      await other.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await stale.getByRole("button", { name: "最新の設定を読み直す", exact: true }).click();
    await expect(stale.getByLabel("表示名", { exact: true })).toHaveValue(`${original}・先に保存`);
    await stale.getByLabel("表示名", { exact: true }).fill(original);
    await stale.getByRole("button", { name: "保存", exact: true }).click();
    await expect(stale.getByText("設定を保存しました。", { exact: true })).toBeVisible();
  } finally {
    await otherContext.close();
  }
});

test("annual state buttons use the same revision guard and white filing saves the explicit no-deduction value", async ({
  page,
  browser,
}) => {
  const workspace = await db.workspace.findFirstOrThrow({ where: { name: "物販帳E2E" } });
  const entity = await db.reportingEntity.create({
    data: { workspaceId: workspace.id, displayName: `設定競合-${randomUUID()}` },
  });
  const fiscal = await db.fiscalYearProfile.create({
    data: {
      reportingEntityId: entity.id,
      year: 2026,
      filingMethod: "BLUE",
      consumptionTaxStatus: "EXEMPT",
      blueDeductionTarget: "NONE",
      inventoryValuationMethod: "SPECIFIC",
      startDate: new Date("2026-01-01Z"),
      endDate: new Date("2026-12-31Z"),
    },
  });
  await page.goto("/settings/fiscal-years");
  const first = page
    .locator("form")
    .filter({ has: page.getByRole("heading", { name: entity.displayName, exact: true }) });
  const otherContext = await browser.newContext({ viewport: page.viewportSize()! });
  const other = await otherContext.newPage();
  try {
    await login(other);
    await other.goto("/settings/fiscal-years");
    const stale = other
      .locator("form")
      .filter({ has: other.getByRole("heading", { name: entity.displayName, exact: true }) });
    await first.getByRole("button", { name: "決算処理中にする", exact: true }).click();
    await expect(first.getByText("設定を保存しました。", { exact: true })).toBeVisible();
    await stale.getByRole("button", { name: "決算処理中にする", exact: true }).click();
    await expect(stale.getByText(/別の端末で設定が更新されました/)).toBeVisible();
    expect(
      (await db.fiscalYearProfile.findUniqueOrThrow({ where: { id: fiscal.id } })).revision,
    ).toBe(1);
    await other.reload();
    await stale.getByRole("button", { name: "使用中へ戻す", exact: true }).click();
    await expect(
      stale.getByRole("button", { name: "決算処理中にする", exact: true }),
    ).toBeVisible();
    await stale.getByRole("combobox", { name: "申告方式", exact: true }).selectOption("WHITE");
    await stale.getByRole("button", { name: "年度設定を保存", exact: true }).click();
    await expect(stale.getByText("設定を保存しました。", { exact: true })).toBeVisible();
    expect(
      await db.fiscalYearProfile.findUniqueOrThrow({ where: { id: fiscal.id } }),
    ).toMatchObject({ filingMethod: "WHITE", blueDeductionTarget: "NONE", status: "OPEN" });
  } finally {
    await otherContext.close();
  }
});

test("invalid channel fees show a field error and retain the unconfirmed input", async ({
  page,
}) => {
  await page.goto("/settings/sales-channels");
  const form = page
    .locator("form")
    .filter({ has: page.getByRole("heading", { name: "メルカリ", exact: true }) });
  const id = await form.locator('input[name="id"]').inputValue();
  const before = await db.salesChannel.findUniqueOrThrow({ where: { id } });
  await form.getByLabel("既定手数料率（%）", { exact: true }).fill("101");
  await form.getByRole("button", { name: "設定を保存", exact: true }).click();
  await expect(
    form.getByRole("heading", { name: "設定を確認してください", exact: true }),
  ).toBeFocused();
  await expect(form.getByLabel("既定手数料率（%）", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(form.getByLabel("既定手数料率（%）", { exact: true })).toHaveValue("101");
  expect((await db.salesChannel.findUniqueOrThrow({ where: { id } })).revision).toBe(
    before.revision,
  );
});
