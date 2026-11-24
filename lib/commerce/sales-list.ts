import { Prisma } from "@/generated/prisma/client";
import { transactionScope, type TransactionScope } from "./scope";

export type SalesListQuery = { q?: string; month?: string; page?: string };
export const salesPageSize = 50;
export const salesListScope = (c: TransactionScope & { operatorId: string }, year: number) =>
  `${c.workspaceId}:${c.operatorId}:${c.businessUnitId}:${c.reportingEntityId}:${year}:sales`;

export function salesListHref(query: SalesListQuery, page = 1) {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.month) params.set("month", query.month);
  if (page > 1) params.set("page", String(page));
  return `/sales${params.size ? `?${params}` : ""}`;
}

/** Resolve the immutable source date and latest correction before filtering or limiting. */
function matchingSales(c: TransactionScope, year: number, month: string, q = "") {
  const start = `${year}-${month || "01"}-01`;
  const end = month
    ? new Date(Date.UTC(year, Number(month), 0)).toISOString().slice(0, 10)
    : `${year}-12-31`;
  return Prisma.sql`WITH dated AS (
    SELECT s.id, s.created_at, s.gross_sales_jpy, s.discount_jpy, s.fee_jpy, s.shipping_jpy, s.cost_status,
      coalesce((SELECT d.effective_date
        FROM inventory_operation op JOIN event_date_correction d ON d.operation_id=op.id
        WHERE op.workspace_id=s.workspace_id AND op.business_unit_id=s.business_unit_id
          AND d.workspace_id=s.workspace_id AND d.business_unit_id=s.business_unit_id
          AND op.source_type='sales_order' AND op.source_id=s.id AND op.operation_type='sale_completion'
        ORDER BY d.created_at DESC,d.id DESC LIMIT 1),
        (s.completed_at AT TIME ZONE 'Asia/Tokyo')::date) AS effective_date
    FROM sales_order s
    WHERE s.workspace_id=${c.workspaceId}::uuid AND s.business_unit_id=${c.businessUnitId}::uuid
      AND s.reporting_entity_id=${c.reportingEntityId}::uuid AND s.completed_at IS NOT NULL
      AND (strpos(lower(coalesce(s.external_order_id,'')),lower(${q}))>0
        OR strpos(lower(coalesce(s.buyer_name,'')),lower(${q}))>0
        OR EXISTS (SELECT 1 FROM sales_order_line l WHERE l.sales_order_id=s.id
          AND strpos(lower(coalesce(l.display_name,'')),lower(${q}))>0))
  ), matches AS (SELECT * FROM dated WHERE effective_date BETWEEN ${start}::date AND ${end}::date)`;
}

export async function loadSalesList(
  tx: Prisma.TransactionClient,
  c: TransactionScope,
  query: SalesListQuery,
  year: number,
) {
  const q = (query.q ?? "").trim().slice(0, 100);
  const month = /^(0[1-9]|1[0-2])$/.test(query.month ?? "") ? query.month! : "";
  const from = matchingSales(c, year, month, q);
  const counts = await tx.$queryRaw<{ total: bigint }[]>(
    Prisma.sql`${from} SELECT count(*) AS total FROM matches`,
  );
  const total = Number(counts[0]!.total);
  const pages = Math.max(1, Math.ceil(total / salesPageSize));
  const requested = /^\d{1,8}$/.test(query.page ?? "") ? Number(query.page) : 1;
  const page = Math.min(pages, Math.max(1, requested));
  const selected = await tx.$queryRaw<{ id: string; date: string }[]>(Prisma.sql`${from}
    SELECT id,to_char(effective_date,'YYYY-MM-DD') AS date FROM matches
    ORDER BY effective_date DESC,created_at DESC,id DESC LIMIT ${salesPageSize} OFFSET ${(page - 1) * salesPageSize}`);
  const orders = selected.length
    ? await tx.salesOrder.findMany({
        where: { ...transactionScope(c), id: { in: selected.map((s) => s.id) } },
        include: { lines: { orderBy: { id: "asc" } }, salesChannel: true },
      })
    : [];
  const byId = new Map(orders.map((o) => [o.id, o]));
  const rows = selected.map((s) => ({ ...byId.get(s.id)!, date: s.date }));
  return { rows, total, page, pages, q, month };
}

export async function salesSummary(
  tx: Prisma.TransactionClient,
  c: TransactionScope,
  year: number,
  month: string,
) {
  const rows = await tx.$queryRaw<
    { count: bigint; revenue: bigint; unknown: bigint }[]
  >(Prisma.sql`${matchingSales(c, year, month)}
    SELECT count(*) AS count,
      coalesce(sum(gross_sales_jpy-discount_jpy-coalesce((SELECT sum(r.sales_refund_jpy) FROM sales_return r WHERE r.sales_order_id=matches.id),0)),0)::bigint AS revenue,
      count(*) FILTER (WHERE fee_jpy IS NULL OR shipping_jpy IS NULL OR cost_status='provisional') AS unknown
    FROM matches`);
  return {
    count: Number(rows[0]!.count),
    revenue: rows[0]!.revenue,
    unknown: Number(rows[0]!.unknown),
  };
}
