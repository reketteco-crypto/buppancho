"use server";

import Decimal from "decimal.js";
import { Prisma } from "@/generated/prisma/client";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertTrustedOrigin } from "@/lib/auth/origin";
import { writeAudit } from "@/lib/audit/write";
import { nextWorkspaceCode } from "@/lib/inventory/codes";
import { lockInventoryTarget, requireInventoryContext, tokyoDate } from "@/lib/inventory/context";
import { averageUnitCost, movingAverageOutCost, parseYen } from "@/lib/inventory/money";
import {
  inventoryItemSchema,
  inventoryOperationSchema,
  parsePayload,
  quantityPurchaseSchema,
  unifiedPurchaseSchema,
  usedBundlePurchaseSchema,
} from "@/lib/validation/inventory";

export type InventoryActionState = { error?: string; success?: string };

function message(error: unknown) {
  if (error instanceof z.ZodError)
    return error.issues[0]?.message ?? "入力内容を確認してください。";
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return "同じコードまたは操作がすでに登録されています。";
  }
  return error instanceof Error ? error.message : "処理を完了できませんでした。";
}

function jsonRecord(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

async function verifyLocationAndSupplier(
  workspaceId: string,
  businessUnitId: string,
  locationId: string,
  supplierId: string,
) {
  const { db } = await requireInventoryContext();
  const [location, supplier] = await Promise.all([
    db.storageLocation.findFirst({
      where: {
        id: locationId,
        workspaceId,
        active: true,
        OR: [{ businessUnitId: null }, { businessUnitId }],
      },
    }),
    db.counterparty.findFirst({
      where: { id: supplierId, workspaceId, type: "SUPPLIER", active: true },
    }),
  ]);
  if (!location) throw new Error("選択した保管場所を使用できません。");
  if (!supplier) throw new Error("選択した仕入先を使用できません。");
}

export async function createStorageLocationAction(
  _state: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  try {
    await assertTrustedOrigin();
    const context = await requireInventoryContext();
    const parsed = z
      .object({
        code: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z0-9_-]{1,40}$/),
        name: z.string().trim().min(1).max(80),
        businessUnitId: z.string().uuid().or(z.literal("")),
      })
      .parse(Object.fromEntries(formData));
    const scopedUnit = parsed.businessUnitId || null;
    if (scopedUnit && scopedUnit !== context.businessUnitId) {
      throw new Error("現在の販売部門以外の保管場所は作成できません。");
    }
    await context.db.$transaction(async (tx) => {
      const row = await tx.storageLocation.create({
        data: {
          workspaceId: context.workspaceId,
          businessUnitId: scopedUnit,
          code: parsed.code,
          name: parsed.name,
        },
      });
      await writeAudit(tx, {
        workspaceId: context.workspaceId,
        userAccountId: context.session.userAccountId,
        operatorId: context.operatorId,
        action: "storage_location.create",
        entityType: "storage_location",
        entityId: row.id,
        after: parsed,
      });
    });
    revalidatePath("/settings/storage-locations");
    return { success: "保管場所を登録しました。" };
  } catch (error) {
    return { error: message(error) };
  }
}

export async function updateStorageLocationAction(formData: FormData): Promise<void> {
  await assertTrustedOrigin();
  const context = await requireInventoryContext();
  const parsed = z
    .object({ id: z.string().uuid(), name: z.string().trim().min(1).max(80) })
    .parse(Object.fromEntries(formData));
  const existing = await context.db.storageLocation.findFirst({
    where: { id: parsed.id, workspaceId: context.workspaceId },
  });
  if (!existing) throw new Error("保管場所が見つかりません。");
  const active = formData.get("active") === "on";
  if (!active) {
    const [quantityRows, uniqueCount] = await Promise.all([
      context.db.stockMovement.findMany({
        where: {
          itemVariant: { inventoryItem: { workspaceId: context.workspaceId } },
          OR: [{ storageLocationFromId: existing.id }, { storageLocationToId: existing.id }],
        },
        select: {
          movementType: true,
          quantity: true,
          storageLocationFromId: true,
          storageLocationToId: true,
        },
      }),
      context.db.uniqueStockUnit.count({
        where: { storageLocationId: existing.id, status: "IN_STOCK" },
      }),
    ]);
    const balance = quantityRows.reduce((sum, row) => {
      if (row.movementType === "LOCATION_TRANSFER") {
        return (
          sum +
          (row.storageLocationToId === existing.id ? row.quantity : 0) -
          (row.storageLocationFromId === existing.id ? row.quantity : 0)
        );
      }
      return (
        sum +
        (row.storageLocationToId === existing.id ? row.quantity : 0) +
        (row.storageLocationFromId === existing.id ? row.quantity : 0)
      );
    }, 0);
    if (balance > 0 || uniqueCount > 0) throw new Error("在庫が残る保管場所は無効化できません。");
  }
  await context.db.$transaction(async (tx) => {
    await tx.storageLocation.update({
      where: { id: existing.id },
      data: { name: parsed.name, active },
    });
    await writeAudit(tx, {
      workspaceId: context.workspaceId,
      userAccountId: context.session.userAccountId,
      operatorId: context.operatorId,
      action: "storage_location.update",
      entityType: "storage_location",
      entityId: existing.id,
      before: { name: existing.name, active: existing.active },
      after: { name: parsed.name, active },
    });
  });
  revalidatePath("/settings/storage-locations");
}

export async function createSupplierAction(
  _state: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  try {
    await assertTrustedOrigin();
    const context = await requireInventoryContext();
    const parsed = z
      .object({ name: z.string().trim().min(1).max(120), memo: z.string().trim().max(1000) })
      .parse(Object.fromEntries(formData));
    await context.db.$transaction(async (tx) => {
      const row = await tx.counterparty.create({
        data: { workspaceId: context.workspaceId, name: parsed.name, memo: parsed.memo || null },
      });
      await writeAudit(tx, {
        workspaceId: context.workspaceId,
        userAccountId: context.session.userAccountId,
        operatorId: context.operatorId,
        action: "counterparty.create",
        entityType: "counterparty",
        entityId: row.id,
        after: parsed,
      });
    });
    revalidatePath("/settings/suppliers");
    return { success: "仕入先を登録しました。" };
  } catch (error) {
    return { error: message(error) };
  }
}

