import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkflowContext } from "@/lib/sales/workflow-context";
import { captureValuationPreview } from "@/lib/inventory/shared-valuation";
import { executeCommerce } from "@/lib/commerce/workflow";
import type { CommerceKind } from "@/lib/commerce/input";
import { buySchema } from "@/lib/commerce/input";
import { purchaseCostPreview } from "@/lib/commerce/purchase-cost-preview";
import {
  purchaseChoices,
  purchaseMeasurements,
  purchaseLineBases,
} from "@/lib/commerce/purchase-history";
const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip).sequential("購入商品の履歴と重量", () => {
  let db: PrismaClient, c: WorkflowContext, locationId: string;
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
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  it("商品履歴の元名称・重量と費用訂正の根拠を、帰属と日付を限定して再利用する", async () => {
    const name = `重量参照-${randomUUID()}`;
    const id = await apply("BUY", {
      ...base(),
      draftId: randomUUID(),
      supplierName: "履歴取引先",
      locationId,
      received: false,
      currency: "CNY",
      exchangeRate: "20",
      charges: [{ name: "購入時の重量根拠", amount: "0", method: "WEIGHT" }],
      lines: [
        {
          clientId: randomUUID(),
          name,
          sourceName: "尺寸:活動支架",
          trackingMode: "QUANTITY",
          quantity: 7,
          amount: "12.34",
          weight: "12.5",
          volume: "15",
        },
      ],
    });
    let document = await db.purchaseDocument.findUniqueOrThrow({
      where: { id },
      include: { lines: true },
    });
    const line = document.lines[0]!,
      variant = line.itemVariantId!;
    expect(line.sourceName).toBe("尺寸:活動支架");
    expect(
      (
        await db.purchaseCharge.findFirstOrThrow({
          where: { documentId: id, name: "購入時の重量根拠" },
        })
      ).basisSnapshot,
    ).toMatchObject({ bases: { [line.id]: { weight: "12.5", volume: "15" } } });
    const choices = await purchaseChoices(db, c, { date, q: name, tab: "history" });
    expect(choices.rows).toHaveLength(1);
    expect(choices.rows[0]).toMatchObject({
      name,
      variantId: variant,
      history: { sourceName: "尺寸:活動支架", quantity: 7, amount: "12.34", currency: "CNY" },
      measurements: { weight: { value: "12.5" }, volume: { value: "15" } },
    });
    const cost = await apply("PURCHASE_COST", {
      ...base(),
      date: "2026-11-11",
      purchaseId: id,
      revision: document.revision,
      charge: { name: "計量した送料", amount: "100", method: "WEIGHT" },
      reason: "計量結果を確認",
      bases: { [line.id]: { weight: "25.5", volume: "", manual: "" } },
    });
    expect(cost).toBe(id);
    expect(
      (await purchaseMeasurements(db, c, date, { variantIds: [variant] })).get(variant)?.weight
        ?.value,
    ).toBe("12.5");
    expect(
      (await purchaseMeasurements(db, c, "2026-11-11", { variantIds: [variant] })).get(variant)
        ?.weight?.value,
    ).toBe("25.5");
    const charge = await db.purchaseCharge.findFirstOrThrow({
      where: { documentId: id, name: "計量した送料" },
    });
    document = await db.purchaseDocument.findUniqueOrThrow({
      where: { id },
      include: { lines: true },
    });
    await apply("PURCHASE_COST", {
      ...base(),
      date: "2026-11-12",
      purchaseId: id,
      revision: document.revision,
      supersedesId: charge.id,
      charge: { name: "計量した送料", amount: "120", method: "WEIGHT" },
      reason: "重量を訂正",
      bases: { [line.id]: { weight: "30.5", volume: "17", manual: "" } },
    });
    const resolved = await purchaseLineBases(db, c, "2026-11-12", document.lines);
    expect(resolved[line.id]).toEqual({ weight: "30.5", volume: "17", manual: "" });
    await db.purchaseCharge.createMany({
      data: [
        {
          documentId: id,
          name: "将来の根拠",
          recordedDate: new Date("2027-01-01"),
          basisSnapshot: { bases: { [line.id]: { weight: "999", volume: "999" } } },
        },
        {
          documentId: id,
          name: "不正形式の古い根拠",
          recordedDate: new Date("2026-11-12"),
          basisSnapshot: { bases: { [line.id]: { weight: "12x3", volume: [] } } },
        },
      ],
    });
    expect(
      (await purchaseMeasurements(db, c, "2026-11-12", { variantIds: [variant] })).get(variant)
        ?.weight?.value,
    ).toBe("30.5");
    expect(
      await purchaseMeasurements(db, { ...c, reportingEntityId: randomUUID() }, "2026-11-12", {
        variantIds: [variant],
      }),
    ).toEqual(new Map());
    expect(
      (await purchaseChoices(db, { ...c, businessUnitId: randomUUID() }, { date, q: name })).rows,
    ).toEqual([]);
    expect(
      (
        await purchaseChoices(
          db,
          { ...c, workspaceId: randomUUID() },
          { date, q: name, tab: "history" },
        )
      ).rows,
    ).toEqual([]);
    expect(
      (await purchaseChoices(db, c, { date, q: "尺寸:活動支架", tab: "history" })).rows[0]
        ?.variantId,
    ).toBe(variant);
    const snapshot = await db.purchaseCharge.findFirstOrThrow({
      where: { documentId: id, supersedesId: charge.id },
    });
    expect(snapshot.basisSnapshot).toMatchObject({
      bases: { [line.id]: { weight: "30.5", volume: "17" } },
    });
  });
  it("商品候補と購入履歴を50・50・1件で取得し、在庫0の商品も選べる", async () => {
    const token = `候補-${randomUUID()}`;
    const itemIds = Array.from({ length: 101 }, () => randomUUID()),
      variants = itemIds.map(() => randomUUID());
    await db.inventoryItem.createMany({
      data: itemIds.map((id, i) => ({
        id,
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        itemCode: `HIST-${id.slice(0, 8).toUpperCase()}-${i}`,
        name: `${token}-${String(i).padStart(3, "0")}`,
        managementType: "QUANTITY",
        managementCostMethod: "MOVING_AVERAGE",
      })),
    });
    await db.itemVariant.createMany({
      data: itemIds.map((inventoryItemId, i) => ({
        id: variants[i]!,
        workspaceId: c.workspaceId,
        inventoryItemId,
        variantCode: `HIST-${inventoryItemId.slice(0, 8).toUpperCase()}-${i}`,
      })),
    });
    const purchase = await apply("BUY", {
      ...base(),
      draftId: randomUUID(),
      supplierName: token,
      locationId,
      received: false,
      lines: itemIds.map((_, i) => ({
        clientId: randomUUID(),
        variantId: variants[i],
        name: `${token}-${i}`,
        trackingMode: "QUANTITY",
        quantity: 1,
        amount: "10",
      })),
    });
    for (const tab of ["products", "history"] as const) {
      const first = await purchaseChoices(db, c, { date, q: token, tab }),
        second = await purchaseChoices(db, c, { date, q: token, tab, page: 2 }),
        third = await purchaseChoices(db, c, { date, q: token, tab, page: 3 });
      expect([first.rows.length, second.rows.length, third.rows.length]).toEqual([50, 50, 1]);
      expect(first.total).toBe(101);
      expect(new Set([...first.rows, ...second.rows, ...third.rows].map((r) => r.id)).size).toBe(
        101,
      );
      expect((await purchaseChoices(db, c, { date, q: token, tab, page: 999 })).page).toBe(3);
    }
    expect(
      (
        await purchaseChoices(
          db,
          { ...c, reportingEntityId: randomUUID() },
          { date, q: token, tab: "history" },
        )
      ).rows,
    ).toHaveLength(0);
    await apply("BUY_CANCEL", {
      ...base(),
      purchaseId: purchase,
      revision: 0,
      reason: "未受取の注文を取消",
      confirmed: true,
    });
    expect((await purchaseChoices(db, c, { date, q: token, tab: "history" })).rows).toHaveLength(0);
  }, 30000);
  it("購入原価を入庫時点と現在在庫で区別し、複数明細を合算して読み取りだけを行う", async () => {
    const seedLine = randomUUID();
    const original = await apply("BUY", {
      ...base(),
      date: "2026-11-01",
      draftId: randomUUID(),
      supplierName: "原価比較",
      locationId,
      received: true,
      lines: [
        {
          clientId: seedLine,
          name: "補充原価",
          trackingMode: "QUANTITY",
          quantity: 10,
          amount: "100",
        },
      ],
    });
    const variantId = (
      await db.purchaseDocumentLine.findFirstOrThrow({ where: { documentId: original } })
    ).itemVariantId!;
    await apply("BUY", {
      ...base(),
      date: "2026-11-09",
      draftId: randomUUID(),
      supplierName: "原価比較",
      locationId,
      received: true,
      lines: [
        {
          clientId: randomUUID(),
          variantId,
          name: "補充原価",
          trackingMode: "QUANTITY",
          quantity: 5,
          amount: "200",
        },
      ],
    });
    const input = buySchema.parse({
      ...base(),
      date: "2026-11-05",
      draftId: randomUUID(),
      supplierName: "原価比較",
      locationId,
      received: false,
      valuationPosition: "LAST",
      lines: [
        {
          clientId: randomUUID(),
          variantId,
          name: "補充原価",
          trackingMode: "QUANTITY",
          quantity: 5,
          amount: "160",
        },
      ],
    });
    const counts = () =>
      Promise.all([
        db.purchaseDocument.count({ where: { workspaceId: c.workspaceId } }),
        db.stockMovement.count({ where: { businessUnitId: c.businessUnitId } }),
        db.workflowDraft.count({ where: { workspaceId: c.workspaceId } }),
        db.workflowRequest.count({ where: { workspaceId: c.workspaceId } }),
        db.auditLog.count({ where: { workspaceId: c.workspaceId } }),
        db.moneyTransaction.count({ where: { workspaceId: c.workspaceId } }),
        db.inventoryCostBalance.findMany({
          where: { businessUnitId: c.businessUnitId, itemVariantId: variantId },
        }),
        db.inventoryRevision.findUnique({ where: { businessUnitId: c.businessUnitId } }),
        db.workspaceSequence.findMany({
          where: { workspaceId: c.workspaceId },
          orderBy: { kind: "asc" },
        }),
      ]);
    const before = await counts();
    const originalPreview = await captureValuationPreview(() =>
      executeCommerce(db, c, "BUY", input),
    );
    expect(await purchaseCostPreview(db, c, input)).toMatchObject({
      status: "READY",
      basis: "CURRENT",
      rows: [
        {
          cost: "800",
          unitCost: "160.000000",
          before: { quantity: 15, cost: "2000" },
          after: { quantity: 20, cost: "2800", unitCost: "140.000000" },
        },
      ],
    });
    const exact = await purchaseCostPreview(db, c, { ...input, received: true });
    expect(exact).toMatchObject({
      status: "READY",
      basis: "RECEIPT",
      rows: [
        {
          before: { quantity: 10, cost: "1000" },
          after: { quantity: 15, cost: "1800", unitCost: "120.000000" },
        },
      ],
    });
    const duplicated = await purchaseCostPreview(db, c, {
      ...input,
      received: true,
      lines: [
        { ...input.lines[0], clientId: randomUUID(), quantity: 2, amount: "100" },
        { ...input.lines[0], clientId: randomUUID(), quantity: 3, amount: "200" },
      ],
    });
    expect(duplicated.rows.map((r) => r.unitCost)).toEqual(["100.000000", "200.000000"]);
    expect(duplicated.rows.map((r) => r.after)).toEqual([
      exact.rows[0]!.after,
      exact.rows[0]!.after,
    ]);
    expect(await counts()).toEqual(before);
    expect(
      (await captureValuationPreview(() => executeCommerce(db, c, "BUY", input))).fingerprint,
    ).toBe(originalPreview.fingerprint);

    const skuId = await executeCommerce(db, c, "SKU_BATCH", {
      ...base(),
      products: [{ variantId, unitId: null, name: "補充原価" }],
    });
    const sku = await db.salesSku.findUniqueOrThrow({ where: { id: skuId } });
    const channel = await db.salesChannel.create({
      data: { workspaceId: c.workspaceId, name: `原価窓口-${randomUUID()}`, type: "OTHER" },
    });
    await apply("SALE", {
      ...base(),
      date: "2026-11-05",
      draftId: randomUUID(),
      skuId,
      skuRevision: sku.revision,
      channelId: channel.id,
      channelRevision: channel.revision,
      quantity: 1,
      price: "500",
      fee: "0",
      shipping: "0",
    });
    const order = await purchaseCostPreview(db, c, {
      ...input,
      received: true,
      valuationPosition: undefined,
    });
    expect(order.status).toBe("ORDER_REQUIRED");
    expect(order.rows).toEqual([]);
    const first = await purchaseCostPreview(db, c, {
      ...input,
      received: true,
      valuationPosition: order.choices![0]!.id,
    });
    const last = await purchaseCostPreview(db, c, {
      ...input,
      received: true,
      valuationPosition: "LAST",
    });
    expect(first.rows[0]!.after.unitCost).toBe("120.000000");
    expect(last.rows[0]!.after.unitCost).toBe("121.428571");
    await apply("BUY", {
      ...input,
      idempotencyKey: randomUUID(),
      draftId: randomUUID(),
      date: "2026-11-12",
      received: true,
      lines: [{ ...input.lines[0], clientId: randomUUID(), quantity: 1, amount: "300" }],
    });
    const refreshed = await purchaseCostPreview(db, c, input);
    expect(refreshed.rows[0]!.before.quantity).toBe(15);
    expect(refreshed.rows[0]!.before.cost).toBe("2200");
    await apply("BUY", { ...input, date: "2026-11-15", received: true });
    expect(
      await db.inventoryCostBalance.findFirstOrThrow({
        where: { itemVariantId: variantId, businessUnitId: c.businessUnitId },
      }),
    ).toMatchObject({ quantity: 20, carryingCostTotalJpy: 3000n });
  }, 60000);

  it("新規・在庫0・暫定原価と境界・不整合・費用配分待ちを判定する", async () => {
    const input = buySchema.parse({
      ...base(),
      draftId: randomUUID(),
      supplierName: "暫定比較",
      locationId,
      received: false,
      valuationPosition: "LAST",
      lines: [
        {
          clientId: randomUUID(),
          name: "新規原価",
          trackingMode: "QUANTITY",
          quantity: 5,
          amount: "160",
        },
      ],
    });
    for (const received of [false, true])
      expect((await purchaseCostPreview(db, c, { ...input, received })).rows[0]).toMatchObject({
        before: { quantity: 0, cost: "0" },
        after: { unitCost: "160.000000" },
      });
    const seed = await apply("BUY", {
      ...input,
      received: true,
      idempotencyKey: randomUUID(),
      charges: [{ name: "未確認送料", amount: "" }],
    });
    const variantId = (
      await db.purchaseDocumentLine.findFirstOrThrow({ where: { documentId: seed } })
    ).itemVariantId!;
    const refill = { ...input, lines: [{ ...input.lines[0], clientId: randomUUID(), variantId }] };
    for (const received of [false, true])
      expect((await purchaseCostPreview(db, c, { ...refill, received })).rows[0]!.provisional).toBe(
        true,
      );
    expect(
      await purchaseCostPreview(db, c, {
        ...refill,
        charges: [{ name: "送料", amount: "100", method: "WEIGHT" }],
      }),
    ).toMatchObject({ status: "PENDING", rows: [] });
    await expect(
      purchaseCostPreview(db, c, {
        ...refill,
        lines: [{ ...refill.lines[0], variantId: randomUUID() }],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      purchaseCostPreview(db, { ...c, workspaceId: randomUUID() }, refill),
    ).rejects.toMatchObject({ code: "CONTEXT_CHANGED" });
    await expect(
      purchaseCostPreview(db, { ...c, businessUnitId: randomUUID() }, refill),
    ).rejects.toMatchObject({ code: "CONTEXT_CHANGED" });
    await expect(
      purchaseCostPreview(db, { ...c, reportingEntityId: randomUUID() }, refill),
    ).rejects.toMatchObject({ code: "CONTEXT_CHANGED" });
    const balance = await db.inventoryCostBalance.findFirstOrThrow({
      where: { itemVariantId: variantId, businessUnitId: c.businessUnitId },
    });
    try {
      await db.inventoryCostBalance.update({
        where: { id: balance.id },
        data: { carryingCostTotalJpy: balance.carryingCostTotalJpy + 1n },
      });
      await expect(purchaseCostPreview(db, c, refill)).rejects.toMatchObject({
        code: "HISTORY_INCOMPLETE",
      });
    } finally {
      await db.inventoryCostBalance.update({
        where: { id: balance.id },
        data: { carryingCostTotalJpy: balance.carryingCostTotalJpy },
      });
    }
    const zero = await db.itemVariant.findFirstOrThrow({
      where: { workspaceId: c.workspaceId, inventoryItem: { name: { startsWith: "候補-" } } },
    });
    expect(
      (
        await purchaseCostPreview(db, c, {
          ...refill,
          lines: [{ ...refill.lines[0], variantId: zero.id }],
        })
      ).rows[0],
    ).toMatchObject({ before: { quantity: 0, cost: "0" }, after: { unitCost: "160.000000" } });
  }, 60000);
});
