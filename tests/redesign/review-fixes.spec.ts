import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { E2E_PASSWORD, E2E_READY_LOGIN } from "../../scripts/test/e2e-config";

test("販売の月・ページ・帰属と詳細復帰、月跨ぎ返金の集計を確認する", async ({ page }, info) => {
  test.setTimeout(150000);
  const url = process.env.TEST_DATABASE_URL;
  if (!url || new URL(url).pathname !== "/buppancho_redesign_20261110_test")
    throw new Error("固定専用DBが必要です。");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  const token = randomUUID().slice(0, 8),
    name = `レビュー確認-${token}`;
  let foreignPurchase = "",
    foreignSale = "";
  try {
    const original = await db.businessUnitAssignment.findFirstOrThrow({
      where: {
        businessUnit: { code: "E2E", workspace: { name: "物販帳E2E" } },
        fiscalYearProfile: { year: 2026 },
      },
      include: { businessUnit: true, fiscalYearProfile: true },
    });
    const workspaceId = original.businessUnit.workspaceId;
    const unit = await db.businessUnit.create({
      data: { workspaceId, code: `REVIEW-${token}`, name, color: "#355d4c" },
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
    const scope = {
      workspaceId,
      businessUnitId: unit.id,
      reportingEntityId: original.fiscalYearProfile.reportingEntityId,
    };
    const other = await db.reportingEntity.create({
      data: { workspaceId, displayName: `別主体-${token}` },
    });
    const channel = await db.salesChannel.create({
      data: { workspaceId, name: `販路-${token}`, type: "OTHER" },
    });
    const sku = await db.salesSku.create({
      data: {
        workspaceId,
        businessUnitId: unit.id,
        name,
        skuCode: `SKU-${Date.now()}`,
        skuType: "SINGLE",
        requestKey: randomUUID(),
      },
    });
    const rows = Array.from({ length: 400 }, (_, i) => ({
      ...scope,
      id: randomUUID(),
      salesChannelId: channel.id,
      recordingMode: "DIRECT",
      status: "COMPLETED" as const,
      completedAt: new Date(i < 300 ? "2026-11-10T00:00:00+09:00" : "2026-10-10T00:00:00+09:00"),
      grossSalesJpy: 500n,
      feeJpy: 0n,
      shippingJpy: 0n,
      packingJpy: 0n,
      otherCostJpy: 0n,
      costStatus: "FINAL" as const,
      requestKey: randomUUID(),
      buyerName: token,
      createdAt: new Date(Date.UTC(2026, 10, 10, 0, 0, i)),
    }));
    foreignSale = randomUUID();
    await db.salesOrder.createMany({
      data: [
        ...rows,
        { ...rows[0]!, id: foreignSale, requestKey: randomUUID(), reportingEntityId: other.id },
      ],
    });
    await db.salesOrderLine.createMany({
      data: [
        ...rows.map((r, i) => ({
          salesOrderId: r.id,
          salesSkuId: sku.id,
          displayName: `${name}-${String(i).padStart(3, "0")}`,
          quantity: 1,
          unitPriceJpy: 500n,
          managementCogsJpy: 100n,
        })),
        {
          salesOrderId: foreignSale,
          salesSkuId: sku.id,
          displayName: `非表示の販売-${token}`,
          quantity: 1,
          unitPriceJpy: 500n,
          managementCogsJpy: 100n,
        },
      ],
    });
    const op = await db.inventoryOperation.create({
      data: {
        workspaceId,
        businessUnitId: unit.id,
        operatorId: original.defaultOperatorId!,
        operationType: "SALE_COMPLETION",
        sourceType: "sales_order",
        sourceId: rows[0]!.id,
        occurredAt: rows[0]!.completedAt,
        idempotencyKey: randomUUID(),
      },
    });
    await db.eventDateCorrection.create({
      data: {
        workspaceId,
        businessUnitId: unit.id,
        operationId: op.id,
        requestId: randomUUID(),
        previousDate: new Date("2026-11-10"),
        effectiveDate: new Date("2026-10-25"),
        reason: "有効日を確認",
        operatorId: original.defaultOperatorId!,
      },
    });
    await db.salesReturn.create({
      data: {
        salesOrderId: rows[300]!.id,
        returnedAt: new Date("2026-11-15T00:00:00+09:00"),
        salesRefundJpy: 200n,
        requestKey: randomUUID(),
        memo: "月跨ぎの一部返金",
      },
    });
    const supplier = await db.counterparty.create({
      data: { workspaceId, name: `取引先-${token}` },
    });
    for (const isForeign of [false, true]) {
      const purchase = await db.purchaseDocument.create({
        data: {
          ...scope,
          reportingEntityId: isForeign ? other.id : scope.reportingEntityId,
          supplierId: supplier.id,
          supplierName: `${isForeign ? "非表示" : "表示"}の取引先-${token}`,
          code: `PUR-${randomUUID().slice(0, 8).toUpperCase()}`,
          purchasedDate: new Date("2026-10-10"),
          totalJpy: 100n,
          requestKey: randomUUID(),
        },
      });
      if (isForeign) foreignPurchase = purchase.id;
    }
  } finally {
    await db.$disconnect();
  }
  await page.goto("/login");
  await page.getByLabel("ユーザー名").fill(E2E_READY_LOGIN);
  await page.getByLabel("パスワード").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  const selector = page.locator("details.context-selector");
  await expect(selector.locator("form")).toHaveAttribute("aria-busy", "false");
  await selector.locator("summary").click();
  await selector.locator('select[name="businessUnitId"]').selectOption({ label: name });
  await selector.getByRole("button", { name: "切り替え", exact: true }).click();
  await expect(selector.locator("summary")).toContainText(name);
  await page.goto(`/sales?month=10&q=${token}`);
  const nav = page.getByRole("navigation", { name: "上部の販売ページ送り" });
  await expect(nav).toContainText("1–50 / 101件");
  await expect(page.locator("a.commerce-row")).toHaveCount(50);
  await expect(page.locator("a.commerce-row").first()).toContainText("2026-10-25");
  await nav.getByRole("link", { name: "次へ", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/page=2/);
  const selected = page.locator("a.commerce-row").nth(10);
  await selected.click();
  await expect(page).toHaveURL(/\/sales\/orders\//);
  const back = page.getByRole("link", { name: "販売一覧へ", exact: true });
  await expect(back).toHaveAttribute("href", new RegExp(`q=${token}.*month=10.*page=2`));
  await back.click();
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === "/sales" &&
      url.searchParams.get("month") === "10" &&
      url.searchParams.get("q") === token &&
      url.searchParams.get("page") === "2",
  );
  await expect(nav).toContainText("51–100 / 101件");
  await expect(page.locator("a.commerce-row").nth(10)).toBeInViewport();
  await nav.getByRole("link", { name: "次へ", exact: true }).click();
  await expect(page.locator("a.commerce-row")).toHaveCount(1);
  await expect(page.getByRole("navigation", { name: "下部の販売ページ送り" })).toContainText(
    "101–101 / 101件",
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `.tmp/redesign-ui/${info.project.name}-review-sales-list.png`,
    fullPage: true,
  });
  await page.goto(`/purchases?q=${token}`);
  await expect(page.getByText(`表示の取引先-${token}`, { exact: true })).toBeVisible();
  await expect(page.getByText(`非表示の取引先-${token}`, { exact: true })).toHaveCount(0);
  for (const path of [
    `/purchases/${foreignPurchase}`,
    `/sales/orders/${foreignSale}`,
    `/sales/orders/${foreignSale}/return`,
  ]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "404", exact: true })).toBeVisible();
  }
  await page.goto("/money/reports?month=10");
  const revenue = page
    .locator(".commerce-summary-line")
    .filter({ has: page.getByText("商品売上（返金後）", { exact: true }) });
  await expect(revenue).toContainText("¥50,300");
  await page.goto("/money/reports?month=11");
  await expect(revenue).toContainText("¥149,500");
});