export async function updateSupplierAction(formData: FormData): Promise<void> {
  await assertTrustedOrigin();
  const context = await requireInventoryContext();
  const parsed = z
    .object({
      id: z.string().uuid(),
      name: z.string().trim().min(1).max(120),
      memo: z.string().trim().max(1000),
    })
    .parse(Object.fromEntries(formData));
  const existing = await context.db.counterparty.findFirst({
    where: { id: parsed.id, workspaceId: context.workspaceId, type: "SUPPLIER" },
  });
  if (!existing) throw new Error("仕入先が見つかりません。");
  const active = formData.get("active") === "on";
  await context.db.$transaction(async (tx) => {
    await tx.counterparty.update({
      where: { id: existing.id },
      data: { name: parsed.name, memo: parsed.memo || null, active },
    });
    await writeAudit(tx, {
      workspaceId: context.workspaceId,
      userAccountId: context.session.userAccountId,
      operatorId: context.operatorId,
      action: "counterparty.update",
      entityType: "counterparty",
      entityId: existing.id,
      before: { name: existing.name, memo: existing.memo, active: existing.active },
      after: { ...parsed, active },
    });
  });
  revalidatePath("/settings/suppliers");
}

export async function createInventoryItemAction(
  _state: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  try {
    await assertTrustedOrigin();
    const context = await requireInventoryContext();
    const rawAttributes = String(formData.get("attributes") ?? "{}");
    const parsed = inventoryItemSchema.parse({
      ...Object.fromEntries(formData),
      attributes: JSON.parse(rawAttributes),
    });
    if (parsed.defaultStorageLocationId) {
      const location = await context.db.storageLocation.findFirst({
        where: {
          id: parsed.defaultStorageLocationId,
          workspaceId: context.workspaceId,
          active: true,
          OR: [{ businessUnitId: null }, { businessUnitId: context.businessUnitId }],
        },
      });
      if (!location) throw new Error("選択した保管場所を使用できません。");
    }
    const row = await context.db.$transaction(async (tx) => {
      const itemCode =
        parsed.itemCode || (await nextWorkspaceCode(tx, context.workspaceId, "ITEM"));
      const variantCode = await nextWorkspaceCode(tx, context.workspaceId, "VARIANT");
      const item = await tx.inventoryItem.create({
        data: {
          workspaceId: context.workspaceId,
          businessUnitId: context.businessUnitId,
          itemCode,
          name: parsed.name,
          category: parsed.category || null,
          defaultConditionCategory: parsed.defaultConditionCategory,
          managementType: parsed.managementType,
          managementCostMethod:
            parsed.managementType === "QUANTITY" ? "MOVING_AVERAGE" : "SPECIFIC",
          defaultStorageLocationId: parsed.defaultStorageLocationId || null,
          memo: parsed.memo || null,
          variants: {
            create: {
              workspaceId: context.workspaceId,
              variantCode,
              attributesJson: jsonRecord(parsed.attributes),
            },
          },
        },
      });
      await writeAudit(tx, {
        workspaceId: context.workspaceId,
        userAccountId: context.session.userAccountId,
        operatorId: context.operatorId,
        action: "inventory_item.create",
        entityType: "inventory_item",
        entityId: item.id,
        after: {
          ...parsed,
          itemCode,
          managementCostMethod:
            parsed.managementType === "QUANTITY" ? "MOVING_AVERAGE" : "SPECIFIC",
        },
      });
      return item;
    });
    revalidatePath("/inventory");
    return { success: `商品「${row.name}」を登録しました。` };
  } catch (error) {
    return { error: message(error) };
  }
}

export async function updateInventoryItemAction(formData: FormData): Promise<void> {
  await assertTrustedOrigin();
  const context = await requireInventoryContext();
  const parsed = z
    .object({
      id: z.string().uuid(),
      name: z.string().trim().min(1).max(120),
      category: z.string().trim().max(80),
      defaultConditionCategory: z.enum(["UNSPECIFIED", "NEW", "USED"]),
      defaultStorageLocationId: z.string().uuid().or(z.literal("")),
      memo: z.string().trim().max(1000),
    })
    .parse(Object.fromEntries(formData));
  const existing = await context.db.inventoryItem.findFirst({
    where: {
      id: parsed.id,
      workspaceId: context.workspaceId,
      businessUnitId: context.businessUnitId,
    },
    include: { variants: true },
  });
  if (!existing) throw new Error("商品が見つかりません。");
  if (parsed.defaultStorageLocationId) {
    const location = await context.db.storageLocation.findFirst({
      where: {
        id: parsed.defaultStorageLocationId,
        workspaceId: context.workspaceId,
        active: true,
        OR: [{ businessUnitId: null }, { businessUnitId: context.businessUnitId }],
      },
    });
    if (!location) throw new Error("選択した保管場所を使用できません。");
  }
  const active = formData.get("active") === "on";
  if (!active) {
    const variantIds = existing.variants.map((variant) => variant.id);
    const [balances, units] = await Promise.all([
      context.db.inventoryCostBalance.aggregate({
        where: { itemVariantId: { in: variantIds }, quantity: { gt: 0 } },
        _sum: { quantity: true },
      }),
      context.db.uniqueStockUnit.count({
        where: { itemVariantId: { in: variantIds }, status: "IN_STOCK" },
      }),
    ]);
    if ((balances._sum.quantity ?? 0) > 0 || units > 0) {
      throw new Error("在庫が残る商品は無効化できません。");
    }
  }
  await context.db.$transaction(async (tx) => {
    await tx.inventoryItem.update({
      where: { id: existing.id },
      data: {
        name: parsed.name,
        category: parsed.category || null,
        defaultConditionCategory: parsed.defaultConditionCategory,
        defaultStorageLocationId: parsed.defaultStorageLocationId || null,
        memo: parsed.memo || null,
        status: active ? "ACTIVE" : "INACTIVE",
      },
    });
    await writeAudit(tx, {
      workspaceId: context.workspaceId,
      userAccountId: context.session.userAccountId,
      operatorId: context.operatorId,
      action: "inventory_item.update",
      entityType: "inventory_item",
      entityId: existing.id,
      before: {
        name: existing.name,
        category: existing.category,
        defaultConditionCategory: existing.defaultConditionCategory,
        defaultStorageLocationId: existing.defaultStorageLocationId,
        memo: existing.memo,
        status: existing.status,
      },
      after: { ...parsed, status: active ? "ACTIVE" : "INACTIVE" },
    });
  });
  revalidatePath("/inventory");
  revalidatePath(`/inventory/${existing.id}`);
}

type PurchasePayload =
  | z.infer<typeof quantityPurchaseSchema>
  | z.infer<typeof usedBundlePurchaseSchema>;

