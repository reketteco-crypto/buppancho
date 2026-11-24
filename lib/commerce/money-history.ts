import { Prisma } from "@/generated/prisma/client";
import { z } from "zod";
import { eventDate } from "@/lib/validation/workflow";
import type { WorkflowContext } from "@/lib/sales/workflow-context";
import { moneyLabels } from "./money-labels";
import {
  otherSettlementStatus,
  signedYen,
  transactionHistoryRow,
  yenText,
  type MoneyHistoryRow,
} from "./money-history-view";

type Scope = Pick<WorkflowContext, "workspaceId" | "businessUnitId" | "reportingEntityId">;
export type MoneyHistoryQuery = {
  tab?: string;
  from?: string;
  to?: string;
  account?: string;
  page?: string;
  cursor?: string;
  open?: string;
};
export const moneyHistoryPageSize = 50;
const scopeWhere = (c: Scope) => ({
  workspaceId: c.workspaceId,
  businessUnitId: c.businessUnitId,
  reportingEntityId: c.reportingEntityId,
});
const orderBy = [
  { date: "desc" as const },
  { createdAt: "desc" as const },
  { id: "desc" as const },
];
const absolute = (value: bigint) => (value < 0n ? -value : value);
const knownHref = (value: unknown) =>
  typeof value === "string" &&
  /^\/(?:purchases(?:\/deliveries)?|sales\/orders|money\/records)\/[a-f0-9-]{36}$/.test(value)
    ? value
    : "";
function snapshot(value: Prisma.JsonValue | null) {
  const object = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return { name: typeof object.name === "string" ? object.name : "", href: knownHref(object.href) };
}

export function moneyHistoryHref(
  query: MoneyHistoryQuery,
  changes: Partial<MoneyHistoryQuery> = {},
) {
  const value = { ...query, ...changes },
    params = new URLSearchParams();
  for (const key of ["tab", "from", "to", "account", "page", "open"] as const)
    if (value[key]) params.set(key, value[key]);
  return `/money${params.size ? `?${params}` : ""}`;
}

async function cursorPage(tx: Prisma.TransactionClient, c: Scope, query: MoneyHistoryQuery) {
  if (query.page || !z.uuid().safeParse(query.cursor).success) return 1;
  const table = Prisma.raw(query.tab === "records" ? "other_record" : "money_transaction");
  const accountFilter =
    query.tab !== "records" && query.account
      ? Prisma.sql`AND EXISTS (SELECT 1 FROM money_entry e WHERE e.transaction_id=t.id AND e.account_id=${query.account}::uuid)`
      : Prisma.empty;
  const rows = await tx.$queryRaw<{ rank: bigint }[]>(Prisma.sql`
    WITH matches AS (
      SELECT t.id,row_number() OVER (ORDER BY t.date DESC,t.created_at DESC,t.id DESC) AS rank
      FROM ${table} t WHERE t.workspace_id=${c.workspaceId}::uuid AND t.business_unit_id=${c.businessUnitId}::uuid
      AND t.reporting_entity_id=${c.reportingEntityId}::uuid AND t.date BETWEEN ${query.from}::date AND ${query.to}::date ${accountFilter}
    ) SELECT rank FROM matches WHERE id=${query.cursor}::uuid`);
  return rows[0] ? Math.floor(Number(rows[0].rank) / moneyHistoryPageSize) + 1 : 1;
}

async function relatedNames(tx: Prisma.TransactionClient, c: Scope, hrefs: string[]) {
  const ids = (prefix: string) =>
    [
      ...new Set(
        hrefs.filter((href) => href.startsWith(prefix)).map((href) => href.slice(prefix.length)),
      ),
    ].filter((id) => z.uuid().safeParse(id).success);
  const [purchases, sales, deliveries] = await Promise.all([
    tx.purchaseDocument.findMany({
      where: { ...scopeWhere(c), id: { in: ids("/purchases/") } },
      select: { id: true, code: true, supplierName: true },
    }),
    tx.salesOrder.findMany({
      where: { ...scopeWhere(c), id: { in: ids("/sales/orders/") } },
      select: {
        id: true,
        externalOrderId: true,
        lines: { select: { displayName: true }, orderBy: { id: "asc" } },
      },
    }),
    tx.inboundDelivery.findMany({
      where: { ...scopeWhere(c), id: { in: ids("/purchases/deliveries/") } },
      select: { id: true, code: true, methodName: true },
    }),
  ]);
  const names = new Map<string, { title: string; reference: string }>();
  for (const p of purchases)
    names.set(`/purchases/${p.id}`, { title: p.supplierName, reference: p.code });
  for (const s of sales) {
    const lines = s.lines.flatMap((line) => (line.displayName ? [line.displayName] : []));
    names.set(`/sales/orders/${s.id}`, {
      title: lines.slice(0, 2).join("・") + (lines.length > 2 ? ` ほか${lines.length - 2}件` : ""),
      reference: s.externalOrderId ?? "",
    });
  }
  for (const d of deliveries)
    names.set(`/purchases/deliveries/${d.id}`, { title: d.methodName ?? "", reference: d.code });
  return names;
}

