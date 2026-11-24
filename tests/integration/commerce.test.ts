import { ownerData, ownerLedger, ownerPlan } from "@/lib/commerce/owner-ledger";
import { catalogStocks } from "@/lib/commerce/catalog";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkflowContext } from "@/lib/sales/workflow-context";
import { captureValuationPreview } from "@/lib/inventory/shared-valuation";
import { executeCommerce } from "@/lib/commerce/workflow";
import type { CommerceKind } from "@/lib/commerce/input";
import { loadReturnReview, previewReturnWorkflow, recordReturn } from "@/lib/sales/return-workflow";
import { blankReturnInput, returnRecordSchema } from "@/lib/sales/return-types";
import { accountBalances } from "@/lib/commerce/money";
import { businessReport } from "@/lib/commerce/reports";
import { skuMaterialQuote, supplyPrices } from "@/lib/commerce/supplies";
import { settlementSource } from "@/lib/commerce/money";
import { recordDateCorrection, dateCorrectionSchema } from "@/lib/inventory/date-correction";
import { recordInventoryOperation } from "@/lib/inventory/workflow";
import { inventoryRecordSchema } from "@/lib/validation/workflow";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite.sequential("共通購入・直接販売のDB統合", () => {
  let db: PrismaClient,
    c: WorkflowContext,
    locationId: string,
    purchaseId: string,
    variantId: string,
    skuId: string,
    channelId: string,
    saleId: string;
  const date = "2026-11-10";
  const confirmed = new Map<string, object>();
  const base = () => ({
    idempotencyKey: randomUUID(),
    context: {
      businessUnitId: c.businessUnitId,
      reportingEntityId: c.reportingEntityId,
      operatorId: c.operatorId,
      year: c.year,
    },
    date,
  });
  async function apply(kind: CommerceKind, input: object) {
    const key = (input as { idempotencyKey: string }).idempotencyKey;
    if (confirmed.has(key)) return executeCommerce(db, c, kind, confirmed.get(key));
    const payload = { ...input, valuationPosition: "LAST" };
    const preview = await captureValuationPreview(() => executeCommerce(db, c, kind, payload));
    const final = { ...payload, valuationFingerprint: preview.fingerprint };
    confirmed.set(key, final);
    return executeCommerce(db, c, kind, final);
  }
  beforeAll(async () => {
    if (!url || !new URL(url).pathname.endsWith("_test"))
      throw new Error("専用テストDBを指定してください。");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    const workspace = await db.workspace.create({
      data: { name: `汎用購入テスト ${randomUUID()}` },
    });
    const entity = await db.reportingEntity.create({
      data: { workspaceId: workspace.id, displayName: "事業者" },
    });
    const unit = await db.businessUnit.create({
      data: { workspaceId: workspace.id, code: "MAIN", name: "事業", color: "#355d4c" },
    });
    const operator = await db.operator.create({
      data: { workspaceId: workspace.id, displayName: "入力者" },
    });
    const account = await db.userAccount.create({
      data: {
        workspaceId: workspace.id,
        loginName: `test-${randomUUID()}`,
        normalizedName: `test-${randomUUID()}`,
        passwordHash: "test-only-placeholder",
      },
    });
    const fiscal = await db.fiscalYearProfile.create({
      data: {
        reportingEntityId: entity.id,
        year: 2026,
        filingMethod: "BLUE",
        consumptionTaxStatus: "EXEMPT",
        blueDeductionTarget: "DEDUCTION_650K",
        inventoryValuationMethod: "SPECIFIC",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
      },
    });
    await db.businessUnitAssignment.create({
      data: {
        businessUnitId: unit.id,
        fiscalYearProfileId: fiscal.id,
        effectiveFrom: new Date("2026-01-01"),
        effectiveTo: new Date("2026-12-31"),
      },
    });
    locationId = (
      await db.storageLocation.create({
        data: {
          workspaceId: workspace.id,
          businessUnitId: unit.id,
          code: "MAIN",
          name: "保管場所",
        },
      })
    ).id;
    c = {
      workspaceId: workspace.id,
      businessUnitId: unit.id,
      reportingEntityId: entity.id,
      operatorId: operator.id,
      userAccountId: account.id,
      year: 2026,
    };
    channelId = (
      await db.salesChannel.create({
        data: {
          workspaceId: workspace.id,
          name: "販売窓口",
          type: "OTHER",
          defaultFeeRate: "0.05",
        },
      })
    ).id;
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  it("購入・費用按分・受取を一度で保存し、再送でも増えない", async () => {
    const first = randomUUID(),
      second = randomUUID();
    const input = {
      ...base(),
      draftId: randomUUID(),
      supplierName: "一般取引先",
      locationId,
      received: true,
      lines: [
        { clientId: first, name: "商品A", trackingMode: "QUANTITY", quantity: 10, amount: "100" },
        { clientId: second, name: "商品B", trackingMode: "QUANTITY", quantity: 5, amount: "200" },
      ],
      charges: [{ name: "配送料", amount: "101", method: "VALUE" }],
    };
    purchaseId = await apply("BUY", input);
    expect(await apply("BUY", input)).toBe(purchaseId);
    const document = await db.purchaseDocument.findUniqueOrThrow({
      where: { id: purchaseId },
      include: {
        lines: { orderBy: { position: "asc" } },
        charges: { include: { allocations: true } },
      },
    });
    expect(document.totalJpy).toBe(2101n);
    expect(document.status).toBe("RECEIVED");
    expect(document.lines.map((l) => l.landedCostJpy)).toEqual([1051n, 1050n]);
    expect(document.charges[0]!.allocations.reduce((s, a) => s + a.amountJpy, 0n)).toBe(101n);
    variantId = document.lines[0]!.itemVariantId!;
    expect(await db.inventoryLot.count({ where: { itemVariantId: variantId } })).toBe(1);
  });
  it("複数商品から商品ごとにSKUを作成し、既存単品SKUを再利用する", async () => {
    const document = await db.purchaseDocument.findUniqueOrThrow({
      where: { id: purchaseId },
      include: { lines: true },
    });
    const products = document.lines.map((l) => ({
      variantId: l.itemVariantId,
      unitId: null,
      name: l.name,
    }));
    skuId = await executeCommerce(db, c, "SKU_BATCH", { ...base(), products });
    expect(await executeCommerce(db, c, "SKU_BATCH", { ...base(), products })).toBe(skuId);
    expect(await db.salesSku.count({ where: { workspaceId: c.workspaceId } })).toBe(2);
  });
  it("出品・確保・発送を作らず販売し、同じ下書きの別キー保存を拒否する", async () => {
    const sku = await db.salesSku.findUniqueOrThrow({ where: { id: skuId } });
    const input = {
      ...base(),
      draftId: randomUUID(),
      skuId,
      skuRevision: sku.revision,
      channelId,
      channelRevision: 0,
      quantity: 2,
      price: "500",
      fee: "50",
      shipping: "200",
    };
    const id = await apply("SALE", input);
    saleId = id;
    const order = await db.salesOrder.findUniqueOrThrow({
      where: { id },
      include: { lines: { include: { consumptions: true } }, shipment: true },
    });
    expect(order.completionListingId).toBeNull();
    expect(order.orderedAt).toBeNull();
    expect(order.shipment).toBeNull();
    expect(order.grossSalesJpy).toBe(1000n);
    expect(order.lines[0]!.managementCogsJpy).toBe(210n);
    expect(order.lines[0]!.consumptions.reduce((s, a) => s + a.quantity, 0)).toBe(2);
    expect(await db.listing.count({ where: { salesSku: { workspaceId: c.workspaceId } } })).toBe(0);
    expect(await db.inventoryReservation.count({ where: { itemVariantId: variantId } })).toBe(0);
    expect(await apply("SALE", input)).toBe(id);
    await expect(apply("SALE", { ...input, idempotencyKey: randomUUID() })).rejects.toThrow();
    expect(
      (await db.inventoryCostBalance.findFirstOrThrow({ where: { itemVariantId: variantId } }))
        .quantity,
    ).toBe(8);
  });
  it("他ワークスペースの取引先を拒否し、業務記録を作らない", async () => {
    const stranger = await db.workspace.create({ data: { name: "別のワークスペース" } });
    const supplier = await db.counterparty.create({
      data: { workspaceId: stranger.id, name: "別の取引先", type: "SUPPLIER" },
    });
    await expect(
      apply("BUY", {
        ...base(),
        draftId: randomUUID(),
        supplierId: supplier.id,
        supplierName: "別の取引先",
        locationId,
        received: false,
        lines: [
          {
            clientId: randomUUID(),
            name: "商品",
            trackingMode: "QUANTITY",
            quantity: 1,
            amount: "100",
          },
        ],
      }),
    ).rejects.toThrow();
    expect(await db.purchaseDocument.count({ where: { workspaceId: c.workspaceId } })).toBe(1);
  });
  it("直接販売の一部を返品でき、不明な返金のまま現物を確定しない", async () => {
    const review = await loadReturnReview(db, c, { kind: "RETURN", orderId: saleId });
    const blank = {
      ...blankReturnInput("RETURN", saleId),
      date: "2026-11-11",
      lineId: review.snapshot.lines[0]!.id,
      dispositions: { [variantId]: "RESTOCK" as const },
    };
    const draftId = randomUUID();
    await expect(
      previewReturnWorkflow(db, c, {
        context: c,
        kind: "RETURN",
        orderId: saleId,
        draftId,
        input: blank,
        baseSnapshot: review.snapshot,
      }),
    ).rejects.toThrow();
    const input = {
      ...blank,
      salesRefund: { state: "AMOUNT" as const, amount: "500" },
      feeRefund: { state: "NONE" as const, amount: "" },
      shippingRefund: { state: "NONE" as const, amount: "" },
    };
    const p = await previewReturnWorkflow(db, c, {
      context: c,
      kind: "RETURN",
      orderId: saleId,
      draftId,
      input,
      baseSnapshot: review.snapshot,
      valuationPosition: "LAST",
    });
    await recordReturn(
      db,
      c,
      returnRecordSchema.parse({
        context: c,
        kind: "RETURN",
        orderId: saleId,
        draftId,
        draftRevision: 0,
        orderRevision: p.revision,
        idempotencyKey: randomUUID(),
        input,
        baseSnapshot: review.snapshot,
        confirmationFingerprint: p.fingerprint,
        valuationFingerprint: p.valuation!.fingerprint,
        valuationPosition: "LAST",
      }),
    );
    expect(
      (await db.inventoryCostBalance.findFirstOrThrow({ where: { itemVariantId: variantId } }))
        .quantity,
    ).toBe(9);
  });
  it("1点ものを同じ購入モデルで扱い、複数点の販売と二重販売を拒否する", async () => {
    const id = await apply("BUY", {
      ...base(),
      draftId: randomUUID(),
      supplierName: "一般取引先",
      locationId,
      received: true,
      lines: [
        {
          clientId: randomUUID(),
          name: "一点もの",
          trackingMode: "UNIQUE",
          quantity: 1,
          amount: "2400",
        },
      ],
    });
    const doc = await db.purchaseDocument.findUniqueOrThrow({
      where: { id },
      include: { lines: { include: { receipts: true } } },
    });
    const unit = await db.uniqueStockUnit.findFirstOrThrow({
      where: { inventoryLotId: doc.lines[0]!.receipts[0]!.inventoryLotId! },
    });
    const singleSku = await executeCommerce(db, c, "SKU_BATCH", {
      ...base(),
      products: [{ variantId: null, unitId: unit.id, name: "一点もの" }],
    });
    const args = {
      ...base(),
      draftId: randomUUID(),
      skuId: singleSku,
      skuRevision: 0,
      channelId,
      channelRevision: 0,
      quantity: 2,
      price: "5000",
      fee: "0",
      shipping: "0",
    };
    await expect(apply("SALE", args)).rejects.toThrow();
    await apply("SALE", { ...args, idempotencyKey: randomUUID(), quantity: 1 });
    expect((await db.uniqueStockUnit.findUniqueOrThrow({ where: { id: unit.id } })).status).toBe(
      "SOLD",
    );
    await expect(
      apply("SALE", { ...args, idempotencyKey: randomUUID(), draftId: randomUUID(), quantity: 1 }),
    ).rejects.toThrow();
  });
  it("競合の選び直しは原基準と入力を退避して新下書きだけを作る", async () => {
    const original = {
      reportingEntityId: c.reportingEntityId,
      values: { supplierName: "開始時", amount: "" },
    };
    const draft = await db.workflowDraft.create({
      data: {
        id: randomUUID(),
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        operatorId: c.operatorId,
        year: c.year,
        kind: "COMMERCE_PURCHASE",
        revision: 2,
        baseSnapshot: original,
        payload: { supplierName: "別端末", amount: "0" },
      },
    });
    const before = await db.purchaseDocument.count({ where: { workspaceId: c.workspaceId } });
    const input = {
      ...base(),
      draftId: draft.id,
      revision: 2,
      kind: "COMMERCE_PURCHASE",
      choice: "LOCAL",
      values: { supplierName: "手元", amount: "100" },
    };
    const next = await executeCommerce(db, c, "DRAFT_REBASE", input);
    expect(await executeCommerce(db, c, "DRAFT_REBASE", input)).toBe(next);
    const saved = await db.workflowDraft.findUniqueOrThrow({ where: { id: next } });
    expect(saved.baseSnapshot).toEqual(original);
    expect(saved.payload).toEqual(input.values);
    expect((await db.workflowDraft.findUniqueOrThrow({ where: { id: draft.id } })).payload).toEqual(
      { supplierName: "別端末", amount: "0" },
    );
    expect(await db.purchaseDocument.count({ where: { workspaceId: c.workspaceId } })).toBe(before);
    await expect(
      executeCommerce(db, c, "DRAFT_REBASE", { ...input, idempotencyKey: randomUUID() }),
    ).rejects.toThrow();
  });
  it("外貨と配送費を分割受取へ限定し、販売後の原価を追記で訂正する", async () => {
    const id = await apply("BUY", {
      ...base(),
      draftId: randomUUID(),
      supplierName: "test evidence",
      locationId,
      received: false,
      currency: "USD",
      exchangeRate: "10",
      lines: [
        {
          clientId: randomUUID(),
          name: "shipment-product",
          trackingMode: "QUANTITY",
          quantity: 10,
          amount: "10",
        },
      ],
    });
    let p = await db.purchaseDocument.findUniqueOrThrow({
      where: { id },
      include: { lines: true },
    });
    const line = p.lines[0]!;
    const delivery = await apply("DELIVERY", {
      ...base(),
      lines: [{ lineId: line.id, quantity: 6, purchaseRevision: p.revision }],
      charges: [{ name: "test evidence", amount: "61", method: "QUANTITY" }],
    });
    const d = await db.inboundDelivery.findUniqueOrThrow({
      where: { id: delivery },
      include: { lines: true },
    });
    for (const quantity of [2, 4]) {
      p = await db.purchaseDocument.findUniqueOrThrow({ where: { id }, include: { lines: true } });
      await apply("RECEIVE", {
        ...base(),
        purchaseId: id,
        revision: p.revision,
        locationId,
        lines: [{ lineId: line.id, quantity, deliveryLineId: d.lines[0]!.id }],
      });
    }
    const receipts = await db.purchaseReceiptLine.findMany({
      where: { lineId: line.id },
      orderBy: { receipt: { createdAt: "asc" } },
    });
    expect(receipts.map((r) => r.costJpy)).toEqual([220n, 441n]);
    expect(receipts.reduce((s, r) => s + r.costJpy, 0n)).toBe(661n);
    p = await db.purchaseDocument.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    await apply("RECEIVE", {
      ...base(),
      purchaseId: id,
      revision: p.revision,
      locationId,
      lines: [{ lineId: line.id, quantity: 4 }],
    });
    expect(
      (
        await db.inventoryCostBalance.findFirstOrThrow({
          where: { itemVariantId: line.itemVariantId! },
        })
      ).carryingCostTotalJpy,
    ).toBe(1061n);
    const sku = await executeCommerce(db, c, "SKU_BATCH", {
      ...base(),
      products: [{ variantId: line.itemVariantId, unitId: null, name: line.name }],
    });
    const sold = await apply("SALE", {
      ...base(),
      draftId: randomUUID(),
      skuId: sku,
      skuRevision: 0,
      channelId,
      channelRevision: 0,
      quantity: 3,
      price: "200",
      fee: "0",
      shipping: "0",
    });
    const originalMoves = await db.stockMovement.findMany({
      where: { itemVariantId: line.itemVariantId! },
      orderBy: { id: "asc" },
    });
    p = await db.purchaseDocument.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    const input = {
      ...base(),
      purchaseId: id,
      revision: p.revision,
      reason: "test evidence",
      charge: { name: "test evidence", amount: "100", method: "VALUE" },
    };
    await apply("PURCHASE_COST", input);
    expect(await apply("PURCHASE_COST", input)).toBe(id);
    const corrections = await db.receiptCostCorrection.findMany({
      where: { receiptLine: { lineId: line.id } },
    });
    expect(corrections).toHaveLength(3);
    expect(corrections.reduce((s, r) => s + r.afterJpy - r.beforeJpy, 0n)).toBe(100n);
    expect(
      await db.stockMovement.findMany({
        where: { itemVariantId: line.itemVariantId! },
        orderBy: { id: "asc" },
      }),
    ).toEqual(originalMoves);
    const balance = await db.inventoryCostBalance.findFirstOrThrow({
      where: { itemVariantId: line.itemVariantId! },
    });
    expect(balance.quantity).toBe(7);
    const order = await db.salesOrder.findUniqueOrThrow({ where: { id: sold } });
    expect(order.costStatus).toBe("FINAL");
    expect(balance.carryingCostTotalJpy).toBe(813n);
  });
  it("後日配送を受取へ紐づけ、重量不足を0円と確定しない", async () => {
    const id = await apply("BUY", {
      ...base(),
      draftId: randomUUID(),
      supplierName: "test evidence",
      locationId,
      received: true,
      lines: [
        {
          clientId: randomUUID(),
          name: "shipment-product",
          trackingMode: "QUANTITY",
          quantity: 5,
          amount: "100",
        },
      ],
    });
    const p = await db.purchaseDocument.findUniqueOrThrow({
        where: { id },
        include: { lines: { include: { receipts: true } } },
      }),
      line = p.lines[0]!;
    const delivery = await apply("DELIVERY", {
      ...base(),
      reason: "test evidence",
      lines: [{ lineId: line.id, quantity: 5, purchaseRevision: p.revision }],
      receiptLinks: [{ lineId: line.id, receiptLineId: line.receipts[0]!.id, quantity: 5 }],
      charges: [{ name: "test evidence", amount: "11", method: "WEIGHT" }],
    });
    const d = await db.inboundDelivery.findUniqueOrThrow({
      where: { id: delivery },
      include: { charges: true },
    });
    expect(d.charges[0]!.allocated).toBe(false);
    expect((await db.purchaseDocument.findUniqueOrThrow({ where: { id } })).costFinal).toBe(false);
    await apply("PURCHASE_COST", {
      ...base(),
      deliveryId: delivery,
      revision: d.revision,
      reason: "test evidence",
      supersedesId: d.charges[0]!.id,
      charge: { name: "test evidence", amount: "11", method: "WEIGHT" },
      bases: { [line.id]: { weight: "10", volume: "", manual: "" } },
    });
    expect(
      (
        await db.inventoryCostBalance.findFirstOrThrow({
          where: { itemVariantId: line.itemVariantId! },
        })
      ).carryingCostTotalJpy,
    ).toBe(511n);
    expect((await db.purchaseDocument.findUniqueOrThrow({ where: { id } })).costFinal).toBe(true);
    const latest = await db.inboundDelivery.findUniqueOrThrow({ where: { id: delivery } });
    await apply("PURCHASE_REFUND", {
      ...base(),
      deliveryId: delivery,
      revision: latest.revision,
      reason: "test evidence",
      charge: { name: "test evidence", amount: "3", method: "VALUE" },
    });
    expect(
      (
        await db.inventoryCostBalance.findFirstOrThrow({
          where: { itemVariantId: line.itemVariantId! },
        })
      ).carryingCostTotalJpy,
    ).toBe(508n);
  });

  it("現物返送と返金・預け金振替を分離し、再送・取消でも残高を追跡する", async () => {
    const id = await apply("BUY", {
      ...base(),
      draftId: randomUUID(),
      supplierName: "返送先",
      locationId,
      received: true,
      lines: [
        {
          clientId: randomUUID(),
          name: "返送商品",
          trackingMode: "QUANTITY",
          quantity: 10,
          amount: "100",
        },
      ],
    });
    const p = await db.purchaseDocument.findUniqueOrThrow({
        where: { id },
        include: { lines: { include: { receipts: true } } },
      }),
      line = p.lines[0]!;
    const returnInput = {
      ...base(),
      receiptLineId: line.receipts[0]!.id,
      revision: p.revision,
      quantity: 2,
      refund: "200",
      reason: "不良品を現物返送",
    };
    await apply("PURCHASE_RETURN", returnInput);
    expect(await apply("PURCHASE_RETURN", returnInput)).toBe(id);
    expect(
      (await db.purchaseDocumentLine.findUniqueOrThrow({ where: { id: line.id } })).landedCostJpy,
    ).toBe(1000n);
    expect(
      (
        await db.inventoryCostBalance.findFirstOrThrow({
          where: { itemVariantId: line.itemVariantId! },
        })
      ).carryingCostTotalJpy,
    ).toBe(800n);
    const a = await executeCommerce(db, c, "ACCOUNT_SAVE", {
      ...base(),
      name: "事業用",
      balance: "2000",
    });
    const b = await executeCommerce(db, c, "ACCOUNT_SAVE", {
      ...base(),
      name: "預け金",
      balance: "0",
    });
    const transfer = {
      ...base(),
      kind: "TRANSFER",
      accountId: a,
      accountRevision: 0,
      toAccountId: b,
      toAccountRevision: 0,
      amount: "1200",
      fee: "10",
    };
    const tid = await executeCommerce(db, c, "MONEY_RECORD", transfer);
    expect(await executeCommerce(db, c, "MONEY_RECORD", transfer)).toBe(tid);
    let balances = await accountBalances(db, c);
    expect(balances.map((a) => a.balance)).toEqual([790n, 1200n]);
    const purchase = await db.purchaseDocument.findUniqueOrThrow({ where: { id } });
    const payment = await executeCommerce(db, c, "MONEY_RECORD", {
      ...base(),
      kind: "PURCHASE_PAYMENT",
      accountId: b,
      accountRevision: balances[1]!.revision,
      amount: "1000",
      sourceId: id,
      sourceRevision: purchase.revision,
    });
    const returned = await db.supplierReturn.findUniqueOrThrow({
      where: { requestId: returnInput.idempotencyKey },
    });
    balances = await accountBalances(db, c);
    await executeCommerce(db, c, "MONEY_RECORD", {
      ...base(),
      kind: "SUPPLIER_RETURN_REFUND",
      accountId: b,
      accountRevision: balances[1]!.revision,
      amount: "200",
      sourceId: returned.id,
      sourceRevision: purchase.revision,
    });
    balances = await accountBalances(db, c);
    expect(balances.map((a) => a.balance)).toEqual([790n, 400n]);
    await expect(
      executeCommerce(db, c, "MONEY_RECORD", {
        ...base(),
        kind: "SUPPLIER_RETURN_REFUND",
        accountId: b,
        accountRevision: balances[1]!.revision,
        amount: "1",
        sourceId: returned.id,
        sourceRevision: purchase.revision,
      }),
    ).rejects.toThrow();
    const reversal = { ...base(), kind: "REVERSAL", reversesId: payment, memo: "支払先を訂正" };
    await executeCommerce(db, c, "MONEY_RECORD", reversal);
    expect((await accountBalances(db, c))[1]!.balance).toBe(1400n);
    await expect(
      executeCommerce(db, c, "MONEY_RECORD", { ...reversal, idempotencyKey: randomUUID() }),
    ).rejects.toThrow();
    await expect(
      db.moneyEntry.updateMany({ where: { transactionId: tid }, data: { amountJpy: 5n } }),
    ).rejects.toThrow();
  });
  it("商品・資材・備品の混在購入と資材の兼用・追加使用で、在庫・出金・経費を二重計上しない", async () => {
    const report = () => db.$transaction((tx) => businessReport(tx, c, "2026-01-01", "2026-12-31"));
    const before = await report();
    const id = await apply("BUY", {
      ...base(),
      draftId: randomUUID(),
      supplierName: "混在注文",
      locationId,
      received: true,
      lines: [
        {
          clientId: randomUUID(),
          name: "混在商品",
          trackingMode: "QUANTITY",
          quantity: 2,
          amount: "100",
        },
        {
          clientId: randomUUID(),
          purpose: "MATERIAL",
          name: "兼用袋",
          trackingMode: "QUANTITY",
          quantity: 100,
          amount: "10",
        },
        {
          clientId: randomUUID(),
          purpose: "EQUIPMENT",
          name: "撮影用具",
          trackingMode: "QUANTITY",
          quantity: 1,
          amount: "500",
        },
      ],
      charges: [{ name: "送料", amount: "100", method: "VALUE" }],
    });
    const p = await db.purchaseDocument.findUniqueOrThrow({
      where: { id },
      include: { lines: { orderBy: { position: "asc" }, include: { receipts: true } } },
    });
    expect(p.lines.map((l) => l.landedCostJpy)).toEqual([212n, 1059n, 529n]);
    expect(p.lines[1]!.receipts[0]!.inventoryLotId).toBeNull();
    expect(p.lines[2]!.receipts[0]!.inventoryLotId).toBeNull();
    const material = p.lines[1]!.supplyItemId!;
    const sku = await executeCommerce(db, c, "SKU_SAVE", {
      ...base(),
      name: "資材を使うSKU",
      components: [
        { itemVariantId: p.lines[0]!.itemVariantId, uniqueStockUnitId: null, requiredQuantity: 1 },
      ],
      supplies: [
        { supplyItemId: material, purpose: "PACKING", quantity: "2", unitCost: "" },
        { supplyItemId: material, purpose: "COMPONENT", quantity: "1", unitCost: "" },
      ],
    });
    const savedSku = await db.salesSku.findUniqueOrThrow({ where: { id: sku } }),
      quote = await db.$transaction((tx) => skuMaterialQuote(tx, c, sku, 1, date));
    expect(quote.cost).toBe(32n);
    const sold = await apply("SALE", {
      ...base(),
      draftId: randomUUID(),
      skuId: sku,
      skuRevision: savedSku.revision,
      channelId,
      channelRevision: 0,
      quantity: 1,
      price: "500",
      fee: "50",
      shipping: "50",
      materialQuote: quote.quote,
    });
    const uses = await db.materialUse.findMany({ where: { saleId: sold } });
    expect(uses).toHaveLength(2);
    expect(uses.reduce((s, u) => s + u.costJpy!, 0n)).toBe(32n);
    expect((await report()).knownProfit - before.knownProfit).toBe(-1294n);
    const wallet = await executeCommerce(db, c, "ACCOUNT_SAVE", {
      ...base(),
      name: "混在購入の口座",
      balance: "2000",
    });
    await executeCommerce(db, c, "MONEY_RECORD", {
      ...base(),
      kind: "PURCHASE_PAYMENT",
      sourceId: id,
      sourceRevision: p.revision,
      accountId: wallet,
      accountRevision: 0,
      amount: "1800",
    });
    let account = (await accountBalances(db, c)).find((a) => a.id === wallet)!;
    const order = await db.salesOrder.findUniqueOrThrow({ where: { id: sold } });
    await executeCommerce(db, c, "MONEY_RECORD", {
      ...base(),
      kind: "SALE_RECEIPT",
      sourceId: sold,
      sourceRevision: order.revision,
      accountId: wallet,
      accountRevision: account.revision,
      amount: "400",
    });
    const moneyCount = await db.moneyTransaction.count({ where: { workspaceId: c.workspaceId } }),
      movementCount = await db.stockMovement.count({ where: { businessUnitId: c.businessUnitId } });
    const supply = (await supplyPrices(db, c, date)).find((s) => s.id === material)!;
    await executeCommerce(db, c, "MATERIAL_USE", {
      ...base(),
      saleId: sold,
      saleRevision: order.revision,
      supplyItemId: material,
      purpose: "PACKING",
      quantity: "1",
      unitCost: supply.unitCost,
      sourceLineId: supply.sourceLineId,
      manualPrice: false,
      reason: "梱包をやり直した",
    });
    expect(await db.moneyTransaction.count({ where: { workspaceId: c.workspaceId } })).toBe(
      moneyCount,
    );
    expect(await db.stockMovement.count({ where: { businessUnitId: c.businessUnitId } })).toBe(
      movementCount,
    );
    expect((await report()).knownProfit - before.knownProfit).toBe(-1294n);
    account = (await accountBalances(db, c)).find((a) => a.id === wallet)!;
    const expenseInput = {
      ...base(),
      kind: "EXPENSE",
      categoryName: "再送料",
      amount: "30",
      sourceSaleId: sold,
      settled: true,
      accountId: wallet,
      accountRevision: account.revision,
    };
    const expense = await executeCommerce(db, c, "OTHER_RECORD", expenseInput);
    expect(await executeCommerce(db, c, "OTHER_RECORD", expenseInput)).toBe(expense);
    expect((await report()).knownProfit - before.knownProfit).toBe(-1324n);
    expect((await accountBalances(db, c)).find((a) => a.id === wallet)!.balance).toBe(570n);
    const reversal = await executeCommerce(db, c, "OTHER_RECORD", {
      ...base(),
      kind: "EXPENSE",
      categoryName: "",
      amount: "0",
      reversesId: expense,
      memo: "再送料が不要になった",
    });
    expect((await report()).knownProfit - before.knownProfit).toBe(-1294n);
    account = (await accountBalances(db, c)).find((a) => a.id === wallet)!;
    await executeCommerce(db, c, "MONEY_RECORD", {
      ...base(),
      kind: "OTHER_RECEIPT",
      sourceId: reversal,
      sourceRevision: 0,
      accountId: wallet,
      accountRevision: account.revision,
      amount: "30",
    });
    expect((await accountBalances(db, c)).find((a) => a.id === wallet)!.balance).toBe(600n);
    const stockBefore = await db.stockMovement.count({
      where: { businessUnitId: c.businessUnitId },
    });
    await apply("BUY", {
      ...base(),
      draftId: randomUUID(),
      supplierName: "追加購入",
      locationId,
      received: true,
      lines: [
        {
          clientId: randomUUID(),
          purpose: "MATERIAL",
          supplyItemId: material,
          name: "兼用袋",
          trackingMode: "QUANTITY",
          quantity: 100,
          amount: "20",
        },
      ],
    });
    expect(await db.stockMovement.count({ where: { businessUnitId: c.businessUnitId } })).toBe(
      stockBefore,
    );
    expect((await supplyPrices(db, c, date)).find((s) => s.id === material)!.unitCost).toBe("20");
    expect(
      (await db.materialUse.findMany({ where: { saleId: sold } })).every(
        (u) => u.unitCostJpy!.toString() === "10.59",
      ),
    ).toBe(true);
    await expect(
      apply("SALE", {
        ...base(),
        draftId: randomUUID(),
        skuId: sku,
        skuRevision: savedSku.revision,
        channelId,
        channelRevision: 0,
        quantity: 1,
        price: "500",
        fee: "50",
        shipping: "50",
        materialQuote: quote.quote,
      }),
    ).rejects.toThrow();
    await expect(
      db.materialUse.updateMany({ where: { saleId: sold }, data: { costJpy: 0n } }),
    ).rejects.toThrow();
    const saleOperation = await db.inventoryOperation.findFirstOrThrow({
      where: { workspaceId: c.workspaceId, sourceType: "sales_order", sourceId: sold },
    });
    await expect(
      captureValuationPreview(() =>
        recordDateCorrection(
          db,
          c,
          dateCorrectionSchema.parse({
            ...base(),
            operationId: saleOperation.id,
            previousDate: date,
            date: "2026-11-11",
            reason: "完了日を訂正",
            valuationPosition: "LAST",
          }),
        ),
      ),
    ).rejects.toThrow("資材の追加使用日より後");
  });
  it("費用訂正の過払いと返金訂正の差額を別の入金として上限管理する", async () => {
    const id = await apply("BUY", {
      ...base(),
      draftId: randomUUID(),
      supplierName: "精算検証",
      locationId,
      received: false,
      lines: [
        {
          clientId: randomUUID(),
          name: "精算商品",
          trackingMode: "QUANTITY",
          quantity: 1,
          amount: "1000",
        },
      ],
      charges: [{ name: "送料", amount: "100", method: "VALUE" }],
    });
    const wallet = await executeCommerce(db, c, "ACCOUNT_SAVE", {
      ...base(),
      name: "精算の口座",
      balance: "2000",
    });
    let p = await db.purchaseDocument.findUniqueOrThrow({
      where: { id },
      include: { charges: true },
    });
    const pay = async (
      kind: Parameters<typeof settlementSource>[2],
      sourceId: string,
      amount: string,
    ) => {
      const source = await db.$transaction((tx) => settlementSource(tx, c, kind, sourceId)),
        account = (await accountBalances(db, c)).find((a) => a.id === wallet)!;
      return executeCommerce(db, c, "MONEY_RECORD", {
        ...base(),
        kind,
        sourceId,
        sourceRevision: source.revision,
        accountId: wallet,
        accountRevision: account.revision,
        amount,
      });
    };
    await pay("PURCHASE_PAYMENT", id, "1100");
    await apply("PURCHASE_COST", {
      ...base(),
      purchaseId: id,
      revision: p.revision,
      reason: "請求の誤りを訂正",
      supersedesId: p.charges[0]!.id,
      charge: { name: "送料", amount: "80", method: "VALUE" },
    });
    await pay("PURCHASE_CREDIT_REFUND", id, "20");
    p = await db.purchaseDocument.findUniqueOrThrow({
      where: { id },
      include: { charges: { where: { supersededBy: null } } },
    });
    await apply("PURCHASE_COST", {
      ...base(),
      purchaseId: id,
      revision: p.revision,
      reason: "再請求",
      supersedesId: p.charges[0]!.id,
      charge: { name: "送料", amount: "120", method: "VALUE" },
    });
    const due = await db.$transaction((tx) => settlementSource(tx, c, "PURCHASE_PAYMENT", id));
    expect(due.amount).toBe(1140n);
    await pay("PURCHASE_PAYMENT", id, "40");
    p = await db.purchaseDocument.findUniqueOrThrow({ where: { id }, include: { charges: true } });
    await apply("PURCHASE_REFUND", {
      ...base(),
      purchaseId: id,
      revision: p.revision,
      reason: "値引き",
      charge: { name: "商品代の返金", amount: "30", method: "VALUE" },
    });
    let refund = await db.purchaseCharge.findFirstOrThrow({
      where: { documentId: id, refund: true, supersededBy: null },
    });
    await pay("PURCHASE_REFUND", refund.id, "30");
    p = await db.purchaseDocument.findUniqueOrThrow({ where: { id }, include: { charges: true } });
    await apply("PURCHASE_REFUND", {
      ...base(),
      purchaseId: id,
      revision: p.revision,
      reason: "値引き額を訂正",
      supersedesId: refund.id,
      charge: { name: "商品代の返金", amount: "50", method: "VALUE" },
    });
    refund = await db.purchaseCharge.findFirstOrThrow({
      where: { documentId: id, refund: true, supersededBy: null },
    });
    await expect(pay("PURCHASE_REFUND", refund.id, "50")).rejects.toThrow();
    await pay("PURCHASE_REFUND", refund.id, "20");
    expect((await accountBalances(db, c)).find((a) => a.id === wallet)!.balance).toBe(930n);
  });
  it("決済前・未使用の誤購入を反対入庫で取り消し、元の移動を残す", async () => {
    const report = () => db.$transaction((tx) => businessReport(tx, c, "2026-01-01", "2026-12-31")),
      before = await report();
    const id = await apply("BUY", {
      ...base(),
      draftId: randomUUID(),
      supplierName: "取消検証",
      locationId,
      received: true,
      lines: [
        {
          clientId: randomUUID(),
          name: "取消数量商品",
          trackingMode: "QUANTITY",
          quantity: 2,
          amount: "100",
        },
        {
          clientId: randomUUID(),
          name: "取消個体",
          trackingMode: "UNIQUE",
          quantity: 1,
          amount: "500",
        },
        {
          clientId: randomUUID(),
          purpose: "MATERIAL",
          name: "取消資材",
          trackingMode: "QUANTITY",
          quantity: 10,
          amount: "10",
        },
      ],
    });
    const p = await db.purchaseDocument.findUniqueOrThrow({
        where: { id },
        include: { lines: { include: { receipts: true } } },
      }),
      lots = p.lines.flatMap((l) =>
        l.receipts.flatMap((r) => (r.inventoryLotId ? [r.inventoryLotId] : [])),
      ),
      original = await db.stockMovement.findMany({ where: { inventoryLotId: { in: lots } } });
    const input = {
      ...base(),
      purchaseId: id,
      revision: p.revision,
      reason: "重複入力",
      confirmed: true,
    };
    await apply("BUY_CANCEL", input);
    expect(await apply("BUY_CANCEL", input)).toBe(id);
    expect((await db.purchaseDocument.findUniqueOrThrow({ where: { id } })).status).toBe(
      "CANCELLED",
    );
    expect(
      await db.stockMovement.findMany({ where: { id: { in: original.map((m) => m.id) } } }),
    ).toEqual(original);
    expect(
      await db.stockMovement.count({
        where: { inventoryLotId: { in: lots }, movementType: "RECEIPT_REVERSAL" },
      }),
    ).toBe(2);
    expect(
      (await db.inventoryLot.findMany({ where: { id: { in: lots } } })).every(
        (l) => l.remainingQuantity === 0,
      ),
    ).toBe(true);
    expect((await report()).knownProfit).toBe(before.knownProfit);
    const other = await apply("BUY", {
      ...base(),
      draftId: randomUUID(),
      supplierName: "取消不可検証",
      locationId,
      received: false,
      lines: [
        {
          clientId: randomUUID(),
          name: "決済した購入",
          trackingMode: "QUANTITY",
          quantity: 1,
          amount: "10",
        },
      ],
    });
    const doc = await db.purchaseDocument.findUniqueOrThrow({ where: { id: other } }),
      account = (await accountBalances(db, c))[0]!;
    await executeCommerce(db, c, "MONEY_RECORD", {
      ...base(),
      kind: "PURCHASE_PAYMENT",
      sourceId: other,
      sourceRevision: doc.revision,
      accountId: account.id,
      accountRevision: account.revision,
      amount: "10",
    });
    await expect(
      apply("BUY_CANCEL", {
        ...base(),
        purchaseId: other,
        revision: doc.revision,
        reason: "決済済みを取消",
        confirmed: true,
      }),
    ).rejects.toThrow();
    expect((await db.purchaseDocument.findUniqueOrThrow({ where: { id: other } })).status).toBe(
      "ORDERED",
    );
  });
  it("受取の訂正日を配送・返送に適用し、元の日付と移動を維持する", async () => {
    const id = await apply("BUY", {
      ...base(),
      draftId: randomUUID(),
      supplierName: "日付照合",
      locationId,
      received: true,
      lines: [
        {
          clientId: randomUUID(),
          name: "日付照合商品",
          trackingMode: "QUANTITY",
          quantity: 2,
          amount: "100",
        },
      ],
    });
    const p = await db.purchaseDocument.findUniqueOrThrow({
        where: { id },
        include: { lines: { include: { receipts: { include: { receipt: true } } } } },
      }),
      row = p.lines[0]!.receipts[0]!,
      operationId = row.receipt.operationId!,
      original = await db.stockMovement.findMany({ where: { operationId } });
    const correct = async (previousDate: string, date: string) => {
      const input = dateCorrectionSchema.parse({
        ...base(),
        operationId,
        previousDate,
        date,
        reason: "受取日を訂正",
        valuationPosition: "LAST",
      });
      const preview = await captureValuationPreview(() => recordDateCorrection(db, c, input));
      return recordDateCorrection(db, c, { ...input, valuationFingerprint: preview.fingerprint });
    };
    await correct("2026-11-10", "2026-11-12");
    const updated = await db.purchaseDocument.findUniqueOrThrow({ where: { id } });
    expect(updated.revision).toBeGreaterThan(p.revision);
    await apply("DELIVERY", {
      ...base(),
      date: "2026-11-11",
      reason: "配送を追記",
      lines: [{ lineId: p.lines[0]!.id, quantity: 2, purchaseRevision: updated.revision }],
      receiptLinks: [{ lineId: p.lines[0]!.id, receiptLineId: row.id, quantity: 2 }],
      charges: [],
    });
    await expect(correct("2026-11-12", "2026-11-10")).rejects.toThrow("購入日・配送日以降");
    const current = await db.purchaseDocument.findUniqueOrThrow({ where: { id } });
    await apply("PURCHASE_RETURN", {
      ...base(),
      date: "2026-11-12",
      receiptLineId: row.id,
      revision: current.revision,
      quantity: 1,
      refund: "100",
      reason: "現物返送",
    });
    await expect(correct("2026-11-12", "2026-11-13")).rejects.toThrow("返送日より後");
    expect(
      (await db.purchaseReceipt.findUniqueOrThrow({ where: { id: row.receiptId } })).receivedDate
        .toISOString()
        .slice(0, 10),
    ).toBe("2026-11-10");
    expect(
      await db.stockMovement.findMany({ where: { id: { in: original.map((m) => m.id) } } }),
    ).toEqual(original);
  });
  it("登録済み商品の管理方式と異なる購入や別部門の口座更新を拒否する", async () => {
    await expect(
      apply("BUY", {
        ...base(),
        draftId: randomUUID(),
        supplierName: "管理方式照合",
        locationId,
        received: false,
        lines: [
          {
            clientId: randomUUID(),
            name: "登録済み商品",
            variantId,
            trackingMode: "UNIQUE",
            quantity: 1,
            amount: "100",
          },
        ],
      }),
    ).rejects.toThrow("管理方法と一致");
    const foreign = await db.businessUnit.create({
      data: { workspaceId: c.workspaceId, code: "FOREIGN", name: "別部門", color: "#355d4c" },
    });
    const account = await db.moneyAccount.create({
      data: {
        workspaceId: c.workspaceId,
        businessUnitId: foreign.id,
        reportingEntityId: c.reportingEntityId,
        name: "別部門口座",
        openingDate: new Date(date),
        openingBalanceJpy: 1000n,
      },
    });
    await expect(
      executeCommerce(db, c, "ACCOUNT_SAVE", {
        ...base(),
        id: account.id,
        revision: account.revision,
        name: "越境変更",
        balance: "1000",
        active: true,
      }),
    ).rejects.toThrow();
    expect((await db.moneyAccount.findUniqueOrThrow({ where: { id: account.id } })).name).toBe(
      "別部門口座",
    );
  });
  it("購入時に数量商品と個体の単品SKUを作成し、再送や再購入で重複させない", async () => {
    const input = {
      ...base(),
      draftId: randomUUID(),
      supplierName: "単品登録",
      locationId,
      received: true,
      createSkus: true,
      lines: [
        {
          clientId: randomUUID(),
          name: "数量の単品登録",
          trackingMode: "QUANTITY",
          quantity: 3,
          amount: "100",
        },
        {
          clientId: randomUUID(),
          name: "個体の単品登録",
          trackingMode: "UNIQUE",
          quantity: 1,
          amount: "500",
        },
        {
          clientId: randomUUID(),
          name: "資材の単品対象外",
          purpose: "MATERIAL",
          trackingMode: "QUANTITY",
          quantity: 10,
          amount: "10",
        },
      ],
    };
    const before = await db.salesSku.count({ where: { workspaceId: c.workspaceId } }),
      id = await apply("BUY", input);
    expect(await apply("BUY", input)).toBe(id);
    expect(await db.salesSku.count({ where: { workspaceId: c.workspaceId } })).toBe(before + 2);
    const lines = await db.purchaseDocumentLine.findMany({
        where: { documentId: id },
        orderBy: { position: "asc" },
      }),
      quantity = lines[0]!;
    const single = await db.salesSku.findFirstOrThrow({
      where: {
        workspaceId: c.workspaceId,
        components: { some: { itemVariantId: quantity.itemVariantId } },
      },
      include: { components: true },
    });
    expect(single.components).toHaveLength(1);
    const unique = await db.salesSku.findFirstOrThrow({
      where: { workspaceId: c.workspaceId, name: "個体の単品登録" },
      include: { components: { include: { uniqueStockUnit: true } } },
    });
    expect(unique.components[0]!.uniqueStockUnit?.status).toBe("IN_STOCK");
    await apply("BUY", {
      ...base(),
      draftId: randomUUID(),
      supplierName: "単品追加購入",
      locationId,
      received: true,
      createSkus: true,
      lines: [
        {
          clientId: randomUUID(),
          variantId: quantity.itemVariantId,
          name: quantity.name,
          trackingMode: "QUANTITY",
          quantity: 2,
          amount: "200",
        },
      ],
    });
    expect(await db.salesSku.count({ where: { workspaceId: c.workspaceId } })).toBe(before + 2);
    expect(
      (
        await db.inventoryCostBalance.findFirstOrThrow({
          where: { itemVariantId: quantity.itemVariantId! },
        })
      ).carryingCostTotalJpy,
    ).toBe(700n);
    const beforeDisposal = await db.$transaction((tx) =>
      businessReport(tx, c, "2026-01-01", "2026-12-31"),
    );
    const inputDisposal = inventoryRecordSchema.parse({
      ...base(),
      occurredDate: date,
      operationType: "DISPOSAL",
      variantId: quantity.itemVariantId,
      trackingMode: "QUANTITY",
      uniqueStockUnitId: "",
      quantity: 1,
      fromLocationId: locationId,
      toLocationId: "",
      unitCostJpy: "",
      reason: "廃棄",
      note: "",
      valuationPosition: "LAST",
      inventoryRevision: (
        await db.inventoryRevision.findUniqueOrThrow({
          where: { businessUnitId: c.businessUnitId },
        })
      ).revision.toString(),
    });
    const preview = await captureValuationPreview(() =>
      recordInventoryOperation(db, c, inputDisposal),
    );
    await recordInventoryOperation(db, c, {
      ...inputDisposal,
      valuationFingerprint: preview.fingerprint,
    });
    const afterDisposal = await db.$transaction((tx) =>
      businessReport(tx, c, "2026-01-01", "2026-12-31"),
    );
    expect(afterDisposal.stockExpense - beforeDisposal.stockExpense).toBe(140n);
    expect(afterDisposal.knownProfit - beforeDisposal.knownProfit).toBe(-140n);
    const otherOwner = await db.reportingEntity.create({
      data: { workspaceId: c.workspaceId, displayName: "別の帰属" },
    });
    expect(
      (
        await db.$transaction((tx) =>
          businessReport(
            tx,
            { ...c, reportingEntityId: otherOwner.id },
            "2026-01-01",
            "2026-12-31",
          ),
        )
      ).stockExpense,
    ).toBe(0n);
  });
  it("商品一覧を101件から50件ずつ取得し、IDで一括SKUを作成する", async () => {
    const prefix = `catalog-${randomUUID()}`,
      rows = Array.from({ length: 101 }, (_, i) => ({
        id: randomUUID(),
        name: `${prefix}-${String(i).padStart(3, "0")}`,
        itemCode: `CAT-${prefix.slice(-8).toUpperCase()}-${i}`,
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        managementType: "QUANTITY" as const,
        managementCostMethod: "MOVING_AVERAGE" as const,
      }));
    await db.inventoryItem.createMany({ data: rows });
    await db.itemVariant.createMany({
      data: rows.map((r) => ({
        workspaceId: c.workspaceId,
        inventoryItemId: r.id,
        variantCode: r.itemCode,
      })),
    });
    const first = await catalogStocks(db, c, { q: prefix, page: 1 }),
      second = await catalogStocks(db, c, { q: prefix, page: 2 }),
      third = await catalogStocks(db, c, { q: prefix, page: 3 });
    expect(first.total).toBe(101);
    expect(first.rows).toHaveLength(50);
    expect(second.rows).toHaveLength(50);
    expect(third.rows).toHaveLength(1);
    expect(new Set([...first.rows, ...second.rows, ...third.rows].map((r) => r.id)).size).toBe(101);
    const ids = [first.rows[0]!.id, second.rows[0]!.id],
      input = { ...base(), selection: ids };
    const sku = await executeCommerce(db, c, "SKU_BATCH", input);
    expect(await executeCommerce(db, c, "SKU_BATCH", input)).toBe(sku);
    expect((await catalogStocks(db, c, { ids })).rows).toHaveLength(2);
    const skuCount = await db.salesSku.count({ where: { workspaceId: c.workspaceId } }),
      invalid = first.rows[3]!;
    await db.inventoryItem.update({ where: { id: invalid.itemId }, data: { status: "INACTIVE" } });
    await expect(
      executeCommerce(db, c, "SKU_BATCH", {
        ...base(),
        selection: [first.rows[2]!.id, invalid.id],
      }),
    ).rejects.toThrow(invalid.name);
    expect(await db.salesSku.count({ where: { workspaceId: c.workspaceId } })).toBe(skuCount);

    expect(
      (await catalogStocks(db, { ...c, businessUnitId: randomUUID() }, { ids })).rows,
    ).toHaveLength(0);
    await expect(
      executeCommerce(db, c, "SKU_BATCH", { ...base(), selection: [ids[0], randomUUID()] }),
    ).rejects.toThrow("利用できない");
  });
  it("商品・資材を版付きで編集し、購入・使用・在庫原価の履歴を維持する", async () => {
    const variant = await db.itemVariant.findUniqueOrThrow({
        where: { id: variantId },
        include: { inventoryItem: true },
      }),
      item = variant.inventoryItem,
      before = await db.stockMovement.findMany({ where: { itemVariantId: variantId } }),
      lines = await db.purchaseDocumentLine.findMany({ where: { itemVariantId: variantId } });
    const input = {
      ...base(),
      id: item.id,
      revision: item.revision,
      name: "編集した商品",
      category: "分類",
      memo: "編集メモ",
      locationId,
      active: true,
    };
    await executeCommerce(db, c, "ITEM_SAVE", input);
    expect(await executeCommerce(db, c, "ITEM_SAVE", input)).toBe(item.id);
    expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).revision).toBe(
      item.revision + 1,
    );
    await expect(
      executeCommerce(db, c, "ITEM_SAVE", {
        ...input,
        idempotencyKey: randomUUID(),
        name: "古い版の上書き",
      }),
    ).rejects.toThrow("更新されて");
    await expect(
      executeCommerce(db, c, "ITEM_SAVE", {
        ...input,
        id: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow();

    const foreignUnit = await db.businessUnit.create({
        data: {
          workspaceId: c.workspaceId,
          code: `BOUND-${randomUUID().slice(0, 8).toUpperCase()}`,
          name: "編集境界",
          color: "#355d4c",
        },
      }),
      profile = await db.fiscalYearProfile.findFirstOrThrow({
        where: { reportingEntityId: c.reportingEntityId, year: c.year },
      });
    await db.businessUnitAssignment.create({
      data: {
        businessUnitId: foreignUnit.id,
        fiscalYearProfileId: profile.id,
        effectiveFrom: new Date("2026-01-01"),
        effectiveTo: new Date("2026-12-31"),
      },
    });
    const foreign = { ...c, businessUnitId: foreignUnit.id },
      foreignContext = { ...base().context, businessUnitId: foreignUnit.id };
    await expect(
      executeCommerce(db, foreign, "ITEM_SAVE", {
        ...input,
        idempotencyKey: randomUUID(),
        context: foreignContext,
        revision: item.revision + 1,
      }),
    ).rejects.toThrow();
    expect(await db.stockMovement.findMany({ where: { itemVariantId: variantId } })).toEqual(
      before,
    );
    expect(await db.purchaseDocumentLine.findMany({ where: { itemVariantId: variantId } })).toEqual(
      lines,
    );
    const supply = await db.supplyItem.findFirstOrThrow({
        where: { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId, kind: "MATERIAL" },
      }),
      uses = await db.materialUse.findMany({ where: { supplyItemId: supply.id } });
    await executeCommerce(db, c, "SUPPLY_SAVE", {
      ...base(),
      id: supply.id,
      revision: supply.revision,
      name: "資材の新名称",
      memo: "資材メモ",
      active: true,
    });
    expect((await db.supplyItem.findUniqueOrThrow({ where: { id: supply.id } })).memo).toBe(
      "資材メモ",
    );
    expect(await db.materialUse.findMany({ where: { supplyItemId: supply.id } })).toEqual(uses);
    await expect(
      executeCommerce(db, foreign, "SUPPLY_SAVE", {
        ...base(),
        context: foreignContext,
        id: supply.id,
        revision: supply.revision + 1,
        name: "他部門の上書き",
        memo: "",
        active: true,
      }),
    ).rejects.toThrow();

    await expect(
      executeCommerce(db, c, "SUPPLY_SAVE", {
        ...base(),
        id: supply.id,
        revision: supply.revision,
        name: "上書き",
        memo: "",
        active: true,
      }),
    ).rejects.toThrow("更新されて");
  });
  it("カード利用と引落・返金、私用資金の入出金を費用と分離する", async () => {
    const report = () => db.$transaction((tx) => businessReport(tx, c, "2026-01-01", "2026-12-31")),
      before = await report();
    const bank = await executeCommerce(db, c, "ACCOUNT_SAVE", {
        ...base(),
        name: "カード検証銀行",
        balance: "20000",
      }),
      card = await executeCommerce(db, c, "ACCOUNT_SAVE", {
        ...base(),
        name: "カード検証",
        accountKind: "CREDIT_CARD",
        balance: "2000",
      });
    const p = await apply("BUY", {
      ...base(),
      draftId: randomUUID(),
      supplierName: "カード購入",
      locationId,
      received: false,
      lines: [
        {
          clientId: randomUUID(),
          name: "カードの商品",
          trackingMode: "QUANTITY",
          quantity: 1,
          amount: "10000",
        },
      ],
    });
    const doc = await db.purchaseDocument.findUniqueOrThrow({ where: { id: p } }),
      sourceAccount = (await accountBalances(db, c)).find((a) => a.id === card)!;
    await executeCommerce(db, c, "MONEY_RECORD", {
      ...base(),
      kind: "PURCHASE_PAYMENT",
      sourceId: p,
      sourceRevision: doc.revision,
      accountId: card,
      accountRevision: sourceAccount.revision,
      amount: "10000",
    });
    expect((await accountBalances(db, c)).find((a) => a.id === card)!.balance).toBe(-12000n);
    const move = async (
      kind: "TRANSFER" | "OWNER_CONTRIBUTION" | "OWNER_DRAWING",
      amount: string,
      to?: string,
    ) => {
      const balances = await accountBalances(db, c);
      return executeCommerce(db, c, "MONEY_RECORD", {
        ...base(),
        kind,
        amount,
        fee: "0",
        accountId: bank,
        accountRevision: balances.find((a) => a.id === bank)!.revision,
        toAccountId: to ?? "",
        toAccountRevision: balances.find((a) => a.id === to)?.revision ?? 0,
      });
    };
    await move("TRANSFER", "4000", card);
    await move("TRANSFER", "8000", card);
    expect((await accountBalances(db, c)).find((a) => a.id === card)!.balance).toBe(0n);
    const current = await db.purchaseDocument.findUniqueOrThrow({ where: { id: p } });
    await apply("PURCHASE_REFUND", {
      ...base(),
      purchaseId: p,
      revision: current.revision,
      reason: "商品代返金",
      charge: { name: "商品代返金", amount: "1000", method: "VALUE" },
    });
    const refund = await db.purchaseCharge.findFirstOrThrow({
        where: { documentId: p, refund: true },
      }),
      cardNow = (await accountBalances(db, c)).find((a) => a.id === card)!;
    const src = await db.$transaction((tx) =>
      settlementSource(tx, c, "PURCHASE_REFUND", refund.id),
    );
    await executeCommerce(db, c, "MONEY_RECORD", {
      ...base(),
      kind: "PURCHASE_REFUND",
      sourceId: refund.id,
      sourceRevision: src.revision,
      accountId: card,
      accountRevision: cardNow.revision,
      amount: "1000",
    });
    expect((await accountBalances(db, c)).find((a) => a.id === card)!.balance).toBe(1000n);
    await move("OWNER_CONTRIBUTION", "5000");
    await move("OWNER_DRAWING", "2000");
    expect((await accountBalances(db, c)).find((a) => a.id === bank)!.balance).toBe(11000n);
    expect((await report()).knownProfit).toBe(before.knownProfit);
    const unchanged = await db.moneyAccount.findUniqueOrThrow({ where: { id: bank } });
    await executeCommerce(db, c, "ACCOUNT_SAVE", {
      ...base(),
      id: bank,
      revision: unchanged.revision,
      name: unchanged.name,
      balance: "999999",
      accountKind: "CREDIT_CARD",
      active: true,
    });
    expect(
      (await db.moneyAccount.findUniqueOrThrow({ where: { id: bank } })).openingBalanceJpy,
    ).toBe(20000n);
  });
  it("購入と本人立替を同時保存し、部分精算・返金・差額返還を追跡する", async () => {
    const beforeMoney = await db.moneyTransaction.count({ where: { workspaceId: c.workspaceId } });
    const input = {
      ...base(),
      draftId: randomUUID(),
      supplierName: "本人立替購入",
      locationId,
      received: true,
      payment: { method: "PERSONAL", date, amount: "10000" },
      lines: [
        {
          clientId: randomUUID(),
          name: "本人立替商品",
          trackingMode: "QUANTITY",
          quantity: 1,
          amount: "10000",
        },
      ],
    };
    const id = await apply("BUY", input);
    expect(await apply("BUY", input)).toBe(id);
    expect(await db.moneyTransaction.count({ where: { workspaceId: c.workspaceId } })).toBe(
      beforeMoney + 1,
    );
    const ledger = () =>
      db.$transaction(async (tx) => ownerLedger(await ownerData(tx, c), "2026-12-31"));
    expect((await ledger()).unpaid).toBe(10000n);
    expect((await accountBalances(db, c)).some((a) => a.accountKind === "OWNER_CLEARING")).toBe(
      false,
    );
    const bank = await executeCommerce(db, c, "ACCOUNT_SAVE", {
      ...base(),
      name: "本人立替精算銀行",
      balance: "20000",
    });
    const settle = async (
      kind: "OWNER_REIMBURSEMENT" | "OWNER_REPAYMENT",
      amount: string,
      day = date,
    ) => {
      const account = (await accountBalances(db, c)).find((a) => a.id === bank)!,
        payload = {
          ...base(),
          date: day,
          kind,
          accountId: bank,
          accountRevision: account.revision,
          amount,
          fee: "0",
        };
      const plan = await db.$transaction((tx) => ownerPlan(tx, c, payload));
      return executeCommerce(db, c, "MONEY_RECORD", {
        ...payload,
        ownerFingerprint: plan.fingerprint,
      });
    };
    const first = await settle("OWNER_REIMBURSEMENT", "4000");
    expect((await ledger()).unpaid).toBe(6000n);
    const second = await settle("OWNER_REIMBURSEMENT", "6000");
    expect((await ledger()).unpaid).toBe(0n);
    await expect(settle("OWNER_REIMBURSEMENT", "1")).rejects.toThrow("未精算額");
    const payment = await db.moneyTransaction.findUniqueOrThrow({
      where: { requestId: input.idempotencyKey },
    });
    await expect(
      executeCommerce(db, c, "MONEY_RECORD", {
        ...base(),
        kind: "REVERSAL",
        reversesId: payment.id,
        memo: "元立替の取消",
      }),
    ).rejects.toThrow("関連する精算");
    const p = await db.purchaseDocument.findUniqueOrThrow({ where: { id } });
    await apply("PURCHASE_REFUND", {
      ...base(),
      purchaseId: id,
      revision: p.revision,
      reason: "一部返金",
      charge: { name: "一部返金", amount: "1000", method: "VALUE" },
    });
    const refund = await db.purchaseCharge.findFirstOrThrow({
        where: { documentId: id, refund: true },
      }),
      source = await db.$transaction((tx) => settlementSource(tx, c, "PURCHASE_REFUND", refund.id));
    await executeCommerce(db, c, "MONEY_RECORD", {
      ...base(),
      kind: "PURCHASE_REFUND",
      sourceId: refund.id,
      sourceRevision: source.revision,
      paymentMethod: "PERSONAL",
      amount: "1000",
    });
    expect((await ledger()).receivable).toBe(1000n);
    await settle("OWNER_REPAYMENT", "1000");
    expect((await ledger()).receivable).toBe(0n);
    expect((await accountBalances(db, c)).find((a) => a.id === bank)!.balance).toBe(11000n);
    const allocations = await db.ownerSettlementAllocation.findMany({
      where: { settlementId: { in: [first, second] } },
    });
    expect(allocations.reduce((sum, a) => sum + a.amountJpy, 0n)).toBe(10000n);
    await expect(
      db.ownerSettlementAllocation.updateMany({
        where: { settlementId: first },
        data: { amountJpy: 1n },
      }),
    ).rejects.toThrow();
  });
  it("立替は古い支払から充当し、過去の過大精算と同時支払の途中失敗を拒否する", async () => {
    const bank = await executeCommerce(db, c, "ACCOUNT_SAVE", {
      ...base(),
      name: "立替まとめ銀行",
      balance: "20000",
    });
    const buy = async (name: string, day: string, amount: string) =>
      apply("BUY", {
        ...base(),
        date: day,
        draftId: randomUUID(),
        supplierName: "立替まとめ",
        locationId,
        received: false,
        payment: { method: "PERSONAL", date: day, amount },
        lines: [{ clientId: randomUUID(), name, trackingMode: "QUANTITY", quantity: 1, amount }],
      });
    await buy("古い立替", "2026-11-08", "3000");
    await buy("新しい立替", "2026-11-09", "5000");
    const account = (await accountBalances(db, c)).find((a) => a.id === bank)!,
      payload = {
        ...base(),
        kind: "OWNER_REIMBURSEMENT",
        date: "2026-11-10",
        accountId: bank,
        accountRevision: account.revision,
        amount: "4000",
        fee: "0",
      };
    const plan = await db.$transaction((tx) => ownerPlan(tx, c, payload));
    expect(plan.allocations.map((a) => a.amountJpy)).toEqual(["3000", "1000"]);
    const key = await executeCommerce(db, c, "MONEY_RECORD", {
      ...payload,
      ownerFingerprint: plan.fingerprint,
    });
    expect(
      await executeCommerce(db, c, "MONEY_RECORD", {
        ...payload,
        ownerFingerprint: plan.fingerprint,
      }),
    ).toBe(key);
    const now = (await accountBalances(db, c)).find((a) => a.id === bank)!;
    await expect(
      db.$transaction((tx) =>
        ownerPlan(tx, c, {
          ...payload,
          date: "2026-11-08",
          accountRevision: now.revision,
          amount: "3000",
        }),
      ),
    ).rejects.toThrow("未精算額");
    const count = await db.purchaseDocument.count({ where: { workspaceId: c.workspaceId } }),
      movements = await db.stockMovement.count({ where: { businessUnitId: c.businessUnitId } });
    await expect(
      apply("BUY", {
        ...base(),
        draftId: randomUUID(),
        supplierName: "失敗する同時支払",
        locationId,
        received: true,
        payment: {
          method: "ACCOUNT",
          date,
          amount: "100",
          accountId: randomUUID(),
          accountRevision: 0,
        },
        lines: [
          {
            clientId: randomUUID(),
            name: "同時保存失敗商品",
            trackingMode: "QUANTITY",
            quantity: 1,
            amount: "100",
          },
        ],
      }),
    ).rejects.toThrow();

    const uncertain = {
      ...base(),
      draftId: randomUUID(),
      supplierName: "支払条件の検証",
      locationId,
      received: true,
      payment: { method: "PERSONAL", date, amount: "100" },
      lines: [
        {
          clientId: randomUUID(),
          name: "原価未確認商品",
          trackingMode: "QUANTITY",
          quantity: 1,
          amount: "100",
        },
      ],
      charges: [{ name: "未確認送料", amount: "", method: "VALUE" }],
    };
    await expect(apply("BUY", uncertain)).rejects.toThrow("取引金額を確認");
    await expect(
      apply("BUY", {
        ...uncertain,
        idempotencyKey: randomUUID(),
        draftId: randomUUID(),
        charges: [],
        payment: { method: "PERSONAL", date: "2027-01-01", amount: "100" },
      }),
    ).rejects.toThrow("年度");
    expect(await db.purchaseDocument.count({ where: { workspaceId: c.workspaceId } })).toBe(count);
    expect(await db.stockMovement.count({ where: { businessUnitId: c.businessUnitId } })).toBe(
      movements,
    );
  });
  it("経費の本人立替・精算取消とカード同時支払を原記録を維持して処理する", async () => {
    const report = () => db.$transaction((tx) => businessReport(tx, c, "2026-01-01", "2026-12-31")),
      ledger = () =>
        db.$transaction(async (tx) => ownerLedger(await ownerData(tx, c), "2026-12-31")),
      before = await report(),
      beforeOwner = await ledger();
    const expense = await executeCommerce(db, c, "OTHER_RECORD", {
      ...base(),
      kind: "EXPENSE",
      categoryName: "本人立替経費",
      amount: "2500",
      settled: true,
      paymentMethod: "PERSONAL",
    });
    expect((await report()).knownProfit).toBe(before.knownProfit - 2500n);
    expect((await ledger()).unpaid).toBe(beforeOwner.unpaid + 2500n);
    expect(
      (await db.$transaction((tx) => ownerData(tx, { ...c, reportingEntityId: randomUUID() })))
        .account,
    ).toBeNull();
    const bank = await executeCommerce(db, c, "ACCOUNT_SAVE", {
        ...base(),
        name: "取消検証銀行",
        balance: "30000",
      }),
      account = (await accountBalances(db, c)).find((a) => a.id === bank)!,
      payload = {
        ...base(),
        kind: "OWNER_REIMBURSEMENT",
        amount: (beforeOwner.unpaid + 2500n).toString(),
        fee: "0",
        accountId: bank,
        accountRevision: account.revision,
      },
      plan = await db.$transaction((tx) => ownerPlan(tx, c, payload));
    await expect(
      executeCommerce(db, c, "MONEY_RECORD", { ...payload, ownerFingerprint: "0".repeat(64) }),
    ).rejects.toThrow("充当内訳");
    const reimbursement = await executeCommerce(db, c, "MONEY_RECORD", {
      ...payload,
      idempotencyKey: randomUUID(),
      ownerFingerprint: plan.fingerprint,
    });
    const allocations = await db.ownerSettlementAllocation.findMany({
      where: { settlementId: reimbursement },
    });
    expect((await ledger()).unpaid).toBe(0n);
    await executeCommerce(db, c, "MONEY_RECORD", {
      ...base(),
      kind: "REVERSAL",
      reversesId: reimbursement,
      memo: "精算の訂正",
    });
    expect((await ledger()).unpaid).toBe(beforeOwner.unpaid + 2500n);
    expect(
      await db.ownerSettlementAllocation.findMany({ where: { settlementId: reimbursement } }),
    ).toEqual(allocations);
    expect((await report()).knownProfit).toBe(before.knownProfit - 2500n);
    const internal = (await db.$transaction((tx) => ownerData(tx, c))).account!;
    await expect(
      db.moneyTransaction.create({
        data: {
          workspaceId: c.workspaceId,
          businessUnitId: c.businessUnitId,
          reportingEntityId: c.reportingEntityId,
          date: new Date(date),
          kind: "OWNER_REIMBURSEMENT",
          amountJpy: 1n,
          feeJpy: 0n,
          requestId: randomUUID(),
          entries: {
            create: [
              { accountId: bank, amountJpy: -1n, purpose: "PRINCIPAL" },
              { accountId: internal.id, amountJpy: 1n, purpose: "PRINCIPAL" },
            ],
          },
        },
      }),
    ).rejects.toThrow();

    const expensePayment = await db.moneyTransaction.findFirstOrThrow({
      where: { sourceId: expense, kind: "OTHER_PAYMENT" },
    });
    await executeCommerce(db, c, "MONEY_RECORD", {
      ...base(),
      kind: "REVERSAL",
      reversesId: expensePayment.id,
      memo: "経費の立替支払の取消",
    });
    await expect(
      db.$transaction(async (tx) => {
        const txn = await tx.moneyTransaction.create({
          data: {
            workspaceId: c.workspaceId,
            businessUnitId: c.businessUnitId,
            reportingEntityId: c.reportingEntityId,
            date: new Date(date),
            kind: "OWNER_REIMBURSEMENT",
            amountJpy: 1n,
            feeJpy: 0n,
            requestId: randomUUID(),
            entries: {
              create: [
                { accountId: bank, amountJpy: -1n, purpose: "PRINCIPAL" },
                { accountId: internal.id, amountJpy: 1n, purpose: "PRINCIPAL" },
              ],
            },
          },
        });
        await tx.ownerSettlementAllocation.create({
          data: { settlementId: txn.id, sourceTransactionId: expensePayment.id, amountJpy: 1n },
        });
      }),
    ).rejects.toThrow("reversed owner");
    const card = await executeCommerce(db, c, "ACCOUNT_SAVE", {
        ...base(),
        name: "同時支払カード",
        accountKind: "CREDIT_CARD",
        balance: "0",
      }),
      cardAccount = (await accountBalances(db, c)).find((a) => a.id === card)!;
    await apply("BUY", {
      ...base(),
      draftId: randomUUID(),
      supplierName: "カード同時購入",
      locationId,
      received: true,
      payment: {
        method: "ACCOUNT",
        date,
        amount: "1000",
        accountId: card,
        accountRevision: cardAccount.revision,
      },
      lines: [
        {
          clientId: randomUUID(),
          name: "同時購入商品",
          trackingMode: "QUANTITY",
          quantity: 1,
          amount: "1000",
        },
      ],
    });
    expect((await accountBalances(db, c)).find((a) => a.id === card)!.balance).toBe(-1000n);
    expect((await db.otherRecord.findUniqueOrThrow({ where: { id: expense } })).amountJpy).toBe(
      2500n,
    );
  });
  it("翌年度の本人立替精算で前年度の費用と元支払を変更しない", async () => {
    const original = await db.moneyTransaction.findMany({
        where: { workspaceId: c.workspaceId },
        orderBy: { id: "asc" },
      }),
      before = await db.$transaction((tx) => businessReport(tx, c, "2026-01-01", "2026-12-31")),
      amount = (
        await db.$transaction(async (tx) => ownerLedger(await ownerData(tx, c), "2026-12-31"))
      ).unpaid;
    expect(amount).toBeGreaterThan(0n);
    const year = await db.fiscalYearProfile.create({
      data: {
        reportingEntityId: c.reportingEntityId,
        year: 2027,
        filingMethod: "BLUE",
        consumptionTaxStatus: "EXEMPT",
        blueDeductionTarget: "NONE",
        inventoryValuationMethod: "SPECIFIC",
        startDate: new Date("2027-01-01"),
        endDate: new Date("2027-12-31"),
      },
    });
    await db.businessUnitAssignment.create({
      data: {
        businessUnitId: c.businessUnitId,
        fiscalYearProfileId: year.id,
        effectiveFrom: new Date("2027-01-01"),
        effectiveTo: new Date("2027-12-31"),
      },
    });
    await db.fiscalYearProfile.updateMany({
      where: { reportingEntityId: c.reportingEntityId, year: 2026 },
      data: { status: "LOCKED", lockedAt: new Date() },
    });
    const next = { ...c, year: 2027 },
      nextDate = "2027-01-10",
      nextBase = { ...base(), date: nextDate, context: { ...base().context, year: 2027 } },
      bank = await executeCommerce(db, next, "ACCOUNT_SAVE", {
        ...nextBase,
        name: "翌年精算銀行",
        balance: "30000",
      }),
      account = (await accountBalances(db, next)).find((a) => a.id === bank)!,
      payload = {
        ...nextBase,
        idempotencyKey: randomUUID(),
        kind: "OWNER_REIMBURSEMENT",
        amount: amount.toString(),
        fee: "0",
        accountId: bank,
        accountRevision: account.revision,
      },
      plan = await db.$transaction((tx) => ownerPlan(tx, next, payload));
    await executeCommerce(db, next, "MONEY_RECORD", {
      ...payload,
      ownerFingerprint: plan.fingerprint,
    });
    expect(
      (await db.$transaction(async (tx) => ownerLedger(await ownerData(tx, next), nextDate)))
        .unpaid,
    ).toBe(0n);
    expect(
      await db.$transaction((tx) => businessReport(tx, c, "2026-01-01", "2026-12-31")),
    ).toEqual(before);
    expect(
      await db.moneyTransaction.findMany({
        where: { id: { in: original.map((t) => t.id) } },
        orderBy: { id: "asc" },
      }),
    ).toEqual(original);
  });
});