async function savePurchase(payload: PurchasePayload, type: "DOMESTIC" | "USED_BUNDLE") {
  const date = tokyoDate(payload.purchasedDate);
  const context = await requireInventoryContext(date);
  await verifyLocationAndSupplier(
    context.workspaceId,
    context.businessUnitId,
    payload.storageLocationId,
    payload.supplierId,
  );
  const variantIds = [...new Set(payload.lines.map((line) => line.variantId))];
  const variants = await context.db.itemVariant.findMany({
    where: {
      id: { in: variantIds },
      active: true,
      inventoryItem: {
        workspaceId: context.workspaceId,
        businessUnitId: context.businessUnitId,
        status: "ACTIVE",
      },
    },
    include: { inventoryItem: true },
  });
  if (variants.length !== variantIds.length)
    throw new Error("選択した商品を現在の部門で使用できません。");
  const expectedType = type === "DOMESTIC" ? "QUANTITY" : "UNIQUE";
  if (variants.some((variant) => variant.inventoryItem.managementType !== expectedType)) {
    throw new Error(
      type === "DOMESTIC" ? "数量商品だけを選択してください。" : "個体商品だけを選択してください。",
    );
  }
  const total = payload.lines.reduce((sum, line) => sum + parseYen(line.amountJpy), 0n);
  if (total !== parseYen(payload.purchaseTotalJpy))
    throw new Error("仕入総額と明細原価の合計が一致しません。");
  if (type === "USED_BUNDLE") {
    const used = payload as z.infer<typeof usedBundlePurchaseSchema>;
    if (used.lines.length !== used.expectedItemCount)
      throw new Error("予定点数と個体の登録件数が一致しません。");
    const normalized = used.lines.map((line) => line.individualCode).filter(Boolean);
    if (new Set(normalized).size !== normalized.length)
      throw new Error("個体コードが仕入内で重複しています。");
    const existing = await context.db.uniqueStockUnit.count({
      where: { workspaceId: context.workspaceId, individualCode: { in: normalized } },
    });
    if (existing) throw new Error("すでに使用されている個体コードがあります。");
  }
  const existing = await context.db.purchase.findUnique({
    where: { requestKey: payload.idempotencyKey },
  });
  if (existing && existing.id !== payload.purchaseId) return existing;
  return context.db.$transaction(
    async (tx) => {
      const editing = payload.purchaseId
        ? await tx.purchase.findFirst({
            where: {
              id: payload.purchaseId,
              workspaceId: context.workspaceId,
              businessUnitId: context.businessUnitId,
              status: "DRAFT",
              purchaseType: type,
            },
          })
        : null;
      if (payload.purchaseId && !editing) throw new Error("編集できる下書きが見つかりません。");
      const purchaseCode =
        editing?.purchaseCode ?? (await nextWorkspaceCode(tx, context.workspaceId, "PURCHASE"));
      const commonData = {
        reportingEntityId: context.reportingEntityId,
        supplierId: payload.supplierId,
        storageLocationId: payload.storageLocationId,
        orderNumber: "orderNumber" in payload ? payload.orderNumber || null : null,
        purchasedDate: date,
        purchaseTotalJpy: parseYen(payload.purchaseTotalJpy),
        expectedItemCount: "expectedItemCount" in payload ? payload.expectedItemCount : null,
        memo: payload.memo || null,
      };
      const row = editing
        ? await tx.purchase.update({ where: { id: editing.id }, data: commonData })
        : await tx.purchase.create({
            data: {
              workspaceId: context.workspaceId,
              businessUnitId: context.businessUnitId,
              purchaseType: type,
              purchaseCode,
              requestKey: payload.idempotencyKey,
              ...commonData,
            },
          });
      if (editing) await tx.purchaseLine.deleteMany({ where: { purchaseId: editing.id } });
      for (const line of payload.lines) {
        const individualCode =
          "individualCode" in line
            ? line.individualCode || (await nextWorkspaceCode(tx, context.workspaceId, "UNIT"))
            : null;
        await tx.purchaseLine.create({
          data: {
            purchaseId: row.id,
            itemVariantId: line.variantId,
            trackingMode: type === "DOMESTIC" ? "QUANTITY" : "UNIQUE",
            conditionCategory: type === "USED_BUNDLE" ? "USED" : "NEW",
            sourceName: line.sourceName,
            sourceUrl: line.sourceUrl || null,
            orderedQuantity: line.quantity,
            productAmountJpy: parseYen(line.amountJpy),
            finalLandedCostJpy: parseYen(line.amountJpy),
            draftIndividualCode: individualCode,
            draftCondition: "condition" in line ? line.condition : null,
            draftMeasurementsJson:
              "measurements" in line ? jsonRecord(line.measurements) : undefined,
            draftMemo: "memo" in line ? line.memo || null : null,
          },
        });
      }
      await writeAudit(tx, {
        workspaceId: context.workspaceId,
        userAccountId: context.session.userAccountId,
        operatorId: context.operatorId,
        action: editing ? "purchase.draft.update" : "purchase.draft.create",
        entityType: "purchase",
        entityId: row.id,
        before: editing
          ? {
              purchaseTotalJpy: editing.purchaseTotalJpy.toString(),
              purchasedDate: editing.purchasedDate,
            }
          : undefined,
        after: {
          purchaseCode,
          purchaseType: type,
          purchasedDate: payload.purchasedDate,
          purchaseTotalJpy: payload.purchaseTotalJpy,
          lineCount: payload.lines.length,
        },
      });
      return row;
    },
    { isolationLevel: "Serializable" },
  );
}

export async function saveQuantityPurchaseAction(
  _state: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  try {
    await assertTrustedOrigin();
    const purchase = await savePurchase(parsePayload(formData, quantityPurchaseSchema), "DOMESTIC");
    redirect(`/purchases/${purchase.id}`);
  } catch (error) {
    if (typeof error === "object" && error && "digest" in error) throw error;
    return { error: message(error) };
  }
}

export async function saveUsedBundlePurchaseAction(
  _state: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  try {
    await assertTrustedOrigin();
    const purchase = await savePurchase(
      parsePayload(formData, usedBundlePurchaseSchema),
      "USED_BUNDLE",
    );
    redirect(`/purchases/${purchase.id}`);
  } catch (error) {
    if (typeof error === "object" && error && "digest" in error) throw error;
    return { error: message(error) };
  }
}

type UnifiedPurchasePayload = z.infer<typeof unifiedPurchaseSchema>;