export async function loadMoneyHistory(
  tx: Prisma.TransactionClient,
  c: Scope,
  raw: MoneyHistoryQuery,
  year: number,
) {
  const tab = raw.tab === "records" ? "records" : "entries";
  const query: MoneyHistoryQuery = {
    tab,
    from: raw.from ?? `${year}-01-01`,
    to: raw.to ?? `${year}-12-31`,
    account: raw.account ?? "",
    page: raw.page,
    cursor: raw.cursor,
  };
  let error = "";
  if (!eventDate.safeParse(query.from).success || !eventDate.safeParse(query.to).success)
    error = "開始日と終了日を正しい日付で指定してください。";
  else if (query.from! > query.to!) error = "終了日は開始日以降を指定してください。";
  const accounts = await tx.moneyAccount.findMany({
    where: { ...scopeWhere(c), accountKind: { not: "OWNER_CLEARING" } },
    select: { id: true, name: true, active: true, accountKind: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  if (tab === "entries" && query.account && !accounts.some((a) => a.id === query.account))
    error = "選択した口座を確認し、選び直してください。";
  if (error)
    return {
      query: { ...query, page: "1" },
      tab,
      accounts,
      error,
      rows: [] as MoneyHistoryRow[],
      total: 0,
      page: 1,
      pages: 1,
      open: "",
    };
  const where = {
    ...scopeWhere(c),
    date: { gte: new Date(`${query.from}T00:00:00Z`), lte: new Date(`${query.to}T00:00:00Z`) },
  };
  const entryWhere = {
    ...where,
    ...(query.account ? { entries: { some: { accountId: query.account } } } : {}),
  };
  const total =
    tab === "records"
      ? await tx.otherRecord.count({ where })
      : await tx.moneyTransaction.count({ where: entryWhere });
  const pages = Math.max(1, Math.ceil(total / moneyHistoryPageSize));
  const requested = /^[1-9]\d{0,6}$/.test(query.page ?? "")
    ? Number(query.page)
    : await cursorPage(tx, c, query);
  const page = Math.min(pages, Math.max(1, requested)),
    skip = (page - 1) * moneyHistoryPageSize;
  let rows: MoneyHistoryRow[];
  if (tab === "entries") {
    const transactions = await tx.moneyTransaction.findMany({
      where: entryWhere,
      include: {
        entries: { include: { account: true }, orderBy: { id: "asc" } },
        reverses: true,
        reversedBy: true,
      },
      orderBy,
      take: moneyHistoryPageSize,
      skip,
    });
    const snapshots = transactions.map((t) => snapshot((t.reverses ?? t).sourceSnapshot));
    const names = await relatedNames(
      tx,
      c,
      snapshots.map((s) => s.href),
    );
    rows = transactions.map((t, index) => {
      const source = snapshots[index]!,
        kind = t.reverses?.kind ?? t.kind,
        related = names.get(source.href);
      const useRelated =
        [
          "PURCHASE_PAYMENT",
          "PURCHASE_CREDIT_REFUND",
          "DELIVERY_PAYMENT",
          "DELIVERY_CREDIT_REFUND",
        ].includes(kind) ||
        kind.startsWith("SALE_") ||
        kind === "FEE_PAYMENT" ||
        kind === "SHIPPING_PAYMENT";
      return transactionHistoryRow(
        t,
        {
          title:
            (useRelated ? related?.title : source.name) ||
            source.name ||
            moneyLabels[kind] ||
            "入出金",
          reference: related?.reference ?? "",
          href: source.href,
        },
        query.account || undefined,
      );
    });
  } else {
    const records = await tx.otherRecord.findMany({
      where,
      include: { reversedBy: true, reverses: true },
      orderBy,
      take: moneyHistoryPageSize,
      skip,
    });
    const sourceIds = [
      ...new Set(records.flatMap((r) => [r.id, ...(r.reversesId ? [r.reversesId] : [])])),
    ];
    const payments = await tx.moneyTransaction.groupBy({
      by: ["sourceId", "kind"],
      where: {
        ...scopeWhere(c),
        kind: { in: ["OTHER_RECEIPT", "OTHER_PAYMENT"] },
        sourceId: { in: sourceIds },
        reversedBy: null,
      },
      _sum: { amountJpy: true },
    });
    const paid = (id: string, kind: string) =>
      payments.find((p) => p.sourceId === id && p.kind === kind)?._sum.amountJpy ?? 0n;
    rows = records.map((r) => {
      const incoming = (r.kind === "INCOME") !== r.amountJpy < 0n,
        amount = absolute(r.amountJpy),
        settled = paid(r.id, incoming ? "OTHER_RECEIPT" : "OTHER_PAYMENT");
      let target = r.reversedBy ? 0n : amount;
      if (r.reverses) {
        const originalPaid = paid(
          r.reverses.id,
          r.kind === "EXPENSE" ? "OTHER_PAYMENT" : "OTHER_RECEIPT",
        );
        if (originalPaid < target) target = originalPaid;
      }
      const status = otherSettlementStatus(target, settled, !!r.reversedBy);
      return {
        id: r.id,
        type: "record" as const,
        date: r.date.toISOString().slice(0, 10),
        title: r.categoryName,
        kindLabel: `${r.kind === "EXPENSE" ? "費用" : "収入"}${r.reversesId ? "の取消" : ""}`,
        reference: r.counterparty ?? "",
        flow: `${incoming ? "入金" : "支払"} · ${status}`,
        amount: signedYen(incoming ? amount : -amount),
        amountLabel: "",
        feeLabel: "",
        status,
        memo: r.memo ?? "",
        relatedHref: `/money/records/${r.id}`,
        principal: amount.toString(),
        fee: "0",
        canCancel: false,
        entries: [
          {
            id: "target",
            name: incoming ? "入金対象額" : "支払対象額",
            amount: yenText(target),
            label: "",
          },
          { id: "paid", name: "決済済み", amount: yenText(settled), label: "" },
          { id: "remaining", name: "差額", amount: signedYen(target - settled), label: "" },
        ],
      };
    });
  }
  return {
    query: { ...query, page: String(page) },
    tab,
    accounts,
    error,
    rows,
    total,
    page,
    pages,
    open: rows.some((r) => r.id === raw.open) ? raw.open! : "",
  };
}
