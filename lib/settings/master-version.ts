import { Prisma } from "@/generated/prisma/client";
import { lockInventoryDomain } from "@/lib/inventory/domain-lock";

export const masterTables = [
  "workspace",
  "operator",
  "reporting_entity",
  "business_unit",
  "fiscal_year_profile",
  "business_unit_assignment",
  "storage_location",
  "counterparty",
  "inventory_item",
  "sales_channel",
] as const;
export type MasterTable = (typeof masterTables)[number];
export class MasterConflict extends Error {}

/** Settings take all department locks in the same order as annual closing. */
export async function lockMasterDomain(tx: Prisma.TransactionClient, workspaceId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`master:${workspaceId}`},0))`;
  for (const unit of await tx.businessUnit.findMany({
    where: { workspaceId },
    select: { id: true },
    orderBy: { id: "asc" },
  }))
    await lockInventoryDomain(tx, unit.id);
}

export async function assertMasterVersion(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  table: MasterTable,
  id: string,
  expected: FormDataEntryValue | null,
) {
  if (typeof expected !== "string" || !/^(0|[1-9]\d{0,9})$/.test(expected))
    throw new MasterConflict(
      "入力開始時の版を確認できません。手元の入力を控えて最新の設定を読み直してください。",
    );
  if (!masterTables.includes(table)) throw new Error("Unknown master table");
  const owned =
    table === "workspace"
      ? Prisma.sql`t.id=${workspaceId}::uuid`
      : table === "fiscal_year_profile"
        ? Prisma.sql`EXISTS(SELECT 1 FROM reporting_entity e WHERE e.id=t.reporting_entity_id AND e.workspace_id=${workspaceId}::uuid)`
        : table === "business_unit_assignment"
          ? Prisma.sql`EXISTS(SELECT 1 FROM business_unit u WHERE u.id=t.business_unit_id AND u.workspace_id=${workspaceId}::uuid)`
          : Prisma.sql`t.workspace_id=${workspaceId}::uuid`;
  const rows = await tx.$queryRaw<{ revision: number }[]>(
    Prisma.sql`SELECT t.revision FROM ${Prisma.raw(table)} t WHERE t.id=${id}::uuid AND ${owned} FOR UPDATE OF t`,
  );
  if (!rows[0] || rows[0].revision.toString() !== expected)
    throw new MasterConflict(
      "別の端末で設定が更新されました。手元の入力は保存していません。最新の設定を確認してから入力し直してください。",
    );
}

export function assertNewMasterVersion(expected: FormDataEntryValue | null) {
  if (expected !== "NEW")
    throw new MasterConflict("保存対象が変わりました。最新の設定を読み直してください。");
}

/** Recheck references after the shared inventory locks, never only before them. */
export async function assertMasterCanDeactivate(
  tx: Prisma.TransactionClient,
  table: MasterTable,
  id: string,
) {
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  if (table === "operator" || table === "reporting_entity") {
    const referenced = await tx.businessUnitAssignment.count({
      where: {
        effectiveTo: { gte: today },
        ...(table === "operator"
          ? { defaultOperatorId: id }
          : { fiscalYearProfile: { reportingEntityId: id } }),
      },
    });
    if (referenced) throw new Error("現在または将来の年度割当で使用中の設定は無効化できません。");
  }
  if (table === "inventory_item") {
    const count = await tx.inventoryCostBalance.count({
      where: { itemVariant: { inventoryItemId: id }, quantity: { gt: 0 } },
    });
    if (count) throw new Error("在庫が残る商品は無効化できません。");
  }
  if (table === "storage_location") {
    const rows = await tx.stockMovement.findMany({
      where: {
        OR: [{ storageLocationFromId: id }, { storageLocationToId: id }],
        movementType: { not: "RETURN_DISPOSAL" },
      },
    });
    const count = rows.reduce(
      (sum, row) =>
        sum +
        (row.storageLocationToId === id ? row.quantity : 0) -
        (row.movementType === "LOCATION_TRANSFER" && row.storageLocationFromId === id
          ? row.quantity
          : 0) +
        (row.movementType !== "LOCATION_TRANSFER" && row.storageLocationFromId === id
          ? row.quantity
          : 0),
      0,
    );
    const units = await tx.uniqueStockUnit.count({
      where: { storageLocationId: id, status: { in: ["IN_STOCK", "RESERVED", "RETURNED"] } },
    });
    if (count > 0 || units) throw new Error("現物・確保在庫が残る保管場所は無効化できません。");
  }
}
