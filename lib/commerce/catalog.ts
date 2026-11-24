import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { WorkflowContext } from "@/lib/sales/workflow-context";
import { skuAvailability } from "@/lib/sales/availability";

type Scope = Pick<WorkflowContext, "workspaceId" | "businessUnitId" | "reportingEntityId">;
export type CatalogStock = {
  id: string;
  itemId: string;
  variantId: string | null;
  unitId: string | null;
  name: string;
  label: string;
  quantity: number;
};
export const catalogPageSize = 50;
const stockSql = (c: Scope) => Prisma.sql`
 SELECT v.id, i.id AS "itemId", v.id AS "variantId", NULL::uuid AS "unitId", i.name, v.variant_code AS label,
 coalesce((SELECT sum(b.quantity)::integer FROM inventory_cost_balance b WHERE b.item_variant_id=v.id AND b.tracking_mode='quantity' AND b.business_unit_id=${c.businessUnitId}::uuid),0) AS quantity
 FROM item_variant v JOIN inventory_item i ON i.id=v.inventory_item_id
 WHERE v.workspace_id=${c.workspaceId}::uuid AND i.workspace_id=${c.workspaceId}::uuid AND i.business_unit_id=${c.businessUnitId}::uuid AND v.active AND i.status='active' AND i.management_type='quantity'
 UNION ALL
 SELECT u.id,i.id,NULL::uuid,u.id,i.name,u.individual_code,1
 FROM unique_stock_unit u JOIN item_variant v ON v.id=u.item_variant_id JOIN inventory_item i ON i.id=v.inventory_item_id
 WHERE u.workspace_id=${c.workspaceId}::uuid AND i.business_unit_id=${c.businessUnitId}::uuid AND i.workspace_id=${c.workspaceId}::uuid AND v.active AND i.status='active' AND u.status='in_stock'`;

export async function catalogStocks(
  db: Pick<PrismaClient, "$queryRaw">,
  c: Scope,
  query: { q?: string; page?: number; ids?: string[] },
) {
  const search = query.q?.trim() ?? "";
  const filter = query.ids
    ? Prisma.sql`id IN (${Prisma.join(query.ids.map((id) => Prisma.sql`${id}::uuid`))})`
    : Prisma.sql`(strpos(lower(name),lower(${search}))>0 OR strpos(lower(label),lower(${search}))>0)`;
  if (query.ids && !query.ids.length)
    return { rows: [] as CatalogStock[], total: 0, page: 1, pages: 1 };
  const from = Prisma.sql`WITH stock AS (${stockSql(c)})`;
  const count = await db.$queryRaw<{ total: bigint }[]>(
    Prisma.sql`${from} SELECT count(*) AS total FROM stock WHERE ${filter}`,
  );
  const total = Number(count[0]!.total),
    pages = Math.max(1, Math.ceil(total / catalogPageSize)),
    page = Math.min(pages, Math.max(1, query.page ?? 1));
  const rows = await db.$queryRaw<CatalogStock[]>(
    Prisma.sql`${from} SELECT * FROM stock WHERE ${filter} ORDER BY name,label,id LIMIT ${query.ids ? 200 : catalogPageSize} OFFSET ${query.ids ? 0 : (page - 1) * catalogPageSize}`,
  );
  return { rows, total, page, pages };
}

export async function catalogSkuAvailability(
  db: Prisma.TransactionClient,
  c: Scope,
  skus: {
    id: string;
    components: {
      itemVariantId: string | null;
      uniqueStockUnitId: string | null;
      requiredQuantity: number;
    }[];
  }[],
) {
  if (!skus.length) return new Map<string, number>();
  const parts = skus.flatMap((s) => s.components),
    variantIds = [...new Set(parts.flatMap((p) => (p.itemVariantId ? [p.itemVariantId] : [])))],
    unitIds = parts.flatMap((p) => (p.uniqueStockUnitId ? [p.uniqueStockUnitId] : []));
  const [balances, units, held] = await Promise.all([
    db.inventoryCostBalance.findMany({
      where: {
        businessUnitId: c.businessUnitId,
        trackingMode: "QUANTITY",
        itemVariantId: { in: variantIds },
      },
    }),
    db.uniqueStockUnit.findMany({
      where: {
        id: { in: unitIds },
        workspaceId: c.workspaceId,
        itemVariant: { inventoryItem: { businessUnitId: c.businessUnitId } },
      },
      select: { id: true, status: true },
    }),
    db.inventoryReservation.findMany({
      where: {
        status: "RESERVED",
        itemVariant: {
          workspaceId: c.workspaceId,
          inventoryItem: { businessUnitId: c.businessUnitId },
        },
        OR: [{ itemVariantId: { in: variantIds } }, { uniqueStockUnitId: { in: unitIds } }],
      },
      select: { itemVariantId: true, uniqueStockUnitId: true, quantity: true },
    }),
  ]);
  const available = new Map(
    variantIds.map((id) => [
      id,
      Math.max(
        0,
        balances.filter((b) => b.itemVariantId === id).reduce((s, b) => s + b.quantity, 0) -
          held
            .filter((h) => h.itemVariantId === id && !h.uniqueStockUnitId)
            .reduce((s, h) => s + h.quantity, 0),
      ),
    ]),
  );
  return new Map(
    skus.map((s) => [
      s.id,
      skuAvailability(
        s.components.map((p) => ({
          requiredQuantity: p.requiredQuantity,
          availableQuantity: p.uniqueStockUnitId
            ? units.some((u) => u.id === p.uniqueStockUnitId && u.status === "IN_STOCK") &&
              !held.some((h) => h.uniqueStockUnitId === p.uniqueStockUnitId)
              ? 1
              : 0
            : (available.get(p.itemVariantId!) ?? 0),
        })),
      ),
    ]),
  );
}

export async function catalogSelectionNames(
  db: Pick<PrismaClient, "$queryRaw">,
  c: Scope,
  ids: string[],
) {
  if (!ids.length) return [];
  const selected = Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));
  return db.$queryRaw<{ id: string; name: string; label: string }[]>(Prisma.sql`
    SELECT v.id,i.name,v.variant_code AS label FROM item_variant v JOIN inventory_item i ON i.id=v.inventory_item_id
    WHERE v.id IN (${selected}) AND v.workspace_id=${c.workspaceId}::uuid AND i.workspace_id=${c.workspaceId}::uuid AND i.business_unit_id=${c.businessUnitId}::uuid
    UNION ALL
    SELECT u.id,i.name,u.individual_code FROM unique_stock_unit u JOIN item_variant v ON v.id=u.item_variant_id JOIN inventory_item i ON i.id=v.inventory_item_id
    WHERE u.id IN (${selected}) AND u.workspace_id=${c.workspaceId}::uuid AND i.workspace_id=${c.workspaceId}::uuid AND i.business_unit_id=${c.businessUnitId}::uuid
  `);
}
