import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { test, expect, type Page } from "@playwright/test";
import { ensureTestContext } from "./helpers/completion";
import { readWorkflowRequest, confirmReturnPreview } from "./helpers/workflow";
import { recordListing, recordCompletion } from "@/lib/sales/workflow";
import { listingRecordSchema, completionRecordSchema } from "@/lib/validation/workflow";
import { prepareRequest } from "@/lib/sales/request-store";

let db: PrismaClient;
test.beforeAll(() => {
  const url = process.env.TEST_DATABASE_URL;
  if (url && !new URL(url).pathname.endsWith("_test")) throw new Error("専用テストDBが必要です");
  if (url) db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
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
  test.skip(!db || !process.env.E2E_LOGIN_NAME || !process.env.E2E_PASSWORD, "専用環境が必要です");
  await login(page);
});
async function fixture(componentQuantity = 1) {
  const a = await db.businessUnitAssignment.findFirstOrThrow({
    where: { businessUnit: { code: "E2E" }, fiscalYearProfile: { year: 2026 } },
    include: { businessUnit: true, fiscalYearProfile: true },
  });
  const user = await db.userAccount.findFirstOrThrow({
    where: { workspaceId: a.businessUnit.workspaceId },
  });
  const c = {
    workspaceId: a.businessUnit.workspaceId,
    businessUnitId: a.businessUnitId,
    operatorId: a.defaultOperatorId!,
    reportingEntityId: a.fiscalYearProfile.reportingEntityId,
    year: 2026,
    userAccountId: user.id,
  };
  const location = await db.storageLocation.findFirstOrThrow({
    where: { businessUnitId: c.businessUnitId, code: "MAIN" },
  });
  const token = randomUUID().toUpperCase(),
    date = "2026-10-01";
  const item = await db.inventoryItem.create({
    data: {
      workspaceId: c.workspaceId,
      businessUnitId: c.businessUnitId,
      itemCode: `RT-${token}`,
      name: `返品検証商品-${token}`,
      managementType: "QUANTITY",
      managementCostMethod: "MOVING_AVERAGE",
      variants: { create: { workspaceId: c.workspaceId, variantCode: `RTV-${token}` } },
    },
    include: { variants: true },
  });
  const variant = item.variants[0]!;
  await db.$transaction(async (tx) => {
    const lot = await tx.inventoryLot.create({
      data: {
        itemVariantId: variant.id,
        trackingMode: "QUANTITY",
        receivedDate: new Date("2026-01-01"),
        receivedQuantity: 3,
        remainingQuantity: 3,
        landedCostTotalJpy: 300n,
        unitCostJpy: "100",
        storageLocationId: location.id,
      },
    });
    const op = await tx.inventoryOperation.create({
      data: {
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        operatorId: c.operatorId,
        operationType: "ADJUSTMENT_IN",
        sourceType: "return_e2e",
        sourceId: lot.id,
        idempotencyKey: randomUUID(),
        occurredAt: new Date("2026-01-01T00:00:00+09:00"),
      },
    });
    await tx.stockMovement.create({
      data: {
        operationId: op.id,
        itemVariantId: variant.id,
        inventoryLotId: lot.id,
        movementType: "ADJUSTMENT_IN",
        quantity: 3,
        costTotalJpy: 300n,
        movementAt: op.occurredAt,
        businessUnitId: c.businessUnitId,
        storageLocationToId: location.id,
        sourceType: "return_e2e",
        sourceId: lot.id,
        idempotencyKey: randomUUID(),
        operatorId: c.operatorId,
      },
    });
    await tx.inventoryCostBalance.create({
      data: {
        itemVariantId: variant.id,
        businessUnitId: c.businessUnitId,
        trackingMode: "QUANTITY",
        quantity: 3,
        carryingCostTotalJpy: 300n,
        averageUnitCostJpy: "100",
      },
    });
  });
  const listingId = await recordListing(
    db,
    c,
    listingRecordSchema.parse({
      context: c,
      idempotencyKey: randomUUID(),
      name: item.name,
      components: [
        { itemVariantId: variant.id, uniqueStockUnitId: null, requiredQuantity: componentQuantity },
      ],
      externalReference: `m${BigInt(`0x${token.replaceAll("-", "").slice(0, 16)}`).toString()}`,
      price: "980",
      listedDate: date,
      expectedShipping: "",
    }),
  );
  const id = await recordCompletion(
    db,
    c,
    completionRecordSchema.parse({
      context: c,
      idempotencyKey: randomUUID(),
      listingId,
      revision: 0,
      completedDate: date,
      actualPrice: "980",
      fee: "98",
      shipping: "0",
      packing: "0",
      other: "0",
      purchasedDate: "",
      shippedDate: "",
      shippingMethod: "",
      trackingNumber: "",
      externalOrderId: "",
      memo: "",
    }),
  );
  return { id, variantId: variant.id, url: `/sales/orders/${id}`, c };
}
async function amounts(page: Page, value = "200") {
  await page.getByLabel("売上返金の確認", { exact: true }).selectOption("AMOUNT");
  await page.getByLabel("売上返金（円）", { exact: true }).fill(value);
  await page.getByLabel("手数料返還の確認", { exact: true }).selectOption("NONE");
  await page.getByLabel("送料返還の確認", { exact: true }).selectOption("NONE");
}
async function preview(page: Page) {
  await confirmReturnPreview(page);
}
async function fillReturn(page: Page, url: string) {
  await page.goto(`${url}/return`);
  await page.getByLabel("返品日", { exact: true }).fill("2026-10-02");
  await page.getByRole("combobox", { name: /の処理$/ }).selectOption("RESTOCK");
  await amounts(page);
  await preview(page);
}
test("backdated return shows downstream cost changes and commits one return after a lost acknowledgement", async ({
  page,
}) => {
  const x = await fixture();
  const location = await db.storageLocation.findFirstOrThrow({
    where: { businessUnitId: x.c.businessUnitId, code: "MAIN" },
  });
  await db.$transaction(async (tx) => {
    const lot = await tx.inventoryLot.create({
      data: {
        itemVariantId: x.variantId,
        trackingMode: "QUANTITY",
        receivedDate: new Date("2026-10-03"),
        receivedQuantity: 1,
        remainingQuantity: 1,
        landedCostTotalJpy: 400n,
        unitCostJpy: "400",
        storageLocationId: location.id,
      },
    });
    const operation = await tx.inventoryOperation.create({
      data: {
        workspaceId: x.c.workspaceId,
        businessUnitId: x.c.businessUnitId,
        operatorId: x.c.operatorId,
        operationType: "ADJUSTMENT_IN",
        sourceType: "return_e2e",
        sourceId: lot.id,
        idempotencyKey: randomUUID(),
        occurredAt: new Date("2026-10-03T00:00:00+09:00"),
      },
    });
    await tx.stockMovement.create({
      data: {
        operationId: operation.id,
        itemVariantId: x.variantId,
        inventoryLotId: lot.id,
        movementType: "ADJUSTMENT_IN",
        quantity: 1,
        costTotalJpy: 400n,
        movementAt: operation.occurredAt,
        businessUnitId: x.c.businessUnitId,
        storageLocationToId: location.id,
        sourceType: "return_e2e",
        sourceId: lot.id,
        idempotencyKey: randomUUID(),
        operatorId: x.c.operatorId,
      },
    });
    const balance = await tx.inventoryCostBalance.findFirstOrThrow({
      where: { itemVariantId: x.variantId },
    });
    await tx.inventoryCostBalance.update({
      where: { id: balance.id },
      data: { quantity: 3, carryingCostTotalJpy: 600n, averageUnitCostJpy: "200" },
    });
  });
  const laterListing = await recordListing(
    db,
    x.c,
    listingRecordSchema.parse({
      context: x.c,
      idempotencyKey: randomUUID(),
      name: "後日返品の後続販売",
      components: [{ itemVariantId: x.variantId, uniqueStockUnitId: null, requiredQuantity: 1 }],
      externalReference: `m${BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 16)}`)}`,
      price: "980",
      listedDate: "2026-10-03",
      expectedShipping: "0",
    }),
  );
  const later = await recordCompletion(
    db,
    x.c,
    completionRecordSchema.parse({
      context: x.c,
      idempotencyKey: randomUUID(),
      listingId: laterListing,
      revision: 0,
      completedDate: "2026-10-04",
      actualPrice: "980",
      fee: "98",
      shipping: "0",
      packing: "0",
      other: "0",
      purchasedDate: "",
      shippedDate: "",
      shippingMethod: "",
      trackingNumber: "",
      externalOrderId: "",
      memo: "",
    }),
  );
  const before = await db.stockMovement.count({ where: { itemVariantId: x.variantId } });
  await fillReturn(page, x.url);
  await expect(page.getByText("管理原価 ¥200 → ¥175", { exact: true })).toBeVisible();
  expect(await db.salesReturn.count({ where: { salesOrderId: x.id } })).toBe(0);
  let requests = 0;
  await page.route("**/api/workflow", async (route) => {
    if (route.request().postDataJSON()?.kind === "RETURN") {
      requests++;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "返品を記録する", exact: true }).click();
  await page.getByRole("button", { name: "保存結果を確認する", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "今回の返品・返金を記録しました", exact: true }),
  ).toBeVisible();
  expect(requests).toBe(1);
  expect(await db.stockMovement.count({ where: { itemVariantId: x.variantId } })).toBe(before + 1);
  const balance = await db.inventoryCostBalance.findFirstOrThrow({
    where: { itemVariantId: x.variantId },
  });
  expect(balance.quantity).toBe(3);
  expect(balance.carryingCostTotalJpy).toBe(525n);
  expect(
    (await db.salesOrderLine.findFirstOrThrow({ where: { salesOrderId: later } }))
      .managementCogsJpy,
  ).toBe(175n);
});

test("component quantities return good and defective portions, then dispose the remainder without returning another set", async ({
  page,
}) => {
  const x = await fixture(3);
  await page.goto(`${x.url}/return`);
  await page.getByLabel("返品日", { exact: true }).fill("2026-10-02");
  await page.getByLabel("返品の範囲", { exact: true }).selectOption("COMPONENTS");
  await page.getByRole("spinbutton", { name: /の良品戻しの数量$/ }).fill("1");
  await page.getByRole("spinbutton", { name: /の不良品の数量$/ }).fill("1");
  await amounts(page, "200");
  await preview(page);
  await page.getByRole("button", { name: "返品を記録する", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "今回の返品・返金を記録しました", exact: true }),
  ).toBeVisible();
  const partial = await db.salesOrder.findUniqueOrThrow({ where: { id: x.id } });
  expect(partial.status).toBe("COMPLETED");
  expect(
    (await db.inventoryCostBalance.findFirstOrThrow({ where: { itemVariantId: x.variantId } }))
      .quantity,
  ).toBe(1);
  await page.getByRole("link", { name: "返品を記録", exact: true }).click();
  await page.getByLabel("返品日", { exact: true }).fill("2026-10-02");
  await page.getByLabel("返品の範囲", { exact: true }).selectOption("COMPONENTS");
  await page.getByRole("spinbutton", { name: /の廃棄の数量$/ }).fill("1");
  for (const name of ["売上返金", "手数料返還", "送料返還"])
    await page.getByLabel(`${name}の確認`, { exact: true }).selectOption("NONE");
  await preview(page);
  await page.getByRole("button", { name: "返品を記録する", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "今回の返品・返金を記録しました", exact: true }),
  ).toBeVisible();
  const order = await db.salesOrder.findUniqueOrThrow({
    where: { id: x.id },
    include: { returns: { include: { lines: { include: { dispositions: true } } } } },
  });
  expect(order.status).toBe("RETURNED");
  expect(order.returns).toHaveLength(2);
  const rows = order.returns.flatMap((r) => r.lines.flatMap((l) => l.dispositions));
  expect(rows.reduce((s, r) => s + r.quantity, 0)).toBe(3);
  expect(rows.reduce((s, r) => s + r.costTotalJpy, 0n)).toBe(300n);
  expect(
    (await db.inventoryCostBalance.findFirstOrThrow({ where: { itemVariantId: x.variantId } }))
      .quantity,
  ).toBe(1);
});

test("unknown refund stays in a resumable return draft, then explicit confirmation restores stock", async ({
  page,
}, info) => {
  const x = await fixture();
  await page.goto(`${x.url}/return`);
  await page.getByLabel("返品日", { exact: true }).fill("2026-10-02");
  await page.getByLabel("メモ（任意）", { exact: true }).fill("返金が未確認でも残す入力");
  await expect(page.getByRole("status").filter({ hasText: "保存済み" })).toBeVisible();
  const draftUrl = page.url();
  await page.goto("/");
  await page
    .locator(`a[href*="draft=${new URL(draftUrl).searchParams.get("draft")}"]`)
    .first()
    .click();
  await expect(page.getByLabel("メモ（任意）", { exact: true })).toHaveValue(
    "返金が未確認でも残す入力",
  );
  expect(new URL(page.url()).searchParams.get("draft")).toBe(
    new URL(draftUrl).searchParams.get("draft"),
  );
  await page.getByRole("button", { name: "内容と在庫・損益を確認する", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "入力・確認内容を修正してください" }),
  ).toBeFocused();
  expect(await db.salesReturn.count({ where: { salesOrderId: x.id } })).toBe(0);
  await page.getByRole("combobox", { name: /の処理$/ }).selectOption("RESTOCK");
  await amounts(page);
  await page.getByLabel("返品する販売単位数（セット数）", { exact: true }).fill("2");
  await page.getByRole("button", { name: "内容と在庫・損益を確認する", exact: true }).click();
  await expect(
    page.getByText("返品する販売単位数が返品可能数を超えています。", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("返品する販売単位数（セット数）", { exact: true }).fill("1");
  await preview(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("return-preview.png"), fullPage: true });
  await page.getByRole("button", { name: "返品を記録する", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${x.url}\\?return=`));
  await expect(page.getByText(/販売可能在庫へ戻した数\s+1個/)).toBeVisible();
  expect(
    (await db.inventoryCostBalance.findFirstOrThrow({ where: { itemVariantId: x.variantId } }))
      .quantity,
  ).toBe(3);
});
for (const choice of ["LOCAL", "NEW"] as const)
  test(`refund conflict ${choice} archives local input without business updates and recovers a lost rebase response`, async ({
    page,
    context,
  }, info) => {
    test.setTimeout(120000);
    const x = await fixture();
    await page.goto(`${x.url}/return?kind=REFUND`);
    await page.getByLabel("返金・返還日", { exact: true }).fill("2026-10-02");
    await amounts(page, "300");
    await page.getByLabel("返金・返還の理由", { exact: true }).fill("手元に残す理由");
    await expect(page.getByRole("status").filter({ hasText: "保存済み" })).toBeVisible();
    const oldDraft = new URL(page.url()).searchParams.get("draft")!;
    const other = await context.newPage();
    await other.goto(`${x.url}/return?kind=REFUND`);
    await other.getByLabel("返金・返還日", { exact: true }).fill("2026-10-02");
    await amounts(other, "100");
    await other.getByLabel("返金・返還の理由", { exact: true }).fill("別端末の返金");
    await preview(other);
    await other.getByRole("button", { name: "在庫を変えずに返金を記録する", exact: true }).click();
    await expect(other).toHaveURL(new RegExp(`${x.url}\\?return=`));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(
      page.getByRole("heading", { name: "返品・返金の変更を確認してください" }),
    ).toBeFocused();
    await expect(page.getByText(/今回の手元の予定：売上返金：¥300/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: info.outputPath(`return-conflict-${choice}.png`),
      fullPage: true,
    });
    let rebaseCount = 0;
    await page.route("**/api/workflow", async (route) => {
      if (route.request().postDataJSON()?.kind === "RETURN_REBASE") {
        rebaseCount++;
        await route.fetch();
        await route.abort();
      } else await route.continue();
    });
    await page
      .getByRole("button", {
        name:
          choice === "LOCAL" ? "手元の入力を引き継いで再確認" : "手元の入力を退避して新しく入力",
        exact: true,
      })
      .press("Enter");
    await expect(
      page.getByRole("button", { name: "保存結果を確認する", exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(/kind=REFUND&draft=/);
    expect(new URL(page.url()).searchParams.get("draft")).not.toBe(oldDraft);
    expect(rebaseCount).toBe(1);
    expect(await db.salesReturn.count({ where: { salesOrderId: x.id } })).toBe(1);
    expect(
      (await db.inventoryCostBalance.findFirstOrThrow({ where: { itemVariantId: x.variantId } }))
        .quantity,
    ).toBe(2);
    await expect(page.getByLabel("返金・返還の理由", { exact: true })).toHaveValue(
      choice === "LOCAL" ? "手元に残す理由" : "",
    );
    if (choice === "NEW") {
      await expect(page.getByLabel("返金・返還日", { exact: true })).toHaveValue("");
      await expect(page.getByLabel("売上返金の確認", { exact: true })).toHaveValue("UNKNOWN");
      await page.getByText("選び直す前の手元入力を確認する", { exact: true }).click();
      await expect(
        page.getByText("今回の手元の予定：手元に残す理由", { exact: true }),
      ).toBeVisible();
    } else {
      await page.unroute("**/api/workflow");
      await preview(page);
      await page.getByRole("button", { name: "在庫を変えずに返金を記録する", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${x.url}\\?return=`));
      expect(
        await db.salesReturn.aggregate({
          where: { salesOrderId: x.id },
          _sum: { salesRefundJpy: true },
        }),
      ).toMatchObject({ _sum: { salesRefundJpy: 400n } });
    }
    await other.close();
  });
test("a lost saved return response survives reload and login with only one return and stock movement", async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  const x = await fixture();
  await fillReturn(page, x.url);
  let count = 0;
  await page.route("**/api/workflow", async (route) => {
    if (route.request().postDataJSON()?.kind === "RETURN") {
      count++;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await page.getByRole("button", { name: "返品を記録する", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存結果を確認する", exact: true })).toBeVisible();
  const recovery = page.url(),
    key = new URL(recovery).searchParams.get("operation")!;
  const saved = await readWorkflowRequest(page, key);
  expect(saved).toMatchObject({ status: "APPLIED", recordId: expect.any(String) });
  await context.clearCookies();
  await login(page);
  await page.goto(recovery);
  await expect(page).toHaveURL(new RegExp(`${x.url}\\?return=${saved.recordId}`));
  expect(count).toBe(1);
  expect(
    await db.salesReturn.count({ where: { salesOrderId: x.id, sourceDraftId: { not: null } } }),
  ).toBe(1);
  expect(await db.stockMovement.count({ where: { sourceId: saved.recordId } })).toBe(1);
});
test("an undelivered request must be cancelled before editing and explicitly returning once", async ({
  page,
}) => {
  const x = await fixture();
  await fillReturn(page, x.url);
  let first = true;
  await page.route("**/api/workflow", async (route) => {
    if (first && route.request().postDataJSON()?.kind === "RETURN") {
      first = false;
      await route.abort();
    } else await route.continue();
  });
  await page.getByRole("button", { name: "返品を記録する", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存結果を確認する", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "保存結果を確認する", exact: true }).click();
  await page
    .getByRole("button", { name: "未確定の要求を取り消して入力へ戻る", exact: true })
    .click();
  expect(await db.salesReturn.count({ where: { salesOrderId: x.id } })).toBe(0);
  await page.getByLabel("売上返金（円）", { exact: true }).fill("100");
  await preview(page);
  await page.getByRole("button", { name: "返品を記録する", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${x.url}\\?return=`));
  expect(await db.salesReturn.count({ where: { salesOrderId: x.id } })).toBe(1);
});
test("all returned on another device keeps local input visible but prevents another physical return", async ({
  page,
  context,
}) => {
  const x = await fixture();
  await fillReturn(page, x.url);
  await page.getByLabel("メモ（任意）", { exact: true }).fill("全数返品後も残す入力");
  await expect(page.getByRole("status").filter({ hasText: "保存済み" })).toBeVisible();
  const draftUrl = page.url(),
    other = await context.newPage();
  await fillReturn(other, x.url);
  await other.getByRole("button", { name: "返品を記録する", exact: true }).click();
  await expect(other).toHaveURL(new RegExp(`${x.url}\\?return=`));
  await page.goto(draftUrl);
  await expect(
    page.getByText("今回の手元の予定：全数返品後も残す入力", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "手元の入力を引き継いで再確認", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("alert").filter({ hasText: "全数返品済み" })).toBeVisible();
  expect(await db.salesReturn.count({ where: { salesOrderId: x.id } })).toBe(1);
  await other.close();
});
test("connection loss during processing keeps editing disabled until the original request result is known", async ({
  page,
}) => {
  test.setTimeout(60000);
  const x = await fixture();
  await fillReturn(page, x.url);
  await expect(page.getByRole("status").filter({ hasText: "保存済み" })).toBeVisible();
  let release!: () => void, entered!: () => void;
  const holding = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lock = db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`inventory-domain:${x.c.businessUnitId}`},0))`;
      entered();
      await finish;
    },
    { timeout: 30000 },
  );
  await holding;
  let response: Promise<unknown> | undefined;
  await page.route("**/api/workflow", async (route) => {
    const body = route.request().postDataJSON();
    if (body?.kind === "RETURN") {
      response = route.fetch().catch(() => undefined);
      await expect
        .poll(
          async () =>
            (await db.workflowRequest.findUnique({ where: { id: body.payload.idempotencyKey } }))
              ?.status,
        )
        .toBe("PREPARED");
      await route.abort();
    } else await route.continue();
  });
  try {
    await page.getByRole("button", { name: "返品を記録する", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "保存結果を確認する", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "保存結果を確認する", exact: true }).click();
    await expect(page.getByLabel("売上返金（円）", { exact: true })).toBeDisabled();
    expect(await db.salesReturn.count({ where: { salesOrderId: x.id } })).toBe(0);
  } finally {
    release();
    await lock;
    await response;
  }
  await page.getByRole("button", { name: "保存結果を確認する", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${x.url}\\?return=`));
  expect(await db.salesReturn.count({ where: { salesOrderId: x.id } })).toBe(1);
});
test("resuming a prepared draft requires settling the request before editing and cancellation resumes input", async ({
  page,
}) => {
  const x = await fixture();
  await fillReturn(page, x.url);
  await expect(page).toHaveURL(/draft=/);
  await expect(page.getByRole("status").filter({ hasText: "保存済み" })).toBeVisible();
  const draftId = new URL(page.url()).searchParams.get("draft")!;
  const key = randomUUID();
  await prepareRequest(db, x.c, key, "RETURN", { context: x.c, orderId: x.id, draftId });
  await page.goto(`${x.url}/return?draft=${draftId}`);
  await expect(page).toHaveURL(new RegExp(`operation=${key}`));
  await expect(page.getByLabel("売上返金（円）", { exact: true })).toBeDisabled();
  await page
    .getByRole("button", { name: "未確定の要求を取り消して入力へ戻る", exact: true })
    .click();
  await expect(page.getByLabel("売上返金（円）", { exact: true })).toBeEnabled();
  await page.getByLabel("売上返金（円）", { exact: true }).fill("100");
  await preview(page);
  await page.getByRole("button", { name: "返品を記録する", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${x.url}\\?return=`));
  expect(await db.salesReturn.count({ where: { salesOrderId: x.id } })).toBe(1);
});
