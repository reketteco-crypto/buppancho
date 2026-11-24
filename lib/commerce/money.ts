import {
  ownerData,
  ownerAvailable,
  ownerAllocate,
  ownerPlan,
  ensureOwnerAccount,
  appendOwnerAllocations,
} from "./owner-ledger";
import { effectiveSourceDates, effectiveOperationDates } from "@/lib/inventory/event-dates";
import type { z } from "zod";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { WorkflowError } from "@/lib/sales/workflow-errors";
import type { WorkflowContext } from "@/lib/sales/workflow-context";
import { runWorkflow } from "@/lib/sales/workflow-runner";
import { toJson } from "@/lib/sales/request-store";
import { accountSchema, moneySchema } from "./input";
type Tx = Prisma.TransactionClient;
const scope = (c: WorkflowContext) => ({
  workspaceId: c.workspaceId,
  businessUnitId: c.businessUnitId,
  reportingEntityId: c.reportingEntityId,
});
function invalid(message: string): never {
  throw new WorkflowError("VALIDATION", message);
}
export async function recordAccount(db: PrismaClient, c: WorkflowContext, raw: unknown) {
  const input = accountSchema.parse(raw);
  return runWorkflow(db, c, input, "ACCOUNT_SAVE", input.date, async (tx) => {
    const account = input.id
      ? await tx.moneyAccount.findFirst({ where: { id: input.id, ...scope(c) } })
      : null;
    if (account?.accountKind === "OWNER_CLEARING")
      invalid("内部の立替台帳は口座設定から変更できません。");
    if (input.id && (!account || account.revision !== input.revision))
      throw new WorkflowError("CONFLICT", "口座が更新されました。再確認してください。");
    if (!account && input.accountKind === "CREDIT_CARD" && BigInt(input.balance) < 0n)
      invalid("開始時の未払額は0円以上で入力してください。");
    const result = account
      ? await tx.moneyAccount.update({
          where: { id: account.id },
          data: {
            name: input.name,
            active: input.active,
            ...(input.accountKind ? { accountKind: input.accountKind } : {}),
          },
        })
      : await tx.moneyAccount.create({
          data: {
            ...scope(c),
            name: input.name,
            openingDate: new Date(`${input.date}T00:00:00Z`),
            accountKind: input.accountKind ?? "STANDARD",
            openingBalanceJpy:
              input.accountKind === "CREDIT_CARD" ? -BigInt(input.balance) : BigInt(input.balance),
          },
        });
    return {
      id: result.id,
      detail: {
        name: result.name,
        accountKind: result.accountKind,
        previousKind: account?.accountKind ?? null,
      },
    };
  });
}
export type SettlementKind = Exclude<
  z.infer<typeof moneySchema>["kind"],
  | "TRANSFER"
  | "REVERSAL"
  | "OWNER_CONTRIBUTION"
  | "OWNER_DRAWING"
  | "OWNER_REIMBURSEMENT"
  | "OWNER_REPAYMENT"
