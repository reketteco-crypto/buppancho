import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  saveWorkflowDraftAction,
  switchCompletionYearAction,
  resumeWorkflowRequestAction,
  submitWorkflowAction,
} from "@/app/sales/workflow-actions";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/origin", () => ({ assertTrustedOrigin: async () => {} }));
vi.mock("@/lib/inventory/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/inventory/context")>()),
  requireInventoryContext: async () => {
    const session = await db.authSession.findUniqueOrThrow({ where: { id: testSessionId } });
    const assignment = await db.businessUnitAssignment.findFirstOrThrow({
      where: {
        businessUnitId: session.activeBusinessUnitId!,
        fiscalYearProfile: { year: session.selectedYear! },
      },
      include: { fiscalYearProfile: true },
    });
    return {
      db,
      session,
      workspaceId: c.workspaceId,
      businessUnitId: session.activeBusinessUnitId,
      operatorId: session.activeOperatorId,
      reportingEntityId: assignment.fiscalYearProfile.reportingEntityId,
      fiscalYear: assignment.fiscalYearProfile,
    };
  },
}));
import {
  recordListing,
  recordCompletion,
  recordListingEvent,
  amendAmounts,
  recordRefund,
  recordPrice,
  previewCompletion,
  type WorkflowContext,
} from "@/lib/sales/workflow";
import {
  listingRecordSchema,
  completionRecordSchema,
  listingEventSchema,
  amountAmendSchema,
  refundRecordSchema,
  priceRecordSchema,
} from "@/lib/validation/workflow";
import { averageUnitCost } from "@/lib/inventory/money";
import { lockInventoryDomain } from "@/lib/inventory/domain-lock";
import { requestResult, prepareRequest } from "@/lib/sales/request-store";
import { recordInventoryOperation } from "@/lib/inventory/workflow";
import { recordStocktake } from "@/lib/inventory/stocktake-workflow";
import {
  listingReturnDraftSnapshot,
  loadListingReturnDraftReview,
  rebaseListingReturn,
} from "@/lib/sales/listing-return-drafts";
import {
  blankListingReturnInput,
  listingReturnRebaseSchema,
} from "@/lib/sales/listing-return-input";
import { recordListingReturn, closeListingReturn } from "@/lib/sales/listing-return-workflow";
import { listingReturnSchema, listingReturnCloseSchema } from "@/lib/validation/workflow";
import { stocktakeRecordSchema } from "@/lib/validation/workflow";
import { captureValuationPreview } from "@/lib/inventory/shared-valuation";
import { recordDateCorrection, dateCorrectionSchema } from "@/lib/inventory/date-correction";
import {
  inventoryRecordSchema,
  purchaseRecordSchema,
  purchaseEventSchema,
} from "@/lib/validation/workflow";
import { recordPurchase, recordPurchaseEvent } from "@/lib/inventory/purchase-workflow";
import {
  loadPurchaseReview,
  rebasePurchase,
  purchaseRebaseSchema,
} from "@/lib/inventory/purchase-conflict";
import { toJson } from "@/lib/sales/request-store";
import { listingEstimateSchema, previewListingEstimate } from "@/lib/sales/listing-estimate";
import {
  loadReturnReview,
  previewReturn,
  previewReturnWorkflow,
  recordReturn,
  rebaseReturn,
} from "@/lib/sales/return-workflow";
import {
  blankReturnInput,
  returnRecordSchema,
  returnRebaseSchema,
  type ReturnKind,
} from "@/lib/sales/return-types";

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
let db: PrismaClient, c: WorkflowContext, locationId: string;
let testSessionId: string;
const date = "2026-09-10";
const externalId = () =>
  `m${BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 20)}`).toString()}`;
suite("listing-owned stock and direct completion", { timeout: 30000 }, () => {
  beforeAll(async () => {
    if (!connectionString || !new URL(connectionString).pathname.endsWith("_test"))
      throw new Error("Use a dedicated database whose name ends in _test for workflow tests.");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
    // Keep preview/save snapshots independent of accumulated fixtures and open E2E sessions.
    const workspace = await db.workspace.create({ data: { name: `workflow-${randomUUID()}` } });
    const entity = await db.reportingEntity.create({
      data: { workspaceId: workspace.id, displayName: "検証主体" },
    });
    const unit = await db.businessUnit.create({
      data: { workspaceId: workspace.id, code: "MAIN", name: "検証部門", color: "#355d4c" },
    });
    const operator = await db.operator.create({
      data: { workspaceId: workspace.id, displayName: "検証入力者" },
    });
    const user = await db.userAccount.create({
      data: {
        workspaceId: workspace.id,
        loginName: randomUUID(),
        normalizedName: randomUUID(),
        passwordHash: "test-only-placeholder",
      },
    });
    const fiscal = await db.fiscalYearProfile.create({
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
        defaultOperatorId: operator.id,
        effectiveFrom: new Date("2026-01-01"),
        effectiveTo: new Date("2026-12-31"),
      },
    });
    await db.counterparty.create({
      data: { workspaceId: workspace.id, name: "検証仕入先", type: "SUPPLIER" },
    });
    await db.salesChannel.create({
      data: { workspaceId: workspace.id, name: "検証販路", type: "MERCARI", defaultFeeRate: "0.1" },
    });
    c = {
      workspaceId: workspace.id,
      businessUnitId: unit.id,
      operatorId: operator.id,
      year: 2026,
      reportingEntityId: entity.id,
      userAccountId: user.id,
    };
    locationId = (
      await db.storageLocation.create({
        data: {
          workspaceId: c.workspaceId,
          businessUnitId: unit.id,
          code: "MAIN",
          name: "検証場所",
        },
      })
    ).id;
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  async function inventory(quantity: number, unique = false, totalCost = BigInt(quantity) * 100n) {
    const id = randomUUID().toUpperCase();
    const item = await db.inventoryItem.create({
      data: {
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        itemCode: `T-${id}`,
        name: `UX test ${id}`,
        managementType: unique ? "UNIQUE" : "QUANTITY",
        managementCostMethod: unique ? "SPECIFIC" : "MOVING_AVERAGE",
        variants: { create: { workspaceId: c.workspaceId, variantCode: `V-${id}` } },
      },
      include: { variants: true },
    });
    const variantId = item.variants[0]!.id;
    const mode = unique ? "UNIQUE" : "QUANTITY";
    const lot = await db.inventoryLot.create({
      data: {
        itemVariantId: variantId,
        trackingMode: mode,
        receivedDate: new Date("2026-01-01Z"),
        receivedQuantity: quantity,
        remainingQuantity: quantity,
        landedCostTotalJpy: totalCost,
        unitCostJpy: averageUnitCost(totalCost, quantity),
        storageLocationId: locationId,
      },
    });
    await db.inventoryCostBalance.create({
      data: {
        itemVariantId: variantId,
        businessUnitId: c.businessUnitId,
        trackingMode: mode,
        quantity,
        carryingCostTotalJpy: totalCost,
        averageUnitCostJpy: averageUnitCost(totalCost, quantity),
      },
    });
    const unit = unique
      ? await db.uniqueStockUnit.create({
          data: {
            workspaceId: c.workspaceId,
            itemVariantId: variantId,
            inventoryLotId: lot.id,
            individualCode: `U-${id}`,
            condition: "良品",
            acquisitionCostJpy: 100n,
            storageLocationId: locationId,
          },
        })
      : null;
    const operation = await db.inventoryOperation.create({
      data: {
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        operatorId: c.operatorId,
        operationType: "ADJUSTMENT_IN",
        sourceType: "ux_test",
        sourceId: id,
        idempotencyKey: id,
        occurredAt: new Date("2026-01-01Z"),
      },
    });
    await db.stockMovement.create({
      data: {
        operationId: operation.id,
        itemVariantId: variantId,
        inventoryLotId: lot.id,
        uniqueStockUnitId: unit?.id,
        movementType: "ADJUSTMENT_IN",
        quantity,
        costTotalJpy: totalCost,
        movementAt: operation.occurredAt,
        businessUnitId: c.businessUnitId,
        storageLocationToId: locationId,
        sourceType: "ux_test",
        sourceId: id,
        idempotencyKey: `${id}:in`,
        operatorId: c.operatorId,
      },
    });
    return {
      variantId,
      lotId: lot.id,
      component: {
        itemVariantId: unique ? null : variantId,
        uniqueStockUnitId: unit?.id ?? null,
        requiredQuantity: 1,
      },
    };
  }
  function listing(
    components: Array<{
      itemVariantId: string | null;
      uniqueStockUnitId: string | null;
      requiredQuantity: number;
    }>,
    price = "1280",
  ) {
    return listingRecordSchema.parse({
      idempotencyKey: randomUUID(),
      context: c,
      name: "UX出品",
      components,
      externalReference: externalId(),
      price,
      listedDate: date,
      expectedShipping: "",
    });
  }
  function completion(listingId: string, revision = 0) {
    return completionRecordSchema.parse({
      idempotencyKey: randomUUID(),
      context: c,
      listingId,
      revision,
      completedDate: date,
      actualPrice: "980",
      fee: "98",
      shipping: "",
      packing: "0",
      other: "0",
      purchasedDate: "",
      shippedDate: "",
      shippingMethod: "",
      trackingNumber: "",
      externalOrderId: "",
      memo: "",
    });
  }
  async function balance(variantId: string) {
    const b = await db.inventoryCostBalance.findFirstOrThrow({
      where: { itemVariantId: variantId },
    });
    const held = await db.inventoryReservation.aggregate({
      where: { itemVariantId: variantId, status: "RESERVED" },
      _sum: { quantity: true },
    });
    return {
      quantity: b.quantity,
      held: held._sum.quantity ?? 0,
      free: b.quantity - (held._sum.quantity ?? 0),
      cost: b.carryingCostTotalJpy,
    };
  }
  async function receipt(variantId: string, receivedDate: string, quantity = 10, cost = 2000n) {
    return db.$transaction(async (tx) => {
      await lockInventoryDomain(tx, c.businessUnitId);
      const b = await tx.inventoryCostBalance.findFirstOrThrow({
        where: { itemVariantId: variantId },
      });
      const lot = await tx.inventoryLot.create({
        data: {
          itemVariantId: variantId,
          trackingMode: "QUANTITY",
          receivedDate: new Date(receivedDate),
          receivedQuantity: quantity,
          remainingQuantity: quantity,
          landedCostTotalJpy: cost,
          unitCostJpy: averageUnitCost(cost, quantity),
          storageLocationId: locationId,
        },
      });
      const op = await tx.inventoryOperation.create({
        data: {
          workspaceId: c.workspaceId,
          businessUnitId: c.businessUnitId,
          operatorId: c.operatorId,
          operationType: "ADJUSTMENT_IN",
          sourceType: "test_receipt",
          sourceId: lot.id,
          idempotencyKey: randomUUID(),
          occurredAt: new Date(`${receivedDate}T00:00:00+09:00`),
        },
      });
      await tx.stockMovement.create({
        data: {
          operationId: op.id,
          itemVariantId: variantId,
          inventoryLotId: lot.id,
          movementType: "ADJUSTMENT_IN",
          quantity,
          costTotalJpy: cost,
          movementAt: op.occurredAt,
          businessUnitId: c.businessUnitId,
          storageLocationToId: locationId,
          sourceType: "test_receipt",
          sourceId: lot.id,
          idempotencyKey: randomUUID(),
          operatorId: c.operatorId,
        },
      });
      await tx.inventoryCostBalance.update({
        where: { id: b.id },
        data: {
          quantity: b.quantity + quantity,
          carryingCostTotalJpy: b.carryingCostTotalJpy + cost,
          averageUnitCostJpy: averageUnitCost(b.carryingCostTotalJpy + cost, b.quantity + quantity),
        },
      });
      return op;
    });
  }
  it("backdated completion uses 100 yen and leaves 19 units / 2900 yen", async () => {
    const i = await inventory(10),
      id = await recordListing(db, c, { ...listing([i.component]), listedDate: "2026-01-01" });
    await receipt(i.variantId, "2026-03-01");
    const input = { ...completion(id), completedDate: "2026-02-01" },
      p = await previewCompletion(db, c, input);
    expect(p.cost).toBe(100n);
    expect(p.changes).toHaveLength(0);
    const key = { ...input, valuationFingerprint: p.fingerprint };
    await recordCompletion(db, c, key);
    await recordCompletion(db, c, key);
    expect(await balance(i.variantId)).toEqual({ quantity: 19, held: 0, free: 19, cost: 2900n });
  });
  it("previews a backdated inventory increase without committing and corrects only subsequent costs", async () => {
    const i = await inventory(10);
    await receipt(i.variantId, "2026-03-01");
    const listingId = await recordListing(db, c, {
      ...listing([i.component]),
      listedDate: "2026-03-02",
    });
    const orderId = await recordCompletion(db, c, {
      ...completion(listingId),
      completedDate: "2026-04-01",
    });
    const revision = await db.inventoryRevision.findUniqueOrThrow({
      where: { businessUnitId: c.businessUnitId },
    });
    const input = inventoryRecordSchema.parse({
      context: c,
      idempotencyKey: randomUUID(),
      operationType: "ADJUSTMENT_IN",
      variantId: i.variantId,
      uniqueStockUnitId: "",
      trackingMode: "QUANTITY",
      quantity: 1,
      fromLocationId: "",
      toLocationId: locationId,
      occurredDate: "2026-02-01",
      unitCostJpy: "100",
      reason: "入力漏れ",
      note: "後日入力",
      inventoryRevision: revision.revision.toString(),
    });
    const count = await db.stockMovement.count({ where: { itemVariantId: i.variantId } });
    const p = await captureValuationPreview(() => recordInventoryOperation(db, c, input));
    expect(await db.stockMovement.count({ where: { itemVariantId: i.variantId } })).toBe(count);
    expect(await db.workflowRequest.findUnique({ where: { id: input.idempotencyKey } })).toBeNull();
    expect(p.orderImpacts[0]).toMatchObject({ beforeCost: "150", afterCost: "148" });
    await recordInventoryOperation(db, c, { ...input, valuationFingerprint: p.fingerprint });
    expect(await balance(i.variantId)).toMatchObject({ quantity: 20, cost: 2952n });
    expect(
      (await db.salesOrderLine.findFirstOrThrow({ where: { salesOrderId: orderId } }))
        .managementCogsJpy,
    ).toBe(148n);
    expect(
      await db.stockMovement.count({
        where: { itemVariantId: i.variantId, movementType: "SALE_OUT" },
      }),
    ).toBe(1);
    await recordInventoryOperation(db, c, { ...input, valuationFingerprint: p.fingerprint });
    expect(await db.stockMovement.count({ where: { itemVariantId: i.variantId } })).toBe(count + 1);
  });
  it("appends an effective receipt date and cost corrections without recreating stock movements", async () => {
    const i = await inventory(10);
    const later = await receipt(i.variantId, "2026-03-01");
    const listingId = await recordListing(db, c, {
      ...listing([i.component]),
      listedDate: "2026-01-02",
    });
    const orderId = await recordCompletion(db, c, {
      ...completion(listingId),
      completedDate: "2026-02-01",
    });
    const input = dateCorrectionSchema.parse({
      context: c,
      idempotencyKey: randomUUID(),
      operationId: later.id,
      previousDate: "2026-03-01",
      date: "2026-01-15",
      reason: "実際の到着日を確認",
    });
    const count = await db.stockMovement.count({ where: { itemVariantId: i.variantId } });
    const p = await captureValuationPreview(() => recordDateCorrection(db, c, input));
    expect(await db.eventDateCorrection.count({ where: { operationId: later.id } })).toBe(0);
    await recordDateCorrection(db, c, { ...input, valuationFingerprint: p.fingerprint });
    expect(await db.stockMovement.count({ where: { itemVariantId: i.variantId } })).toBe(count);
    expect(
      (await db.inventoryOperation.findUniqueOrThrow({ where: { id: later.id } })).occurredAt,
    ).toEqual(later.occurredAt);
    expect(
      (await db.salesOrderLine.findFirstOrThrow({ where: { salesOrderId: orderId } }))
        .managementCogsJpy,
    ).toBe(150n);
    expect(await balance(i.variantId)).toMatchObject({ quantity: 19, cost: 2850n });
    const nextListing = await recordListing(db, c, {
      ...listing([i.component]),
      listedDate: "2026-04-01",
    });
    await recordCompletion(db, c, { ...completion(nextListing), completedDate: "2026-05-01" });
    expect(await balance(i.variantId)).toMatchObject({ quantity: 18, cost: 2700n });
  });
  it("revalues a subsequent sale through append-only corrections and invalidates old previews", async () => {
    const i = await inventory(10),
      a = await recordListing(db, c, { ...listing([i.component]), listedDate: "2026-01-01" }),
      b = await recordListing(db, c, { ...listing([i.component]), listedDate: "2026-01-01" });
    await receipt(i.variantId, "2026-03-01");
    const laterId = await recordCompletion(db, c, {
      ...completion(b),
      completedDate: "2026-04-01",
    });
    const input = { ...completion(a), completedDate: "2026-02-01" },
      p = await previewCompletion(db, c, input);
    expect(p.changes.find((x) => x.type === "CONSUMPTION")).toMatchObject({
      before: 150n,
      after: 153n,
    });
    await receipt(i.variantId, "2026-05-01", 1, 200n);
    await expect(
      recordCompletion(db, c, { ...input, valuationFingerprint: p.fingerprint }),
    ).rejects.toThrow("再確認");
    expect(await db.salesOrder.count({ where: { completionListingId: a } })).toBe(0);
    const next = { ...input, idempotencyKey: randomUUID() },
      confirmed = await previewCompletion(db, c, next);
    await recordCompletion(db, c, { ...next, valuationFingerprint: confirmed.fingerprint });
    const line = await db.salesOrderLine.findFirstOrThrow({
      where: { salesOrderId: laterId },
      include: { consumptions: true },
    });
    expect(line.managementCogsJpy).toBe(153n);
    expect(line.consumptions[0]!.costTotalJpy).toBe(150n);
    expect(
      await db.stockMovement.count({ where: { sourceId: laterId, movementType: "SALE_OUT" } }),
    ).toBe(1);
    expect((await balance(i.variantId)).cost).toBe(2947n);
    const correction = await db.valuationAdjustment.findFirstOrThrow({
      where: { targetId: line.consumptions[0]!.id },
    });
    await expect(
      db.valuationAdjustment.update({ where: { id: correction.id }, data: { afterJpy: 999n } }),
    ).rejects.toThrow();
  });
  it("keeps the first date correction and rejects a concurrent stale correction without duplicating movements", async () => {
    const i = await inventory(3);
    const receipt = await db.stockMovement.findFirstOrThrow({
      where: { inventoryLotId: i.lotId, movementType: "ADJUSTMENT_IN" },
    });
    const make = (day: string) =>
      dateCorrectionSchema.parse({
        context: c,
        idempotencyKey: randomUUID(),
        operationId: receipt.operationId,
        previousDate: "2026-01-01",
        date: day,
        reason: "納品日を確認",
      });
    const first = make("2026-01-02"),
      second = make("2026-01-03");
    const a = await captureValuationPreview(() => recordDateCorrection(db, c, first));
    const b = await captureValuationPreview(() => recordDateCorrection(db, c, second));
    const count = await db.stockMovement.count({ where: { itemVariantId: i.variantId } });
    const key = await recordDateCorrection(db, c, {
      ...first,
      valuationFingerprint: a.fingerprint,
    });
    expect(
      await recordDateCorrection(db, c, { ...first, valuationFingerprint: a.fingerprint }),
    ).toBe(key);
    await expect(
      recordDateCorrection(db, c, { ...second, valuationFingerprint: b.fingerprint }),
    ).rejects.toThrow("日付が別操作");
    expect(
      await db.eventDateCorrection.count({ where: { operationId: receipt.operationId } }),
    ).toBe(1);
    expect(await db.stockMovement.count({ where: { itemVariantId: i.variantId } })).toBe(count);
  });
  it("refuses an acquisition date after consumption and preserves the original event", async () => {
    const i = await inventory(3);
    const receipt = await db.stockMovement.findFirstOrThrow({
      where: { inventoryLotId: i.lotId, movementType: "ADJUSTMENT_IN" },
    });
    const listingId = await recordListing(db, c, {
      ...listing([i.component]),
      listedDate: "2026-01-02",
    });
    await recordCompletion(db, c, { ...completion(listingId), completedDate: "2026-02-01" });
    const input = dateCorrectionSchema.parse({
      context: c,
      idempotencyKey: randomUUID(),
      operationId: receipt.operationId,
      previousDate: "2026-01-01",
      date: "2026-03-01",
      reason: "後日の納品を確認",
    });
    await expect(
      captureValuationPreview(() => recordDateCorrection(db, c, input)),
    ).rejects.toThrow();
    expect(
      await db.eventDateCorrection.count({ where: { operationId: receipt.operationId } }),
    ).toBe(0);
    expect((await balance(i.variantId)).quantity).toBe(2);
  });
  it("refuses a receipt correction before the purchase date", async () => {
    const i = await inventory(3);
    const purchaseId = await recordPurchase(db, c, await purchaseRequest(i.variantId));
    await recordPurchaseEvent(db, c, purchaseEvent(purchaseId, 0), "PURCHASE_RECEIVE");
    const operation = await db.inventoryOperation.findFirstOrThrow({
      where: { sourceType: "purchase", sourceId: purchaseId, operationType: "PURCHASE_RECEIPT" },
    });
    const input = dateCorrectionSchema.parse({
      context: c,
      idempotencyKey: randomUUID(),
      operationId: operation.id,
      previousDate: date,
      date: "2026-09-09",
      reason: "日付を確認",
    });
    await expect(captureValuationPreview(() => recordDateCorrection(db, c, input))).rejects.toThrow(
      "仕入日以降",
    );
    expect(await db.eventDateCorrection.count({ where: { operationId: operation.id } })).toBe(0);
  });
  it("does not ask same-day ordering for receipts with identical valuation outcomes", async () => {
    const i = await inventory(3);
    await receipt(i.variantId, date);
    const purchaseId = await recordPurchase(db, c, await purchaseRequest(i.variantId));
    const input = purchaseEvent(purchaseId, 0);
    const preview = await captureValuationPreview(() =>
      recordPurchaseEvent(db, c, input, "PURCHASE_RECEIVE"),
    );
    expect(preview.requiresOrder).toBe(false);
    await recordPurchaseEvent(
      db,
      c,
      { ...input, valuationFingerprint: preview.fingerprint },
      "PURCHASE_RECEIVE",
    );
    expect((await db.purchase.findUniqueOrThrow({ where: { id: purchaseId } })).status).toBe(
      "FINALIZED",
    );
  });
  it("refuses moving a completion after its refund or before its listing date", async () => {
    const i = await inventory(3),
      listingId = await recordListing(db, c, listing([i.component]));
    const orderId = await recordCompletion(db, c, completion(listingId));
    await recordRefund(
      db,
      c,
      refundRecordSchema.parse({
        context: c,
        idempotencyKey: randomUUID(),
        orderId,
        revision: 0,
        date,
        salesRefund: "100",
        feeRefund: "0",
        shippingRefund: "0",
        reason: "返金",
      }),
    );
    const operation = await db.inventoryOperation.findFirstOrThrow({
      where: { sourceId: orderId, operationType: "SALE_COMPLETION" },
    });
    const input = dateCorrectionSchema.parse({
      context: c,
      idempotencyKey: randomUUID(),
      operationId: operation.id,
      previousDate: date,
      date: "2026-09-11",
      reason: "日付を確認",
    });
    await expect(captureValuationPreview(() => recordDateCorrection(db, c, input))).rejects.toThrow(
      "返品・返金日より後",
    );
    await expect(
      captureValuationPreview(() => recordDateCorrection(db, c, { ...input, date: "2026-09-09" })),
    ).rejects.toThrow("出品日以降");
    expect(await db.eventDateCorrection.count({ where: { operationId: operation.id } })).toBe(0);
  });
  it("asks same-day placement only when it changes costs or inventory validity", async () => {
    const i = await inventory(10),
      id = await recordListing(db, c, { ...listing([i.component]), listedDate: "2026-01-01" });
    const op = await receipt(i.variantId, "2026-03-01");
    const input = { ...completion(id), completedDate: "2026-03-01" };
    expect((await previewCompletion(db, c, input)).requiresOrder).toBe(true);
    const before = await previewCompletion(db, c, { ...input, valuationPosition: op.id }),
      after = await previewCompletion(db, c, { ...input, valuationPosition: "LAST" });
    expect(before.cost).toBe(100n);
    expect(after.cost).toBe(150n);
    const saved = { ...input, valuationPosition: op.id, valuationFingerprint: before.fingerprint };
    await recordCompletion(db, c, saved);
    await recordCompletion(db, c, saved);
    expect((await balance(i.variantId)).cost).toBe(2900n);
    const j = await inventory(10),
      other = await recordListing(db, c, { ...listing([j.component]), listedDate: "2026-01-01" });
    await receipt(j.variantId, "2026-03-01", 10, 1000n);
    expect(
      (await previewCompletion(db, c, { ...completion(other), completedDate: "2026-03-01" }))
        .requiresOrder,
    ).toBe(false);
  });
  it("durable requests recover saved results, reject changed payloads and tombstone cancelled unknown requests", async () => {
    const i = await inventory(2),
      input = listing([i.component]);
    await prepareRequest(db, c, input.idempotencyKey, "LIST", input);
    expect((await requestResult(db, c, input.idempotencyKey)).status).toBe("PREPARED");
    const id = await recordListing(db, c, input);
    expect(await requestResult(db, c, input.idempotencyKey)).toMatchObject({
      status: "APPLIED",
      id,
    });
    expect(await requestResult(db, c, input.idempotencyKey, true)).toMatchObject({
      status: "APPLIED",
      id,
    });
    await expect(recordListing(db, c, { ...input, price: 500n })).rejects.toThrow("操作キー");
    const cancelled = listing([i.component]);
    expect((await requestResult(db, c, cancelled.idempotencyKey)).status).toBe("UNKNOWN");
    expect((await requestResult(db, c, cancelled.idempotencyKey, true)).status).toBe("CANCELLED");
    await expect(recordListing(db, c, cancelled)).rejects.toThrow();
    await expect(
      db.workflowRequest.update({
        where: { id: input.idempotencyKey },
        data: { status: "PREPARED", targetId: null },
      }),
    ).rejects.toThrow();
    expect((await balance(i.variantId)).held).toBe(1);
  });
  it("50 -> reserve 2 -> complete one; retry and amount amendment never consume twice", async () => {
    const i = await inventory(50);
    const first = listing([i.component]);
    const a = await recordListing(db, c, first);
    expect(await recordListing(db, c, first)).toBe(a);
    const b = await recordListing(db, c, listing([i.component], "980"));
    expect(await balance(i.variantId)).toEqual({ quantity: 50, held: 2, free: 48, cost: 5000n });
    const input = completion(b);
    const orderId = await recordCompletion(db, c, input);
    expect(await recordCompletion(db, c, input)).toBe(orderId);
    await expect(recordCompletion(db, c, completion(b, 1))).rejects.toThrow();
    expect(await balance(i.variantId)).toEqual({ quantity: 49, held: 1, free: 48, cost: 4900n });
    expect((await db.listing.findUniqueOrThrow({ where: { id: a } })).currentPriceJpy).toBe(1280n);
    const order = await db.salesOrder.findUniqueOrThrow({
      where: { id: orderId },
      include: { events: true, shipment: true },
    });
    expect(order.orderedAt).toBeNull();
    expect(order.shipment).toBeNull();
    expect(order.events).toHaveLength(1);
    expect(order.shippingJpy).toBeNull();
    await amendAmounts(
      db,
      c,
      amountAmendSchema.parse({
        idempotencyKey: randomUUID(),
        context: c,
        orderId,
        revision: 0,
        date,
        actualPrice: "980",
        fee: "98",
        shipping: "210",
        packing: "0",
        other: "0",
        reason: "送料を確認",
      }),
    );
    expect((await balance(i.variantId)).quantity).toBe(49);
    expect(
      await db.orderComponentConsumption.count({
        where: { salesOrderLine: { salesOrderId: orderId } },
      }),
    ).toBe(1);
  });
  it("retires prepared listing writes while preserving mismatched keys and durable rejected results", async () => {
    const session = await db.authSession.create({
      data: {
        userAccountId: c.userAccountId,
        tokenHash: randomUUID().replaceAll("-", "").repeat(2),
        activeBusinessUnitId: c.businessUnitId,
        activeOperatorId: c.operatorId,
        selectedYear: c.year,
        expiresAt: new Date(Date.now() + 3600000),
        absoluteExpiresAt: new Date(Date.now() + 7200000),
      },
    });
    const previous = testSessionId;
    testSessionId = session.id;
    try {
      const item = await inventory(2);
      const id = await recordListing(db, c, listing([item.component]));
      const input = listingEventSchema.parse({
        idempotencyKey: randomUUID(),
        context: c,
        listingId: id,
        revision: 0,
        event: "PAUSE",
        date,
        goodsInHand: false,
        reason: "明示的な再実行",
      });
      await prepareRequest(db, c, input.idempotencyKey, "EVENT", input);
      expect(await submitWorkflowAction("EVENT", { ...input, reason: "別内容" })).toMatchObject({
        status: "PREPARED",
        code: "KEY_REUSED",
        saved: false,
      });
      expect(await resumeWorkflowRequestAction(input.idempotencyKey, input.context)).toMatchObject({
        status: "REJECTED",
        saved: false,
        code: "VALIDATION",
      });
      expect(await resumeWorkflowRequestAction(input.idempotencyKey, input.context)).toMatchObject({
        status: "REJECTED",
        saved: false,
        code: "VALIDATION",
      });
      expect(await db.listing.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: "ACTIVE",
        revision: 0,
      });
      expect((await balance(item.variantId)).held).toBe(1);
      const invalid = { ...input, idempotencyKey: randomUUID(), revision: -1 };
      expect(await submitWorkflowAction("EVENT", invalid)).toMatchObject({
        status: "REJECTED",
        code: "VALIDATION",
        saved: false,
        fields: { revision: expect.any(String) },
      });
      expect(await requestResult(db, c, invalid.idempotencyKey)).toMatchObject({
        status: "REJECTED",
        fields: { revision: expect.any(String) },
      });
      expect(await submitWorkflowAction("EVENT", invalid)).toMatchObject({ status: "REJECTED" });
      expect(await db.workflowEvent.count({ where: { id: invalid.idempotencyKey } })).toBe(0);
    } finally {
      testSessionId = previous;
      await db.authSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    }
  });
  it("serializes concurrent reservations of the last quantity and the same unique unit", async () => {
    for (const unique of [false, true]) {
      const i = await inventory(1, unique);
      const result = await Promise.allSettled([
        recordListing(db, c, listing([i.component])),
        recordListing(db, c, listing([i.component])),
      ]);
      expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await balance(i.variantId)).toEqual({ quantity: 1, held: 1, free: 0, cost: 100n });
    }
  });
  it("reserves bundle components, pause keeps stock, end releases all", async () => {
    const a = await inventory(10),
      b = await inventory(15);
    const id = await recordListing(
      db,
      c,
      listing([a.component, { ...b.component, requiredQuantity: 2 }]),
    );
    const event = (type: string, revision: number, goods = false) =>
      listingEventSchema.parse({
        idempotencyKey: randomUUID(),
        context: c,
        listingId: id,
        revision,
        date,
        event: type,
        goodsInHand: goods,
        reason: "現物確認",
      });
    await recordListingEvent(db, c, event("PAUSE", 0));
    expect((await balance(b.variantId)).held).toBe(2);
    await expect(recordListingEvent(db, c, event("END", 1))).rejects.toThrow("現物確認");
    await recordListingEvent(db, c, event("END", 1, true));
    expect((await balance(b.variantId)).free).toBe(15);
    expect((await db.listing.findUniqueOrThrow({ where: { id } })).status).toBe("ENDED");
  });
  it("keeps stock until return confirmation; defective and disposed components produce no sales", async () => {
    const a = await inventory(5),
      b = await inventory(5),
      d = await inventory(1, true);
    const id = await recordListing(db, c, listing([a.component, b.component, d.component]));
    await recordListingEvent(
      db,
      c,
      listingEventSchema.parse({
        idempotencyKey: randomUUID(),
        context: c,
        listingId: id,
        revision: 0,
        date,
        event: "RETURN_PENDING",
        goodsInHand: false,
        reason: "発送後キャンセル",
      }),
    );
    expect((await balance(a.variantId)).held).toBe(1);
    const reservations = await db.inventoryReservation.findMany({ where: { listingId: id } });
    const returnCase = await db.listingReturnCase.findFirstOrThrow({ where: { listingId: id } });
    const members = await db.listingReturnMember.findMany({ where: { caseId: returnCase.id } });
    const input = listingReturnSchema.parse({
      valuationPosition: "LAST",
      idempotencyKey: randomUUID(),
      context: c,
      listingId: id,
      revision: 1,
      date,
      reason: "現物確認",
      rows: reservations.map((r) => ({
        memberId: members.find((m) => m.reservationId === r.id)!.id,
        quantity: r.quantity,
        disposition:
          r.itemVariantId === a.variantId
            ? "RESTOCK"
            : r.itemVariantId === b.variantId
              ? "DEFECTIVE"
              : "DISPOSED",
      })),
    });
    const preview = await captureValuationPreview(() => recordListingReturn(db, c, input));
    const confirmed = {
      ...input,
      valuationPosition: "LAST" as const,
      valuationFingerprint: preview.fingerprint,
    };
    await recordListingReturn(db, c, confirmed);
    await recordListingReturn(db, c, confirmed);
    expect((await balance(a.variantId)).held).toBe(1);
    const close = listingReturnCloseSchema.parse({
      idempotencyKey: randomUUID(),
      context: c,
      listingId: id,
      revision: 2,
      date,
      action: "END",
      goodsInHand: true,
      reason: "全数確認して終了",
    });
    await expect(closeListingReturn(db, c, { ...close, action: "RESUME" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await closeListingReturn(db, c, { ...close, idempotencyKey: randomUUID() });
    expect((await balance(a.variantId)).free).toBe(5);
    expect((await balance(b.variantId)).free).toBe(4);
    expect((await balance(d.variantId)).free).toBe(0);
    expect(await db.salesOrder.count({ where: { completionListingId: id } })).toBe(0);
    expect(
      await db.stockMovement.count({ where: { sourceId: id, movementType: "RETURN_DEFECTIVE" } }),
    ).toBe(1);
  });
  it("keeps partial good and pending holds, then ends without a fictional sale", async () => {
    const item = await inventory(3);
    const id = await recordListing(db, c, listing([{ ...item.component, requiredQuantity: 3 }]));
    await recordListingEvent(
      db,
      c,
      listingEventSchema.parse({
        idempotencyKey: randomUUID(),
        context: c,
        listingId: id,
        revision: 0,
        date,
        event: "RETURN_PENDING",
        goodsInHand: false,
        reason: "返送待ち",
      }),
    );
    const caseRow = await db.listingReturnCase.findFirstOrThrow({ where: { listingId: id } });
    const member = await db.listingReturnMember.findFirstOrThrow({ where: { caseId: caseRow.id } });
    const input = listingReturnSchema.parse({
      context: c,
      idempotencyKey: randomUUID(),
      listingId: id,
      revision: 1,
      date,
      valuationPosition: "LAST",
      reason: "一部到着",
      rows: [
        { memberId: member.id, quantity: 1, disposition: "RESTOCK" },
        { memberId: member.id, quantity: 1, disposition: "DEFECTIVE" },
      ],
    });
    const p = await captureValuationPreview(() => recordListingReturn(db, c, input));
    const confirmed = { ...input, valuationFingerprint: p.fingerprint };
    await recordListingReturn(db, c, confirmed);
    await recordListingReturn(db, c, confirmed);
    expect(await balance(item.variantId)).toMatchObject({
      quantity: 2,
      held: 2,
      free: 0,
      cost: 200n,
    });
    await expect(
      db.listingReturnHandling.create({
        data: {
          memberId: member.id,
          requestId: randomUUID(),
          quantity: 2,
          disposition: "RESTOCK",
          handledDate: new Date(date),
          costTotalJpy: 0n,
        },
      }),
    ).rejects.toThrow();
    const stored = await db.listingReturnHandling.findFirstOrThrow({
      where: { memberId: member.id },
    });
    await expect(
      db.listingReturnHandling.update({ where: { id: stored.id }, data: { quantity: 2 } }),
    ).rejects.toThrow();
    const close = listingReturnCloseSchema.parse({
      context: c,
      idempotencyKey: randomUUID(),
      listingId: id,
      revision: 2,
      date,
      action: "END",
      goodsInHand: true,
      reason: "確認",
    });
    await expect(closeListingReturn(db, c, close)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      recordListingReturn(db, c, { ...confirmed, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const last = {
      ...input,
      idempotencyKey: randomUUID(),
      revision: 2,
      rows: [{ memberId: member.id, quantity: 1, disposition: "LOST" as const }],
    };
    const lastPreview = await captureValuationPreview(() => recordListingReturn(db, c, last));
    await recordListingReturn(db, c, { ...last, valuationFingerprint: lastPreview.fingerprint });
    expect(await balance(item.variantId)).toMatchObject({
      quantity: 1,
      held: 1,
      free: 0,
      cost: 100n,
    });
    await closeListingReturn(db, c, { ...close, idempotencyKey: randomUUID(), revision: 3 });
    expect(await balance(item.variantId)).toMatchObject({ quantity: 1, held: 0, free: 1 });
    expect(await db.salesOrder.count({ where: { completionListingId: id } })).toBe(0);
    await expect(
      db.listingReturnHandling.create({
        data: {
          memberId: member.id,
          requestId: randomUUID(),
          quantity: 1,
          disposition: "RESTOCK",
          handledDate: new Date(date),
          costTotalJpy: 0n,
        },
      }),
    ).rejects.toThrow();
  });
  it("resumes the same listing only after all original goods are confirmed", async () => {
    const item = await inventory(2),
      id = await recordListing(db, c, listing([{ ...item.component, requiredQuantity: 2 }]));
    await recordListingEvent(
      db,
      c,
      listingEventSchema.parse({
        context: c,
        idempotencyKey: randomUUID(),
        listingId: id,
        revision: 0,
        date,
        event: "RETURN_PENDING",
        goodsInHand: false,
        reason: "返送待ち",
      }),
    );
    const caseRow = await db.listingReturnCase.findFirstOrThrow({ where: { listingId: id } }),
      member = await db.listingReturnMember.findFirstOrThrow({ where: { caseId: caseRow.id } });
    const input = listingReturnSchema.parse({
      context: c,
      idempotencyKey: randomUUID(),
      listingId: id,
      revision: 1,
      date,
      reason: "良品全量",
      rows: [{ memberId: member.id, quantity: 2, disposition: "RESTOCK" }],
    });
    const p = await captureValuationPreview(() => recordListingReturn(db, c, input));
    await recordListingReturn(db, c, { ...input, valuationFingerprint: p.fingerprint });
    const close = listingReturnCloseSchema.parse({
      context: c,
      idempotencyKey: randomUUID(),
      listingId: id,
      revision: 2,
      date,
      action: "RESUME",
      goodsInHand: true,
      reason: "現物とメルカリを確認",
    });
    await closeListingReturn(db, c, close);
    await closeListingReturn(db, c, close);
    expect(await balance(item.variantId)).toMatchObject({
      quantity: 2,
      held: 2,
      free: 0,
      cost: 200n,
    });
    expect(await db.listing.findUniqueOrThrow({ where: { id } })).toMatchObject({
      returnPending: false,
      status: "ACTIVE",
    });
    expect(await db.stockMovement.count({ where: { sourceId: id } })).toBe(0);
  });
  async function listingReturnDraftFixture() {
    const item = await inventory(3),
      id = await recordListing(db, c, listing([{ ...item.component, requiredQuantity: 3 }]));
    await recordListingEvent(
      db,
      c,
      listingEventSchema.parse({
        context: c,
        idempotencyKey: randomUUID(),
        listingId: id,
        revision: 0,
        date,
        event: "RETURN_PENDING",
        goodsInHand: false,
        reason: "返送案件",
      }),
    );
    const snapshot = await listingReturnDraftSnapshot(db, c, id),
      member = snapshot.members[0]!;
    const input = {
      ...blankListingReturnInput(id, snapshot.caseId),
      date,
      reason: "手元入力",
      quantities: { [member.id + ":RESTOCK"]: "1" },
    };
    const draft = await db.workflowDraft.create({
      data: {
        id: randomUUID(),
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        operatorId: c.operatorId,
        year: c.year,
        kind: "LISTING_RETURN",
        revision: 1,
        payload: toJson(input),
        baseSnapshot: toJson(snapshot),
      },
    });
    return { item, id, snapshot, member, input, draft };
  }
  it("fences a return draft, archives confirmed input and rejects a second request for the same draft", async () => {
    const x = await listingReturnDraftFixture();
    const input = listingReturnSchema.parse({
      context: c,
      idempotencyKey: randomUUID(),
      listingId: x.id,
      revision: x.snapshot.revision,
      date,
      reason: x.input.reason,
      rows: [{ memberId: x.member.id, quantity: 1, disposition: "RESTOCK" }],
      draftId: x.draft.id,
      draftRevision: 1,
      baseSnapshot: x.snapshot,
      draftInput: x.input,
    });
    const p = await captureValuationPreview(() => recordListingReturn(db, c, input));
    await recordListingReturn(db, c, { ...input, valuationFingerprint: p.fingerprint });
    expect(
      (await db.workflowDraft.findUniqueOrThrow({ where: { id: x.draft.id } })).archivedAt,
    ).not.toBeNull();
    expect(await db.listingReturnSubmission.count({ where: { draftId: x.draft.id } })).toBe(1);
    const next = { ...input, idempotencyKey: randomUUID(), revision: 2 };
    await expect(
      captureValuationPreview(() => recordListingReturn(db, c, next)),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.listingReturnHandling.count({ where: { memberId: x.member.id } })).toBe(1);
    expect(await balance(x.item.variantId)).toMatchObject({ quantity: 3, held: 3, cost: 300n });
  });
  it("rebases pre-completion return input without business writes and retains the previous local input", async () => {
    const x = await listingReturnDraftFixture();
    const other = listingReturnSchema.parse({
      context: c,
      idempotencyKey: randomUUID(),
      listingId: x.id,
      revision: 1,
      date,
      reason: "他端末の良品確認",
      rows: [{ memberId: x.member.id, quantity: 1, disposition: "RESTOCK" }],
    });
    const p = await captureValuationPreview(() => recordListingReturn(db, c, other));
    await recordListingReturn(db, c, { ...other, valuationFingerprint: p.fingerprint });
    const review = await loadListingReturnDraftReview(db, c, {
      listingId: x.id,
      draftId: x.draft.id,
    });
    const input = listingReturnRebaseSchema.parse({
      context: c,
      idempotencyKey: randomUUID(),
      listingId: x.id,
      draftId: x.draft.id,
      draftRevision: 1,
      currentFingerprint: review.fingerprint,
      choice: "NEW",
      input: { ...x.input, reason: "退避する手元理由" },
      baseSnapshot: x.snapshot,
    });
    const id = await rebaseListingReturn(db, c, input);
    expect(await rebaseListingReturn(db, c, input)).toBe(id);
    const draft = await db.workflowDraft.findUniqueOrThrow({ where: { id } });
    expect(draft.payload).toMatchObject({ date: "", reason: "", quantities: {} });
    expect(
      (await db.workflowDraft.findUniqueOrThrow({ where: { id: x.draft.id } })).baseSnapshot,
    ).toEqual(toJson(x.snapshot));
    expect(
      (await loadListingReturnDraftReview(db, c, { listingId: x.id, draftId: id })).previous?.input
        .reason,
    ).toBe("退避する手元理由");
    expect(await db.listingReturnHandling.count({ where: { memberId: x.member.id } })).toBe(1);
    expect(await balance(x.item.variantId)).toMatchObject({ quantity: 3, held: 3 });
    await expect(
      rebaseListingReturn(db, c, { ...input, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("rejects cross-department and outdated revisions", async () => {
    const i = await inventory(2);
    const id = await recordListing(db, c, listing([i.component]));
    await expect(recordCompletion(db, c, completion(id, 99))).rejects.toThrow("別端末");
    await expect(
      recordCompletion(db, { ...c, businessUnitId: randomUUID() }, completion(id)),
    ).rejects.toThrow();
  });
  it("completes a bundle and unique stock exactly once under competing requests", async () => {
    const a = await inventory(10),
      b = await inventory(15),
      u = await inventory(1, true);
    const id = await recordListing(
      db,
      c,
      listing([a.component, { ...b.component, requiredQuantity: 2 }, u.component]),
    );
    const results = await Promise.allSettled([
      recordCompletion(db, c, completion(id)),
      recordCompletion(db, c, completion(id)),
    ]);
    expect(
      results.filter((r) => r.status === "fulfilled"),
      results
        .filter((r) => r.status === "rejected")
        .map((r) => String(r.reason))
        .join("\n"),
    ).toHaveLength(1);
    expect((await balance(a.variantId)).quantity).toBe(9);
    expect((await balance(b.variantId)).quantity).toBe(13);
    expect((await balance(u.variantId)).quantity).toBe(0);
    expect(
      (await db.inventoryLot.findUniqueOrThrow({ where: { id: u.lotId } })).remainingQuantity,
    ).toBe(0);
    const order = await db.salesOrder.findUniqueOrThrow({
      where: { completionListingId: id },
      include: { lines: true },
    });
    expect(order.lines[0]!.managementCogsJpy).toBe(400n);
    expect(
      await db.stockMovement.count({ where: { sourceId: order.id, movementType: "SALE_OUT" } }),
    ).toBe(3);
  });
  it("records price history and refund without changing reserved or completed stock", async () => {
    const i = await inventory(5),
      id = await recordListing(db, c, listing([i.component]));
    await recordPrice(
      db,
      c,
      priceRecordSchema.parse({
        idempotencyKey: randomUUID(),
        context: c,
        listingId: id,
        revision: 0,
        date,
        price: "900",
        reason: "メルカリで値下げ",
      }),
    );
    expect((await balance(i.variantId)).quantity).toBe(5);
    expect(await db.listingPriceHistory.count({ where: { listingId: id } })).toBe(2);
    const orderId = await recordCompletion(db, c, completion(id, 1));
    const refund = refundRecordSchema.parse({
      idempotencyKey: randomUUID(),
      context: c,
      orderId,
      revision: 0,
      date,
      salesRefund: "100",
      feeRefund: "10",
      shippingRefund: "0",
      reason: "一部返金・返送なし",
    });
    await recordRefund(db, c, refund);
    await recordRefund(db, c, refund);
    expect(await db.salesReturn.count({ where: { salesOrderId: orderId } })).toBe(1);
    expect((await balance(i.variantId)).quantity).toBe(4);
    await expect(
      recordRefund(db, c, {
        ...refund,
        idempotencyKey: randomUUID(),
        revision: 1,
        salesRefund: 1000n,
      }),
    ).rejects.toThrow("累計");
  });
  it("rejects missing reservations and protects the fixed listing composition in SQL", async () => {
    const i = await inventory(5),
      id = await recordListing(db, c, listing([{ ...i.component, requiredQuantity: 2 }]));
    await expect(
      db.listing.update({ where: { id }, data: { componentsSnapshot: [] } }),
    ).rejects.toThrow();
    // Simulate a pre-existing inconsistent hold in an isolated asset.
    const held = await db.inventoryReservation.findFirstOrThrow({ where: { listingId: id } });
    await db.inventoryReservation.update({ where: { id: held.id }, data: { quantity: 1 } });
    await expect(recordCompletion(db, c, completion(id))).rejects.toThrow("構成と確保数");
    expect(await db.salesOrder.count({ where: { completionListingId: id } })).toBe(0);
    await db.inventoryReservation.update({ where: { id: held.id }, data: { quantity: 2 } });
  });
  it("splits original components across returns and absorbs the last cost remainder without returning a fictional set", async () => {
    const item = await inventory(3, false, 100n);
    const listingId = await recordListing(
      db,
      c,
      listing([{ ...item.component, requiredQuantity: 3 }]),
    );
    const orderId = await recordCompletion(db, c, { ...completion(listingId), shipping: 0n });
    for (const disposition of ["RESTOCK", "DEFECTIVE", "DISPOSED"] as const) {
      const review = await loadReturnReview(db, c, { orderId, kind: "RETURN" });
      expect(review.code).toBeUndefined();
      const line = review.snapshot.lines[0]!;
      const input = {
        ...blankReturnInput("RETURN", orderId),
        date: "2026-09-11",
        lineId: line.id,
        scope: "COMPONENTS" as const,
        components: [{ key: line.components[0]!.key, disposition, quantity: "1" }],
        salesRefund: { state: "NONE" as const, amount: "" },
        feeRefund: { state: "NONE" as const, amount: "" },
        shippingRefund: { state: "NONE" as const, amount: "" },
      };
      const preview = await previewReturn(db, c, { context: c, kind: "RETURN", orderId, input });
      expect(preview.cost).toBe(disposition === "DISPOSED" ? "34" : "33");
      const request = returnRecordSchema.parse({
        context: c,
        kind: "RETURN",
        orderId,
        input,
        draftId: randomUUID(),
        draftRevision: 0,
        idempotencyKey: randomUUID(),
        orderRevision: preview.revision,
        confirmationFingerprint: preview.fingerprint,
        baseSnapshot: review.snapshot,
      });
      await recordReturn(db, c, request);
      await recordReturn(db, c, request);
      await expect(
        recordReturn(db, c, { ...request, idempotencyKey: randomUUID() }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      if (disposition === "RESTOCK") {
        await expect(
          previewReturn(db, c, {
            context: c,
            kind: "RETURN",
            orderId,
            input: {
              ...input,
              scope: "SALE_UNIT",
              dispositions: { [line.components[0]!.key]: "RESTOCK" },
            },
          }),
        ).rejects.toMatchObject({ code: "VALIDATION" });
      }
    }
    const order = await db.salesOrder.findUniqueOrThrow({
      where: { id: orderId },
      include: { lines: { include: { consumptions: { include: { dispositions: true } } } } },
    });
    expect(order.status).toBe("RETURNED");
    expect(order.lines[0]!.returnedQuantity).toBe(0); // component quantities are not fractional sale units
    expect(
      order.lines[0]!.consumptions.flatMap((r) => r.dispositions).reduce(
        (s, d) => s + d.costTotalJpy,
        0n,
      ),
    ).toBe(100n);
    expect(await balance(item.variantId)).toMatchObject({ quantity: 1, cost: 33n });
    expect((await loadReturnReview(db, c, { orderId, kind: "RETURN" })).code).toBe("CONFLICT");
    expect((await loadReturnReview(db, c, { orderId, kind: "REFUND" })).code).toBeUndefined();
  });
  it("processes mixed dispositions in one component return and rejects over-return and stale confirmations", async () => {
    const item = await inventory(3, false, 100n);
    const listingId = await recordListing(
      db,
      c,
      listing([{ ...item.component, requiredQuantity: 3 }]),
    );
    const orderId = await recordCompletion(db, c, { ...completion(listingId), shipping: 0n });
    const review = await loadReturnReview(db, c, { orderId, kind: "RETURN" });
    const line = review.snapshot.lines[0]!;
    const input = {
      ...blankReturnInput("RETURN", orderId),
      date: "2026-09-11",
      lineId: line.id,
      scope: "COMPONENTS" as const,
      components: ["RESTOCK", "DEFECTIVE", "DISPOSED"].map((disposition) => ({
        key: line.components[0]!.key,
        disposition: disposition as "RESTOCK" | "DEFECTIVE" | "DISPOSED",
        quantity: "1",
      })),
      salesRefund: { state: "NONE" as const, amount: "" },
      feeRefund: { state: "NONE" as const, amount: "" },
      shippingRefund: { state: "NONE" as const, amount: "" },
    };
    await expect(
      previewReturn(db, c, {
        context: c,
        kind: "RETURN",
        orderId,
        input: { ...input, components: input.components.map((r) => ({ ...r, quantity: "2" })) },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const preview = await previewReturn(db, c, { context: c, kind: "RETURN", orderId, input });
    expect(preview.changes.map((r) => r.cost)).toEqual(["33", "33", "34"]);
    const request = returnRecordSchema.parse({
      context: c,
      kind: "RETURN",
      orderId,
      input,
      draftId: randomUUID(),
      draftRevision: 0,
      idempotencyKey: randomUUID(),
      orderRevision: preview.revision,
      confirmationFingerprint: preview.fingerprint,
      baseSnapshot: review.snapshot,
    });
    await recordReturn(db, c, request);
    expect(
      await db.stockMovement.count({
        where: { operation: { idempotencyKey: request.idempotencyKey } },
      }),
    ).toBe(3);
    expect(await balance(item.variantId)).toMatchObject({ quantity: 1, cost: 33n });
    await expect(
      recordReturn(db, c, { ...request, idempotencyKey: randomUUID(), draftId: randomUUID() }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // Replaying later valuation must retain the same disposition-level rounding order.
    const otherId = await recordListing(db, c, listing([item.component]));
    const completed = { ...completion(otherId), completedDate: "2026-09-12", shipping: 0n };
    const costPreview = await previewCompletion(db, c, completed);
    expect(costPreview.cost).toBe(33n);
    expect(costPreview.changes).toEqual([]);
  });
  it("estimates a full bundle without losing rounded yen and freezes listing expenses and names", async () => {
    const item = await inventory(3, false, 1000n);
    const input = listingRecordSchema.parse({
      ...listing([{ ...item.component, requiredQuantity: 3 }]),
      name: "保存したセットA",
      price: "1280",
      expectedFeeSource: "RATE",
      expectedPacking: "0",
      expectedOther: "0",
      expectedShipping: "0",
    });
    const preview = await previewListingEstimate(
      db,
      c,
      listingEstimateSchema.parse({
        context: c,
        components: input.components,
        price: "1280",
        expectedFeeSource: "RATE",
        expectedShipping: "0",
        expectedPacking: "0",
        expectedOther: "0",
      }),
    );
    expect(preview).toMatchObject({
      cost: "1000",
      fee: "128",
      profit: "152",
      missing: [],
      final: true,
    });
    const first = await recordListing(db, c, {
      ...input,
      channelRevision: preview.channelRevision!,
    });
    const saved = await db.listing.findUniqueOrThrow({ where: { id: first } });
    expect(saved).toMatchObject({
      displayName: "保存したセットA",
      expectedFeeSource: "RATE",
      expectedPackingJpy: 0n,
      expectedOtherJpy: 0n,
      expectedShippingJpy: 0n,
    });
    const channel = await db.salesChannel.findUniqueOrThrow({
      where: { id: saved.salesChannelId },
    });
    await db.salesChannel.update({
      where: { id: channel.id },
      data: { defaultFeeRate: channel.defaultFeeRate },
    });
    await expect(
      recordListing(db, c, {
        ...input,
        idempotencyKey: randomUUID(),
        externalReference: externalId(),
        channelRevision: preview.channelRevision!,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await db.listing.findUniqueOrThrow({ where: { id: first } })).feeRate.toString()).toBe(
      saved.feeRate.toString(),
    );
    await recordListingEvent(
      db,
      c,
      listingEventSchema.parse({
        context: c,
        idempotencyKey: randomUUID(),
        listingId: first,
        revision: 0,
        date,
        event: "END",
        goodsInHand: true,
        reason: "構成の再利用を確認",
      }),
    );
    const second = await recordListing(db, c, {
      ...input,
      name: "保存したセットB",
      idempotencyKey: randomUUID(),
      externalReference: externalId(),
    });
    expect((await db.listing.findUniqueOrThrow({ where: { id: second } })).salesSkuId).not.toBe(
      saved.salesSkuId,
    );
    expect(
      (await db.listing.findUniqueOrThrow({ where: { id: first } })).componentsSnapshot,
    ).toEqual(saved.componentsSnapshot);
  });
  it("keeps per-listing names with a reused single SKU and never confirms forecast costs as actual", async () => {
    const item = await inventory(3);
    const one = await recordListing(db, c, {
      ...listing([item.component]),
      name: "表示名A",
      expectedFeeSource: "AMOUNT",
      expectedFee: 99n,
      expectedPacking: 20n,
      expectedOther: 10n,
    });
    const two = await recordListing(db, c, {
      ...listing([item.component]),
      name: "表示名B",
      expectedFeeSource: "AMOUNT",
      expectedFee: 88n,
      expectedPacking: 30n,
      expectedOther: 5n,
    });
    const rows = await db.listing.findMany({ where: { id: { in: [one, two] } } });
    expect(new Set(rows.map((row) => row.salesSkuId)).size).toBe(1);
    expect(new Set(rows.map((row) => row.displayName))).toEqual(new Set(["表示名A", "表示名B"]));
    const id = await recordCompletion(db, c, {
      ...completion(two),
      fee: null,
      shipping: null,
      packing: null,
      other: null,
    });
    expect(
      await db.salesOrder.findUniqueOrThrow({ where: { id }, include: { lines: true } }),
    ).toMatchObject({
      feeJpy: null,
      shippingJpy: null,
      packingJpy: null,
      otherCostJpy: null,
      lines: [{ displayName: "表示名B" }],
    });
  });
  it("keeps a listing draft's original entity after annual attribution changes and refuses to reserve for the new entity", async () => {
    const item = await inventory(1);
    const draft = await db.workflowDraft.create({
      data: {
        id: randomUUID(),
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        operatorId: c.operatorId,
        year: c.year,
        kind: "LISTING",
        payload: {},
        baseSnapshot: toJson({
          type: "INPUT_ORIGIN",
          reportingEntityId: c.reportingEntityId,
          businessUnitId: c.businessUnitId,
          operatorId: c.operatorId,
          year: c.year,
        }),
      },
    });
    const assignment = await db.businessUnitAssignment.findFirstOrThrow({
      where: { businessUnitId: c.businessUnitId, fiscalYearProfile: { year: c.year } },
    });
    const entity = await db.reportingEntity.create({
      data: { workspaceId: c.workspaceId, displayName: `入力帰属検証-${randomUUID()}` },
    });
    const profile = await db.fiscalYearProfile.create({
      data: {
        reportingEntityId: entity.id,
        year: c.year,
        filingMethod: "BLUE",
        consumptionTaxStatus: "EXEMPT",
        blueDeductionTarget: "NONE",
        inventoryValuationMethod: "SPECIFIC",
        startDate: new Date("2026-01-01Z"),
        endDate: new Date("2026-12-31Z"),
      },
    });
    try {
      await db.businessUnitAssignment.update({
        where: { id: assignment.id },
        data: { fiscalYearProfileId: profile.id },
      });
      const next = { ...c, reportingEntityId: entity.id };
      const input = {
        ...listing([item.component]),
        draftId: draft.id,
        draftRevision: 0,
        baseSnapshot: null,
        context: {
          businessUnitId: c.businessUnitId,
          operatorId: c.operatorId,
          year: c.year,
          reportingEntityId: entity.id,
        },
      };
      await expect(recordListing(db, next, input)).rejects.toMatchObject({
        code: "OWNERSHIP_CHANGED",
      });
      expect(
        await db.inventoryReservation.count({ where: { itemVariantId: item.variantId } }),
      ).toBe(0);
      expect(
        (await db.workflowDraft.findUniqueOrThrow({ where: { id: draft.id } })).archivedAt,
      ).toBeNull();
    } finally {
      await db.businessUnitAssignment.update({
        where: { id: assignment.id },
        data: { fiscalYearProfileId: assignment.fiscalYearProfileId },
      });
    }
  });
  async function returnFixture(kind: ReturnKind = "RETURN", unique = false) {
    const item = await inventory(unique ? 1 : 3, unique),
      listingId = await recordListing(db, c, listing([item.component]));
    const orderId = await recordCompletion(db, c, { ...completion(listingId), shipping: 0n });
    const review = await loadReturnReview(db, c, { orderId, kind });
    const line = review.snapshot.lines[0]!,
      key = line.components[0]!.key;
    const input = {
      ...blankReturnInput(kind, orderId),
      date: "2026-09-11",
      lineId: line.id,
      quantity: "1",
      dispositions: kind === "RETURN" ? { [key]: "RESTOCK" as const } : {},
      salesRefund: { state: "AMOUNT" as const, amount: "200" },
      feeRefund: { state: "NONE" as const, amount: "" },
      shippingRefund: { state: "NONE" as const, amount: "" },
      memo: "返品・返金確認",
    };
    const draft = await db.workflowDraft.create({
      data: {
        id: randomUUID(),
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        operatorId: c.operatorId,
        year: c.year,
        kind,
        payload: toJson(input),
        baseSnapshot: toJson(review.snapshot),
      },
    });
    const preview = await previewReturn(db, c, {
      context: c,
      kind,
      orderId,
      draftId: draft.id,
      input,
    });
    const request = returnRecordSchema.parse({
      context: c,
      kind,
      orderId,
      draftId: draft.id,
      draftRevision: draft.revision,
      idempotencyKey: randomUUID(),
      input,
      baseSnapshot: review.snapshot,
      orderRevision: preview.revision,
      confirmationFingerprint: preview.fingerprint,
    });
    return { item, orderId, review, line, key, input, draft, preview, request };
  }
  it("records return, stock and receipt exactly once and rejects same-draft or different-content replays", async () => {
    const x = await returnFixture();
    expect(await recordReturn(db, c, x.request)).toBe(x.orderId);
    expect(await recordReturn(db, c, x.request)).toBe(x.orderId);
    const result = await requestResult(db, c, x.request.idempotencyKey);
    expect(result).toMatchObject({
      status: "APPLIED",
      id: x.orderId,
      recordId: expect.any(String),
    });
    expect(await balance(x.item.variantId)).toMatchObject({ quantity: 3, cost: 300n });
    expect(await db.stockMovement.count({ where: { sourceId: result.recordId } })).toBe(1);
    await expect(
      recordReturn(db, c, { ...x.request, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      recordReturn(db, c, { ...x.request, input: { ...x.input, memo: "別内容" } }),
    ).rejects.toMatchObject({ code: "KEY_REUSED" });
    expect(await db.salesReturn.count({ where: { sourceDraftId: x.draft.id } })).toBe(1);
    await expect(
      db.salesReturn.update({ where: { id: result.recordId }, data: { memo: "上書き" } }),
    ).rejects.toThrow();
    expect(
      (await db.salesOrderLine.findUniqueOrThrow({ where: { id: x.line.id } })).returnedQuantity,
    ).toBe(1);
  });
  it("refund-only does not move stock and conflicts are re-confirmed without recording on selection", async () => {
    const x = await returnFixture("REFUND"),
      before = await balance(x.item.variantId);
    await amendAmounts(db, c, {
      ...amountAmendSchema.parse({
        context: c,
        idempotencyKey: randomUUID(),
        orderId: x.orderId,
        revision: 0,
        date: "2026-09-11",
        actualPrice: "900",
        fee: "90",
        shipping: "0",
        packing: "0",
        other: "0",
        reason: "別端末の金額変更",
      }),
    });
    await expect(recordReturn(db, c, x.request)).rejects.toMatchObject({ code: "CONFLICT" });
    const resolve = returnRebaseSchema.parse({
      context: c,
      idempotencyKey: randomUUID(),
      kind: "REFUND",
      orderId: x.orderId,
      draftId: x.draft.id,
      draftRevision: x.draft.revision,
      orderRevision: 1,
      input: x.input,
      baseSnapshot: x.review.snapshot,
      choice: "LOCAL",
    });
    const id = await rebaseReturn(db, c, resolve);
    expect(await rebaseReturn(db, c, resolve)).toBe(id);
    expect(await db.salesReturn.count({ where: { salesOrderId: x.orderId } })).toBe(0);
    expect(await balance(x.item.variantId)).toEqual(before);
    const next = await db.workflowDraft.findUniqueOrThrow({ where: { id } }),
      p = await previewReturn(db, c, {
        context: c,
        kind: "REFUND",
        orderId: x.orderId,
        draftId: id,
        input: x.input,
      });
    await recordReturn(db, c, {
      ...x.request,
      idempotencyKey: randomUUID(),
      draftId: id,
      draftRevision: next.revision,
      orderRevision: p.revision,
      confirmationFingerprint: p.fingerprint,
    });
    expect(await balance(x.item.variantId)).toEqual(before);
    expect(
      await db.inventoryOperation.count({
        where: {
          sourceId: {
            in: (
              await db.salesReturn.findMany({
                where: { salesOrderId: x.orderId },
                select: { id: true },
              })
            ).map((r) => r.id),
          },
        },
      }),
    ).toBe(0);
    expect(
      await loadReturnReview(db, c, { orderId: x.orderId, kind: "REFUND", draftId: id }),
    ).toMatchObject({ previous: { input: { memo: x.input.memo } } });
  });
  it("unknown refund amounts stay in drafts and no return or stock issue is committed", async () => {
    const x = await returnFixture(),
      unknown = { ...x.input, salesRefund: { state: "UNKNOWN" as const, amount: "" } };
    await db.workflowDraft.update({
      where: { id: x.draft.id },
      data: { payload: toJson(unknown) },
    });
    await expect(
      previewReturn(db, c, {
        context: c,
        kind: "RETURN",
        orderId: x.orderId,
        draftId: x.draft.id,
        input: unknown,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await db.salesReturn.count({ where: { salesOrderId: x.orderId } })).toBe(0);
    expect(await balance(x.item.variantId)).toMatchObject({ quantity: 2, cost: 200n });
    expect(
      (await db.workflowDraft.findUniqueOrThrow({ where: { id: x.draft.id } })).payload,
    ).toMatchObject({ salesRefund: { state: "UNKNOWN", amount: "" } });
  });
  it("previews a backdated good return and corrects downstream cost without replaying quantities", async () => {
    const x = await returnFixture();
    await receipt(x.item.variantId, "2026-09-12", 1, 400n);
    const laterListing = await recordListing(db, c, listing([x.item.component]));
    const later = await recordCompletion(db, c, {
      ...completion(laterListing),
      completedDate: "2026-09-13",
      shipping: 0n,
    });
    const count = await db.stockMovement.count({ where: { itemVariantId: x.item.variantId } });
    const p = await previewReturnWorkflow(db, c, {
      context: c,
      kind: "RETURN",
      orderId: x.orderId,
      draftId: x.draft.id,
      input: x.input,
      baseSnapshot: x.review.snapshot,
    });
    expect(p.valuation?.requiresOrder).toBe(false);
    expect(p.valuation?.orderImpacts).toEqual(
      expect.arrayContaining([expect.objectContaining({ beforeCost: "200", afterCost: "175" })]),
    );
    expect(await db.stockMovement.count({ where: { itemVariantId: x.item.variantId } })).toBe(
      count,
    );
    expect(await db.salesReturn.count({ where: { salesOrderId: x.orderId } })).toBe(0);
    const request = {
      ...x.request,
      idempotencyKey: randomUUID(),
      orderRevision: p.revision,
      confirmationFingerprint: p.fingerprint,
      valuationFingerprint: p.valuation!.fingerprint,
    };
    await recordReturn(db, c, request);
    await recordReturn(db, c, request);
    expect(await balance(x.item.variantId)).toMatchObject({ quantity: 3, cost: 525n });
    expect(await db.stockMovement.count({ where: { itemVariantId: x.item.variantId } })).toBe(
      count + 1,
    );
    expect(
      (await db.salesOrderLine.findFirstOrThrow({ where: { salesOrderId: later } }))
        .managementCogsJpy,
    ).toBe(175n);
    expect(await db.salesReturn.count({ where: { salesOrderId: x.orderId } })).toBe(1);
  });
  it("rejects a return valuation after another receipt and preserves the draft and stock", async () => {
    const x = await returnFixture();
    const p = await previewReturnWorkflow(db, c, {
      context: c,
      kind: "RETURN",
      orderId: x.orderId,
      draftId: x.draft.id,
      input: x.input,
      baseSnapshot: x.review.snapshot,
    });
    await receipt(x.item.variantId, "2026-09-12", 1, 400n);
    const before = await balance(x.item.variantId);
    await expect(
      recordReturn(db, c, {
        ...x.request,
        idempotencyKey: randomUUID(),
        confirmationFingerprint: p.fingerprint,
        valuationFingerprint: p.valuation!.fingerprint,
      }),
    ).rejects.toMatchObject({ code: "VALUATION_REQUIRED" });
    expect(await balance(x.item.variantId)).toEqual(before);
    expect(
      (await db.workflowDraft.findUniqueOrThrow({ where: { id: x.draft.id } })).archivedAt,
    ).toBeNull();
    expect(await db.salesReturn.count({ where: { salesOrderId: x.orderId } })).toBe(0);
  });
  it("rejects stale stock previews, year locks, wrong scopes and unconfirmed backdated return insertions", async () => {
    const x = await returnFixture();
    await inventory(1);
    await expect(recordReturn(db, c, x.request)).rejects.toMatchObject({
      code: "VALUATION_REQUIRED",
    });
    await expect(
      loadReturnReview(
        db,
        { ...c, workspaceId: randomUUID() },
        { orderId: x.orderId, kind: "RETURN" },
      ),
    ).rejects.toMatchObject({ code: "CONTEXT_CHANGED" });
    await expect(
      loadReturnReview(
        db,
        { ...c, businessUnitId: randomUUID() },
        { orderId: x.orderId, kind: "RETURN", draftId: x.draft.id },
      ),
    ).rejects.toMatchObject({ code: "CONTEXT_CHANGED" });
    await receipt(x.item.variantId, "2026-09-12", 1, 100n);
    await expect(
      previewReturn(db, c, { context: c, kind: "RETURN", orderId: x.orderId, input: x.input }),
    ).rejects.toMatchObject({ code: "VALUATION_REQUIRED" });
    const fiscal = await db.fiscalYearProfile.findFirstOrThrow({
      where: { reportingEntityId: c.reportingEntityId, year: c.year },
    });
    try {
      await db.fiscalYearProfile.update({
        where: { id: fiscal.id },
        data: { status: "LOCKED", lockedAt: new Date() },
      });
      expect(await loadReturnReview(db, c, { orderId: x.orderId, kind: "RETURN" })).toMatchObject({
        code: "YEAR_LOCKED",
        canResolve: false,
      });
      expect(await requestResult(db, c, x.request.idempotencyKey)).toMatchObject({
        status: "REJECTED",
        code: "VALUATION_REQUIRED",
      });
    } finally {
      await db.fiscalYearProfile.update({
        where: { id: fiscal.id },
        data: { status: fiscal.status, lockedAt: fiscal.lockedAt },
      });
    }
    expect(await db.salesReturn.count({ where: { salesOrderId: x.orderId } })).toBe(0);
  });
  for (const disposition of ["RESTOCK", "DEFECTIVE", "DISPOSED"] as const)
    it(`keeps unique ${disposition} quantities and costs consistent`, async () => {
      const x = await returnFixture("RETURN", true),
        input = { ...x.input, dispositions: { [x.key]: disposition } };
      const p = await previewReturn(db, c, {
        context: c,
        kind: "RETURN",
        orderId: x.orderId,
        input,
      });
      await recordReturn(db, c, { ...x.request, input, confirmationFingerprint: p.fingerprint });
      expect(await balance(x.item.variantId)).toMatchObject({
        quantity: disposition === "RESTOCK" ? 1 : 0,
        cost: disposition === "RESTOCK" ? 100n : 0n,
      });
      expect(
        (
          await db.uniqueStockUnit.findUniqueOrThrow({
            where: { id: x.item.component.uniqueStockUnitId! },
          })
        ).status,
      ).toBe(
        disposition === "RESTOCK"
          ? "IN_STOCK"
          : disposition === "DEFECTIVE"
            ? "RETURNED"
            : "DISPOSED",
      );
    });
  it("archives original local input on NEW rebase without copying another return or confirming anything", async () => {
    const x = await returnFixture("REFUND");
    const local = {
      ...x.input,
      memo: "まだ送っていなかった手元入力",
      salesRefund: { state: "UNKNOWN" as const, amount: "" },
    };
    const input = returnRebaseSchema.parse({
      context: c,
      kind: "REFUND",
      orderId: x.orderId,
      idempotencyKey: randomUUID(),
      draftId: x.draft.id,
      draftRevision: 0,
      orderRevision: 0,
      choice: "NEW",
      input: local,
      baseSnapshot: x.review.snapshot,
    });
    const id = await rebaseReturn(db, c, input);
    expect(await rebaseReturn(db, c, input)).toBe(id);
    expect(
      (await db.workflowDraft.findUniqueOrThrow({ where: { id: x.draft.id } })).payload,
    ).toMatchObject(local);
    expect((await db.workflowDraft.findUniqueOrThrow({ where: { id } })).payload).toEqual(
      blankReturnInput("REFUND", x.orderId),
    );
    expect(await db.salesReturn.count({ where: { salesOrderId: x.orderId } })).toBe(0);
    const review = await loadReturnReview(db, c, {
      kind: "REFUND",
      orderId: x.orderId,
      draftId: id,
    });
    expect(review.previous?.input.memo).toBe(local.memo);
    await expect(
      db.workflowDraft.update({
        where: { id },
        data: { baseSnapshot: toJson({ ...x.review.snapshot, revision: 100 }) },
      }),
    ).rejects.toThrow();
  });
  it("serializes concurrent returns from different drafts without exceeding sold quantities or doubling stock", async () => {
    const x = await returnFixture();
    const otherDraft = await db.workflowDraft.create({
      data: {
        id: randomUUID(),
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        operatorId: c.operatorId,
        year: c.year,
        kind: "RETURN",
        payload: toJson(x.input),
        baseSnapshot: toJson(x.review.snapshot),
      },
    });
    const results = await Promise.allSettled([
      recordReturn(db, c, x.request),
      recordReturn(db, c, { ...x.request, idempotencyKey: randomUUID(), draftId: otherDraft.id }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.salesReturn.count({ where: { salesOrderId: x.orderId } })).toBe(1);
    expect(await balance(x.item.variantId)).toMatchObject({ quantity: 3, cost: 300n });
    expect((await loadReturnReview(db, c, { kind: "RETURN", orderId: x.orderId })).canResolve).toBe(
      false,
    );
  });
  it("keeps unresolved requests ahead of new confirmation and cancels delayed execution safely", async () => {
    const x = await returnFixture("REFUND");
    await prepareRequest(db, c, x.request.idempotencyKey, "REFUND", x.request);
    expect(
      await loadReturnReview(db, c, { kind: "REFUND", orderId: x.orderId, draftId: x.draft.id }),
    ).toMatchObject({
      activeRequest: { id: x.request.idempotencyKey, status: "PREPARED" },
    });
    await expect(
      recordReturn(db, c, { ...x.request, idempotencyKey: randomUUID() }),
    ).rejects.toThrow("未解決");
    expect(await requestResult(db, c, x.request.idempotencyKey, true)).toMatchObject({
      status: "CANCELLED",
    });
    await expect(recordReturn(db, c, x.request)).rejects.toMatchObject({ code: "CANCELLED" });
    expect(await db.salesReturn.count({ where: { salesOrderId: x.orderId } })).toBe(0);
    await recordReturn(db, c, { ...x.request, idempotencyKey: randomUUID() });
    expect(await db.salesReturn.count({ where: { salesOrderId: x.orderId } })).toBe(1);
  });
  it("uses corrected original sale cost and blocks an old cost preview without rewriting consumption", async () => {
    const x = await returnFixture();
    const consumption = await db.orderComponentConsumption.findFirstOrThrow({
      where: { salesOrderLineId: x.line.id },
    });
    const movement = await db.stockMovement.findFirstOrThrow({
      where: { sourceId: x.orderId, movementType: "SALE_OUT" },
    });
    await db.$transaction(async (tx) => {
      await lockInventoryDomain(tx, c.businessUnitId);
      await tx.valuationRun.create({
        data: {
          workspaceId: c.workspaceId,
          businessUnitId: c.businessUnitId,
          operatorId: c.operatorId,
          requestId: randomUUID(),
          sourceOrderId: x.orderId,
          summary: {},
          adjustments: {
            create: [
              {
                targetType: "CONSUMPTION",
                targetId: consumption.id,
                beforeJpy: 100n,
                afterJpy: 101n,
                deltaJpy: 1n,
              },
              {
                targetType: "MOVEMENT",
                targetId: movement.id,
                beforeJpy: -100n,
                afterJpy: -101n,
                deltaJpy: -1n,
              },
            ],
          },
        },
      });
      await tx.salesOrderLine.update({
        where: { id: x.line.id },
        data: { managementCogsJpy: 101n },
      });
      await tx.inventoryCostBalance.updateMany({
        where: { itemVariantId: x.item.variantId },
        data: {
          carryingCostTotalJpy: 199n,
          averageUnitCostJpy: "99.5",
        },
      });
    });
    await expect(recordReturn(db, c, x.request)).rejects.toMatchObject({
      code: "VALUATION_REQUIRED",
    });
    const p = await previewReturn(db, c, {
      context: c,
      kind: "RETURN",
      orderId: x.orderId,
      input: x.input,
    });
    expect(p.cost).toBe("101");
    await recordReturn(db, c, {
      ...x.request,
      idempotencyKey: randomUUID(),
      confirmationFingerprint: p.fingerprint,
    });
    expect(
      (await db.orderComponentConsumption.findUniqueOrThrow({ where: { id: consumption.id } }))
        .costTotalJpy,
    ).toBe(100n);
    expect(await balance(x.item.variantId)).toMatchObject({ cost: 300n });
  });
  it("enforces SQL return parent scope, cumulative refund limits and append-only children", async () => {
    const x = await returnFixture(),
      y = await returnFixture("REFUND");
    await expect(
      db.salesReturn.create({
        data: {
          salesOrderId: y.orderId,
          sourceDraftId: x.draft.id,
          requestKey: randomUUID(),
          returnedAt: new Date("2026-09-11"),
          salesRefundJpy: 0n,
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.salesReturn.create({
        data: {
          salesOrderId: x.orderId,
          requestKey: randomUUID(),
          returnedAt: new Date("2026-09-11"),
          salesRefundJpy: 981n,
        },
      }),
    ).rejects.toThrow();
    const p = await previewReturn(db, c, {
      context: c,
      kind: "RETURN",
      orderId: x.orderId,
      input: x.input,
    });
    await recordReturn(db, c, { ...x.request, confirmationFingerprint: p.fingerprint });
    const record = await db.salesReturn.findFirstOrThrow({
      where: { sourceDraftId: x.draft.id },
      include: { lines: { include: { dispositions: true } } },
    });
    await expect(
      db.salesReturnLine.update({ where: { id: record.lines[0]!.id }, data: { quantity: 2 } }),
    ).rejects.toThrow();
    await expect(
      db.returnComponentDisposition.delete({ where: { id: record.lines[0]!.dispositions[0]!.id } }),
    ).rejects.toThrow();
    await expect(
      db.salesOrderLine.update({ where: { id: x.line.id }, data: { returnedQuantity: 0 } }),
    ).rejects.toThrow();
  });
  it("returns PROCESSING during execution and does not cancel or retry a running operation", async () => {
    const x = await returnFixture("REFUND");
    await prepareRequest(db, c, x.request.idempotencyKey, "REFUND", x.request);
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transaction = db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`workflow:${x.request.idempotencyKey}`},0))`;
      entered();
      await proceed;
    });
    await held;
    try {
      expect(await requestResult(db, c, x.request.idempotencyKey)).toMatchObject({
        status: "PROCESSING",
      });
      expect(await requestResult(db, c, x.request.idempotencyKey, true)).toMatchObject({
        status: "PROCESSING",
      });
    } finally {
      release();
      await transaction;
    }
    await recordReturn(db, c, x.request);
    expect(await requestResult(db, c, x.request.idempotencyKey)).toMatchObject({
      status: "APPLIED",
    });
  });
  it("returns the complete fixed bundle with separate good and defective component histories", async () => {
    const a = await inventory(6),
      b = await inventory(4);
    const listingId = await recordListing(
      db,
      c,
      listing([
        { ...a.component, requiredQuantity: 3 },
        { ...b.component, requiredQuantity: 2 },
      ]),
    );
    const orderId = await recordCompletion(db, c, { ...completion(listingId), shipping: 0n });
    const review = await loadReturnReview(db, c, { kind: "RETURN", orderId });
    const input = {
      ...blankReturnInput("RETURN", orderId),
      date: "2026-09-11",
      lineId: review.snapshot.lines[0]!.id,
      dispositions: { [a.variantId]: "RESTOCK" as const, [b.variantId]: "DEFECTIVE" as const },
      salesRefund: { state: "AMOUNT" as const, amount: "200" },
      feeRefund: { state: "NONE" as const, amount: "" },
      shippingRefund: { state: "NONE" as const, amount: "" },
    };
    const p = await previewReturn(db, c, { context: c, kind: "RETURN", orderId, input });
    expect(p.cost).toBe("500");
    expect(p.profit).toBe("482");
    await recordReturn(
      db,
      c,
      returnRecordSchema.parse({
        context: c,
        kind: "RETURN",
        orderId,
        input,
        draftId: randomUUID(),
        draftRevision: 0,
        orderRevision: 0,
        idempotencyKey: randomUUID(),
        confirmationFingerprint: p.fingerprint,
        baseSnapshot: review.snapshot,
      }),
    );
    expect(await balance(a.variantId)).toMatchObject({ quantity: 6, cost: 600n });
    expect(await balance(b.variantId)).toMatchObject({ quantity: 2, cost: 200n });
  });
  it("rejects corrupt balances, changed ownership and cross-year returns without filling missing cost", async () => {
    const x = await returnFixture();
    const args = { context: c, kind: "RETURN" as const, orderId: x.orderId, input: x.input };
    await expect(
      loadReturnReview(db, { ...c, reportingEntityId: randomUUID() }, args),
    ).rejects.toMatchObject({ code: "CONTEXT_CHANGED" });
    await expect(
      previewReturn(db, c, { ...args, input: { ...x.input, date: "2027-01-01" } }),
    ).rejects.toMatchObject({ code: "CONTEXT_CHANGED" });
    await db.inventoryCostBalance.updateMany({
      where: { itemVariantId: x.item.variantId },
      data: { carryingCostTotalJpy: 201n },
    });
    await expect(previewReturn(db, c, args)).rejects.toMatchObject({ code: "HISTORY_INCOMPLETE" });
    expect(await db.salesReturn.count({ where: { salesOrderId: x.orderId } })).toBe(0);
  });
  async function purchaseRequest(variantId: string) {
    const supplier = await db.counterparty.findFirstOrThrow({
      where: { workspaceId: c.workspaceId, type: "SUPPLIER", active: true },
    });
    const draft = await db.workflowDraft.create({
      data: {
        id: randomUUID(),
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        operatorId: c.operatorId,
        year: c.year,
        kind: "PURCHASE",
        payload: {},
      },
    });
    return purchaseRecordSchema.parse({
      context: c,
      idempotencyKey: randomUUID(),
      revision: 0,
      draftId: draft.id,
      draftRevision: draft.revision,
      purchasedDate: date,
      supplierId: supplier.id,
      storageLocationId: locationId,
      orderNumber: "",
      purchaseTotalJpy: "300",
      memo: "",
      newProducts: [],
      lines: [
        {
          clientRef: randomUUID(),
          variant: { source: "EXISTING", variantId },
          trackingMode: "QUANTITY",
          conditionCategory: "NEW",
          conditionDescription: "新品",
          sourceName: "共通保存テスト",
          sourceUrl: "",
          quantity: 2,
          amountJpy: "300",
          commonMeasurements: {},
        },
      ],
    });
  }
  function purchaseEvent(purchaseId: string, revision: number) {
    return purchaseEventSchema.parse({
      context: c,
      purchaseId,
      revision,
      idempotencyKey: randomUUID(),
      date,
      reason: "動作確認",
    });
  }
  async function editablePurchase() {
    const item = await inventory(3),
      request = await purchaseRequest(item.variantId);
    const id = await recordPurchase(db, c, request);
    const review = await loadPurchaseReview(db, c, { purchaseId: id });
    const draft = await db.workflowDraft.create({
      data: {
        id: randomUUID(),
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        operatorId: c.operatorId,
        year: c.year,
        kind: "PURCHASE",
        payload: toJson(review.input),
        baseSnapshot: toJson(review.baseline),
      },
    });
    const resolve = (revision: number, choice: "LOCAL" | "LATEST" = "LOCAL") =>
      purchaseRebaseSchema.parse({
        context: c,
        idempotencyKey: randomUUID(),
        purchaseId: id,
        purchaseRevision: revision,
        draftId: draft.id,
        draftRevision: draft.revision,
        choice,
        baseSnapshot: review.baseline,
        local: { ...review.input, orderNumber: "手元の注文", total: "300" },
      });
    return { item, id, draft, review, resolve };
  }
  it("rebases purchase input idempotently without modifying the purchase or inventory and retains immutable baselines", async () => {
    const x = await editablePurchase();
    await db.purchase.update({ where: { id: x.id }, data: { orderNumber: "別端末の注文" } });
    const request = x.resolve(1);
    const id = await rebasePurchase(db, c, request);
    expect(await rebasePurchase(db, c, request)).toBe(id);
    await expect(
      rebasePurchase(db, c, {
        ...request,
        local: { ...request.local, orderNumber: "同じキーで異なる入力" },
      }),
    ).rejects.toMatchObject({ code: "KEY_REUSED" });
    expect(await requestResult(db, c, request.idempotencyKey)).toMatchObject({
      status: "APPLIED",
      id,
    });
    const next = await db.workflowDraft.findUniqueOrThrow({ where: { id } });
    expect(next.payload).toMatchObject({
      orderNumber: "手元の注文",
      revision: 1,
      step: 3,
      replacedFields: expect.arrayContaining(["orderNumber"]),
    });
    expect(next.baseSnapshot).toMatchObject({
      revision: 1,
      values: { orderNumber: "別端末の注文" },
    });
    expect(
      (await db.workflowDraft.findUniqueOrThrow({ where: { id: x.draft.id } })).archivedAt,
    ).not.toBeNull();
    expect(await db.purchase.findUniqueOrThrow({ where: { id: x.id } })).toMatchObject({
      orderNumber: "別端末の注文",
      revision: 1,
    });
    expect(await balance(x.item.variantId)).toMatchObject({ quantity: 3, cost: 300n });
    expect((await requestResult(db, c, request.idempotencyKey)).payload).toMatchObject({
      local: { orderNumber: "手元の注文" },
    });
    await expect(
      db.workflowDraft.update({ where: { id }, data: { baseSnapshot: {} } }),
    ).rejects.toThrow();
    await expect(
      rebasePurchase(db, c, { ...request, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("latest selection does not confirm and rechecks versions, states and department access", async () => {
    const x = await editablePurchase();
    await db.purchase.update({ where: { id: x.id }, data: { orderNumber: "最新" } });
    await expect(rebasePurchase(db, c, x.resolve(0))).rejects.toMatchObject({ code: "CONFLICT" });
    const id = await rebasePurchase(db, c, x.resolve(1, "LATEST"));
    expect((await db.workflowDraft.findUniqueOrThrow({ where: { id } })).payload).toMatchObject({
      orderNumber: "最新",
      revision: 1,
    });
    await expect(
      loadPurchaseReview(db, { ...c, businessUnitId: randomUUID() }, { purchaseId: x.id }),
    ).rejects.toMatchObject({ code: "CONTEXT_CHANGED" });
    await recordPurchaseEvent(db, c, purchaseEvent(x.id, 1), "PURCHASE_RECEIVE");
    const current = await loadPurchaseReview(db, c, { purchaseId: x.id, draftId: id });
    expect(current).toMatchObject({
      canResolve: false,
      code: "PURCHASE_STATE",
      baseline: { status: "FINALIZED" },
    });
    await expect(
      rebasePurchase(db, c, { ...x.resolve(2), draftId: id, draftRevision: 1 }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await balance(x.item.variantId)).toMatchObject({ quantity: 5, cost: 600n });
    await recordPurchaseEvent(db, c, purchaseEvent(x.id, 2), "PURCHASE_CANCEL");
    expect(await loadPurchaseReview(db, c, { purchaseId: x.id })).toMatchObject({
      canResolve: false,
      baseline: { status: "CANCELLED" },
    });
  });
  it("rejects a second purchase update after selection and isolates comparison data", async () => {
    const x = await editablePurchase();
    const nextId = await rebasePurchase(db, c, x.resolve(0));
    const next = await db.workflowDraft.findUniqueOrThrow({ where: { id: nextId } });
    await db.purchase.update({ where: { id: x.id }, data: { orderNumber: "再度の別端末更新" } });
    const attempt = await purchaseRequest(x.item.variantId);
    await expect(
      recordPurchase(db, c, {
        ...attempt,
        purchaseId: x.id,
        revision: 0,
        draftId: nextId,
        draftRevision: next.revision,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      loadPurchaseReview(db, { ...c, workspaceId: randomUUID() }, { purchaseId: x.id }),
    ).rejects.toMatchObject({ code: "CONTEXT_CHANGED" });
    await expect(
      loadPurchaseReview(db, { ...c, operatorId: randomUUID() }, { draftId: nextId }),
    ).rejects.toMatchObject({ code: "CONTEXT_CHANGED" });
    expect((await db.purchase.findUniqueOrThrow({ where: { id: x.id } })).orderNumber).toBe(
      "再度の別端末更新",
    );
    expect(await balance(x.item.variantId)).toMatchObject({ quantity: 3, cost: 300n });
  });
  it("keeps purchase input read-only during a year lock or ownership change", async () => {
    const x = await editablePurchase();
    const fiscal = await db.fiscalYearProfile.findFirstOrThrow({
      where: { reportingEntityId: c.reportingEntityId, year: c.year },
    });
    try {
      await db.fiscalYearProfile.update({
        where: { id: fiscal.id },
        data: { status: "LOCKED", lockedAt: new Date() },
      });
      expect(
        await loadPurchaseReview(db, c, { purchaseId: x.id, draftId: x.draft.id }),
      ).toMatchObject({ code: "YEAR_LOCKED", canResolve: false });
      await expect(rebasePurchase(db, c, x.resolve(0))).rejects.toMatchObject({
        code: "YEAR_LOCKED",
      });
      await expect(
        recordPurchaseEvent(db, c, purchaseEvent(x.id, 0), "PURCHASE_RECEIVE"),
      ).rejects.toMatchObject({ code: "YEAR_LOCKED" });
      expect(
        (await db.workflowDraft.findUniqueOrThrow({ where: { id: x.draft.id } })).archivedAt,
      ).toBeNull();
    } finally {
      await db.fiscalYearProfile.update({
        where: { id: fiscal.id },
        data: { status: fiscal.status, lockedAt: fiscal.lockedAt },
      });
    }
    const wrong = { ...c, reportingEntityId: randomUUID() };
    expect(
      await loadPurchaseReview(db, wrong, { purchaseId: x.id, draftId: x.draft.id }),
    ).toMatchObject({ code: "OWNERSHIP_CHANGED", canResolve: false });
    expect(await balance(x.item.variantId)).toMatchObject({ quantity: 3, cost: 300n });
  });
  it("saves, receives and cancels a purchase through durable requests without duplicate stock", async () => {
    const item = await inventory(3);
    const input = await purchaseRequest(item.variantId);
    const id = await recordPurchase(db, c, input);
    expect(await recordPurchase(db, c, input)).toBe(id);
    expect(await balance(item.variantId)).toMatchObject({ quantity: 3, cost: 300n });
    const receiving = purchaseEvent(id, 0);
    await recordPurchaseEvent(db, c, receiving, "PURCHASE_RECEIVE");
    await recordPurchaseEvent(db, c, receiving, "PURCHASE_RECEIVE");
    expect(await balance(item.variantId)).toMatchObject({ quantity: 5, cost: 600n });
    expect((await db.purchase.findUniqueOrThrow({ where: { id } })).revision).toBe(1);
    await expect(
      recordPurchaseEvent(
        db,
        c,
        { ...receiving, idempotencyKey: randomUUID() },
        "PURCHASE_RECEIVE",
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const cancelling = purchaseEvent(id, 1);
    await recordPurchaseEvent(db, c, cancelling, "PURCHASE_CANCEL");
    await recordPurchaseEvent(db, c, cancelling, "PURCHASE_CANCEL");
    expect(await balance(item.variantId)).toMatchObject({ quantity: 3, cost: 300n });
    expect((await requestResult(db, c, cancelling.idempotencyKey)).status).toBe("APPLIED");
    expect(
      await db.inventoryOperation.count({ where: { sourceType: "purchase", sourceId: id } }),
    ).toBe(2);
  });
  it("accepts confirmation before the first autosave and closes that draft against late saves", async () => {
    const item = await inventory(3);
    const input = {
      ...(await purchaseRequest(item.variantId)),
      draftId: randomUUID(),
      draftRevision: 0,
    };
    const id = await recordPurchase(db, c, input);
    expect(await recordPurchase(db, c, input)).toBe(id);
    const draft = await db.workflowDraft.findUniqueOrThrow({ where: { id: input.draftId } });
    expect(draft.archivedAt).not.toBeNull();
    expect(draft.kind).toBe("PURCHASE");
    expect(await db.purchase.count({ where: { requestKey: input.idempotencyKey } })).toBe(1);
    await expect(
      recordPurchase(db, c, { ...input, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await balance(item.variantId)).toMatchObject({ quantity: 3, cost: 300n });
  });
  it("cancels purchase drafts without deletion or inventory changes and rejects a stale draft", async () => {
    const item = await inventory(3);
    const stale = await purchaseRequest(item.variantId);
    await db.workflowDraft.update({
      where: { id: stale.draftId },
      data: { revision: { increment: 1 } },
    });
    await expect(recordPurchase(db, c, stale)).rejects.toMatchObject({ code: "CONFLICT" });
    const rejected = await requestResult(db, c, stale.idempotencyKey);
    expect(rejected).toMatchObject({
      status: "REJECTED",
      code: "CONFLICT",
      error: "途中保存が別操作で更新されました。内容を再確認してください。",
    });
    await expect(recordPurchase(db, c, stale)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "途中保存が別操作で更新されました。内容を再確認してください。",
    });
    await expect(
      db.workflowRequest.update({
        where: { id: stale.idempotencyKey },
        data: { errorMessage: "履歴の改変" },
      }),
    ).rejects.toThrow();
    expect(await db.purchase.count({ where: { requestKey: stale.idempotencyKey } })).toBe(0);
    const input = await purchaseRequest(item.variantId),
      id = await recordPurchase(db, c, input);
    await recordPurchaseEvent(db, c, purchaseEvent(id, 0), "PURCHASE_CANCEL");
    expect((await db.purchase.findUniqueOrThrow({ where: { id } })).status).toBe("CANCELLED");
    expect(await db.inventoryOperation.count({ where: { sourceId: id } })).toBe(0);
    expect(await balance(item.variantId)).toMatchObject({ quantity: 3, cost: 300n });
  });

  async function inventoryRequest(variantId: string, quantity = 1) {
    const version = await db.inventoryRevision.findUniqueOrThrow({
      where: { businessUnitId: c.businessUnitId },
    });
    return inventoryRecordSchema.parse({
      idempotencyKey: randomUUID(),
      context: c,
      inventoryRevision: version.revision.toString(),
      operationType: "DISPOSAL",
      variantId,
      trackingMode: "QUANTITY",
      uniqueStockUnitId: "",
      quantity,
      fromLocationId: locationId,
      toLocationId: "",
      occurredDate: date,
      unitCostJpy: "",
      reason: "廃棄",
      note: "保存要求の検証",
    });
  }
  async function stocktakeInput(
    variantId: string,
    countedQuantity: number,
    countedDate = "2026-02-01",
  ) {
    const version = await db.inventoryRevision.findUnique({
      where: { businessUnitId: c.businessUnitId },
    });
    return stocktakeRecordSchema.parse({
      idempotencyKey: randomUUID(),
      context: c,
      inventoryRevision: (version?.revision ?? 0n).toString(),
      variantId,
      locationId,
      countedQuantity,
      countedDate,
      unitCostJpy: "",
      reason: "管理対象数の実測確認",
    });
  }
  it("uses observed-date stock, previews without mutation and records one fixed adjustment", async () => {
    const item = await inventory(10);
    await receipt(item.variantId, "2026-03-01");
    const input = await stocktakeInput(item.variantId, 9);
    const preview = await captureValuationPreview(() => recordStocktake(db, c, input));
    expect(preview.stocktake).toEqual({ bookQuantity: 10, countedQuantity: 9, difference: -1 });
    expect(await balance(item.variantId)).toMatchObject({ quantity: 20, cost: 3000n });
    expect(
      await db.stocktakeObservation.count({ where: { requestId: input.idempotencyKey } }),
    ).toBe(0);
    const confirmed = { ...input, valuationFingerprint: preview.fingerprint };
    const id = await recordStocktake(db, c, confirmed);
    expect(await recordStocktake(db, c, confirmed)).toBe(id);
    expect(await balance(item.variantId)).toMatchObject({ quantity: 19, cost: 2900n });
    expect(
      await db.stocktakeObservation.count({ where: { requestId: input.idempotencyKey } }),
    ).toBe(1);
    const observation = await db.stocktakeObservation.findUniqueOrThrow({
      where: { requestId: input.idempotencyKey },
    });
    await expect(
      db.stocktakeObservation.update({
        where: { id: observation.id },
        data: { countedQuantity: 8 },
      }),
    ).rejects.toThrow();
  });
  it("records zero difference without a movement and rejects conflicting backdated writes", async () => {
    const item = await inventory(10);
    const input = await stocktakeInput(item.variantId, 10);
    const preview = await captureValuationPreview(() => recordStocktake(db, c, input));
    await recordStocktake(db, c, { ...input, valuationFingerprint: preview.fingerprint });
    const observation = await db.stocktakeObservation.findUniqueOrThrow({
      where: { requestId: input.idempotencyKey },
    });
    expect(await db.stockMovement.count({ where: { operationId: observation.operationId } })).toBe(
      0,
    );
    const change = {
      ...(await inventoryRequest(item.variantId)),
      occurredDate: "2026-01-15",
      operationType: "ADJUSTMENT_IN" as const,
      fromLocationId: "",
      toLocationId: locationId,
      unitCostJpy: "100",
    };
    await expect(
      captureValuationPreview(() => recordInventoryOperation(db, c, change)),
    ).rejects.toMatchObject({ code: "HISTORY_INCOMPLETE" });
    await expect(recordInventoryOperation(db, c, change)).rejects.toMatchObject({
      code: "HISTORY_INCOMPLETE",
    });
    expect(await balance(item.variantId)).toMatchObject({ quantity: 10, cost: 1000n });
    const correction = dateCorrectionSchema.parse({
      context: c,
      idempotencyKey: randomUUID(),
      operationId: observation.operationId,
      previousDate: "2026-02-01",
      date: "2026-02-02",
      reason: "記録日の確認",
    });
    const correctionPreview = await captureValuationPreview(() =>
      recordDateCorrection(db, c, correction),
    );
    await recordDateCorrection(db, c, {
      ...correction,
      valuationFingerprint: correctionPreview.fingerprint,
    });
    expect(await db.stockMovement.count({ where: { operationId: observation.operationId } })).toBe(
      0,
    );
  });
  it("refuses unconfirmed increase cost and decreases of held inventory", async () => {
    const item = await inventory(3);
    await expect(
      captureValuationPreview(async () =>
        recordStocktake(db, c, await stocktakeInput(item.variantId, 4)),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await recordListing(db, c, listing([item.component]));
    await expect(
      captureValuationPreview(async () =>
        recordStocktake(db, c, await stocktakeInput(item.variantId, 2)),
      ),
    ).rejects.toMatchObject({ code: "STOCK_SHORTAGE" });
    expect(await balance(item.variantId)).toMatchObject({ quantity: 3, held: 1 });
  });
  it("records the inventory event date and replays the same committed request once", async () => {
    const item = await inventory(5);
    const input = await inventoryRequest(item.variantId);
    const id = await recordInventoryOperation(db, c, input);
    expect(await recordInventoryOperation(db, c, input)).toBe(id);
    expect(await balance(item.variantId)).toEqual({ quantity: 4, held: 0, free: 4, cost: 400n });
    const op = await db.inventoryOperation.findUniqueOrThrow({
      where: { idempotencyKey: input.idempotencyKey },
    });
    expect(op.occurredAt.toISOString()).toBe("2026-09-09T15:00:00.000Z");
    expect(await db.stockMovement.count({ where: { operationId: op.id } })).toBe(1);
    expect(await requestResult(db, c, input.idempotencyKey)).toMatchObject({
      status: "APPLIED",
      id,
      kind: "INVENTORY",
    });
    await expect(recordInventoryOperation(db, c, { ...input, quantity: 2 })).rejects.toMatchObject({
      code: "KEY_REUSED",
    });
  });
  it("rejects stale inventory versions and cancelled late requests without writing movements", async () => {
    const item = await inventory(5);
    const first = await inventoryRequest(item.variantId);
    const stale = { ...first, idempotencyKey: randomUUID() };
    await recordInventoryOperation(db, c, first);
    await expect(recordInventoryOperation(db, c, stale)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect((await requestResult(db, c, stale.idempotencyKey)).status).toBe("REJECTED");
    const cancelled = await inventoryRequest(item.variantId);
    await requestResult(db, c, cancelled.idempotencyKey, true);
    await expect(recordInventoryOperation(db, c, cancelled)).rejects.toThrow();
    expect(await balance(item.variantId)).toMatchObject({ quantity: 4, cost: 400n });
  });
  it("does not consume held stock and refuses unsupported backdating rather than using current cost", async () => {
    const item = await inventory(1);
    await recordListing(db, c, listing([item.component]));
    await expect(
      recordInventoryOperation(db, c, await inventoryRequest(item.variantId)),
    ).rejects.toThrow("未確保在庫");
    expect(await balance(item.variantId)).toMatchObject({ quantity: 1, held: 1 });
    const other = await inventory(3);
    await recordInventoryOperation(db, c, await inventoryRequest(other.variantId));
    const earlier = { ...(await inventoryRequest(other.variantId)), occurredDate: "2026-09-09" };
    await expect(recordInventoryOperation(db, c, earlier)).rejects.toMatchObject({
      code: "VALUATION_REQUIRED",
    });
    expect(await balance(other.variantId)).toMatchObject({ quantity: 2, cost: 200n });
  });
  it("allows only one inventory write at a shared confirmed version", async () => {
    const item = await inventory(2);
    const first = await inventoryRequest(item.variantId);
    const results = await Promise.allSettled([
      recordInventoryOperation(db, c, first),
      recordInventoryOperation(db, c, { ...first, idempotencyKey: randomUUID() }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await balance(item.variantId)).toMatchObject({ quantity: 1, cost: 100n });
  });

  it("rejects retired migration without changing existing test records", async () => {
    const i = await inventory(50);
    const sku = await db.salesSku.create({
      data: {
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        skuCode: `SKU-${Date.now()}`,
        name: "旧出品",
        skuType: "SINGLE",
        requestKey: randomUUID(),
        components: { create: [i.component] },
      },
    });
    const channel = await db.salesChannel.findFirstOrThrow({
      where: { workspaceId: c.workspaceId, type: "MERCARI" },
    });
    const old = await db.listing.create({
      data: {
        salesSkuId: sku.id,
        salesChannelId: channel.id,
        currentPriceJpy: 1280n,
        feeRate: channel.defaultFeeRate!,
        listedQuantity: 50,
        status: "SOLD_OUT",
        listedAt: new Date(`${date}T00:00:00+09:00`),
        requestKey: randomUUID(),
      },
    });
    const input = listingEventSchema.parse({
      idempotencyKey: randomUUID(),
      context: c,
      listingId: old.id,
      revision: 0,
      date,
      event: "MIGRATE",
      legacyQuantity: 50,
      externalReference: externalId(),
      goodsInHand: true,
      reason: "実際の1出品と数量を確認",
    });
    await expect(
      recordListingEvent(db, c, { ...input, idempotencyKey: randomUUID(), legacyQuantity: 1 }),
    ).rejects.toThrow();
    await expect(recordListingEvent(db, c, input)).rejects.toThrow("旧方式");
    expect(await balance(i.variantId)).toEqual({ quantity: 50, held: 0, free: 50, cost: 5000n });
    expect(await db.workflowEvent.count({ where: { id: input.idempotencyKey } })).toBe(0);
    expect((await db.listing.findUniqueOrThrow({ where: { id: old.id } })).listedQuantity).toBe(50);
  });

  it("completes a locked prior-year listing in an open year without rewriting its origin", async () => {
    const previous = c,
      previousLocation = locationId;
    const entity = await db.reportingEntity.create({
      data: { workspaceId: c.workspaceId, displayName: `年越し検証-${randomUUID()}` },
    });
    const unit = await db.businessUnit.create({
      data: {
        workspaceId: c.workspaceId,
        code: randomUUID(),
        name: `年越し-${randomUUID()}`,
        color: "#176b52",
      },
    });
    const template = await db.fiscalYearProfile.findFirstOrThrow({
      where: { reportingEntityId: c.reportingEntityId, year: 2026 },
    });
    const fiscalData = {
      filingMethod: template.filingMethod,
      consumptionTaxStatus: template.consumptionTaxStatus,
      blueDeductionTarget: template.blueDeductionTarget,
      inventoryValuationMethod: template.inventoryValuationMethod,
    };
    const profiles = [];
    for (const year of [2026, 2027]) {
      const f = await db.fiscalYearProfile.create({
        data: {
          ...fiscalData,
          reportingEntityId: entity.id,
          year,
          startDate: new Date(`${year}-01-01`),
          endDate: new Date(`${year}-12-31`),
        },
      });
      profiles.push(f);
      await db.businessUnitAssignment.create({
        data: {
          businessUnitId: unit.id,
          fiscalYearProfileId: f.id,
          defaultOperatorId: c.operatorId,
          effectiveFrom: f.startDate,
          effectiveTo: f.endDate,
        },
      });
    }
    const loc = await db.storageLocation.create({
      data: {
        workspaceId: c.workspaceId,
        businessUnitId: unit.id,
        code: `T-${randomUUID().slice(0, 8).toUpperCase()}`,
        name: "年越し検証場所",
      },
    });
    c = { ...c, businessUnitId: unit.id, reportingEntityId: entity.id };
    locationId = loc.id;
    try {
      const i = await inventory(10);
      const id = await recordListing(db, c, listing([i.component]));
      const before = await db.listing.findUniqueOrThrow({ where: { id } }),
        history = await db.listingPriceHistory.findMany({ where: { listingId: id } });
      const session = await db.authSession.create({
        data: {
          userAccountId: c.userAccountId,
          tokenHash: randomUUID().replaceAll("-", "").repeat(2),
          activeBusinessUnitId: c.businessUnitId,
          activeOperatorId: c.operatorId,
          selectedYear: 2026,
          expiresAt: new Date(Date.now() + 3600000),
          absoluteExpiresAt: new Date(Date.now() + 7200000),
        },
      });
      testSessionId = session.id;
      const draftId = randomUUID(),
        draftPayload = {
          listingId: id,
          revision: 0,
          completedDate: "2027-01-02",
          money: { actualPrice: "980", shipping: "" },
          extra: { memo: "年度切替で残す" },
        };
      expect(
        await saveWorkflowDraftAction({
          id: draftId,
          requestId: randomUUID(),
          context: c,
          kind: "COMPLETION",
          revision: 0,
          payload: draftPayload,
        }),
      ).toMatchObject({ saved: true, revision: 1 });
      await db.fiscalYearProfile.update({
        where: { id: profiles[0]!.id },
        data: { status: "LOCKED", lockedAt: new Date() },
      });
      const switchKey = randomUUID();
      const switched = await switchCompletionYearAction({
        idempotencyKey: switchKey,
        context: c,
        draftId,
        draftRevision: 1,
        listingId: id,
        targetDate: "2027-01-02",
        payload: draftPayload,
      });
      expect(switched).toMatchObject({ saved: true });
      expect(
        await switchCompletionYearAction({
          idempotencyKey: switchKey,
          context: c,
          draftId,
          draftRevision: 1,
          listingId: id,
          targetDate: "2027-01-02",
          payload: draftPayload,
        }),
      ).toEqual(switched);
      const kept = await db.workflowDraft.findUniqueOrThrow({ where: { id: switched.id! } });
      expect(kept.payload).toEqual(draftPayload);
      expect(kept.year).toBe(2027);
      expect(kept.operatorId).toBe(c.operatorId);
      expect(kept.businessUnitId).toBe(c.businessUnitId);
      expect(await db.salesOrder.count({ where: { completionListingId: id } })).toBe(0);
      expect(
        (await db.authSession.findUniqueOrThrow({ where: { id: session.id } })).activeOperatorId,
      ).toBe(c.operatorId);
      c = { ...c, year: 2027 };
      const input = { ...completion(id), completedDate: "2027-01-02" };
      const unknown = await db.listing.create({
        data: {
          salesSkuId: before.salesSkuId,
          salesChannelId: before.salesChannelId,
          listedAt: before.listedAt,
          currentPriceJpy: before.currentPriceJpy,
          listedQuantity: 1,
          feeRate: before.feeRate,
          requestKey: randomUUID(),
          externalListingId: `legacy-${randomUUID()}`,
          status: "ACTIVE",
        },
      });
      await expect(
        previewCompletion(db, c, { ...completion(unknown.id), completedDate: "2027-01-02" }),
      ).rejects.toMatchObject({ code: "OWNERSHIP_CHANGED" });
      const alternate = await db.reportingEntity.create({
        data: { workspaceId: c.workspaceId, displayName: `別帰属-${randomUUID()}` },
      });
      const alternateProfile = await db.fiscalYearProfile.create({
        data: {
          ...fiscalData,
          reportingEntityId: alternate.id,
          year: 2027,
          startDate: new Date("2027-01-01"),
          endDate: new Date("2027-12-31"),
        },
      });
      const targetAssignment = await db.businessUnitAssignment.findFirstOrThrow({
        where: { businessUnitId: unit.id, fiscalYearProfileId: profiles[1]!.id },
      });
      try {
        await db.businessUnitAssignment.update({
          where: { id: targetAssignment.id },
          data: { fiscalYearProfileId: alternateProfile.id },
        });
        await expect(
          previewCompletion(db, { ...c, reportingEntityId: alternate.id }, input),
        ).rejects.toMatchObject({ code: "OWNERSHIP_CHANGED" });
        expect(await db.salesOrder.count({ where: { completionListingId: id } })).toBe(0);
      } finally {
        await db.businessUnitAssignment.update({
          where: { id: targetAssignment.id },
          data: { fiscalYearProfileId: profiles[1]!.id },
        });
      }
      const p = await previewCompletion(db, c, input);
      await db.fiscalYearProfile.update({
        where: { id: profiles[1]!.id },
        data: { status: "LOCKED", lockedAt: new Date() },
      });
      await expect(
        recordCompletion(db, c, { ...input, valuationFingerprint: p.fingerprint }),
      ).rejects.toThrow("ロック");
      await db.fiscalYearProfile.update({
        where: { id: profiles[1]!.id },
        data: { status: "OPEN", lockedAt: null },
      });
      const next = { ...input, idempotencyKey: randomUUID() },
        p2 = await previewCompletion(db, c, next);
      const orderId = await recordCompletion(db, c, {
        ...next,
        valuationFingerprint: p2.fingerprint,
      });
      const after = await db.listing.findUniqueOrThrow({ where: { id } });
      expect(after.listedAt).toEqual(before.listedAt);
      expect(after.originYear).toBe(2026);
      expect(after.originReportingEntityId).toBe(entity.id);
      expect(await db.listingPriceHistory.findMany({ where: { listingId: id } })).toEqual(history);
      expect(
        (
          await db.salesOrder.findUniqueOrThrow({ where: { id: orderId } })
        ).completedAt?.toISOString(),
      ).toBe("2027-01-01T15:00:00.000Z");
      expect((await balance(i.variantId)).quantity).toBe(9);
      await db.fiscalYearProfile.update({
        where: { id: profiles[1]!.id },
        data: { status: "LOCKED", lockedAt: new Date() },
      });
      expect(await requestResult(db, c, next.idempotencyKey)).toMatchObject({
        status: "APPLIED",
        id: orderId,
      });
      expect(await recordCompletion(db, c, { ...next, valuationFingerprint: p2.fingerprint })).toBe(
        orderId,
      );
      await expect(
        db.listing.update({ where: { id }, data: { originYear: 2027 } }),
      ).rejects.toThrow();
      await db.fiscalYearProfile.update({
        where: { id: profiles[1]!.id },
        data: { status: "OPEN", lockedAt: null },
      });
      const wrong = { ...c, reportingEntityId: previous.reportingEntityId };
      await expect(
        previewCompletion(db, wrong, { ...completion(id), completedDate: "2027-01-03" }),
      ).rejects.toThrow();
    } finally {
      c = previous;
      locationId = previousLocation;
      await db.businessUnit.update({ where: { id: unit.id }, data: { active: false } });
    }
  });
  it("returns PROCESSING while the operation lock is held, then safely cancels", async () => {
    const input = listing([(await inventory(1)).component]);
    await prepareRequest(db, c, input.idempotencyKey, "LIST", input);
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      ready = new Promise<void>((r) => {
        started = r;
      });
    const transaction = db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`workflow:${input.idempotencyKey}`},0))`;
      started();
      await gate;
    });
    await ready;
    try {
      expect((await requestResult(db, c, input.idempotencyKey)).status).toBe("PROCESSING");
    } finally {
      release();
      await transaction;
    }
    expect((await requestResult(db, c, input.idempotencyKey, true)).status).toBe("CANCELLED");
    await expect(recordListing(db, c, input)).rejects.toThrow("取消");
  });

  it("draft response loss is idempotent and a stale device receives the current payload", async () => {
    const session = await db.authSession.create({
      data: {
        userAccountId: c.userAccountId,
        tokenHash: randomUUID().replaceAll("-", "").repeat(2),
        activeBusinessUnitId: c.businessUnitId,
        activeOperatorId: c.operatorId,
        selectedYear: c.year,
        expiresAt: new Date(Date.now() + 3600000),
        absoluteExpiresAt: new Date(Date.now() + 7200000),
      },
    });
    testSessionId = session.id;
    const first = {
      id: randomUUID(),
      requestId: randomUUID(),
      context: c,
      kind: "PURCHASE",
      revision: 0,
      payload: { totalJpy: "", orderReference: "入力開始" },
    };
    expect(await saveWorkflowDraftAction(first)).toMatchObject({ saved: true, revision: 1 });
    expect(await saveWorkflowDraftAction(first)).toMatchObject({ saved: true, revision: 1 });
    expect(
      await saveWorkflowDraftAction({
        ...first,
        requestId: randomUUID(),
        revision: 1,
        payload: { totalJpy: "100", orderReference: "別端末" },
      }),
    ).toMatchObject({ saved: true, revision: 2 });
    expect(await saveWorkflowDraftAction(first)).toMatchObject({ saved: true, revision: 1 });
    expect(
      await saveWorkflowDraftAction({
        ...first,
        requestId: randomUUID(),
        revision: 1,
        payload: { totalJpy: "200", orderReference: "手元" },
      }),
    ).toMatchObject({
      code: "CONFLICT",
      revision: 2,
      payload: { totalJpy: "100", orderReference: "別端末" },
    });
    expect((await db.workflowDraft.findUniqueOrThrow({ where: { id: first.id } })).revision).toBe(
      2,
    );
    const assignment = await db.businessUnitAssignment.findFirstOrThrow({
      where: { businessUnitId: c.businessUnitId, fiscalYearProfile: { year: c.year } },
      include: { fiscalYearProfile: true },
    });
    const fiscal = assignment.fiscalYearProfile;
    try {
      await db.fiscalYearProfile.update({
        where: { id: fiscal.id },
        data: { status: "LOCKED", lockedAt: new Date() },
      });
      expect(await saveWorkflowDraftAction(first)).toMatchObject({ saved: true, revision: 1 });
      expect(
        await saveWorkflowDraftAction({ ...first, requestId: randomUUID(), revision: 2 }),
      ).toMatchObject({ code: "YEAR_LOCKED" });
      expect((await db.workflowDraft.findUniqueOrThrow({ where: { id: first.id } })).revision).toBe(
        2,
      );
    } finally {
      await db.fiscalYearProfile.update({
        where: { id: fiscal.id },
        data: { status: fiscal.status, lockedAt: fiscal.lockedAt },
      });
    }
    await db.authSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
  });

  it("revalues existing good, defective and discarded returns without rewriting their quantities", async () => {
    const i = await inventory(10),
      a = await recordListing(db, c, { ...listing([i.component]), listedDate: "2026-01-01" }),
      b = await recordListing(db, c, {
        ...listing([{ ...i.component, requiredQuantity: 3 }]),
        listedDate: "2026-01-01",
      });
    await receipt(i.variantId, "2026-03-01");
    const orderId = await recordCompletion(db, c, {
      ...completion(b),
      completedDate: "2026-04-01",
    });
    const line = await db.salesOrderLine.findFirstOrThrow({
        where: { salesOrderId: orderId },
        include: { consumptions: true },
      }),
      consumption = line.consumptions[0]!;
    expect(consumption.costTotalJpy).toBe(450n);
    const returned = await db.$transaction(async (tx) => {
      await lockInventoryDomain(tx, c.businessUnitId);
      const r = await tx.salesReturn.create({
        data: {
          salesOrderId: orderId,
          returnedAt: new Date("2026-05-01T00:00:00+09:00"),
          requestKey: randomUUID(),
          lines: { create: { salesOrderLineId: line.id, quantity: 1 } },
        },
        include: { lines: true },
      });
      const op = await tx.inventoryOperation.create({
        data: {
          workspaceId: c.workspaceId,
          businessUnitId: c.businessUnitId,
          operatorId: c.operatorId,
          operationType: "SALE_RETURN",
          sourceType: "sales_return",
          sourceId: r.id,
          idempotencyKey: randomUUID(),
          occurredAt: r.returnedAt,
        },
      });
      for (const disposition of ["RESTOCK", "DEFECTIVE", "DISPOSED"] as const) {
        await tx.returnComponentDisposition.create({
          data: {
            salesReturnLineId: r.lines[0]!.id,
            consumptionId: consumption.id,
            itemVariantId: i.variantId,
            inventoryLotId: i.lotId,
            storageLocationId: locationId,
            quantity: 1,
            disposition,
            costTotalJpy: 150n,
          },
        });
        await tx.stockMovement.create({
          data: {
            operationId: op.id,
            itemVariantId: i.variantId,
            inventoryLotId: i.lotId,
            movementType:
              disposition === "RESTOCK"
                ? "RETURN_IN"
                : disposition === "DEFECTIVE"
                  ? "RETURN_DEFECTIVE"
                  : "RETURN_DISPOSAL",
            quantity: 1,
            costTotalJpy: 150n,
            movementAt: r.returnedAt,
            businessUnitId: c.businessUnitId,
            storageLocationToId: locationId,
            sourceType: "sales_return",
            sourceId: r.id,
            idempotencyKey: randomUUID(),
            operatorId: c.operatorId,
          },
        });
      }
      await tx.salesOrderLine.update({ where: { id: line.id }, data: { returnedQuantity: 1 } });
      await tx.salesOrder.update({ where: { id: orderId }, data: { revision: { increment: 1 } } });
      await tx.inventoryLot.update({
        where: { id: i.lotId },
        data: { remainingQuantity: { increment: 1 } },
      });
      const balance = await tx.inventoryCostBalance.findFirstOrThrow({
        where: { itemVariantId: i.variantId },
      });
      await tx.inventoryCostBalance.update({
        where: { id: balance.id },
        data: { quantity: 18, carryingCostTotalJpy: 2700n, averageUnitCostJpy: "150" },
      });
      return r;
    });
    const input = { ...completion(a), completedDate: "2026-02-01" },
      p = await previewCompletion(db, c, input);
    const changes = p.changes.filter((x) => x.type === "DISPOSITION");
    expect(changes).toHaveLength(3);
    expect(changes.reduce((s, x) => s + x.after, 0n)).toBe(458n);
    const key = { ...input, valuationFingerprint: p.fingerprint };
    await recordCompletion(db, c, key);
    await recordCompletion(db, c, key);
    const dispositions = await db.returnComponentDisposition.findMany({
      where: { salesReturnLine: { salesReturnId: returned.id } },
    });
    expect(dispositions.every((d) => d.quantity === 1 && d.costTotalJpy === 150n)).toBe(true);
    const good = changes.find(
      (x) => x.id === dispositions.find((d) => d.disposition === "RESTOCK")!.id,
    )!;
    expect(await balance(i.variantId)).toEqual({
      quantity: 17,
      held: 0,
      free: 17,
      cost: 2900n - 458n + good.after,
    });
    expect(await db.stockMovement.count({ where: { sourceId: returned.id } })).toBe(3);
    expect(
      (await db.salesOrderLine.findUniqueOrThrow({ where: { id: line.id } })).managementCogsJpy,
    ).toBe(458n);
  });
});
