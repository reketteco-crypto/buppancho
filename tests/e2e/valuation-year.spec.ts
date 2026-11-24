import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { ensureTestContext, confirmCompletionPreview } from "./helpers/completion";
let db: PrismaClient;
test.beforeAll(() => {
  const url = process.env.TEST_DATABASE_URL;
  if (url && !new URL(url).pathname.endsWith("_test"))
    throw new Error("Use an isolated _test database");
  if (url) db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
});
test.afterAll(async () => {
  await db?.$disconnect();
});
test.beforeEach(async ({ page }) => {
  test.skip(
    !db || !process.env.E2E_LOGIN_NAME || !process.env.E2E_PASSWORD,
    "Dedicated DB and authenticated test account required",
  );
  await page.goto("/login");
  await page.getByLabel("ユーザー名").fill(process.env.E2E_LOGIN_NAME!);
  await page.getByLabel("パスワード").fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(page.getByRole("heading", { name: "ホーム", exact: true })).toBeVisible();
  await ensureTestContext(page);
});
async function asset() {
  const a = await db.businessUnitAssignment.findFirstOrThrow({
    where: { businessUnit: { code: "E2E" }, fiscalYearProfile: { year: 2026 } },
    include: { businessUnit: true, fiscalYearProfile: true },
  });
  const location = await db.storageLocation.findFirstOrThrow({
      where: { businessUnitId: a.businessUnitId, code: "MAIN" },
    }),
    token = randomUUID().toUpperCase();
  const item = await db.inventoryItem.create({
    data: {
      workspaceId: a.businessUnit.workspaceId,
      businessUnitId: a.businessUnitId,
      itemCode: `T-${token}`,
      name: `年度原価検証-${token}`,
      managementType: "QUANTITY",
      managementCostMethod: "MOVING_AVERAGE",
      variants: { create: { workspaceId: a.businessUnit.workspaceId, variantCode: `V-${token}` } },
    },
    include: { variants: true },
  });
  const variant = item.variants[0]!;
  await db.$transaction(async (tx) => {
    for (const [day, cost] of [
      ["2026-01-01", 1000n],
      ["2026-03-01", 2000n],
    ] as const) {
      const lot = await tx.inventoryLot.create({
        data: {
          itemVariantId: variant.id,
          trackingMode: "QUANTITY",
          receivedDate: new Date(day),
          receivedQuantity: 10,
          remainingQuantity: 10,
          landedCostTotalJpy: cost,
          unitCostJpy: (cost / 10n).toString(),
          storageLocationId: location.id,
        },
      });
      const operation = await tx.inventoryOperation.create({
        data: {
          workspaceId: a.businessUnit.workspaceId,
          businessUnitId: a.businessUnitId,
          operatorId: a.defaultOperatorId!,
          operationType: "ADJUSTMENT_IN",
          sourceType: "e2e_reliability",
          sourceId: lot.id,
          idempotencyKey: randomUUID(),
          occurredAt: new Date(`${day}T00:00:00+09:00`),
        },
      });
      await tx.stockMovement.create({
        data: {
          operationId: operation.id,
          itemVariantId: variant.id,
          inventoryLotId: lot.id,
          movementType: "ADJUSTMENT_IN",
          quantity: 10,
          costTotalJpy: cost,
          movementAt: operation.occurredAt,
          businessUnitId: a.businessUnitId,
          storageLocationToId: location.id,
          sourceType: "e2e_reliability",
          sourceId: lot.id,
          idempotencyKey: randomUUID(),
          operatorId: a.defaultOperatorId!,
        },
      });
    }
    await tx.inventoryCostBalance.create({
      data: {
        itemVariantId: variant.id,
        businessUnitId: a.businessUnitId,
        trackingMode: "QUANTITY",
        quantity: 20,
        carryingCostTotalJpy: 3000n,
        averageUnitCostJpy: "150",
      },
    });
  });
  return { a, item, variant };
}
async function listing(page: Page, name: string) {
  await page.goto("/sales/listings/new");
  await page.getByLabel("商品名・色・サイズ・個体コードで検索").fill(name);
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await page.getByLabel("出品URLまたは商品ID").fill(`m${Date.now()}`);
  await page.getByLabel("出品価格（円）").fill("980");
  await page.getByLabel("出品日（必須）").fill("2026-01-10");
  await page.getByRole("button", { name: "出品を記録して在庫を確保", exact: true }).click();
  await expect(page.getByText("出品用に確保：1個")).toBeVisible();
  return page.url().split("?")[0]!;
}
test("backdated confirmation shows downstream costs and profits before recording one stock issue", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const { item, variant } = await asset(),
    first = await listing(page, item.name);
  await listing(page, item.name);
  await page.getByRole("link", { name: "取引完了を記録", exact: true }).click();
  await page.getByLabel("完了日（日本時間・必須）").fill("2026-04-01");
  for (const label of ["販売手数料（円）", "負担送料（円）", "梱包費（円）", "その他費用（円）"])
    await page.getByLabel(label).fill("0");
  await confirmCompletionPreview(page);
  await page.getByRole("button", { name: "完了を記録する", exact: true }).click();
  await expect(page).toHaveURL(/\/sales\/orders\/[a-f0-9-]+/);
  const laterId = page.url().split("?")[0]!.split("/").at(-1)!;
  await page.goto(`${first}/complete`);
  await page.getByLabel("完了日（日本時間・必須）").fill("2026-02-01");
  await expect(page.getByRole("heading", { name: "後続の原価への影響（取引1件）" })).toBeVisible();
  await expect(page.getByText("管理原価：¥150 → ¥153", { exact: true })).toBeVisible();
  await expect(page.getByText("返品反映後の管理利益：¥830 → ¥827", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("valuation-impact.png"), fullPage: true });
  await page.getByRole("button", { name: "影響を確認して完了を記録する", exact: true }).click();
  await expect(page).toHaveURL(/\/sales\/orders\/[a-f0-9-]+/);
  const balance = await db.inventoryCostBalance.findFirstOrThrow({
    where: { itemVariantId: variant.id },
  });
  expect(balance.quantity).toBe(18);
  expect(balance.carryingCostTotalJpy).toBe(2747n);
  expect(
    await db.stockMovement.count({ where: { sourceId: laterId, movementType: "SALE_OUT" } }),
  ).toBe(1);
});