async function persistUnifiedPurchase(payload: UnifiedPurchasePayload) {
  const date = tokyoDate(payload.purchasedDate);
  const context = await requireInventoryContext(date);
  await verifyLocationAndSupplier(
    context.workspaceId,
    context.businessUnitId,
    payload.storageLocationId,
    payload.supplierId,
  );
  const existingVariantIds = [
    ...new Set(
      payload.lines.flatMap((line) =>
        line.variant.source === "EXISTING" ? [line.variant.variantId] : [],
      ),
    ),
  ];
  const existingVariantCount = await context.db.itemVariant.count({
    where: {
      id: { in: existingVariantIds },
      workspaceId: context.workspaceId,
      active: true,
      inventoryItem: { businessUnitId: context.businessUnitId, status: "ACTIVE" },
    },
  });
  if (existingVariantCount !== existingVariantIds.length)
    throw new Error("選択した商品を現在の部門で使用できません。");
  const total = payload.lines.reduce((sum, line) => sum + parseYen(line.amountJpy), 0n);
  if (total !== parseYen(payload.purchaseTotalJpy))
    throw new Error("仕入総額と明細原価の合計が一致しません。");
  const individualCodes = payload.lines.flatMap((line) =>
    line.trackingMode === "UNIQUE" && line.individualCode ? [line.individualCode] : [],
  );
  if (new Set(individualCodes).size !== individualCodes.length)
    throw new Error("個体コードが仕入内で重複しています。");
  if (
    individualCodes.length &&
    (await context.db.uniqueStockUnit.count({
      where: { workspaceId: context.workspaceId, individualCode: { in: individualCodes } },
    }))
  )
    throw new Error("すでに使用されている個体コードがあります。");
  const replay = await context.db.purchase.findUnique({
    where: { requestKey: payload.idempotencyKey },
  });
  if (replay && replay.id !== payload.purchaseId) return replay;

  return context.db.$transaction(
    async (tx) => {
      const editing = payload.purchaseId
        ? await tx.purchase.findFirst({
            where: {
              id: payload.purchaseId,
              workspaceId: context.workspaceId,
              businessUnitId: context.businessUnitId,
              status: "DRAFT",
            },
          })
        : null;
      if (payload.purchaseId && !editing) throw new Error("編集できる仕入下書きが見つかりません。");

      const variantMap = new Map<string, string>();
      for (const product of payload.newProducts) {
        const itemCode =
          product.itemCode || (await nextWorkspaceCode(tx, context.workspaceId, "ITEM"));
        const item = await tx.inventoryItem.create({
          data: {
            workspaceId: context.workspaceId,
            businessUnitId: context.businessUnitId,
            itemCode,
            name: product.name,
            category: product.category || null,
            defaultConditionCategory: product.defaultConditionCategory,
            managementType: product.defaultTrackingMode,
            managementCostMethod:
              product.defaultTrackingMode === "QUANTITY" ? "MOVING_AVERAGE" : "SPECIFIC",
            defaultStorageLocationId: payload.storageLocationId,
            memo: product.memo || null,
          },
        });
        for (const variant of product.variants) {
          const variantCode =
            variant.variantCode || (await nextWorkspaceCode(tx, context.workspaceId, "VARIANT"));
          const created = await tx.itemVariant.create({
            data: {
              workspaceId: context.workspaceId,
              inventoryItemId: item.id,
              variantCode,
              attributesJson: jsonRecord(variant.attributes),
            },
          });
          variantMap.set(`${product.clientRef}:${variant.clientRef}`, created.id);
        }
        await writeAudit(tx, {
          workspaceId: context.workspaceId,
          userAccountId: context.session.userAccountId,
          operatorId: context.operatorId,
          action: "inventory_item.create_from_purchase",
          entityType: "inventory_item",
          entityId: item.id,
          after: { itemCode, name: product.name, variantCount: product.variants.length },
        });
      }

      const purchaseCode =
        editing?.purchaseCode ?? (await nextWorkspaceCode(tx, context.workspaceId, "PURCHASE"));
      const uniqueLineCount = payload.lines.filter((line) => line.trackingMode === "UNIQUE").length;
      const data = {
        reportingEntityId: context.reportingEntityId,
        supplierId: payload.supplierId,
        storageLocationId: payload.storageLocationId,
        orderNumber: payload.orderNumber || null,
        purchasedDate: date,
        purchaseTotalJpy: parseYen(payload.purchaseTotalJpy),
        expectedItemCount: uniqueLineCount > 0 ? uniqueLineCount : null,
        memo: payload.memo || null,
        requestKey: payload.idempotencyKey,
      };
      const purchase = editing
        ? await tx.purchase.update({ where: { id: editing.id }, data })
        : await tx.purchase.create({
            data: {
              workspaceId: context.workspaceId,
              businessUnitId: context.businessUnitId,
              purchaseType: "DOMESTIC",
              purchaseCode,
              ...data,
            },
          });
      if (editing) await tx.purchaseLine.deleteMany({ where: { purchaseId: editing.id } });

      for (const line of payload.lines) {
        const itemVariantId =
          line.variant.source === "EXISTING"
            ? line.variant.variantId
            : variantMap.get(`${line.variant.productRef}:${line.variant.variantRef}`);
        if (!itemVariantId) throw new Error("新規商品のバリアントを解決できませんでした。");
        if (line.trackingMode === "QUANTITY" && Object.keys(line.commonMeasurements).length) {
          const current = await tx.itemVariant.findUniqueOrThrow({ where: { id: itemVariantId } });
          await tx.itemVariant.update({
            where: { id: itemVariantId },
            data: {
              attributesJson: jsonRecord({
                ...(current.attributesJson as Record<string, string>),
                ...line.commonMeasurements,
              }),
            },
          });
        }
        await tx.purchaseLine.create({
          data: {
            purchaseId: purchase.id,
            itemVariantId,
            trackingMode: line.trackingMode,
            conditionCategory: line.conditionCategory,
            sourceName: line.sourceName,
            sourceUrl: line.sourceUrl || null,
            orderedQuantity: line.quantity,
            productAmountJpy: parseYen(line.amountJpy),
            finalLandedCostJpy: parseYen(line.amountJpy),
            draftIndividualCode:
              line.trackingMode === "UNIQUE" ? line.individualCode || null : null,
            draftCondition: line.conditionDescription || null,
            draftMeasurementsJson:
              line.trackingMode === "UNIQUE" ? jsonRecord(line.measurements) : undefined,
            draftMemo: line.trackingMode === "UNIQUE" ? line.memo || null : null,
          },
        });
      }
      await writeAudit(tx, {
        workspaceId: context.workspaceId,
        userAccountId: context.session.userAccountId,
        operatorId: context.operatorId,
        action: editing ? "purchase.draft.update" : "purchase.draft.create",
        entityType: "purchase",
        entityId: purchase.id,
        before: editing ? { purchaseTotalJpy: editing.purchaseTotalJpy.toString() } : undefined,
        after: {
          purchaseCode,
          purchaseType: "DOMESTIC",
          purchasedDate: payload.purchasedDate,
          purchaseTotalJpy: payload.purchaseTotalJpy,
          lineCount: payload.lines.length,
        },
      });
      return purchase;
    },
    { isolationLevel: "Serializable", timeout: 20_000 },
  );
}

