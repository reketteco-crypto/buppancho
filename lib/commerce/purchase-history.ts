import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { z } from "zod";
import { eventDate } from "@/lib/validation/workflow";
import type { WorkflowContext } from "@/lib/sales/workflow-context";
import { Precise } from "./allocation";
import type { PurchaseChoice, PurchaseMeasurements } from "./purchase-choice";

type Scope = Pick<WorkflowContext, "workspaceId" | "businessUnitId" | "reportingEntityId">;
type Reader = Pick<PrismaClient, "$queryRaw">;
export const purchaseChoicesSchema = z.object({
  date: eventDate,
  q: z.string().trim().max(120).default(""),
  tab: z.enum(["products", "history"]).default("products"),
  mode: z.enum(["QUANTITY", "UNIQUE"]).default("QUANTITY"),
  page: z.number().int().min(1).max(1000000).default(1),
});

export async function purchaseMeasurements(
  db: Reader,
  c: Scope,
  date: string,
  selection: { variantIds: string[] } | { lineIds: string[] },
) {
  const byVariant = "variantIds" in selection;
  const ids = byVariant ? selection.variantIds : selection.lineIds;
  const result = new Map<string, PurchaseMeasurements>();
  if (!ids.length) return result;
  const field = byVariant ? Prisma.sql`l.item_variant_id` : Prisma.sql`l.id`;
  const samples = await db.$queryRaw<
    {
      key: string;
      metric: "weight" | "volume";
      value: string;
      date: Date;
      code: string;
    }[]
  >(Prisma.sql`
    WITH lines AS (
      SELECT l.*, p.code, p.purchased_date, p.created_at AS recorded_at,
        ${field} AS key
      FROM purchase_document_line l JOIN purchase_document p ON p.id=l.document_id
      WHERE p.workspace_id=${c.workspaceId}::uuid AND p.business_unit_id=${c.businessUnitId}::uuid
        AND p.reporting_entity_id=${c.reportingEntityId}::uuid AND p.status<>'CANCELLED'
        AND p.purchased_date<=${date}::date
        AND ${field} IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
    ), samples AS (
      SELECT l.key, l.weight_g::text AS weight, l.volume_cm3::text AS volume,
        l.purchased_date AS date, l.recorded_at, l.id::text AS stable_id, l.code
      FROM lines l
      UNION ALL
      SELECT l.key, b.value->>'weight', b.value->>'volume',
        coalesce(ch.recorded_date,l.purchased_date), ch.created_at, ch.id::text || l.id::text, l.code
      FROM lines l JOIN purchase_charge ch ON (
        ch.document_id=l.document_id OR EXISTS (
          SELECT 1 FROM inbound_delivery d JOIN inbound_delivery_line dl ON dl.delivery_id=d.id
          WHERE d.id=ch.delivery_id AND dl.purchase_line_id=l.id
            AND d.workspace_id=${c.workspaceId}::uuid AND d.business_unit_id=${c.businessUnitId}::uuid
            AND d.reporting_entity_id=${c.reportingEntityId}::uuid
        )
      )
      CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(ch.basis_snapshot->'bases')='object'
        THEN ch.basis_snapshot->'bases' ELSE '{}'::jsonb END) b
      WHERE b.key=l.id::text AND coalesce(ch.recorded_date,l.purchased_date)<=${date}::date
        AND NOT EXISTS (SELECT 1 FROM purchase_charge next WHERE next.supersedes_id=ch.id)
    ), metrics AS (
      SELECT s.*, m.metric, m.value FROM samples s
      CROSS JOIN LATERAL (VALUES ('weight',s.weight),('volume',s.volume)) m(metric,value)
      WHERE CASE WHEN m.value ~ '^(0|[1-9][0-9]{0,14})([.][0-9]{1,8})?$'
        THEN m.value::numeric>0 ELSE false END
    )
    SELECT DISTINCT ON (key,metric) key,metric,value,date,code FROM metrics
    ORDER BY key,metric,date DESC,recorded_at DESC,stable_id DESC
  `);
  for (const row of samples) {
    const values = result.get(row.key) ?? {};
    values[row.metric] = {
      value: new Precise(row.value).toFixed(),
      date: row.date.toISOString().slice(0, 10),
      code: row.code,
    };
    result.set(row.key, values);
  }
  return result;
}