>;
export const incomingSettlementKinds = new Set<SettlementKind>([
  "PURCHASE_REFUND",
  "SUPPLIER_RETURN_REFUND",
  "SALE_RECEIPT",
  "SALE_FEE_REFUND",
  "SALE_SHIPPING_REFUND",
  "OTHER_RECEIPT",
  "PURCHASE_CREDIT_REFUND",
  "DELIVERY_CREDIT_REFUND",
]);
async function postedAmount(tx: Tx, c: WorkflowContext, kind: SettlementKind, id: string) {
  const sum = await tx.moneyTransaction.aggregate({
    where: { ...scope(c), kind, sourceId: id, reversedBy: null },
    _sum: { amountJpy: true },
  });
  return sum._sum.amountJpy ?? 0n;
}
export async function settlementSource(
  tx: Tx,
  c: WorkflowContext,
  kind: SettlementKind,
  id: string,
): Promise<{
  amount: bigint | null;
  date: Date;
  revision: number;
  name: string;
  sourceIds: string[];
  incoming: boolean;
  receivingAccountId: string | null;
  href: string;
}> {
  let amount: bigint | null = null,
    date: Date | null = null,
    revision = 0,
    name = "";
  const sourceIds = [id];
  let receivingAccountId: string | null = null;
  let href = "";
  if (kind === "PURCHASE_PAYMENT") {
    const p = await tx.purchaseDocument.findFirst({
      where: { id, ...scope(c), status: { not: "CANCELLED" } },
      include: { charges: { where: { supersededBy: null } } },
    });
    if (p) {
      amount = p.charges.some((ch) => ch.amountJpy === null)
        ? null
        : p.totalJpy -
          p.charges.filter((ch) => ch.refund).reduce((s, ch) => s + (ch.amountJpy ?? 0n), 0n);
      date = p.purchasedDate;
      revision = p.revision;
      name = p.code;
      href = `/purchases/${p.id}`;
      if (amount !== null) amount += await postedAmount(tx, c, "PURCHASE_CREDIT_REFUND", id);
    }
  } else if (kind === "DELIVERY_PAYMENT") {
    const d = await tx.inboundDelivery.findFirst({
      where: { id, ...scope(c) },
      include: { charges: { where: { supersededBy: null } } },
    });
    if (d) {
      amount = d.charges.some((ch) => ch.amountJpy === null)
        ? null
        : d.charges.filter((ch) => !ch.refund).reduce((s, ch) => s + (ch.amountJpy ?? 0n), 0n);
      date = d.shippedDate;
      revision = d.revision;
      name = d.code;
      href = `/purchases/deliveries/${d.id}`;
      if (amount !== null) amount += await postedAmount(tx, c, "DELIVERY_CREDIT_REFUND", id);
    }
  } else if (kind === "PURCHASE_REFUND") {
    const ch = await tx.purchaseCharge.findFirst({
      where: {
        id,
        refund: true,
        supersededBy: null,
        OR: [{ document: scope(c) }, { delivery: scope(c) }],
      },
      include: { document: true, delivery: true },
    });
    if (ch) {
      amount = ch.amountJpy === null || (!ch.recordedDate && ch.reason) ? null : -ch.amountJpy;
      date = ch.recordedDate ?? ch.document?.purchasedDate ?? ch.delivery!.shippedDate;
      revision = ch.document?.revision ?? ch.delivery!.revision;
      name = ch.name;
      href = ch.documentId
        ? `/purchases/${ch.documentId}`
        : `/purchases/deliveries/${ch.deliveryId}`;
      let previous = ch.supersedesId;
      while (previous) {
        const ancestor = await tx.purchaseCharge.findFirst({
          where: {
            id: previous,
            refund: true,
            OR: [{ document: scope(c) }, { delivery: scope(c) }],
          },
          select: { id: true, supersedesId: true },
        });
        if (!ancestor || sourceIds.includes(ancestor.id) || sourceIds.length > 1000)
          invalid("返金の訂正履歴を確認してください。");
        sourceIds.push(ancestor.id);
        previous = ancestor.supersedesId;
      }
    }
  } else if (kind === "SUPPLIER_RETURN_REFUND") {
    const r = await tx.supplierReturn.findFirst({
      where: { id, receiptLine: { receipt: scope(c) } },
      include: { receiptLine: { include: { line: { include: { document: true } } } } },
    });
    if (r) {
      amount = r.refundJpy;
      const operation = await tx.inventoryOperation.findFirst({
        where: { id: r.operationId, workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
      });
      date = operation
        ? new Date(
            `${(await effectiveOperationDates(tx, [operation])).get(operation.id)!}T00:00:00Z`,
          )
        : r.returnedDate;
      revision = r.receiptLine.line.document.revision;
      name = r.receiptLine.line.name;
      href = `/purchases/${r.receiptLine.line.documentId}`;
    }
  } else if (
    [
      "SALE_RECEIPT",
      "SALE_SETTLEMENT_PAYMENT",
      "FEE_PAYMENT",
      "SHIPPING_PAYMENT",
      "SALE_CREDIT_REFUND",
    ].includes(kind)
  ) {
    const sale = await tx.salesOrder.findFirst({
      where: { id, ...scope(c), status: { in: ["COMPLETED", "RETURNED"] } },
    });
    if (sale?.completedAt) {
      const rule = sale.settlementSnapshot as {
        feeDeducted: boolean;
        shippingDeducted: boolean;
        receivingAccountId?: string | null;
      } | null;
      date = new Date(
        `${(await effectiveSourceDates(tx, c, "sales_order", [{ id: sale.id, date: sale.completedAt }])).get(sale.id)!}T00:00:00Z`,
      );
      revision = sale.revision;
      name = "販売";
      href = `/sales/orders/${sale.id}`;
      if (rule) {
        receivingAccountId = rule.receivingAccountId || null;
        const net =
          (rule.feeDeducted && sale.feeJpy === null) ||
          (rule.shippingDeducted && sale.shippingJpy === null)
            ? null
            : sale.grossSalesJpy -
              sale.discountJpy -
              (rule.feeDeducted ? (sale.feeJpy ?? 0n) : 0n) -
              (rule.shippingDeducted ? (sale.shippingJpy ?? 0n) : 0n);
        if (kind === "FEE_PAYMENT") amount = rule.feeDeducted ? 0n : sale.feeJpy;
        else if (kind === "SHIPPING_PAYMENT")
          amount = rule.shippingDeducted ? 0n : sale.shippingJpy;
        else if (net !== null) {
          const receivable = net < 0n ? 0n : net;
          if (kind === "SALE_SETTLEMENT_PAYMENT") amount = net < 0n ? -net : 0n;
          else if (kind === "SALE_CREDIT_REFUND") {
            const paid = await postedAmount(tx, c, "SALE_RECEIPT", id);
            amount = paid > receivable ? paid - receivable : 0n;
          } else amount = receivable + (await postedAmount(tx, c, "SALE_CREDIT_REFUND", id));
        }
      }
    }
  } else if (["SALE_REFUND", "SALE_FEE_REFUND", "SALE_SHIPPING_REFUND"].includes(kind)) {
    const r = await tx.salesReturn.findFirst({
      where: { id, salesOrder: scope(c) },
      include: { salesOrder: true },
    });
    if (r) {
      date = new Date(
        `${(await effectiveSourceDates(tx, c, "sales_return", [{ id: r.id, date: r.returnedAt }])).get(r.id)!}T00:00:00Z`,
      );
      amount =
        kind === "SALE_REFUND"
          ? r.salesRefundJpy
          : kind === "SALE_FEE_REFUND"
            ? r.feeRefundJpy
            : r.shippingRefundJpy;
      revision = r.salesOrder.revision;
      name = "販売の返品・返金";
      href = `/sales/orders/${r.salesOrderId}`;
    }
  } else if (kind === "OTHER_PAYMENT" || kind === "OTHER_RECEIPT") {
    const other = await tx.otherRecord.findFirst({
      where: { id, ...scope(c) },
      include: { reversedBy: true, reverses: true },
    });
    if (other) {
      const incoming = (other.kind === "INCOME") !== other.amountJpy < 0n;
      if (incoming !== (kind === "OTHER_RECEIPT")) invalid("収支の入出金方向を確認してください。");
      amount = other.amountJpy < 0n ? -other.amountJpy : other.amountJpy;
      if (other.reversedBy) amount = 0n;
      if (other.reverses) {
        const paid = await postedAmount(
          tx,
          c,
          other.kind === "EXPENSE" ? "OTHER_PAYMENT" : "OTHER_RECEIPT",
          other.reverses.id,
        );
        if (amount > paid) amount = paid;
      }
      date = other.date;
      revision = other.reversedBy ? 1 : 0;
      name = other.categoryName;
      href = `/money/records/${other.id}`;
    }
  } else if (kind === "PURCHASE_CREDIT_REFUND" || kind === "DELIVERY_CREDIT_REFUND") {
    const paymentKind = kind === "PURCHASE_CREDIT_REFUND" ? "PURCHASE_PAYMENT" : "DELIVERY_PAYMENT";
    const original = await settlementSource(tx, c, paymentKind, id),
      refunded = await postedAmount(tx, c, kind, id),
      paid = await postedAmount(tx, c, paymentKind, id);
    amount = original.amount === null ? null : paid - (original.amount - refunded);
    if (amount !== null && amount < 0n) amount = 0n;
    date = original.date;
    revision = original.revision;
    name = original.name;
    href = original.href;
  }
  if (!date) invalid("決済する取引を確認してください。");
  return {
    amount,
    date,
    revision,
    name,
    sourceIds,
    incoming: incomingSettlementKinds.has(kind),
    receivingAccountId,
    href,
  };
}
export async function recordMoney(db: PrismaClient, c: WorkflowContext, raw: unknown) {
  const input = moneySchema.parse(raw);
  return runWorkflow(db, c, input, "MONEY_RECORD", input.date, (tx) => executeMoney(tx, c, input));
}
export async function executeMoney(tx: Tx, c: WorkflowContext, input: z.infer<typeof moneySchema>) {
  const date = new Date(`${input.date}T00:00:00Z`),
    amount = BigInt(input.amount),
    fee = BigInt(input.fee || "0");
  if (input.kind === "REVERSAL") {
    if (!input.reversesId) invalid("取消対象の入出金を指定してください。");
    const original = await tx.moneyTransaction.findFirst({
      where: { id: input.reversesId, ...scope(c), reversedBy: null, reversesId: null },
      include: { entries: { include: { account: true } } },
    });
    if (!original || !input.memo.trim()) invalid("取消対象と理由を確認してください。");
    if (date < original.date) invalid("取消日は元の記録日以降にしてください。");
    if (
      await tx.ownerSettlementAllocation.count({
        where: { sourceTransactionId: original.id, settlement: { reversedBy: null } },
      })
    )
      invalid("この立替には精算・返金の充当があります。関連する精算を先に取り消してください。");
    const r = await tx.moneyTransaction.create({
      data: {
        ...scope(c),
        date,
        kind: "REVERSAL",
        amountJpy: original.amountJpy,
        feeJpy: original.feeJpy,
        reversesId: original.id,
        requestId: input.idempotencyKey,
        memo: input.memo,
        entries: {
          create: original.entries.map((e) => ({
            accountId: e.accountId,
            amountJpy: -e.amountJpy,
            purpose: e.purpose,
          })),
        },
      },
    });
    return { id: r.id, detail: { reversesId: original.id } };
  }
  const ownerSettlement = input.kind === "OWNER_REIMBURSEMENT" || input.kind === "OWNER_REPAYMENT";
  const personal = input.paymentMethod === "PERSONAL";
  if (
    personal &&
    [
      "TRANSFER",
      "OWNER_CONTRIBUTION",
      "OWNER_DRAWING",
      "OWNER_REIMBURSEMENT",
      "OWNER_REPAYMENT",
    ].includes(input.kind)
  )
    invalid("この資金移動では通常の口座を指定してください。");
  const account = personal
    ? await ensureOwnerAccount(tx, scope(c), input.date)
    : await tx.moneyAccount.findFirst({
        where: {
          id: input.accountId,
          ...scope(c),
          active: true,
          accountKind: { not: "OWNER_CLEARING" },
        },
      });
  if (
    !account ||
    (!personal && (account.openingDate > date || account.revision !== input.accountRevision))
  )
    throw new WorkflowError("CONFLICT", "口座の残高・開始日を再確認してください。");
  if (amount <= 0n) invalid("金額は1円以上を入力してください。");
  if (input.kind === "OWNER_DRAWING" && input.fee === "")
    invalid("振込手数料を入力してください。手数料なしは0円にしてください。");
  const entries: { accountId: string; amountJpy: bigint; purpose: string }[] = [];
  let snapshot: object | undefined;
  let ownerAllocations: { sourceTransactionId: string; amountJpy: string | bigint }[] = [];
  if (ownerSettlement) {
    if (account.accountKind !== "STANDARD") invalid("精算には通常口座を選択してください。");
    if (input.fee === "" || (input.kind === "OWNER_REPAYMENT" && fee !== 0n))
      invalid("精算手数料を確認してください。本人からの返金は手数料0円で記録します。");
    const plan = await ownerPlan(tx, scope(c), input);
    if (plan.fingerprint !== input.ownerFingerprint)
      throw new WorkflowError(
        "CONFLICT",
        "立替の精算内容が変わりました。充当内訳を再確認してください。",
      );
    const incoming = input.kind === "OWNER_REPAYMENT";
    entries.push(
      { accountId: account.id, amountJpy: incoming ? amount : -amount, purpose: "PRINCIPAL" },
      { accountId: plan.accountId!, amountJpy: incoming ? -amount : amount, purpose: "PRINCIPAL" },
    );
    if (fee) entries.push({ accountId: account.id, amountJpy: -fee, purpose: "FEE" });
    ownerAllocations = plan.allocations;
    snapshot = { ownerFingerprint: plan.fingerprint, allocations: plan.allocations };
  } else if (input.kind === "TRANSFER") {
    if (input.fee === "") invalid("振込手数料を入力してください。手数料なしは0円にしてください。");
    const to = await tx.moneyAccount.findFirst({
      where: {
        id: input.toAccountId,
        ...scope(c),
        active: true,
        accountKind: { not: "OWNER_CLEARING" },
      },
    });
    if (
      !to ||
      to.id === account.id ||
      to.openingDate > date ||
      to.revision !== input.toAccountRevision
    )
      invalid("振替先の口座・開始日を再確認してください。");
    entries.push(
      { accountId: account.id, amountJpy: -amount, purpose: "PRINCIPAL" },
      { accountId: to.id, amountJpy: amount, purpose: "PRINCIPAL" },
    );
    if (fee) entries.push({ accountId: account.id, amountJpy: -fee, purpose: "FEE" });
  } else if (input.kind === "OWNER_CONTRIBUTION" || input.kind === "OWNER_DRAWING") {
    if (input.kind === "OWNER_CONTRIBUTION" && fee !== 0n)
      invalid("入金時の手数料は別の費用として記録してください。");
    entries.push({
      accountId: account.id,
      amountJpy: input.kind === "OWNER_CONTRIBUTION" ? amount : -amount,
      purpose: "PRINCIPAL",
    });
    if (fee) entries.push({ accountId: account.id, amountJpy: -fee, purpose: "FEE" });
    snapshot = { purpose: input.kind, reportingEntityId: c.reportingEntityId };
  } else {
    if (!input.sourceId) invalid("決済する取引を選んでください。");
    const settlementKind = input.kind as SettlementKind;
    const source = await settlementSource(tx, c, settlementKind, input.sourceId);
    if (source.revision !== input.sourceRevision || date < source.date)
      throw new WorkflowError("CONFLICT", "取引金額・決済日を再確認してください。");
    if (source.amount === null) invalid("取引金額を確認してから決済を記録してください。");
    const settled = await tx.moneyTransaction.aggregate({
      where: {
        ...scope(c),
        sourceId: { in: source.sourceIds },
        kind: input.kind,
        reversedBy: null,
      },
      _sum: { amountJpy: true },
    });
    if (amount + (settled._sum.amountJpy ?? 0n) > source.amount)
      invalid("未決済の金額を超えています。前払い残高への入金は口座間振替で記録してください。");
    const incoming = incomingSettlementKinds.has(settlementKind);
    entries.push({
      accountId: account.id,
      amountJpy: incoming ? amount : -amount,
      purpose: "PRINCIPAL",
    });
    let group = source.href;
    if (input.kind === "OTHER_RECEIPT" || input.kind === "OTHER_PAYMENT") {
      const other = await tx.otherRecord.findFirst({
        where: { id: input.sourceId, ...scope(c) },
        select: { reversesId: true },
      });
      if (other?.reversesId) group = `/money/records/${other.reversesId}`;
    }
    if (personal && incoming) {
      const data = await ownerData(tx, scope(c)),
        offset = ownerAllocate(ownerAvailable(data, input.date, false, group), amount);
      ownerAllocations = offset.allocations;
    }
    snapshot = {
      ownerGroup: group,
      ...source,
      amount: source.amount.toString(),
      date: source.date.toISOString().slice(0, 10),
    };
  }
  const result = await tx.moneyTransaction.create({
    data: {
      ...scope(c),
      date,
      kind: input.kind,
      amountJpy: amount,
      feeJpy:
        input.kind === "TRANSFER" || input.kind === "OWNER_DRAWING" || ownerSettlement ? fee : 0n,
      sourceId: input.sourceId || null,
      sourceSnapshot: snapshot ? toJson(snapshot) : undefined,
      memo: input.memo || null,
      requestId: input.idempotencyKey,
      entries: { create: entries },
    },
  });
  await appendOwnerAllocations(tx, result.id, ownerAllocations);
  return {
    id: result.id,
    detail: {
      kind: result.kind,
      amount: amount.toString(),
      personal,
      ownerAllocations: ownerAllocations.map((a) => ({ ...a, amountJpy: a.amountJpy.toString() })),
    },
  };
}
export async function accountBalances(
  tx: Pick<Tx, "moneyAccount" | "moneyEntry">,
  c: Pick<WorkflowContext, "workspaceId" | "businessUnitId" | "reportingEntityId">,
  asOf?: Date,
) {
  const accounts = await tx.moneyAccount.findMany({
    where: {
      ...scope(c as WorkflowContext),
      accountKind: { not: "OWNER_CLEARING" },
      ...(asOf ? { openingDate: { lte: asOf } } : {}),
    },
    orderBy: { createdAt: "asc" },
  });
  const sums = await tx.moneyEntry.groupBy({
    by: ["accountId"],
    where: {
      accountId: { in: accounts.map((a) => a.id) },
      ...(asOf ? { transaction: { date: { lte: asOf } } } : {}),
    },
    _sum: { amountJpy: true },
  });
  return accounts.map((a) => ({
    ...a,
    balance: a.openingBalanceJpy + (sums.find((s) => s.accountId === a.id)?._sum.amountJpy ?? 0n),
  }));
}