test("date correction previews affected costs and recovers one saved correction after acknowledgement loss", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const { item, variant } = await asset();
  const listed = await listing(page, item.name);
  await page.goto(`${listed}/complete`);
  await page.getByLabel("完了日（日本時間・必須）").fill("2026-02-01");
  for (const label of ["販売手数料（円）", "負担送料（円）", "梱包費（円）", "その他費用（円）"])
    await page.getByLabel(label).fill("0");
  await confirmCompletionPreview(page);
  await page.getByRole("button", { name: /完了を記録する$/ }).click();
  await expect(page).toHaveURL(/\/sales\/orders\/[a-f0-9-]+/);
  const orderId = page.url().split("?")[0]!.split("/").at(-1)!;
  const receipt = await db.stockMovement.findFirstOrThrow({
    where: {
      itemVariantId: variant.id,
      movementType: "ADJUSTMENT_IN",
      movementAt: new Date("2026-03-01T00:00:00+09:00"),
    },
  });
  const movements = await db.stockMovement.count({ where: { itemVariantId: variant.id } });
  await page.goto(`/inventory/events/${receipt.operationId}/date`);
  await page.getByLabel("訂正後の日付（日本時間）").fill("2026-01-15");
  await page.getByLabel("訂正理由（必須）").fill("到着日を納品書で確認");
  await expect(page.getByText("管理原価 ¥100 → ¥150", { exact: true })).toBeVisible();
  expect(await db.eventDateCorrection.count({ where: { operationId: receipt.operationId } })).toBe(
    0,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("date-correction-preview.png"), fullPage: true });
  let writes = 0;
  await page.route("**/api/workflow", async (route) => {
    if (route.request().postDataJSON()?.kind === "DATE_CORRECT") {
      writes++;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "影響を確認して日付を訂正する", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存結果を確認する", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "日付訂正の記録", exact: true })).toBeVisible();
  await expect(page.getByText("2026-03-01 → 2026-01-15", { exact: true })).toBeVisible();
  expect(writes).toBe(1);
  expect(await db.eventDateCorrection.count({ where: { operationId: receipt.operationId } })).toBe(
    1,
  );
  expect(await db.stockMovement.count({ where: { itemVariantId: variant.id } })).toBe(movements);
  expect(
    (await db.salesOrderLine.findFirstOrThrow({ where: { salesOrderId: orderId } }))
      .managementCogsJpy,
  ).toBe(150n);
  await page.goto(`/inventory/${item.id}`);
  await expect(page.getByText("当初：2026-03-01", { exact: true })).toBeVisible();
});
test("locked listing year switches explicitly with input intact then completes in the open year", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const { a, item } = await asset(),
    f = a.fiscalYearProfile;
  const target = await db.fiscalYearProfile.upsert({
    where: { reportingEntityId_year: { reportingEntityId: f.reportingEntityId, year: 2027 } },
    update: {},
    create: {
      reportingEntityId: f.reportingEntityId,
      year: 2027,
      filingMethod: f.filingMethod,
      consumptionTaxStatus: f.consumptionTaxStatus,
      blueDeductionTarget: f.blueDeductionTarget,
      inventoryValuationMethod: f.inventoryValuationMethod,
      startDate: new Date("2027-01-01"),
      endDate: new Date("2027-12-31"),
    },
  });
  if (
    !(await db.businessUnitAssignment.findFirst({
      where: { businessUnitId: a.businessUnitId, fiscalYearProfileId: target.id },
    }))
  )
    await db.businessUnitAssignment.create({
      data: {
        businessUnitId: a.businessUnitId,
        fiscalYearProfileId: target.id,
        defaultOperatorId: a.defaultOperatorId,
        effectiveFrom: target.startDate,
        effectiveTo: target.endDate,
      },
    });
  const url = await listing(page, item.name),
    listingId = url.split("/").at(-1)!,
    history = await db.listingPriceHistory.findMany({ where: { listingId } });
  const originalOperatorId = await page.locator('select[name="operatorId"]').inputValue();
  await page.getByRole("link", { name: "取引完了を記録", exact: true }).click();
  await page.getByLabel("完了日（日本時間・必須）").fill("2027-01-02");
  await page.getByLabel("実際に売れた金額").fill("900");
  await expect(page.getByRole("status").filter({ hasText: "保存済み" })).toBeVisible();
  await db.fiscalYearProfile.update({
    where: { id: f.id },
    data: { status: "LOCKED", lockedAt: new Date() },
  });
  try {
    await page.getByRole("button", { name: "2027年度へ切り替えて続ける", exact: true }).click();
    await expect(page.locator("details.context-selector summary")).toContainText(
      "E2E販売部門・2027年",
    );
    await expect(page.locator('select[name="operatorId"]')).toHaveValue(originalOperatorId);
    await expect(page.getByLabel("実際に売れた金額")).toHaveValue("900");
    await expect(page.getByLabel("完了日（日本時間・必須）")).toHaveValue("2027-01-02");
    expect(await db.salesOrder.count({ where: { completionListingId: listingId } })).toBe(0);
    await confirmCompletionPreview(page);
    await page.screenshot({
      path: info.outputPath("year-switch-confirmation.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "完了を記録する", exact: true }).click();
    await expect(page).toHaveURL(/\/sales\/orders\/[a-f0-9-]+/);
    expect(await db.listingPriceHistory.findMany({ where: { listingId } })).toEqual(history);
    expect(await db.salesOrder.count({ where: { completionListingId: listingId } })).toBe(1);
  } finally {
    await db.fiscalYearProfile.update({
      where: { id: f.id },
      data: { status: f.status, lockedAt: f.lockedAt },
    });
  }
});