export async function purchaseLineBases(
  db: Reader,
  c: Scope,
  date: string,
  lines: { id: string; itemVariantId: string | null }[],
) {
  const own = await purchaseMeasurements(db, c, date, { lineIds: lines.map((l) => l.id) });
  const variants = [...new Set(lines.flatMap((l) => (l.itemVariantId ? [l.itemVariantId] : [])))];
  const history = await purchaseMeasurements(db, c, date, { variantIds: variants });
  return Object.fromEntries(
    lines.map((l) => {
      const current = own.get(l.id),
        previous = history.get(l.itemVariantId ?? "");
      return [
        l.id,
        {
          weight: current?.weight?.value ?? previous?.weight?.value ?? "",
          volume: current?.volume?.value ?? previous?.volume?.value ?? "",
          manual: "",
        },
      ];
    }),
  );
}

export async function purchaseChoices(db: Reader, c: Scope, raw: unknown) {
  const query = purchaseChoicesSchema.parse(raw),
    history = query.tab === "history";
  const mode = query.mode === "QUANTITY" ? "quantity" : "unique";
  const records = history
    ? Prisma.sql`
    JOIN purchase_document_line l ON l.item_variant_id=v.id
    JOIN purchase_document p ON p.id=l.document_id
  `
    : Prisma.empty;
  const columns = history
    ? Prisma.sql`
    l.id, l.name AS "historyName", l.source_name AS "sourceName", p.code AS "purchaseCode",
    p.purchased_date AS date, p.created_at, p.supplier_name AS supplier,
    l.quantity, l.amount::text AS amount, p.currency, l.price_basis AS "priceBasis",
  `
    : Prisma.sql`v.id,`;
  const from = Prisma.sql`
    FROM item_variant v JOIN inventory_item i ON i.id=v.inventory_item_id ${records}
    WHERE v.workspace_id=${c.workspaceId}::uuid AND i.workspace_id=${c.workspaceId}::uuid
      AND i.business_unit_id=${c.businessUnitId}::uuid AND v.active AND i.status='active'
      AND i.management_type::text=${mode}
      ${
        history
          ? Prisma.sql`AND p.workspace_id=${c.workspaceId}::uuid
        AND p.business_unit_id=${c.businessUnitId}::uuid AND p.reporting_entity_id=${c.reportingEntityId}::uuid
        AND p.status<>'CANCELLED' AND p.purchased_date<=${query.date}::date`
          : Prisma.empty
      }
      AND (strpos(lower(i.name),lower(${query.q}))>0 OR strpos(lower(v.variant_code),lower(${query.q}))>0
        ${
          history
            ? Prisma.sql`OR strpos(lower(l.name),lower(${query.q}))>0
          OR strpos(lower(coalesce(l.source_name,'')),lower(${query.q}))>0
          OR strpos(lower(p.supplier_name),lower(${query.q}))>0`
            : Prisma.empty
        })
  `;
  const count = await db.$queryRaw<{ total: bigint }[]>(
    Prisma.sql`SELECT count(*) AS total ${from}`,
  );
  const total = Number(count[0]!.total),
    pages = Math.max(1, Math.ceil(total / 50));
  const page = Math.min(pages, query.page);
  type Row = {
    id: string;
    variantId: string;
    name: string;
    code: string;
    historyName: string;
    sourceName: string | null;
    purchaseCode: string;
    date: Date;
    supplier: string;
    quantity: number;
    amount: string;
    currency: string;
    priceBasis: string;
  };
  const rows = await db.$queryRaw<Row[]>(Prisma.sql`
    SELECT ${columns} v.id AS "variantId", i.name, v.variant_code AS code ${from}
    ORDER BY ${history ? Prisma.sql`p.purchased_date DESC,p.created_at DESC,l.id DESC` : Prisma.sql`i.name,v.variant_code,v.id`}
    LIMIT 50 OFFSET ${(page - 1) * 50}
  `);
  const measures = await purchaseMeasurements(db, c, query.date, {
    variantIds: [...new Set(rows.map((r) => r.variantId))],
  });
  return {
    total,
    pages,
    page,
    rows: rows.map(
      (r): PurchaseChoice => ({
        id: r.id,
        variantId: r.variantId,
        name: r.name,
        code: r.code,
        mode: query.mode,
        measurements: measures.get(r.variantId) ?? {},
        ...(history
          ? {
              history: {
                name: r.historyName,
                sourceName: r.sourceName,
                date: r.date.toISOString().slice(0, 10),
                code: r.purchaseCode,
                supplier: r.supplier,
                quantity: r.quantity,
                amount: new Precise(r.amount).toFixed(),
                currency: r.currency,
                priceBasis: r.priceBasis,
              },
            }
          : {}),
      }),
    ),
  };
}