export async function saveUnifiedPurchaseAction(
  _state: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  try {
    await assertTrustedOrigin();
    const purchase = await persistUnifiedPurchase(parsePayload(formData, unifiedPurchaseSchema));
    redirect(`/purchases/${purchase.id}`);
  } catch (error) {
    if (typeof error === "object" && error && "digest" in error) throw error;
    return { error: message(error) };
  }
}

export async function finalizePurchaseAction(formData: FormData): Promise<void> {
  await assertTrustedOrigin();
  const parsed = z
    .object({ id: z.string().uuid(), idempotencyKey: z.string().uuid() })
    .parse(Object.fromEntries(formData));
  const initialContext = await requireInventoryContext();
  const purchase = await initialContext.db.purchase.findFirst({
    where: {
      id: parsed.id,
      workspaceId: initialContext.workspaceId,
      businessUnitId: initialContext.businessUnitId,
    },
    include: { lines: { include: { itemVariant: { include: { inventoryItem: true } } } } },
  });
  if (!purchase) throw new Error("仕入れが見つかりません。");
  const context = await requireInventoryContext(purchase.purchasedDate);
  if (purchase.status === "FINALIZED") return;
  if (purchase.status !== "DRAFT") throw new Error("下書きの仕入れだけを確定できます。");
  const sum = purchase.lines.reduce((total, line) => total + line.finalLandedCostJpy, 0n);
  if (sum !== purchase.purchaseTotalJpy)
    throw new Error("仕入総額と明細原価の合計が一致しません。");
  if (purchase.purchaseType === "USED_BUNDLE") {
    if (purchase.expectedItemCount !== purchase.lines.length)
      throw new Error("予定点数と個体件数が一致しません。");
    if (
      purchase.lines.some(
        (line) => line.orderedQuantity !== 1 || !line.draftIndividualCode || !line.draftCondition,
      )
    ) {
      throw new Error("すべての個体についてコードと状態を入力してください。");
    }
  }
  if (
    purchase.lines.some(
      (line) =>
        line.trackingMode === "UNIQUE" && (line.orderedQuantity !== 1 || !line.draftCondition),
    )
  )
    throw new Error("個体管理の明細は1点固定で、状態の入力が必要です。");
  const already = await context.db.inventoryOperation.findUnique({
    where: { idempotencyKey: parsed.idempotencyKey },
  });
  if (already) return;
  await context.db.$transaction(
    async (tx) => {
      const current = await tx.purchase.findUnique({ where: { id: purchase.id } });
      if (!current || current.status !== "DRAFT") return;
      const operation = await tx.inventoryOperation.create({
        data: {
          workspaceId: context.workspaceId,
          businessUnitId: context.businessUnitId,
          operatorId: context.operatorId,
          operationType: "PURCHASE_RECEIPT",
          sourceType: "purchase",
          sourceId: purchase.id,
          idempotencyKey: parsed.idempotencyKey,
          occurredAt: new Date(),
        },
      });
      for (const [index, line] of purchase.lines.entries()) {
        await lockInventoryTarget(tx, line.itemVariantId, context.businessUnitId);
        const lot = await tx.inventoryLot.create({
          data: {
            itemVariantId: line.itemVariantId,
            trackingMode: line.trackingMode,
            purchaseLineId: line.id,
            receivedDate: purchase.purchasedDate,
            receivedQuantity: line.orderedQuantity,
            remainingQuantity: line.orderedQuantity,
            landedCostTotalJpy: line.finalLandedCostJpy,
            unitCostJpy: averageUnitCost(line.finalLandedCostJpy, line.orderedQuantity),
            costStatus: "FINAL",
            storageLocationId: purchase.storageLocationId,
          },
        });
        let uniqueId: string | null = null;
        if (line.trackingMode === "UNIQUE") {
          const individualCode =
            line.draftIndividualCode || (await nextWorkspaceCode(tx, context.workspaceId, "UNIT"));
          const unit = await tx.uniqueStockUnit.create({
            data: {
              workspaceId: context.workspaceId,
              itemVariantId: line.itemVariantId,
              inventoryLotId: lot.id,
              individualCode,
              condition: line.draftCondition!,
              measurementsJson: line.draftMeasurementsJson ?? {},
              acquisitionCostJpy: line.finalLandedCostJpy,
              storageLocationId: purchase.storageLocationId,
              memo: line.draftMemo,
            },
          });
          uniqueId = unit.id;
        }
        await tx.stockMovement.create({
          data: {
            operationId: operation.id,
            itemVariantId: line.itemVariantId,
            inventoryLotId: lot.id,
            uniqueStockUnitId: uniqueId,
            movementType: "RECEIPT",
            quantity: line.orderedQuantity,
            costTotalJpy: line.finalLandedCostJpy,
            movementAt: operation.occurredAt,
            businessUnitId: context.businessUnitId,
            storageLocationToId: purchase.storageLocationId,
            sourceType: "purchase_line",
            sourceId: line.id,
            idempotencyKey: `${parsed.idempotencyKey}:${index}`,
            operatorId: context.operatorId,
          },
        });
        const balance = await tx.inventoryCostBalance.findUnique({
          where: {
            itemVariantId_businessUnitId_trackingMode: {
              itemVariantId: line.itemVariantId,
              businessUnitId: context.businessUnitId,
              trackingMode: line.trackingMode,
            },
          },
        });
        const quantity = (balance?.quantity ?? 0) + line.orderedQuantity;
        const total = (balance?.carryingCostTotalJpy ?? 0n) + line.finalLandedCostJpy;
        await tx.inventoryCostBalance.upsert({
          where: {
            itemVariantId_businessUnitId_trackingMode: {
              itemVariantId: line.itemVariantId,
              businessUnitId: context.businessUnitId,
              trackingMode: line.trackingMode,
            },
          },
          create: {
            itemVariantId: line.itemVariantId,
            businessUnitId: context.businessUnitId,
            trackingMode: line.trackingMode,
            quantity,
            carryingCostTotalJpy: total,
            averageUnitCostJpy: averageUnitCost(total, quantity),
          },
          update: {
            quantity,
            carryingCostTotalJpy: total,
            averageUnitCostJpy: averageUnitCost(total, quantity),
          },
        });
      }
      await tx.purchase.update({
        where: { id: purchase.id },
        data: { status: "FINALIZED", finalizedAt: new Date() },
      });
      await writeAudit(tx, {
        workspaceId: context.workspaceId,
        userAccountId: context.session.userAccountId,
        operatorId: context.operatorId,
        action: "purchase.finalize",
        entityType: "purchase",
        entityId: purchase.id,
        before: { status: "DRAFT" },
        after: {
          status: "FINALIZED",
          purchaseTotalJpy: purchase.purchaseTotalJpy.toString(),
          lineCount: purchase.lines.length,
        },
      });
    },
    { isolationLevel: "Serializable", timeout: 20_000 },
  );
  revalidatePath("/inventory");
  revalidatePath("/purchases");
  revalidatePath(`/purchases/${purchase.id}`);
  revalidatePath("/");
}

