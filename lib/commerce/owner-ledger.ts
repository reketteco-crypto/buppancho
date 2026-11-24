import type { Prisma } from "@/generated/prisma/client";
import type { WorkflowContext } from "@/lib/sales/workflow-context";
import { WorkflowError } from "@/lib/sales/workflow-errors";
import { fingerprint } from "@/lib/sales/request-store";
export type OwnerScope = Pick<
  WorkflowContext,
  "workspaceId" | "businessUnitId" | "reportingEntityId"
>;
type Tx = Prisma.TransactionClient;
const ownerScope = (c: OwnerScope) => ({
  workspaceId: c.workspaceId,
  businessUnitId: c.businessUnitId,
  reportingEntityId: c.reportingEntityId,
});
const day = (d: Date) => d.toISOString().slice(0, 10);
export async function ownerData(tx: Tx, c: OwnerScope) {
  const account = await tx.moneyAccount.findFirst({
    where: { ...ownerScope(c), accountKind: "OWNER_CLEARING" },
  });
  const [entries, allocations] = account
    ? await Promise.all([
        tx.moneyEntry.findMany({
          where: { accountId: account.id, purpose: "PRINCIPAL" },
          include: { transaction: { include: { reversedBy: { select: { date: true } } } } },
          orderBy: [
            { transaction: { date: "asc" } },
            { transaction: { createdAt: "asc" } },
            { transaction: { id: "asc" } },
          ],
        }),
        tx.ownerSettlementAllocation.findMany({
          where: { settlement: ownerScope(c) },
          select: { settlementId: true, sourceTransactionId: true, amountJpy: true },
        }),
      ])
    : [[], []];
  return { account, entries, allocations };
}
export type OwnerData = Awaited<ReturnType<typeof ownerData>>;
export function ownerLedger(data: OwnerData, date: string) {
  const active = data.entries.filter(
      (e) =>
        e.transaction.reversesId === null &&
        day(e.transaction.date) <= date &&
        (!e.transaction.reversedBy || day(e.transaction.reversedBy.date) > date),
    ),
    activeIds = new Set(active.map((e) => e.transactionId));
  const allocations = data.allocations.filter((a) => activeIds.has(a.settlementId));
  const rows = active
    .map((e) => {
      const used = allocations
          .filter(
            (a) => a.sourceTransactionId === e.transactionId || a.settlementId === e.transactionId,
          )
          .reduce((s, a) => s + a.amountJpy, 0n),
        amount = (e.amountJpy < 0n ? -e.amountJpy : e.amountJpy) - used,
        snapshot = e.transaction.sourceSnapshot as {
          name?: string;
          href?: string;
          ownerGroup?: string;
        } | null;
      return {
        id: e.transactionId,
        amount,
        date: day(e.transaction.date),
        name: snapshot?.name ?? "本人立替",
        href: snapshot?.href ?? "",
        group: snapshot?.ownerGroup ?? snapshot?.href ?? "",
        incoming: e.amountJpy > 0n,
      };
    })
    .filter((r) => r.amount > 0n);
  const debts = rows.filter((r) => !r.incoming),
    credits = rows.filter((r) => r.incoming);
  return {
    debts,
    credits,
    unpaid: debts.reduce((s, r) => s + r.amount, 0n),
    receivable: credits.reduce((s, r) => s + r.amount, 0n),
  };
}
/** Future saved allocations remain reserved; retroactive records never move them. */
export function ownerAvailable(data: OwnerData, date: string, incoming: boolean, group?: string) {
  const ledger = ownerLedger(data, date),
    rows = (incoming ? ledger.credits : ledger.debts).filter(
      (r) => group === undefined || r.group === group,
    ),
    dates = new Set([
      date,
      "9999-12-31",
      ...data.entries
        .flatMap((e) => [
          day(e.transaction.date),
          ...(e.transaction.reversedBy ? [day(e.transaction.reversedBy.date)] : []),
        ])
        .filter((d) => d > date),
    ]);
  const available = new Map(rows.map((r) => [r.id, r.amount]));
  for (const at of dates) {
    const later = ownerLedger(data, at),
      values = new Map((incoming ? later.credits : later.debts).map((r) => [r.id, r.amount]));
    for (const [id, amount] of available)
      if ((values.get(id) ?? 0n) < amount) available.set(id, values.get(id) ?? 0n);
  }
  return rows
    .map((r) => ({ ...r, amount: available.get(r.id) ?? 0n }))
    .filter((r) => r.amount > 0n);
}
export function ownerAllocate(
  rows: { id: string; amount: bigint; name: string; date: string }[],
  amount: bigint,
) {
  let rest = amount;
  const result: { sourceTransactionId: string; amountJpy: bigint; name: string; date: string }[] =
    [];
  for (const row of rows) {
    const value = rest < row.amount ? rest : row.amount;
    if (value > 0n) {
      result.push({
        sourceTransactionId: row.id,
        amountJpy: value,
        name: row.name,
        date: row.date,
      });
      rest -= value;
    }
    if (!rest) break;
  }
  return { allocations: result, remaining: rest };
}
export async function ownerPlan(
  tx: Tx,
  c: OwnerScope,
  input: { kind: string; date: string; amount: string; accountId: string; accountRevision: number },
) {
  const data = await ownerData(tx, c),
    rows = ownerAvailable(data, input.date, input.kind === "OWNER_REPAYMENT"),
    result = ownerAllocate(rows, BigInt(input.amount || "0"));
  if (BigInt(input.amount || "0") <= 0n)
    throw new WorkflowError("VALIDATION", "精算する金額を入力してください。");
  if (result.remaining > 0n)
    throw new WorkflowError(
      "VALIDATION",
      "処理日時点の未精算額を超えています。後日の精算記録も確認してください。",
    );
  const allocations = result.allocations.map((a) => ({ ...a, amountJpy: a.amountJpy.toString() })),
    quote = fingerprint({
      kind: input.kind,
      date: input.date,
      amount: input.amount,
      accountId: input.accountId,
      accountRevision: input.accountRevision,
      ownerRevision: data.account?.revision ?? 0,
      allocations,
    });
  return { accountId: data.account?.id, allocations, fingerprint: quote };
}
export async function ensureOwnerAccount(tx: Tx, c: OwnerScope, date: string) {
  return (
    (await tx.moneyAccount.findFirst({
      where: { ...ownerScope(c), accountKind: "OWNER_CLEARING" },
    })) ??
    tx.moneyAccount.create({
      data: {
        ...ownerScope(c),
        name: "本人立替",
        accountKind: "OWNER_CLEARING",
        openingDate: new Date(date),
        openingBalanceJpy: 0n,
      },
    })
  );
}
export async function appendOwnerAllocations(
  tx: Tx,
  id: string,
  allocations: { sourceTransactionId: string; amountJpy: string | bigint }[],
) {
  if (allocations.length)
    await tx.ownerSettlementAllocation.createMany({
      data: allocations.map((a) => ({
        settlementId: id,
        sourceTransactionId: a.sourceTransactionId,
        amountJpy: BigInt(a.amountJpy),
      })),
    });
}
