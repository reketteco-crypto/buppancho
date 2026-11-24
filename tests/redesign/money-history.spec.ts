import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { E2E_READY_LOGIN, E2E_PASSWORD } from "../../scripts/test/e2e-config";
async function fixture(page: Page) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || new URL(url).pathname !== "/buppancho_redesign_20261110_test")
    throw new Error("固定専用DBが必要です。");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) }),
    token = randomUUID().slice(0, 8).toUpperCase(),
    name = `履歴確認-${token}`,
    bank = `事業口座-${token}`,
    target = `受取口座-${token}`;
  try {
    const original = await db.businessUnitAssignment.findFirstOrThrow({
        where: {
          businessUnit: { code: "E2E", workspace: { name: "物販帳E2E" } },
          fiscalYearProfile: { year: 2026 },
        },
        include: { businessUnit: true, fiscalYearProfile: true },
      }),
      workspaceId = original.businessUnit.workspaceId,
      reportingEntityId = original.fiscalYearProfile.reportingEntityId;
    const unit = await db.businessUnit.create({
      data: { workspaceId, code: `HISTORY-${token}`, name, color: "#355d4c" },
    });
    await db.businessUnitAssignment.create({
      data: {
        businessUnitId: unit.id,
        fiscalYearProfileId: original.fiscalYearProfileId,
        defaultOperatorId: original.defaultOperatorId,
        effectiveFrom: new Date("2026-01-01"),
        effectiveTo: new Date("2026-12-31"),
      },
    });
    const scope = { workspaceId, businessUnitId: unit.id, reportingEntityId },
      a = await db.moneyAccount.create({
        data: {
          ...scope,
          name: bank,
          openingDate: new Date("2026-01-01"),
          openingBalanceJpy: 20000n,
        },
      }),
      b = await db.moneyAccount.create({
        data: {
          ...scope,
          name: target,
          openingDate: new Date("2026-01-01"),
          openingBalanceJpy: 0n,
        },
      }),
      category = await db.moneyCategory.create({
        data: { workspaceId, kind: "EXPENSE", name: `履歴経費-${token}` },
      });
    const ids = Array.from({ length: 101 }, () => ({
      record: randomUUID(),
      transaction: randomUUID(),
    }));
    await db.$transaction(async (tx) => {
      await tx.otherRecord.createMany({
        data: ids.map((id, i) => ({
          ...scope,
          id: id.record,
          kind: "EXPENSE",
          categoryId: category.id,
          categoryName: `再送料-${token}-${String(i).padStart(3, "0")}${i === 100 ? " 長い内容や取引先名も折り返して確認できる履歴の表示テスト" : ""}`,
          date: new Date("2026-10-01"),
          amountJpy: 25n,
          createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)),
          requestId: randomUUID(),
        })),
      });
      await tx.moneyTransaction.createMany({
        data: ids.map((id, i) => ({
          ...scope,
          id: id.transaction,
          kind: "OTHER_PAYMENT",
          sourceId: id.record,
          sourceSnapshot: {
            name: `再送料-${token}-${String(i).padStart(3, "0")}${i === 100 ? " 長い内容や取引先名も折り返して確認できる履歴の表示テスト" : ""}`,
            href: `/money/records/${id.record}`,
          },
          date: new Date("2026-10-01"),
          amountJpy: 25n,
          createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)),
          requestId: randomUUID(),
        })),
      });
      await tx.moneyEntry.createMany({
        data: ids.map((id) => ({
          transactionId: id.transaction,
          accountId: a.id,
          amountJpy: -25n,
          purpose: "PRINCIPAL",
        })),
      });
      await tx.moneyTransaction.create({
        data: {
          ...scope,
          kind: "TRANSFER",
          date: new Date("2026-11-15"),
          amountJpy: 9800n,
          feeJpy: 200n,
          requestId: randomUUID(),
          entries: {
            create: [
              { accountId: a.id, amountJpy: -9800n, purpose: "PRINCIPAL" },
              { accountId: a.id, amountJpy: -200n, purpose: "FEE" },
              { accountId: b.id, amountJpy: 9800n, purpose: "PRINCIPAL" },
            ],
          },
        },
      });
    });
  } finally {
    await db.$disconnect();
  }
  await page.goto("/login");
  await page.getByLabel("ユーザー名").fill(E2E_READY_LOGIN);
  await page.getByLabel("パスワード").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  const context = page.locator("details.context-selector");
  await expect(context.locator("form")).toHaveAttribute("aria-busy", "false");
  await context.locator("summary").click();
  await context.locator('select[name="businessUnitId"]').selectOption({ label: name });
  await context.getByRole("button", { name: "切り替え", exact: true }).click();
  await expect(context.locator("summary")).toContainText(name);
  return { bank, target, token };
}
test("履歴の50件表示、行内詳細、検索条件と詳細からの復帰を確認する", async ({ page }, info) => {
  test.setTimeout(150000);
  page.setDefaultTimeout(15000);
  const { bank, token } = await fixture(page);
  await page.goto("/money?from=2026-10-01&to=2026-10-01");
  const rows = page.locator(".money-history-toggle");
  await expect(rows).toHaveCount(50);
  await expect(page.getByRole("navigation", { name: "上部の履歴ページ送り" })).toContainText(
    "1–50 / 101件",
  );
  await expect(rows.first()).toContainText(`再送料-${token}-100`);
  await expect(rows.first()).toContainText("−¥25");
  await expect(rows.first()).toContainText(bank);
  await rows.first().focus();
  await page.keyboard.press("Enter");
  await expect(rows.first()).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Space");
  await expect(rows.first()).toHaveAttribute("aria-expanded", "false");
  await expect(rows.first()).toBeFocused();
  await rows.first().click();
  await rows.nth(1).click();
  await expect(page.locator(".money-history-detail")).toHaveCount(1);
  await page.getByRole("button", { name: "詳細を閉じる", exact: true }).click();
  await expect(rows.nth(1)).toBeFocused();
  if (info.project.name === "desktop") {
    const box = await rows.nth(2).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(72);
    expect(box!.height).toBeLessThanOrEqual(88);
  }
  await page.evaluate(
    (offset) => {
      const section = document.getElementById("money-history")!;
      window.scrollTo(0, section.getBoundingClientRect().top + scrollY - offset);
    },
    info.project.name === "desktop" ? 88 : 16,
  );
  await page.screenshot({
    path: `.tmp/redesign-ui/${info.project.name}-money-history.png`,
    caret: "initial",
  });
  for (const pageNumber of [2, 3]) {
    await page
      .getByRole("navigation", { name: "上部の履歴ページ送り" })
      .getByRole("link", { name: "次へ", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`page=${pageNumber}`));
    await expect(rows).toHaveCount(pageNumber === 2 ? 50 : 1);
  }
  await expect(page.getByRole("navigation", { name: "下部の履歴ページ送り" })).toContainText(
    "101–101 / 101件",
  );
  const filter = page.locator("form.money-history-filters");
  await filter.getByRole("combobox", { name: "口座", exact: true }).selectOption({ label: bank });
  await filter.getByRole("button", { name: "表示", exact: true }).click();
  await expect(rows).toHaveCount(50);
  await expect(page).not.toHaveURL(/page=3/);
  await page.getByRole("link", { name: "その他の費用・収入", exact: true }).click();
  await expect(page).toHaveURL(/tab=records/);
  await expect(filter.getByLabel("開始日", { exact: true })).toHaveValue("2026-10-01");
  await page
    .getByRole("navigation", { name: "上部の履歴ページ送り" })
    .getByRole("link", { name: "次へ", exact: true })
    .click();
  await expect(page).toHaveURL(/page=2/);
  await expect(rows).toHaveCount(50);
  await rows.first().click();
  const selected = await rows.first().innerText();
  await page.getByRole("link", { name: "費用・収入の詳細", exact: true }).click();
  await expect(page).toHaveURL(/\/money\/records\//);
  await page.getByRole("link", { name: "お金の一覧へ", exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(rows.first()).toHaveAttribute("aria-expanded", "true");
  await expect(rows.first()).toBeInViewport();
  await expect(rows.first()).toContainText(selected.split("\n")[1] ?? "再送料");
  await page.getByRole("link", { name: "費用・収入の詳細", exact: true }).click();
  const cancel = page.locator('details:has(>summary:text-is("この収支を取り消す"))');
  await cancel.locator(":scope > summary").click();
  await cancel.getByLabel("取消日", { exact: true }).fill("2026-11-15");
  await cancel.getByLabel("取消理由", { exact: true }).fill("誤って記録した費用");
  await cancel.getByRole("button", { name: "収支を取り消す", exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(rows.first()).toContainText("取消済み");
  await page.getByRole("link", { name: "入出金履歴", exact: true }).click();
  await expect(filter.getByRole("combobox", { name: "口座", exact: true })).toHaveValue(/.+/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("手数料付き振替を口座別に確認し、応答欠落後の照会から元の一覧へ戻る", async ({ page }) => {
  test.setTimeout(120000);
  page.setDefaultTimeout(15000);
  const { bank, target } = await fixture(page);
  await page.goto("/money?from=2026-11-15&to=2026-11-15");
  const row = page.locator(".money-history-toggle");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("¥9,800");
  await expect(row).toContainText("手数料 ¥200");
  await expect(row).toContainText(`${bank} → ${target}`);
  const filter = page.locator("form.money-history-filters");
  for (const [label, amount] of [
    [bank, "−¥10,000"],
    [target, "＋¥9,800"],
    ["すべて", "¥9,800"],
  ]) {
    const [accountId] = await filter
      .getByRole("combobox", { name: "口座", exact: true })
      .selectOption({ label: label! });
    await filter.getByRole("button", { name: "表示", exact: true }).click();
    await expect(page).toHaveURL((url) => url.searchParams.get("account") === accountId);
    await expect(row.locator(".money-history-amount strong")).toHaveText(amount!);
  }
  await row.click();
  const panel = page.locator(".money-history-detail");
  await expect(panel).toContainText("−¥9,800");
  await expect(panel).toContainText("−¥200");
  await expect(panel).toContainText("＋¥9,800");
  await page.locator(".money-history-cancel > summary").click();
  await panel.getByLabel("取消日", { exact: true }).fill("2026-11-15");
  await panel.getByLabel("取消理由", { exact: true }).fill("振替記録の訂正");
  let dropped = false;
  await page.route("**/api/commerce", async (route) => {
    const body = route.request().postDataJSON();
    if (!dropped && body.action === "save" && body.kind === "MONEY_RECORD") {
      dropped = true;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await panel.getByRole("button", { name: "反対の入出金で取り消す", exact: true }).click();
  await expect(panel.getByRole("button", { name: "保存結果を確認", exact: true })).toBeVisible();
  await expect(row).toBeDisabled();
  await expect(panel.getByRole("button", { name: "詳細を閉じる", exact: true })).toBeDisabled();
  await expect(panel.getByLabel("取消理由", { exact: true })).toHaveValue("振替記録の訂正");
  await panel.getByRole("button", { name: "保存結果を確認", exact: true }).click();
  await expect(page).toHaveURL(/from=2026-11-15/);
  await expect(page.locator(".money-history-toggle")).toHaveCount(2);
  await expect(page.locator(".money-history-toggle").filter({ hasText: "取消済み" })).toHaveCount(
    1,
  );
  expect(dropped).toBe(true);
});
