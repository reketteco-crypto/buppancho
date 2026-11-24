import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { E2E_PASSWORD, E2E_READY_LOGIN } from "../../scripts/test/e2e-config";
test("購入時の本人立替・部分精算・返金とカードの同時支払を記録する", async ({ page }, info) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(15000);
  const token = randomUUID().slice(0, 8).toUpperCase(),
    unitName = `立替確認-${info.project.name}-${token}`,
    bank = `立替銀行-${token}`,
    card = `同時カード-${token}`,
    product = `立替商品-${token}`;
  const url = process.env.TEST_DATABASE_URL;
  if (!url || new URL(url).pathname !== "/buppancho_redesign_20261110_test")
    throw new Error("固定専用DBが必要です。");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    const previous = await db.businessUnitAssignment.findFirstOrThrow({
        where: {
          businessUnit: { code: "E2E", workspace: { name: "物販帳E2E" } },
          fiscalYearProfile: { year: 2026 },
        },
        include: { businessUnit: true },
      }),
      workspaceId = previous.businessUnit.workspaceId;
    const entity = await db.reportingEntity.create({
        data: { workspaceId, displayName: `本人-${token}` },
      }),
      unit = await db.businessUnit.create({
        data: { workspaceId, code: `OWNER-${token}`, name: unitName, color: "#355d4c" },
      }),
      fiscal = await db.fiscalYearProfile.create({
        data: {
          reportingEntityId: entity.id,
          year: 2026,
          filingMethod: "BLUE",
          consumptionTaxStatus: "EXEMPT",
          blueDeductionTarget: "NONE",
          inventoryValuationMethod: "SPECIFIC",
          startDate: new Date("2026-01-01"),
          endDate: new Date("2026-12-31"),
        },
      });
    await db.businessUnitAssignment.create({
      data: {
        businessUnitId: unit.id,
        fiscalYearProfileId: fiscal.id,
        defaultOperatorId: previous.defaultOperatorId,
        effectiveFrom: new Date("2026-01-01"),
        effectiveTo: new Date("2026-12-31"),
      },
    });
    await db.storageLocation.create({
      data: { workspaceId, businessUnitId: unit.id, code: `OWN-${token}`, name: `保管-${token}` },
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
  await context.locator('select[name="businessUnitId"]').selectOption({ label: unitName });
  await context.getByRole("button", { name: "切り替え", exact: true }).click();
  await expect(context.locator("summary")).toContainText(unitName);
  for (const [name, kind, amount] of [
    [bank, "STANDARD", "10000"],
    [card, "CREDIT_CARD", "0"],
  ] as const) {
    await page.goto("/money");
    const add = page.locator('details:has(>summary:text-is("口座を追加"))');
    await add.locator(":scope > summary").click();
    await add.getByLabel("口座名", { exact: true }).fill(name);
    await add.getByRole("combobox", { name: "口座の種類", exact: true }).selectOption(kind);
    await add
      .getByLabel(kind === "STANDARD" ? "開始残高（円）" : "開始時の未払額（円）", { exact: true })
      .fill(amount);
    await add.getByRole("button", { name: "口座を保存", exact: true }).click();
    await expect(
      page.locator(".commerce-row").filter({ has: page.getByText(name, { exact: true }) }),
    ).toBeVisible();
  }
  await page.goto("/purchases/new");
  await page.getByLabel("取引先", { exact: true }).fill(`立替先-${token}`);
  await page.getByLabel("商品名", { exact: true }).fill(product);
  await page.getByLabel("単価（円）", { exact: true }).fill("10000");
  const payment = page.locator('details:has(>summary:text-matches("^支払"))');
  await payment.locator(":scope > summary").click();
  await payment.getByRole("combobox", { name: "支払方法", exact: true }).selectOption("PERSONAL");
  await expect(payment.getByLabel("支払額（円）", { exact: true })).toHaveValue("10000");
  await page.getByRole("button", { name: "保存して入庫", exact: true }).click();
  await expect(page.getByRole("heading", { name: `立替先-${token}`, exact: true })).toBeVisible({
    timeout: 20000,
  });
  const purchase = page.url();
  await page.goto("/money");
  await expect(page.getByRole("region", { name: "本人立替" })).toContainText("¥10,000");
  for (const amount of ["4000", "6000"]) {
    await page.getByRole("link", { name: "精算する", exact: true }).click();
    await expect(page).toHaveURL(/\/money\/move\?kind=OWNER_REIMBURSEMENT(?:&|$)/);
    await page
      .getByRole("combobox", { name: "口座", exact: true })
      .selectOption(
        (await page
          .getByRole("combobox", { name: "口座", exact: true })
          .locator("option")
          .filter({ hasText: bank })
          .getAttribute("value")) ?? "",
      );
    await expect(page.getByRole("combobox", { name: "口座", exact: true })).not.toHaveValue("");
    await page.getByLabel("金額（円）", { exact: true }).fill(amount);
    await expect(page.getByRole("combobox", { name: "口座", exact: true })).not.toHaveValue("");
    await expect(page.getByRole("heading", { name: "充当内訳", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "資金移動を記録", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "資金移動を記録", exact: true }).click();
    await expect(page).toHaveURL(/\/money(?:\?|$)/);
  }
  await expect(page.getByRole("region", { name: "本人立替" })).toHaveCount(0);
  await page.goto(purchase);
  const refund = page.locator('details:has(>summary:text-is("購入への返金を記録"))');
  await refund.locator(":scope > summary").click();
  await refund.getByLabel("金額（JPY）", { exact: true }).fill("1000");
  await refund.getByLabel("理由", { exact: true }).fill("一部返金を確認");
  await refund.getByRole("button", { name: "返金を記録", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "原価への影響を確認", exact: true }),
  ).toBeVisible();
  await refund.getByRole("button", { name: "返金を記録", exact: true }).click();
  await expect(
    page
      .locator(".commerce-summary-line")
      .filter({ hasText: /購入返金/ })
      .first(),
  ).toBeVisible({ timeout: 20000 });
  const receive = page.locator('details:has(>summary:text-matches("^入金"))');
  await receive.locator(":scope > summary").click();
  await receive
    .getByRole("combobox", { name: "支払・受取方法", exact: true })
    .selectOption("PERSONAL");
  await expect(receive.getByRole("combobox", { name: "口座", exact: true })).toHaveCount(0);
  const refundRequest = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/commerce") &&
      request.method() === "POST" &&
      request.postDataJSON().action === "save" &&
      request.postDataJSON().kind === "MONEY_RECORD",
  );
  await receive.getByRole("button", { name: "決済を記録", exact: true }).click();
  expect((await refundRequest).postDataJSON().payload.paymentMethod).toBe("PERSONAL");
  await expect(page).toHaveURL(/\/money(?:\?|$)/);
  await expect(page.getByRole("region", { name: "本人立替" })).toContainText("本人からの返金待ち");
  await page.getByRole("link", { name: "返金を記録", exact: true }).click();
  await expect(page).toHaveURL(/\/money\/move\?kind=OWNER_REPAYMENT(?:&|$)/);
  await page
    .getByRole("combobox", { name: "口座", exact: true })
    .selectOption(
      (await page
        .getByRole("combobox", { name: "口座", exact: true })
        .locator("option")
        .filter({ hasText: bank })
        .getAttribute("value")) ?? "",
    );
  await page.getByLabel("金額（円）", { exact: true }).fill("1000");
  await expect(page.getByRole("button", { name: "資金移動を記録", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "資金移動を記録", exact: true }).click();
  await expect(page).toHaveURL(/\/money(?:\?|$)/);
  await expect(page.getByRole("region", { name: "本人立替" })).toHaveCount(0);
  await page.goto("/purchases/new");
  await page.getByLabel("取引先", { exact: true }).fill(`同時カード先-${token}`);
  await page.getByLabel("商品名", { exact: true }).fill(`同時カード商品-${token}`);
  await page.getByLabel("単価（円）", { exact: true }).fill("1000");
  await payment.locator(":scope > summary").click();
  await payment.getByRole("combobox", { name: "支払方法", exact: true }).selectOption("ACCOUNT");
  await payment
    .getByRole("combobox", { name: "口座", exact: true })
    .selectOption(
      (await payment
        .getByRole("combobox", { name: "口座", exact: true })
        .locator("option")
        .filter({ hasText: card })
        .getAttribute("value")) ?? "",
    );
  await page.getByRole("button", { name: "保存して入庫", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: `同時カード先-${token}`, exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await page.goto("/money");
  await expect(
    page.locator(".commerce-row").filter({ has: page.getByText(card, { exact: true }) }),
  ).toContainText("¥1,000");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const heading = page.getByRole("heading", { name: "お金", exact: true });
  await expect
    .poll(async () => {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      return heading.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return box.top >= 0 && box.bottom <= innerHeight;
      });
    })
    .toBe(true);
  await page.screenshot({
    path: `.tmp/redesign-ui/${info.project.name}-owner-money.png`,
    caret: "initial",
  });
});
