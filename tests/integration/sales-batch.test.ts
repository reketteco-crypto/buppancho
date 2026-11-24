import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeCommerce } from "@/lib/commerce/workflow";
import type { CommerceKind } from "@/lib/commerce/input";
import type { WorkflowContext } from "@/lib/sales/workflow-context";
import { captureValuationPreview } from "@/lib/inventory/shared-valuation";
import { emptySalesBatchRow, type SalesBatchRow } from "@/lib/commerce/sales-batch-types";
import {
  forkSalesBatch,
  previewSalesBatch,
  readSalesBatch,
  rememberSalesBatchMapping,
  salesBatchMappings,
  salesBatchProgress,
  saveSalesBatch,
  saveSalesBatchNext,
} from "@/lib/commerce/sales-batch";
import { requestResult } from "@/lib/sales/request-store";
import { effectiveCosts } from "@/lib/inventory/effective-cost";
import { inputDrafts } from "@/lib/commerce/input-drafts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip).sequential("販売のまとめ入力DB統合", () => {
  let db: PrismaClient;
  beforeAll(() => {
    if (!url || new URL(url).pathname !== "/buppancho_redesign_20261110_test")
      throw new Error("固定専用DBを指定してください。");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  async function apply(c: WorkflowContext, kind: CommerceKind, input: object) {
    const payload = { ...input, valuationPosition: "LAST" };
    const preview = await captureValuationPreview(() => executeCommerce(db, c, kind, payload));
    return executeCommerce(db, c, kind, { ...payload, valuationFingerprint: preview.fingerprint });
  }
  async function fixture() {
    const workspace = await db.workspace.create({ data: { name: `販売一括-${randomUUID()}` } });
    const entity = await db.reportingEntity.create({
      data: { workspaceId: workspace.id, displayName: "事業者" },
    });
    const unit = await db.businessUnit.create({
      data: { workspaceId: workspace.id, name: "事業", code: "MAIN", color: "#355d4c" },
    });
    const operator = await db.operator.create({
      data: { workspaceId: workspace.id, displayName: "入力者" },
    });
    const account = await db.userAccount.create({
      data: {
        workspaceId: workspace.id,
        loginName: `batch-${randomUUID()}`,
        normalizedName: `batch-${randomUUID()}`,
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
    const location = await db.storageLocation.create({
      data: { workspaceId: workspace.id, businessUnitId: unit.id, code: "MAIN", name: "保管場所" },
    });
    const channel = await db.salesChannel.create({
      data: { workspaceId: workspace.id, name: "販路", type: "OTHER" },
    });
    const c: WorkflowContext = {
      workspaceId: workspace.id,
      reportingEntityId: entity.id,
      businessUnitId: unit.id,
      operatorId: operator.id,
      userAccountId: account.id,
      year: 2026,
    };
    const purchase = async (date: string, quantity: number, amount: string, variantId?: string) =>
      apply(c, "BUY", {
        idempotencyKey: randomUUID(),
        draftId: randomUUID(),
        context: c,
        date,
        supplierName: "仕入先",
        locationId: location.id,
        received: true,
        createSkus: true,
        lines: [
          {
            clientId: randomUUID(),
            name: "商品",
            trackingMode: "QUANTITY",
            quantity,
            amount,
            ...(variantId ? { variantId } : {}),
          },
        ],
      });
    await purchase("2026-11-01", 10, "100");
    const sku = await db.salesSku.findFirstOrThrow({
      where: { workspaceId: workspace.id },
      include: { components: true },
    });
    const variantId = sku.components[0]!.itemVariantId!;
    const row = (patch: Partial<SalesBatchRow> = {}): SalesBatchRow => ({
      ...emptySalesBatchRow(randomUUID()),
      selected: true,
      completed: true,
      sourceName: "商品",
      date: "2026-11-10",
      skuId: sku.id,
      channelId: channel.id,
      quantity: 1,
      price: "500",
      fee: "50",
      shipping: "0",
      position: "LAST",
      externalId: randomUUID(),
      ...patch,
    });
    const batch = async (rows: SalesBatchRow[]) => {
      const id = randomUUID();
      await saveSalesBatch(db, c, id, 0, randomUUID(), { rows });
      return id;
    };
    const counts = async () => ({
      orders: await db.salesOrder.count({ where: { workspaceId: workspace.id } }),
      operations: await db.inventoryOperation.count({ where: { workspaceId: workspace.id } }),
      movements: await db.stockMovement.count({ where: { businessUnitId: unit.id } }),
      requests: await db.workflowRequest.count({ where: { workspaceId: workspace.id } }),
      valuations: await db.valuationRun.count({ where: { workspaceId: workspace.id } }),
      money: await db.moneyTransaction.count({ where: { workspaceId: workspace.id } }),
      balance: (
        await db.inventoryCostBalance.findFirstOrThrow({ where: { itemVariantId: variantId } })
      ).carryingCostTotalJpy,
    });
    return { c, sku, row, batch, purchase, variantId, fiscal, counts };
  }
  it("同じ在庫の累積不足を検出し、仮反映の業務記録を残さない", async () => {
    const f = await fixture();
    const rows = [f.row({ quantity: 8 }), f.row({ quantity: 8 })];
    const id = await f.batch(rows),
      before = await f.counts();
    const result = await previewSalesBatch(db, f.c, id, 1);
    expect(result.id).toBeUndefined();
    expect(result.rows[0]?.cost).toBe("800");
    expect(result.issues[0]?.rowId).toBe(rows[1]!.id);
    expect(await f.counts()).toEqual(before);
    expect((await readSalesBatch(db, f.c, id)).data.rows).toEqual(rows);
  });
  it("変更行だけを同じ版へ保存し、再送は同じ結果、古い版・別内容・確定行改変は拒否する", async () => {
    const f = await fixture();
    const rows = [f.row(), f.row({ selected: false })];
    const id = await f.batch(rows);
    const before = await f.counts();
    const changed = { ...rows[0]!, price: "880", date: "2026-11-12" };
    const appended = f.row({ selected: false });
    const patch = { changedRows: [changed, appended] };
    const key = randomUUID();
    const saved = await saveSalesBatch(db, f.c, id, 1, key, patch);
    expect(await saveSalesBatch(db, f.c, id, 1, key, patch)).toEqual(saved);
    expect((await readSalesBatch(db, f.c, id)).data.rows).toEqual([changed, rows[1], appended]);
    await expect(
      saveSalesBatch(db, f.c, id, 1, randomUUID(), { changedRows: [rows[1]] }),
    ).rejects.toThrow();
    await expect(
      saveSalesBatch(db, f.c, id, 1, key, { changedRows: [appended] }),
    ).rejects.toThrow();
    expect(await f.counts()).toEqual(before);
    const review = await previewSalesBatch(db, f.c, id, saved.revision);
    await saveSalesBatchNext(db, f.c, review.id!, 0);
    const current = await readSalesBatch(db, f.c, id);
    await expect(
      saveSalesBatch(db, f.c, id, current.revision, randomUUID(), {
        changedRows: [{ ...current.data.rows[0]!, price: "1" }],
      }),
    ).rejects.toThrow("保存済み");
  });
  it("選択順に一括確認して行ごとに確定し、再送・再開でも二重出庫しない", async () => {
    const f = await fixture();
    const rows = [
      f.row({ quantity: 3, date: "2026-11-11" }),
      f.row({ quantity: 2, date: "2026-11-10", priceBasis: "TOTAL", price: "900" }),
    ];
    const id = await f.batch(rows),
      before = await f.counts();
    const preview = await previewSalesBatch(db, f.c, id, 1);
    expect(preview.issues).toEqual([]);
    expect(preview.rows.map((r) => r.cost)).toEqual(["200", "300"]);
    expect(preview.rows[0]?.profit).toBe("650");
    expect(await f.counts()).toEqual(before);
    await expect(saveSalesBatchNext(db, f.c, preview.id!, 1)).rejects.toThrow("先行");
    const first = await saveSalesBatchNext(db, f.c, preview.id!, 0);
    expect(
      (await db.salesOrder.findUniqueOrThrow({ where: { id: first.targetId } })).saleSnapshot,
    ).toMatchObject({ importSource: { batchId: id, rowId: rows[1]!.id, sourceName: "商品" } });
    expect(await saveSalesBatchNext(db, f.c, preview.id!, 0)).toEqual(first);
    expect((await salesBatchProgress(db, f.c, preview.id!)).next).toBe(1);
    expect((await readSalesBatch(db, f.c, id)).recovery).toBeDefined();
    const second = await saveSalesBatchNext(db, f.c, preview.id!, 1);
    expect(first.targetId).not.toBe(second.targetId);
    expect((await salesBatchProgress(db, f.c, preview.id!)).done).toBe(true);
    expect((await readSalesBatch(db, f.c, id)).data.rows.every((r) => r.targetId)).toBe(true);
    expect(
      (await db.inventoryCostBalance.findFirstOrThrow({ where: { itemVariantId: f.variantId } }))
        .quantity,
    ).toBe(5);
    expect((await f.counts()).money).toBe(before.money);
  });
  it("後日追加した過去の入庫で確定済み原価を訂正し、残りの承認を失効させる", async () => {
    const f = await fixture();
    const id = await f.batch([f.row({ quantity: 2 }), f.row({ quantity: 1, date: "2026-11-12" })]);
    const preview = await previewSalesBatch(db, f.c, id, 1);
    const saved = await saveSalesBatchNext(db, f.c, preview.id!, 0);
    const originalMoves = await db.stockMovement.findMany({
      where: { sourceId: saved.targetId },
      orderBy: { id: "asc" },
    });
    await f.purchase("2026-11-05", 10, "200", f.variantId);
    const order = await db.salesOrder.findUniqueOrThrow({
      where: { id: saved.targetId },
      include: { lines: { include: { consumptions: true } } },
    });
    expect(order.lines[0]!.managementCogsJpy).toBe(300n);
    expect([
      ...(await effectiveCosts(db, "CONSUMPTION", order.lines[0]!.consumptions)).values(),
    ]).toEqual([300n]);
    expect(
      await db.stockMovement.findMany({
        where: { sourceId: saved.targetId },
        orderBy: { id: "asc" },
      }),
    ).toEqual(originalMoves);
    await expect(saveSalesBatchNext(db, f.c, preview.id!, 1)).rejects.toThrow("一括確認後");
    expect(await db.salesOrder.count({ where: { workspaceId: f.c.workspaceId } })).toBe(1);
    const current = await readSalesBatch(db, f.c, id);
    await saveSalesBatch(db, f.c, id, current.revision, randomUUID(), current.data);
    const revised = await previewSalesBatch(db, f.c, id, current.revision + 1);
    expect(revised.rows.map((r) => r.cost)).toEqual(["150"]);
    await saveSalesBatchNext(db, f.c, revised.id!, 0);
    expect(await db.salesOrder.count({ where: { workspaceId: f.c.workspaceId } })).toBe(2);
  });
  it("取消墓標で遅延保存を止め、入力を残したまま再確認できる", async () => {
    const f = await fixture(),
      id = await f.batch([f.row()]);
    const preview = await previewSalesBatch(db, f.c, id, 1);
    const progress = await salesBatchProgress(db, f.c, preview.id!);
    expect((await requestResult(db, f.c, progress.nextKey!)).status).toBe("UNKNOWN");
    expect((await requestResult(db, f.c, progress.nextKey!, true)).status).toBe("CANCELLED");
    await expect(saveSalesBatchNext(db, f.c, preview.id!, 0)).rejects.toThrow();
    expect(await db.salesOrder.count({ where: { workspaceId: f.c.workspaceId } })).toBe(0);
    const batch = await readSalesBatch(db, f.c, id);
    await saveSalesBatch(db, f.c, id, batch.revision, randomUUID(), batch.data);
    const next = await previewSalesBatch(db, f.c, id, batch.revision + 1);
    await saveSalesBatchNext(db, f.c, next.id!, 0);
  });
  it("不足情報・別年度・端数を残し、SKU対応を次回候補として帰属で限定する", async () => {
    const f = await fixture();
    const rows = [f.row({ completed: false, date: "" })];
    const id = await f.batch(rows);
    expect((await previewSalesBatch(db, f.c, id, 1)).issues[0]?.message).toContain("完了日");
    rows[0] = f.row({ priceBasis: "TOTAL", price: "901", quantity: 2 });
    await saveSalesBatch(db, f.c, id, 1, randomUUID(), { rows });
    expect((await previewSalesBatch(db, f.c, id, 2)).issues[0]?.message).toContain("割り切れ");
    rows[0] = f.row({ date: "2025-12-31" });
    await saveSalesBatch(db, f.c, id, 2, randomUUID(), { rows });
    expect((await previewSalesBatch(db, f.c, id, 3)).id).toBeUndefined();
    const mapping = { sourceName: "30枚セット", skuId: f.sku.id, channelId: rows[0]!.channelId };
    await rememberSalesBatchMapping(db, f.c, mapping, randomUUID());
    expect(await salesBatchMappings(db, f.c)).toEqual([mapping]);
    const other = await db.reportingEntity.create({
      data: { workspaceId: f.c.workspaceId, displayName: "別主体" },
    });
    const otherC = { ...f.c, reportingEntityId: other.id };
    await expect(readSalesBatch(db, otherC, id)).rejects.toThrow();
    const stranger = await fixture();
    await expect(readSalesBatch(db, stranger.c, id)).rejects.toThrow();
    expect(await salesBatchMappings(db, stranger.c)).toEqual([]);
    await expect(
      rememberSalesBatchMapping(db, stranger.c, mapping, randomUUID()),
    ).rejects.toThrow();
  });
  it("重複商品ID・確認後の年度ロック・保存済み行の改変を拒否する", async () => {
    const f = await fixture();
    const rows = [f.row({ externalId: "duplicate" }), f.row({ externalId: "duplicate" })];
    const id = await f.batch(rows);
    expect((await previewSalesBatch(db, f.c, id, 1)).issues[0]?.message).toContain("登録");
    rows[1]!.selected = false;
    await saveSalesBatch(db, f.c, id, 1, randomUUID(), { rows });
    const review = await previewSalesBatch(db, f.c, id, 2);
    await db.fiscalYearProfile.update({
      where: { id: f.fiscal.id },
      data: { status: "LOCKED", lockedAt: new Date() },
    });
    await expect(saveSalesBatchNext(db, f.c, review.id!, 0)).rejects.toThrow("ロック");
    await db.fiscalYearProfile.update({
      where: { id: f.fiscal.id },
      data: { status: "OPEN", lockedAt: null },
    });
    const revised = await previewSalesBatch(db, f.c, id, 2);
    await saveSalesBatchNext(db, f.c, revised.id!, 0);
    const current = await readSalesBatch(db, f.c, id);
    current.data.rows[0]!.price = "999";
    await expect(
      saveSalesBatch(db, f.c, id, current.revision, randomUUID(), current.data),
    ).rejects.toThrow("保存済み");
  });
  it("途中保存の競合では基準を変えず、理由付きの新下書きだけを作る", async () => {
    const f = await fixture();
    const originalRows = [f.row()];
    const id = await f.batch(originalRows);
    const local = { rows: [{ ...originalRows[0]!, quantity: 3 }] };
    const remote = { rows: [{ ...originalRows[0]!, quantity: 2 }] };
    await saveSalesBatch(db, f.c, id, 1, randomUUID(), remote);
    await expect(saveSalesBatch(db, f.c, id, 1, randomUUID(), local)).rejects.toThrow();
    const before = await f.counts(),
      newId = randomUUID();
    const input = {
      revision: 1,
      baseline: { rows: originalRows },
      local,
      reason: "手元の数量を確認して継続",
    };
    await forkSalesBatch(db, f.c, id, newId, input);
    expect(await forkSalesBatch(db, f.c, id, newId, input)).toEqual({ id: newId });
    const copied = await readSalesBatch(db, f.c, newId);
    expect(copied.data.rows[0]!.quantity).toBe(3);
    expect(copied.data.rows[0]!.id).not.toBe(originalRows[0]!.id);
    expect((await readSalesBatch(db, f.c, id)).data).toEqual(remote);
    const stored = await db.workflowDraft.findUniqueOrThrow({ where: { id: newId } });
    expect(stored.baseSnapshot).toMatchObject({
      originalDraftId: id,
      originalRevision: 1,
      baseline: { rows: originalRows },
      local,
      reason: input.reason,
    });
    expect(await f.counts()).toEqual(before);
  });
  it("ホームの再開は帰属内の未完了入力だけを要約し、確定済み・対象外・内部確認を混ぜない", async () => {
    const f = await fixture();
    const row = f.row({
      selected: false,
      source: {
        file: "販売履歴.csv",
        purchasedAt: "2026-11-01",
        updatedAt: "2026-11-10",
        profit: "450",
        url: "",
      },
    });
    const unfinished = await f.batch([row]);
    const completed = await f.batch([f.row()]);
    const review = await previewSalesBatch(db, f.c, completed, 1);
    await saveSalesBatchNext(db, f.c, review.id!, 0);
    await f.batch([f.row({ excluded: true, selected: false })]);
    await rememberSalesBatchMapping(
      db,
      f.c,
      { sourceName: "対応の内部記録", skuId: row.skuId, channelId: row.channelId },
      randomUUID(),
    );
    const base = {
      workspaceId: f.c.workspaceId,
      businessUnitId: f.c.businessUnitId,
      operatorId: f.c.operatorId,
      year: f.c.year,
      baseSnapshot: { reportingEntityId: f.c.reportingEntityId },
    };
    const purchase = await db.workflowDraft.create({
      data: {
        ...base,
        id: randomUUID(),
        kind: "COMMERCE_PURCHASE",
        payload: { supplierName: "仕入の途中入力" },
      },
    });
    await db.workflowDraft.create({
      data: {
        ...base,
        id: randomUUID(),
        kind: "COMMERCE_PURCHASE",
        payload: {},
        archivedAt: new Date(),
      },
    });
    await db.workflowDraft.create({
      data: {
        ...base,
        id: randomUUID(),
        kind: "COMMERCE_SALE",
        payload: {},
        baseSnapshot: { reportingEntityId: randomUUID() },
      },
    });
    const before = await f.counts();
    const cards = await inputDrafts(db, f.c);
    expect(cards.map((card) => card.id).sort()).toEqual([unfinished, purchase.id].sort());
    expect(cards.find((card) => card.id === unfinished)).toMatchObject({
      title: "販売まとめ入力 · 販売履歴.csv",
      total: 1n,
      remaining: 1n,
      saved: 0n,
      href: `/sales/batch?draft=${unfinished}`,
    });
    for (const changed of [
      { workspaceId: randomUUID() },
      { businessUnitId: randomUUID() },
      { reportingEntityId: randomUUID() },
      { operatorId: randomUUID() },
      { year: 2025 },
    ])
      expect(await inputDrafts(db, { ...f.c, ...changed })).toEqual([]);
    expect(await f.counts()).toEqual(before);
  });
});