export async function deleteDraftPurchaseAction(formData: FormData): Promise<void> {
  await assertTrustedOrigin();
  const context = await requireInventoryContext();
  const id = z.string().uuid().parse(formData.get("id"));
  const purchase = await context.db.purchase.findFirst({
    where: {
      id,
      workspaceId: context.workspaceId,
      businessUnitId: context.businessUnitId,
      status: "DRAFT",
    },
  });
  if (!purchase) throw new Error("削除できる下書きが見つかりません。");
  await context.db.$transaction(async (tx) => {
    await writeAudit(tx, {
      workspaceId: context.workspaceId,
      userAccountId: context.session.userAccountId,
      operatorId: context.operatorId,
      action: "purchase.draft.delete",
      entityType: "purchase",
      entityId: purchase.id,
      before: {
        purchaseCode: purchase.purchaseCode,
        purchaseTotalJpy: purchase.purchaseTotalJpy.toString(),
      },
    });
    await tx.purchase.delete({ where: { id: purchase.id } });
  });
  redirect("/purchases");
}

async function cancelPurchase(formData: FormData): Promise<void> {
  await assertTrustedOrigin();
  const parsed = z
    .object({
      id: z.string().uuid(),
      reason: z.string().trim().min(1).max(500),
      idempotencyKey: z.string().uuid(),
    })
    .parse(Object.fromEntries(formData));
  const initial = await requireInventoryContext();
  const replay = await initial.db.inventoryOperation.findUnique({
    where: { idempotencyKey: parsed.idempotencyKey },
  });
  if (replay) {
    if (
      replay.workspaceId === initial.workspaceId &&
      replay.businessUnitId === initial.businessUnitId &&
      replay.operationType === "PURCHASE_REVERSAL" &&
      replay.sourceType === "purchase" &&
      replay.sourceId === parsed.id
    ) {
      return;
    }
    throw new Error("同じ送信キーが別の在庫操作で使用されています。");
  }
  const purchase = await initial.db.purchase.findFirst({
    where: {
      id: parsed.id,
      workspaceId: initial.workspaceId,
      businessUnitId: initial.businessUnitId,
    },
    include: {
      lines: {
        include: { inventoryLot: { include: { uniqueStockUnits: true, stockMovements: true } } },
      },
    },
  });
  if (!purchase || purchase.status !== "FINALIZED")
    throw new Error("取消できる確定仕入れが見つかりません。");
  const context = await requireInventoryContext(purchase.purchasedDate);
  for (const line of purchase.lines) {
    const lot = line.inventoryLot;
    if (!lot || lot.remainingQuantity !== lot.receivedQuantity || lot.stockMovements.length !== 1) {
      throw new Error(
        "入庫後の移動があるため取消できません。対象商品の在庫履歴を確認してください。",
      );
    }
    if (lot.uniqueStockUnits.some((unit) => unit.status !== "IN_STOCK")) {
      throw new Error("状態が変更された個体を含むため取消できません。");
    }
  }
  await context.db.$transaction(
    async (tx) => {
      const operation = await tx.inventoryOperation.create({
        data: {
          workspaceId: context.workspaceId,
          businessUnitId: context.businessUnitId,
          operatorId: context.operatorId,
          operationType: "PURCHASE_REVERSAL",
          sourceType: "purchase",
          sourceId: purchase.id,
          idempotencyKey: parsed.idempotencyKey,
          occurredAt: new Date(),
          note: parsed.reason,
        },
      });
      for (const [index, line] of purchase.lines.entries()) {
        const lot = line.inventoryLot!;
        await lockInventoryTarget(tx, line.itemVariantId, context.businessUnitId);
        const balance = await tx.inventoryCostBalance.findUniqueOrThrow({
          where: {
            itemVariantId_businessUnitId_trackingMode: {
              itemVariantId: line.itemVariantId,
              businessUnitId: context.businessUnitId,
              trackingMode: line.trackingMode,
            },
          },
        });
        if (
          balance.quantity < line.orderedQuantity ||
          balance.carryingCostTotalJpy < line.finalLandedCostJpy
        )
          throw new Error("原価残高が不足するため取消できません。");
        const quantity = balance.quantity - line.orderedQuantity;
        const total = balance.carryingCostTotalJpy - line.finalLandedCostJpy;
        await tx.inventoryCostBalance.update({
          where: { id: balance.id },
          data: {
            quantity,
            carryingCostTotalJpy: total,
            averageUnitCostJpy: quantity === 0 ? 0 : averageUnitCost(total, quantity),
          },
        });
        await tx.inventoryLot.update({ where: { id: lot.id }, data: { remainingQuantity: 0 } });
        if (lot.uniqueStockUnits.length) {
          await tx.uniqueStockUnit.updateMany({
            where: { inventoryLotId: lot.id },
            data: { status: "PURCHASE_CANCELLED" },
          });
        }
        await tx.stockMovement.create({
          data: {
            operationId: operation.id,
            itemVariantId: line.itemVariantId,
            inventoryLotId: lot.id,
            uniqueStockUnitId: lot.uniqueStockUnits[0]?.id,
            movementType: "RECEIPT_REVERSAL",
            quantity: -line.orderedQuantity,
            costTotalJpy: -line.finalLandedCostJpy,
            movementAt: operation.occurredAt,
            businessUnitId: context.businessUnitId,
            storageLocationFromId: purchase.storageLocationId,
            sourceType: "purchase_line",
            sourceId: line.id,
            idempotencyKey: `${parsed.idempotencyKey}:${index}`,
            operatorId: context.operatorId,
            note: parsed.reason,
          },
        });
      }
      await tx.purchase.update({
        where: { id: purchase.id },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      });
      await writeAudit(tx, {
        workspaceId: context.workspaceId,
        userAccountId: context.session.userAccountId,
        operatorId: context.operatorId,
        action: "purchase.cancel",
        entityType: "purchase",
        entityId: purchase.id,
        before: { status: "FINALIZED" },
        after: { status: "CANCELLED", reason: parsed.reason },
      });
    },
    { isolationLevel: "Serializable", timeout: 20_000 },
  );
  revalidatePath("/inventory");
  revalidatePath(`/purchases/${purchase.id}`);
  revalidatePath("/");
}

