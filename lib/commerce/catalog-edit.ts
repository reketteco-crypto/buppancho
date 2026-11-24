import type { Prisma, PrismaClient, ItemConditionCategory } from "@/generated/prisma/client";
import type { WorkflowContext } from "@/lib/sales/workflow-context";
import { WorkflowError } from "@/lib/sales/workflow-errors";
import { runWorkflow } from "@/lib/sales/workflow-runner";
import { assertMasterCanDeactivate } from "@/lib/settings/master-version";
import { itemSaveSchema, supplySaveSchema } from "./input";
import type { z } from "zod";
const scope = (c: WorkflowContext) => ({
  workspaceId: c.workspaceId,
  businessUnitId: c.businessUnitId,
});
function conflict(): never {
  throw new WorkflowError(
    "CONFLICT",
    "商品情報が更新されています。手元の入力を保持して最新の内容を確認してください。",
  );
}
export async function updateCatalogItem(
  tx: Prisma.TransactionClient,
  c: Pick<WorkflowContext, "workspaceId" | "businessUnitId">,
  input: Pick<
    z.infer<typeof itemSaveSchema>,
    "id" | "revision" | "name" | "category" | "memo" | "locationId" | "active"
  > & { defaultConditionCategory?: ItemConditionCategory },
) {
  const before = await tx.inventoryItem.findFirst({
    where: { id: input.id, workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
  });
  if (!before || before.revision !== input.revision) conflict();
  if (
    input.locationId &&
    !(await tx.storageLocation.findFirst({
      where: {
        id: input.locationId,
        workspaceId: c.workspaceId,
        active: true,
        OR: [{ businessUnitId: null }, { businessUnitId: c.businessUnitId }],
      },
    }))
  )
    throw new WorkflowError("VALIDATION", "既定保管場所を選び直してください。");
  if (!input.active) {
    try {
      await assertMasterCanDeactivate(tx, "inventory_item", input.id);
    } catch (e) {
      throw new WorkflowError("VALIDATION", e instanceof Error ? e.message : "無効化できません。");
    }
  }
  const after = await tx.inventoryItem.update({
    where: { id: before.id },
    data: {
      ...(input.defaultConditionCategory
        ? { defaultConditionCategory: input.defaultConditionCategory }
        : {}),
      name: input.name,
      category: input.category || null,
      memo: input.memo || null,
      defaultStorageLocationId: input.locationId || null,
      status: input.active ? "ACTIVE" : "INACTIVE",
    },
  });
  return { before, after };
}
export async function recordCatalogEdit(
  db: PrismaClient,
  c: WorkflowContext,
  kind: "ITEM_SAVE" | "SUPPLY_SAVE",
  raw: unknown,
) {
  if (kind === "ITEM_SAVE") {
    const input = itemSaveSchema.parse(raw);
    return runWorkflow(db, c, input, kind, input.date, async (tx) => {
      const { before, after } = await updateCatalogItem(tx, c, input);
      return {
        id: input.id,
        detail: {
          before: {
            name: before.name,
            category: before.category,
            memo: before.memo,
            status: before.status,
            locationId: before.defaultStorageLocationId,
          },
          after: {
            name: after.name,
            category: after.category,
            memo: after.memo,
            status: after.status,
            locationId: after.defaultStorageLocationId,
          },
        },
      };
    });
  }
  const input = supplySaveSchema.parse(raw);
  return runWorkflow(db, c, input, kind, input.date, async (tx) => {
    const before = await tx.supplyItem.findFirst({ where: { id: input.id, ...scope(c) } });
    if (!before || before.revision !== input.revision) conflict();
    if (
      !input.active &&
      (await tx.skuSupplySetting.count({
        where: { supplyItemId: before.id, sku: { ...scope(c), active: true } },
      }))
    )
      throw new WorkflowError(
        "VALIDATION",
        "有効なSKUで使用しています。先にSKUの資材設定を変更してください。",
      );
    const after = await tx.supplyItem.update({
      where: { id: before.id },
      data: { name: input.name, memo: input.memo || null, active: input.active },
    });
    return {
      id: after.id,
      detail: {
        before: { name: before.name, memo: before.memo, active: before.active },
        after: { name: after.name, memo: after.memo, active: after.active },
      },
    };
  });
}
