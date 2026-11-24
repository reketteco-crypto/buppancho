import { captureValuationPreview } from "@/lib/inventory/shared-valuation";
import type { CommerceKind } from "@/lib/commerce/input";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { executeCommerce } from "@/lib/commerce/workflow";
import { loadMoneyHistory } from "@/lib/commerce/money-history";
import type { WorkflowContext } from "@/lib/sales/workflow-context";
const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip).sequential("入出金履歴の読み取り", () => {
  let db: PrismaClient, c: WorkflowContext, bank: string, categoryId: string;
  const ids = Array.from({ length: 101 }, () => ({
    record: randomUUID(),
    transaction: randomUUID(),
  }));
  const base = (date = "2026-11-10", year = 2026) => ({
    idempotencyKey: randomUUID(),
    date,
    context: {
      businessUnitId: c.businessUnitId,
      reportingEntityId: c.reportingEntityId,
      operatorId: c.operatorId,
      year,
    },
  });
  beforeAll(async () => {
    if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("専用DBが必要です。");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    const workspace = await db.workspace.create({ data: { name: `履歴テスト-${randomUUID()}` } }),
      entity = await db.reportingEntity.create({
        data: { workspaceId: workspace.id, displayName: "履歴本人" },
      }),
      unit = await db.businessUnit.create({
        data: { workspaceId: workspace.id, code: "MAIN", name: "履歴部門", color: "#355d4c" },
      }),
      operator = await db.operator.create({
        data: { workspaceId: workspace.id, displayName: "入力者" },
      }),
      user = await db.userAccount.create({
        data: {
          workspaceId: workspace.id,
          loginName: `history-${randomUUID()}`,
          normalizedName: `history-${randomUUID()}`,
          passwordHash: "test-only-placeholder",
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
    for (const year of [2026, 2027]) {
      const fiscal = await db.fiscalYearProfile.create({
        data: {
          reportingEntityId: entity.id,
          year,
          filingMethod: "BLUE",
          consumptionTaxStatus: "EXEMPT",
          blueDeductionTarget: "NONE",
          inventoryValuationMethod: "SPECIFIC",
          startDate: new Date(`${year}-01-01`),
          endDate: new Date(`${year}-12-31`),
        },
      });
      await db.businessUnitAssignment.create({
        data: {
          businessUnitId: unit.id,
          fiscalYearProfileId: fiscal.id,
          effectiveFrom: new Date(`${year}-01-01`),
          effectiveTo: new Date(`${year}-12-31`),
        },
      });
    }
    bank = await executeCommerce(db, c, "ACCOUNT_SAVE", {
      ...base("2026-01-01"),
      name: "銀行",
      balance: "20000",
    });
    categoryId = (
      await db.moneyCategory.create({
        data: { workspaceId: c.workspaceId, name: "保存時の再送料", kind: "EXPENSE" },
      })
    ).id;
    await db.$transaction(async (tx) => {
      await tx.otherRecord.createMany({
        data: ids.map((id, i) => ({
          id: id.record,
          workspaceId: c.workspaceId,
          businessUnitId: c.businessUnitId,
          reportingEntityId: c.reportingEntityId,
          kind: "EXPENSE",
          categoryId,
          categoryName: "保存時の再送料",
          date: new Date("2026-10-01"),
          createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)),
          amountJpy: 100n,
          requestId: randomUUID(),
        })),
      });
      await tx.moneyTransaction.createMany({
        data: ids.map((id, i) => ({
          id: id.transaction,
          workspaceId: c.workspaceId,
          businessUnitId: c.businessUnitId,
          reportingEntityId: c.reportingEntityId,
          kind: "OTHER_PAYMENT",
          sourceId: id.record,
          sourceSnapshot: { name: "保存時の再送料", href: `/money/records/${id.record}` },
          date: new Date("2026-10-01"),
          createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)),
          amountJpy: 100n,
          requestId: randomUUID(),
        })),
      });
      await tx.moneyEntry.createMany({
        data: ids.map((id) => ({
          transactionId: id.transaction,
          accountId: bank,
          amountJpy: -100n,
          purpose: "PRINCIPAL",
        })),
      });
    });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  const read = (q: Parameters<typeof loadMoneyHistory>[2], context = c) =>
    db.$transaction((tx) => loadMoneyHistory(tx, context, q, context.year));
  it("両一覧の101件を50・50・1件で取得し、旧カーソルと境界を確認する", async () => {
    for (const tab of ["entries", "records"]) {
      const q = { tab, from: "2026-10-01", to: "2026-10-01" };
      const first = await read(q),
        second = await read({ ...q, page: "2" }),
        third = await read({ ...q, page: "3" });
      expect(first.total).toBe(101);
      expect(first.rows).toHaveLength(50);
      expect(second.rows).toHaveLength(50);
      expect(third.rows).toHaveLength(1);
      expect(new Set([...first.rows, ...second.rows, ...third.rows].map((r) => r.id)).size).toBe(
        101,
      );
      expect((await read({ ...q, cursor: second.rows.at(-1)!.id })).rows[0]!.id).toBe(
        third.rows[0]!.id,
      );
      expect((await read(q, { ...c, businessUnitId: randomUUID() })).total).toBe(0);
      expect((await read(q, { ...c, reportingEntityId: randomUUID() })).total).toBe(0);
    }
    expect((await read({ account: randomUUID() })).error).toContain("口座");
    expect((await read({ from: "2026-11-10", to: "2026-10-01" })).error).toContain("終了日");
  });
  it("名称変更前の記録と翌年度の部分決済を現在の有効な決済で表示する", async () => {
    await db.moneyCategory.update({ where: { id: categoryId }, data: { name: "現在の項目名" } });
    await executeCommerce(db, c, "MONEY_RECORD", {
      ...base(),
      kind: "REVERSAL",
      reversesId: ids[100]!.transaction,
      memo: "決済の訂正",
    });
    const q = { tab: "records", from: "2026-10-01", to: "2026-10-01" };
    expect((await read(q)).rows[0]).toMatchObject({ title: "保存時の再送料", status: "未決済" });
    const pay = async (amount: string) =>
      executeCommerce(db, { ...c, year: 2027 }, "MONEY_RECORD", {
        ...base("2027-01-02", 2027),
        kind: "OTHER_PAYMENT",
        sourceId: ids[100]!.record,
        sourceRevision: 0,
        amount,
        accountId: bank,
        accountRevision: (await db.moneyAccount.findUniqueOrThrow({ where: { id: bank } }))
          .revision,
      });
    await pay("40");
    expect((await read(q)).rows[0]!.status).toBe("一部決済");
    await pay("60");
    expect((await read(q)).rows[0]!.status).toBe("決済済み");
  });
  it("振替手数料と取消を全体・口座別で照合する", async () => {
    const target = await executeCommerce(db, c, "ACCOUNT_SAVE", {
        ...base("2026-01-01"),
        name: "受取銀行",
        balance: "0",
      }),
      source = await db.moneyAccount.findUniqueOrThrow({ where: { id: bank } }),
      to = await db.moneyAccount.findUniqueOrThrow({ where: { id: target } });
    const id = await executeCommerce(db, c, "MONEY_RECORD", {
      ...base(),
      kind: "TRANSFER",
      amount: "9800",
      fee: "200",
      accountId: bank,
      accountRevision: source.revision,
      toAccountId: target,
      toAccountRevision: to.revision,
    });
    const q = { from: "2026-11-10", to: "2026-11-11" };
    expect((await read(q)).rows.find((r) => r.id === id)).toMatchObject({
      amount: "¥9,800",
      feeLabel: "手数料 ¥200",
    });
    expect((await read({ ...q, account: bank })).rows.find((r) => r.id === id)!.amount).toBe(
      "−¥10,000",
    );
    expect((await read({ ...q, account: target })).rows.find((r) => r.id === id)!.amount).toBe(
      "＋¥9,800",
    );
    const reversed = await executeCommerce(db, c, "MONEY_RECORD", {
      ...base("2026-11-11"),
      kind: "REVERSAL",
      reversesId: id,
      memo: "振替の訂正",
    });
    const rows = (await read({ ...q, account: bank })).rows;
    expect(rows.find((r) => r.id === reversed)!.amount).toBe("＋¥10,000");
    expect(rows.find((r) => r.id === id)!.status).toBe("取消済み");
  });
  it("購入と販売の表示には保存時の取引先名・SKU名を使う", async () => {
    const apply = async (kind: CommerceKind, input: object) => {
      const planned = { ...input, valuationPosition: "LAST" },
        preview = await captureValuationPreview(() => executeCommerce(db, c, kind, planned));
      return executeCommerce(db, c, kind, {
        ...planned,
        valuationFingerprint: preview.fingerprint,
      });
    };
    const location = await db.storageLocation.create({
      data: {
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        code: "MAIN",
        name: "保管",
      },
    });
    const purchase = await apply("BUY", {
      ...base(),
      draftId: randomUUID(),
      supplierName: "保存時の取引先",
      locationId: location.id,
      received: true,
      createSkus: true,
      lines: [
        {
          clientId: randomUUID(),
          name: "保存時SKU",
          trackingMode: "QUANTITY",
          quantity: 1,
          amount: "100",
        },
      ],
    });
    const document = await db.purchaseDocument.findUniqueOrThrow({
        where: { id: purchase },
        include: { lines: true },
      }),
      sku = await db.salesSku.findFirstOrThrow({
        where: {
          workspaceId: c.workspaceId,
          businessUnitId: c.businessUnitId,
          components: { some: { itemVariantId: document.lines[0]!.itemVariantId } },
        },
      }),
      channel = await db.salesChannel.create({
        data: { workspaceId: c.workspaceId, name: "販路", type: "OTHER" },
      });
    const sale = await apply("SALE", {
      ...base(),
      draftId: randomUUID(),
      skuId: sku.id,
      skuRevision: sku.revision,
      channelId: channel.id,
      channelRevision: channel.revision,
      quantity: 1,
      price: "500",
      fee: "0",
      shipping: "0",
    });
    const pay = async (
      kind: "PURCHASE_PAYMENT" | "SALE_RECEIPT",
      sourceId: string,
      amount: string,
      sourceRevision: number,
    ) =>
      executeCommerce(db, c, "MONEY_RECORD", {
        ...base(),
        kind,
        sourceId,
        sourceRevision,
        amount,
        accountId: bank,
        accountRevision: (await db.moneyAccount.findUniqueOrThrow({ where: { id: bank } }))
          .revision,
      });
    const purchasePayment = await pay("PURCHASE_PAYMENT", purchase, "100", document.revision),
      salePayment = await pay(
        "SALE_RECEIPT",
        sale,
        "500",
        (await db.salesOrder.findUniqueOrThrow({ where: { id: sale } })).revision,
      );
    await db.counterparty.update({
      where: { id: document.supplierId },
      data: { name: "現在の取引先名" },
    });
    await db.salesSku.update({ where: { id: sku.id }, data: { name: "現在のSKU名" } });
    const rows = (await read({ from: "2026-11-10", to: "2026-11-10" })).rows;
    expect(rows.find((r) => r.id === purchasePayment)).toMatchObject({
      title: "保存時の取引先",
      reference: document.code,
    });
    expect(rows.find((r) => r.id === salePayment)!.title).toBe("保存時SKU");
  });
});