export async function cancelPurchaseAction(
  _state: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  try {
    await cancelPurchase(formData);
    return { success: "仕入れを取り消しました。" };
  } catch (error) {
    return { error: message(error) };
  }
}

function locationBalances(
  movements: Array<{
    inventoryLotId: string | null;
    movementType: string;
    quantity: number;
    storageLocationFromId: string | null;
    storageLocationToId: string | null;
  }>,
  locationId: string,
) {
  const balances = new Map<string, number>();
  for (const row of movements) {
    if (!row.inventoryLotId) continue;
    let delta = 0;
    if (row.movementType === "LOCATION_TRANSFER") {
      if (row.storageLocationToId === locationId) delta += row.quantity;
      if (row.storageLocationFromId === locationId) delta -= row.quantity;
    } else {
      if (row.storageLocationToId === locationId) delta += row.quantity;
      if (row.storageLocationFromId === locationId) delta += row.quantity;
    }
    balances.set(row.inventoryLotId, (balances.get(row.inventoryLotId) ?? 0) + delta);
  }
  return balances;
}

export async function executeInventoryOperationAction(
  _state: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  try {
    await assertTrustedOrigin();
    const input = parsePayload(formData, inventoryOperationSchema);
    const date = tokyoDate(input.occurredDate);
    const context = await requireInventoryContext(date);
    const variant = await context.db.itemVariant.findFirst({
      where: {
        id: input.variantId,
        active: true,
        inventoryItem: {
          workspaceId: context.workspaceId,
          businessUnitId: context.businessUnitId,
          status: "ACTIVE",
        },
      },
      include: { inventoryItem: true },
    });
    if (!variant) throw new Error("対象商品が見つかりません。");
    const locationIds = [input.fromLocationId, input.toLocationId].filter(Boolean);
    const locationCount = await context.db.storageLocation.count({
      where: {
        id: { in: locationIds },
        workspaceId: context.workspaceId,
        active: true,
        OR: [{ businessUnitId: null }, { businessUnitId: context.businessUnitId }],
      },
    });
    if (locationCount !== new Set(locationIds).size) throw new Error("保管場所を使用できません。");
    if (
      await context.db.inventoryOperation.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      })
    )
      return { success: "この在庫操作は登録済みです。" };
    await context.db.$transaction(
      async (tx) => {
        await lockInventoryTarget(tx, variant.id, context.businessUnitId);
        const operation = await tx.inventoryOperation.create({
          data: {
            workspaceId: context.workspaceId,
            businessUnitId: context.businessUnitId,
            operatorId: context.operatorId,
            operationType: input.operationType,
            sourceType: "manual_adjustment",
            sourceId: input.idempotencyKey,
            idempotencyKey: input.idempotencyKey,
            occurredAt: new Date(),
            note: `${input.reason}: ${input.note}`.trim(),
          },
        });
        if (input.trackingMode === "UNIQUE") {
          if (
            !input.uniqueStockUnitId ||
            input.quantity !== 1 ||
            input.operationType === "ADJUSTMENT_IN"
          )
            throw new Error("個体商品の操作内容を確認してください。");
          const unit = await tx.uniqueStockUnit.findFirst({
            where: {
              id: input.uniqueStockUnitId,
              workspaceId: context.workspaceId,
              itemVariantId: variant.id,
              status: "IN_STOCK",
            },
          });
          if (!unit) throw new Error("在庫中の個体が見つかりません。");
          if (input.fromLocationId && unit.storageLocationId !== input.fromLocationId)
            throw new Error("個体の現在場所が移動元と一致しません。");
          const isTransfer = input.operationType === "LOCATION_TRANSFER";
          const movementType = input.operationType;
          const status =
            input.operationType === "DISPOSAL"
              ? "DISPOSED"
              : input.operationType === "LOSS"
                ? "LOST"
                : input.operationType === "PERSONAL_USE"
                  ? "PERSONAL_USE"
                  : input.operationType === "ADJUSTMENT_OUT"
                    ? "DISPOSED"
                    : "IN_STOCK";
          await tx.uniqueStockUnit.update({
            where: { id: unit.id },
            data: {
              storageLocationId: isTransfer ? input.toLocationId : unit.storageLocationId,
              status,
            },
          });
          if (!isTransfer) {
            await tx.inventoryLot.update({
              where: { id: unit.inventoryLotId },
              data: { remainingQuantity: 0 },
            });
            const balance = await tx.inventoryCostBalance.findUniqueOrThrow({
              where: {
                itemVariantId_businessUnitId_trackingMode: {
                  itemVariantId: variant.id,
                  businessUnitId: context.businessUnitId,
                  trackingMode: "UNIQUE",
                },
              },
            });
            const quantity = balance.quantity - 1;
            const total = balance.carryingCostTotalJpy - unit.acquisitionCostJpy;
            if (quantity < 0 || total < 0) throw new Error("在庫原価残高が不足しています。");
            await tx.inventoryCostBalance.update({
              where: { id: balance.id },
              data: {
                quantity,
                carryingCostTotalJpy: total,
                averageUnitCostJpy: quantity === 0 ? 0 : averageUnitCost(total, quantity),
              },
            });
          }
          await tx.stockMovement.create({
            data: {
              operationId: operation.id,
              itemVariantId: variant.id,
              inventoryLotId: unit.inventoryLotId,
              uniqueStockUnitId: unit.id,
              movementType,
              quantity: isTransfer ? 1 : -1,
              costTotalJpy: isTransfer ? 0n : -unit.acquisitionCostJpy,
              movementAt: operation.occurredAt,
              businessUnitId: context.businessUnitId,
              storageLocationFromId: input.fromLocationId || unit.storageLocationId,
              storageLocationToId: isTransfer ? input.toLocationId : null,
              sourceType: "manual_adjustment",
              sourceId: operation.id,
              idempotencyKey: `${input.idempotencyKey}:0`,
              operatorId: context.operatorId,
              note: `${input.reason}: ${input.note}`.trim(),
            },
          });
        } else if (input.operationType === "ADJUSTMENT_IN") {
          const unitCost = parseYen(input.unitCostJpy);
          const totalCost = unitCost * BigInt(input.quantity);
          const locationId = input.toLocationId || variant.inventoryItem.defaultStorageLocationId;
          if (!locationId) throw new Error("増加先の保管場所を選択してください。");
          const lot = await tx.inventoryLot.create({
            data: {
              itemVariantId: variant.id,
              trackingMode: "QUANTITY",
              receivedDate: date,
              receivedQuantity: input.quantity,
              remainingQuantity: input.quantity,
              landedCostTotalJpy: totalCost,
              unitCostJpy: averageUnitCost(totalCost, input.quantity),
              costStatus: "FINAL",
              storageLocationId: locationId,
            },
          });
          const balance = await tx.inventoryCostBalance.findUnique({
            where: {
              itemVariantId_businessUnitId_trackingMode: {
                itemVariantId: variant.id,
                businessUnitId: context.businessUnitId,
                trackingMode: "QUANTITY",
              },
            },
          });
          const quantity = (balance?.quantity ?? 0) + input.quantity;
          const total = (balance?.carryingCostTotalJpy ?? 0n) + totalCost;
          await tx.inventoryCostBalance.upsert({
            where: {
              itemVariantId_businessUnitId_trackingMode: {
                itemVariantId: variant.id,
                businessUnitId: context.businessUnitId,
                trackingMode: "QUANTITY",
              },
            },
            create: {
              itemVariantId: variant.id,
              businessUnitId: context.businessUnitId,
              trackingMode: "QUANTITY",
              quantity,
              carryingCostTotalJpy: total,
              averageUnitCostJpy: averageUnitCost(total, quantity),
            },
            update: {
              quantity,
              carryingCostTotalJpy: total,
              averageUnitCostJpy: averageUnitCost(total, quantity),
            },
          });
          await tx.stockMovement.create({
            data: {
              operationId: operation.id,
              itemVariantId: variant.id,
              inventoryLotId: lot.id,
              movementType: "ADJUSTMENT_IN",
              quantity: input.quantity,
              costTotalJpy: totalCost,
              movementAt: operation.occurredAt,
              businessUnitId: context.businessUnitId,
              storageLocationToId: locationId,
              sourceType: "manual_adjustment",
              sourceId: operation.id,
              idempotencyKey: `${input.idempotencyKey}:0`,
              operatorId: context.operatorId,
              note: `${input.reason}: ${input.note}`.trim(),
            },
          });
        } else {
          if (!input.fromLocationId) throw new Error("移動元の保管場所を選択してください。");
          const movements = await tx.stockMovement.findMany({
            where: {
              itemVariantId: variant.id,
              businessUnitId: context.businessUnitId,
              inventoryLot: { trackingMode: "QUANTITY" },
            },
            select: {
              inventoryLotId: true,
              movementType: true,
              quantity: true,
              storageLocationFromId: true,
              storageLocationToId: true,
            },
          });
          const byLot = locationBalances(movements, input.fromLocationId);
          const lots = await tx.inventoryLot.findMany({
            where: {
              itemVariantId: variant.id,
              trackingMode: "QUANTITY",
              remainingQuantity: { gt: 0 },
            },
            orderBy: [{ receivedDate: "asc" }, { id: "asc" }],
          });
          let remaining = input.quantity;
          const allocations: Array<{ lot: (typeof lots)[number]; quantity: number }> = [];
          for (const lot of lots) {
            const available = Math.min(lot.remainingQuantity, byLot.get(lot.id) ?? 0);
            if (available <= 0) continue;
            const quantity = Math.min(available, remaining);
            allocations.push({ lot, quantity });
            remaining -= quantity;
            if (!remaining) break;
          }
          if (remaining) throw new Error("移動元の在庫数量が不足しています。");
          const isTransfer = input.operationType === "LOCATION_TRANSFER";
          const balance = await tx.inventoryCostBalance.findUniqueOrThrow({
            where: {
              itemVariantId_businessUnitId_trackingMode: {
                itemVariantId: variant.id,
                businessUnitId: context.businessUnitId,
                trackingMode: "QUANTITY",
              },
            },
          });
          const outgoingCost = isTransfer
            ? 0n
            : movingAverageOutCost(balance.carryingCostTotalJpy, balance.quantity, input.quantity);
          let allocatedCost = 0n;
          for (const [index, allocation] of allocations.entries()) {
            const last = index === allocations.length - 1;
            const share = isTransfer
              ? 0n
              : last
                ? outgoingCost - allocatedCost
                : BigInt(
                    new Decimal(outgoingCost.toString())
                      .mul(allocation.quantity)
                      .div(input.quantity)
                      .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
                      .toFixed(0),
                  );
            allocatedCost += share;
            if (!isTransfer)
              await tx.inventoryLot.update({
                where: { id: allocation.lot.id },
                data: { remainingQuantity: { decrement: allocation.quantity } },
              });
            await tx.stockMovement.create({
              data: {
                operationId: operation.id,
                itemVariantId: variant.id,
                inventoryLotId: allocation.lot.id,
                movementType: input.operationType,
                quantity: isTransfer ? allocation.quantity : -allocation.quantity,
                costTotalJpy: isTransfer ? 0n : -share,
                movementAt: operation.occurredAt,
                businessUnitId: context.businessUnitId,
                storageLocationFromId: input.fromLocationId,
                storageLocationToId: isTransfer ? input.toLocationId : null,
                sourceType: "manual_adjustment",
                sourceId: operation.id,
                idempotencyKey: `${input.idempotencyKey}:${index}`,
                operatorId: context.operatorId,
                note: `${input.reason}: ${input.note}`.trim(),
              },
            });
          }
          if (!isTransfer) {
            const quantity = balance.quantity - input.quantity;
            const total = balance.carryingCostTotalJpy - outgoingCost;
            await tx.inventoryCostBalance.update({
              where: { id: balance.id },
              data: {
                quantity,
                carryingCostTotalJpy: total,
                averageUnitCostJpy: quantity === 0 ? 0 : averageUnitCost(total, quantity),
              },
            });
          }
        }
        await writeAudit(tx, {
          workspaceId: context.workspaceId,
          userAccountId: context.session.userAccountId,
          operatorId: context.operatorId,
          action: "inventory.operation",
          entityType: "inventory_operation",
          entityId: operation.id,
          after: {
            operationType: input.operationType,
            variantId: input.variantId,
            quantity: input.quantity,
            reason: input.reason,
          },
        });
      },
      { isolationLevel: "Serializable", timeout: 20_000 },
    );
    revalidatePath("/inventory");
    revalidatePath("/");
    return { success: "在庫操作を記録しました。" };
  } catch (error) {
    return { error: message(error) };
  }
}
