import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import type { WorkflowContext } from "@/lib/sales/workflow-context";
import { loadSalesList, salesSummary } from "@/lib/commerce/sales-list";
import { accountBalances, executeMoney, recordMoney } from "@/lib/commerce/money";
import { moneySchema } from "@/lib/commerce/input";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite("レビュー指摘の販売一覧・取消のDB回帰", () => {
  let db: PrismaClient, c: WorkflowContext, otherEntity: string, original: string, foreign: string;
  let accountId: string;
  const base = () => ({ idempotencyKey: randomUUID(), context: c, date: "2026-11-15" });
  beforeAll(async () => {
    if (!url || new URL(url).pathname !== "/buppancho_redesign_20261110_test")
      throw new Error("固定専用DBが必要です。");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    const workspace = await db.workspace.create({ data: { name: `review-fix-${randomUUID()}` } });
    const entity = await db.reportingEntity.create({
      data: { workspaceId: workspace.id, displayName: "対象主体" },
    });
    otherEntity = (
      await db.reportingEntity.create({
        data: { workspaceId: workspace.id, displayName: "別主体" },
      })
    ).id;
    const unit = await db.businessUnit.create({
      data: { workspaceId: workspace.id, code: "MAIN", name: "確認部門", color: "#355d4c" },
    });
    const operator = await db.operator.create({
      data: { workspaceId: workspace.id, displayName: "入力者" },
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
        effectiveFrom: new Date("2026-01-01"),
        effectiveTo: new Date("2026-12-31"),
      },
    });
    c = {
      workspaceId: workspace.id,
      businessUnitId: unit.id,
      reportingEntityId: entity.id,
      operatorId: operator.id,
      userAccountId: user.id,
      year: 2026,
    };
    const scope = {
      workspaceId: c.workspaceId,
      businessUnitId: c.businessUnitId,
      reportingEntityId: c.reportingEntityId,
    };
    const channel = await db.salesChannel.create({
      data: { workspaceId: c.workspaceId, name: "確認販路", type: "OTHER" },
    });
    const sku = await db.salesSku.create({
      data: {
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        name: "確認SKU",
        skuCode: "SKU-000001",
        skuType: "SINGLE",
        requestKey: randomUUID(),
      },
    });
    const rows = Array.from({ length: 302 }, (_, i) => ({
      ...scope,
      id: randomUUID(),
      salesChannelId: channel.id,
      recordingMode: "DIRECT",
      status: "COMPLETED" as const,
      completedAt: new Date(i < 300 ? "2026-11-10T00:00:00+09:00" : "2026-10-10T00:00:00+09:00"),
      createdAt: new Date(Date.UTC(2026, 10, 10, 0, 0, i)),
      grossSalesJpy: 500n,
      feeJpy: 0n,
      shippingJpy: 0n,
      packingJpy: 0n,
      otherCostJpy: 0n,
      costStatus: "FINAL" as const,
      requestKey: randomUUID(),
      buyerName: i < 300 ? "新しい販売" : "過去月の販売",
    }));
    await db.salesOrder.createMany({
      data: [
        ...rows,
        {
          ...rows[0]!,
          id: randomUUID(),
          requestKey: randomUUID(),
          reportingEntityId: otherEntity,
          buyerName: "別主体の販売",
        },
        {
          ...rows[0]!,
          id: randomUUID(),
          requestKey: randomUUID(),
          completedAt: new Date("2025-11-10T00:00:00+09:00"),
          buyerName: "別年度の販売",
        },
      ],
    });
    await db.salesOrderLine.createMany({
      data: rows.map((r) => ({
        salesOrderId: r.id,
        salesSkuId: sku.id,
        displayName: "確認SKU",
        quantity: 1,
        unitPriceJpy: 500n,
        managementCogsJpy: 100n,
      })),
    });
    const op = await db.inventoryOperation.create({
      data: {
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        operatorId: c.operatorId,
        operationType: "SALE_COMPLETION",
        sourceType: "sales_order",
        sourceId: rows[0]!.id,
        occurredAt: rows[0]!.completedAt,
        idempotencyKey: randomUUID(),
      },
    });
    await db.eventDateCorrection.create({
      data: {
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        operationId: op.id,
        requestId: randomUUID(),
        previousDate: new Date("2026-11-10"),
        effectiveDate: new Date("2026-10-25"),
        reason: "訂正日の一覧確認",
        operatorId: c.operatorId,
      },
    });
    accountId = (
      await db.moneyAccount.create({
        data: {
          ...scope,
          name: "通常口座",
          openingDate: new Date("2026-01-01"),
          openingBalanceJpy: 0n,
        },
      })
    ).id;
    original = await db.$transaction(
      async (tx) =>
        (
          await executeMoney(
            tx,
            c,
            moneySchema.parse({
              ...base(),
              kind: "OWNER_CONTRIBUTION",
              amount: "10000",
              accountId,
              accountRevision: 0,
            }),
          )
        ).id,
    );
    const foreignAccount = await db.moneyAccount.create({
      data: {
        ...scope,
        reportingEntityId: otherEntity,
        name: "別主体口座",
        openingDate: new Date("2026-01-01"),
        openingBalanceJpy: 0n,
      },
    });
    foreign = await db.$transaction(
      async (tx) =>
        (
          await executeMoney(
            tx,
            { ...c, reportingEntityId: otherEntity },
            moneySchema.parse({
              ...base(),
              kind: "OWNER_CONTRIBUTION",
              amount: "10000",
              accountId: foreignAccount.id,
              accountRevision: 0,
            }),
          )
        ).id,
    );
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  const read = (query = {}, scope = c, year = 2026) =>
    db.$transaction((tx) => loadSalesList(tx, scope, query, year), {
      isolationLevel: "RepeatableRead",
    });
  it("300件を超えても選択月と有効日の販売を取得し、主体・年度を混ぜない", async () => {
    const october = await read({ month: "10" });
    expect(october.total).toBe(3);
    expect(october.rows.map((r) => r.date)).toEqual(["2026-10-25", "2026-10-10", "2026-10-10"]);
    expect((await read({ month: "11" })).total).toBe(299);
    expect((await read({ q: "過去月" })).total).toBe(2);
    expect((await read({}, { ...c, reportingEntityId: otherEntity })).total).toBe(1);
    expect((await read({}, { ...c, workspaceId: randomUUID() })).total).toBe(0);
    expect((await read({}, { ...c, businessUnitId: randomUUID() })).total).toBe(0);
    expect((await read({}, c, 2025)).total).toBe(1);
    const summary = await db.$transaction((tx) => salesSummary(tx, c, 2026, "10"));
    expect(summary).toEqual({ count: 3, revenue: 1500n, unknown: 0 });
  });
  it("50件の安定したページ境界を保ち、全302件を重複なく閲覧できる", async () => {
    const ids: string[] = [];
    for (let page = 1; page <= 7; page++) {
      const result = await read({ page: String(page) });
      expect(result.total).toBe(302);
      expect(result.rows).toHaveLength(page === 7 ? 2 : 50);
      ids.push(...result.rows.map((r) => r.id));
    }
    expect(new Set(ids).size).toBe(302);
    expect((await read({ page: "999" })).page).toBe(7);
    expect((await read({ page: "invalid" })).page).toBe(1);
    expect((await read({ q: "一致しない", page: "999" })).page).toBe(1);
  });
  it("取消対象なし・不存在・別主体のIDでは元記録と残高を変えない", async () => {
    const raw = { ...base(), kind: "REVERSAL", memo: "取消の確認" };
    await expect(recordMoney(db, c, raw)).rejects.toThrow(/取消対象/);
    for (const reversesId of [randomUUID(), foreign]) {
      await expect(
        recordMoney(db, c, { ...raw, idempotencyKey: randomUUID(), reversesId }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    }
    expect(
      await db.moneyTransaction.count({
        where: { businessUnitId: c.businessUnitId, kind: "REVERSAL" },
      }),
    ).toBe(0);
    expect(
      (
        await db.moneyTransaction.findUniqueOrThrow({
          where: { id: original },
          include: { reversedBy: true },
        })
      ).reversedBy,
    ).toBeNull();
    expect(
      (await accountBalances(db, c, new Date("2026-11-15"))).find((a) => a.id === accountId)
        ?.balance,
    ).toBe(10000n);
  });
});
