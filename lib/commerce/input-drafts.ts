import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { WorkflowContext } from "@/lib/sales/workflow-context";

type DraftCard = {
  id: string;
  kind: string;
  updatedAt: Date;
  name: string;
  total: bigint;
  remaining: bigint;
  saved: bigint;
};

/** Return summaries only; completed batches must not displace unfinished work. */
export async function inputDrafts(
  db: PrismaClient | Prisma.TransactionClient,
  c: Pick<
    WorkflowContext,
    "workspaceId" | "businessUnitId" | "reportingEntityId" | "operatorId" | "year"
  >,
) {
  const rows = await db.$queryRaw<DraftCard[]>`
    SELECT d.id, d.kind, d.updated_at AS "updatedAt",
      CASE WHEN d.kind = 'COMMERCE_SALE_BATCH'
        THEN COALESCE(NULLIF(d.payload #>> '{rows,0,source,file}', ''), '手入力')
        WHEN d.kind = 'COMMERCE_PURCHASE' THEN COALESCE(NULLIF(d.payload ->> 'supplierName', ''), '購入の入力')
        ELSE '販売の入力' END AS name,
      detail.total, detail.remaining, detail.saved
    FROM workflow_draft d
    CROSS JOIN LATERAL (
      SELECT count(*) AS total,
        count(*) FILTER (WHERE NULLIF(r ->> 'targetId', '') IS NULL AND r ->> 'excluded' IS DISTINCT FROM 'true') AS remaining,
        count(*) FILTER (WHERE NULLIF(r ->> 'targetId', '') IS NOT NULL) AS saved
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.payload -> 'rows') = 'array' THEN d.payload -> 'rows' ELSE '[]'::jsonb END) r
    ) detail
    WHERE d.workspace_id = ${c.workspaceId}::uuid
      AND d.business_unit_id = ${c.businessUnitId}::uuid
      AND d.operator_id = ${c.operatorId}::uuid AND d.year = ${c.year}
      AND d.base_snapshot ->> 'reportingEntityId' = ${c.reportingEntityId ?? ""}
      AND d.archived_at IS NULL
      AND d.kind IN ('COMMERCE_PURCHASE', 'COMMERCE_SALE', 'COMMERCE_SALE_BATCH')
      AND (d.kind <> 'COMMERCE_SALE_BATCH' OR detail.remaining > 0)
    ORDER BY d.updated_at DESC, d.id ASC LIMIT 5
  `;
  return rows.map((row) => ({
    ...row,
    href: `${row.kind === "COMMERCE_SALE_BATCH" ? "/sales/batch" : row.kind === "COMMERCE_PURCHASE" ? "/purchases/new" : "/sales/new"}?draft=${row.id}`,
    title: row.kind === "COMMERCE_SALE_BATCH" ? `販売まとめ入力 · ${row.name}` : row.name,
  }));
}
