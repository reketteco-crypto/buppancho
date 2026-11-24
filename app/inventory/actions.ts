"use server";

import { updateCatalogItem } from "@/lib/commerce/catalog-edit";

import {
  lockMasterDomain,
  assertMasterVersion,
  assertMasterCanDeactivate,
} from "@/lib/settings/master-version";
import { masterAction, type MasterResult } from "@/lib/settings/master-result";

import { lockInventoryDomain } from "@/lib/inventory/domain-lock";

import { checkWorkflowContext } from "@/lib/sales/workflow";

import { Prisma } from "@/generated/prisma/client";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertTrustedOrigin } from "@/lib/auth/origin";
import { writeAudit } from "@/lib/audit/write";
import { nextWorkspaceCode } from "@/lib/inventory/codes";
import { lockInventoryTarget, requireInventoryContext, tokyoDate } from "@/lib/inventory/context";
import { averageUnitCost, parseYen } from "@/lib/inventory/money";
import {
  inventoryItemSchema,
  parsePayload,
  quantityPurchaseSchema,
  unifiedPurchaseSchema,
  usedBundlePurchaseSchema,
} from "@/lib/validation/inventory";

async function rejectRetiredPurchaseWrite(): Promise<void> {
  await requireInventoryContext();
  throw new Error(
    "仕入れ画面を開き直してください。保存結果を確認できる新しい操作へ切り替わりました。",
  );
}

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
      await lockInventoryDomain(tx, context.businessUnitId);
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

export async function updateStorageLocationAction(formData: FormData): Promise<MasterResult> {
  return masterAction(async () => {
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
    await context.db.$transaction(async (tx) => {
      await lockMasterDomain(tx, context.workspaceId);
      await assertMasterVersion(
        tx,
        context.workspaceId,
        "storage_location",
        existing.id,
        formData.get("revision"),
      );
      if (!active) await assertMasterCanDeactivate(tx, "storage_location", existing.id);
      await lockInventoryDomain(tx, context.businessUnitId);
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
  });
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
      await lockInventoryDomain(tx, context.businessUnitId);
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

export async function updateSupplierAction(formData: FormData): Promise<MasterResult> {
  return masterAction(async () => {
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
      await lockMasterDomain(tx, context.workspaceId);
      await assertMasterVersion(
        tx,
        context.workspaceId,
        "counterparty",
        existing.id,
        formData.get("revision"),
      );
      await lockInventoryDomain(tx, context.businessUnitId);
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
  });
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
      await lockInventoryDomain(tx, context.businessUnitId);
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

export async function updateInventoryItemAction(formData: FormData): Promise<MasterResult> {
  return masterAction(async () => {
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
    await context.db.$transaction(async (tx) => {
      await lockMasterDomain(tx, context.workspaceId);
      await assertMasterVersion(
        tx,
        context.workspaceId,
        "inventory_item",
        existing.id,
        formData.get("revision"),
      );
      if (!active) await assertMasterCanDeactivate(tx, "inventory_item", existing.id);
      await lockInventoryDomain(tx, context.businessUnitId);
      await updateCatalogItem(tx, context, {
        id: existing.id,
        revision: Number(formData.get("revision")),
        name: parsed.name,
        category: parsed.category,
        memo: parsed.memo,
        locationId: parsed.defaultStorageLocationId,
        defaultConditionCategory: parsed.defaultConditionCategory,
        active,
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
  });
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
      await lockInventoryDomain(tx, context.businessUnitId);
      await checkWorkflowContext(tx, {
        workspaceId: context.workspaceId,
        businessUnitId: context.businessUnitId,
        operatorId: context.operatorId,
        year: context.fiscalYear.year,
        reportingEntityId: context.reportingEntityId,
        userAccountId: context.session.userAccountId,
        sessionId: context.session.id,
      });
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
    await rejectRetiredPurchaseWrite();
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
    await rejectRetiredPurchaseWrite();
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

async function persistUnifiedPurchase(
  payload: UnifiedPurchasePayload,
  expected?: { businessUnitId: string; operatorId: string; year: number },
  draftId?: string,
  updatedAt?: string,
) {
  const date = tokyoDate(payload.purchasedDate);
  const context = await requireInventoryContext(date);
  if (
    expected &&
    (expected.businessUnitId !== context.businessUnitId ||
      expected.operatorId !== context.operatorId ||
      expected.year !== context.fiscalYear.year)
  )
    throw new Error(
      "入力中に部門・年度・入力者が変更されました。元の選択に戻して保存してください。",
    );
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
      await lockInventoryDomain(tx, context.businessUnitId);
      await checkWorkflowContext(tx, {
        workspaceId: context.workspaceId,
        businessUnitId: context.businessUnitId,
        operatorId: context.operatorId,
        year: context.fiscalYear.year,
        reportingEntityId: context.reportingEntityId,
        userAccountId: context.session.userAccountId,
        sessionId: context.session.id,
      });
      await checkWorkflowContext(
        tx,
        {
          workspaceId: context.workspaceId,
          businessUnitId: context.businessUnitId,
          operatorId: context.operatorId,
          year: context.fiscalYear.year,
          reportingEntityId: context.reportingEntityId,
          userAccountId: context.session.userAccountId,
          sessionId: context.session.id,
        },
        payload.purchasedDate,
      );
      if (draftId)
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`draft:${draftId}`},0))`;
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
      if (editing && (!updatedAt || editing.updatedAt.toISOString() !== updatedAt))
        throw new Error(
          "別端末で仕入れが更新されました。入力を控えてから再読み込みし、差分を確認してください。",
        );

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
      if (draftId) {
        const prior = await tx.workflowDraft.findUnique({ where: { id: draftId } });
        if (
          prior &&
          (prior.workspaceId !== context.workspaceId ||
            prior.businessUnitId !== context.businessUnitId ||
            prior.operatorId !== context.operatorId ||
            prior.year !== context.fiscalYear.year ||
            prior.kind !== "PURCHASE")
        )
          throw new Error("途中保存の入力先が一致しません。");
        await tx.workflowDraft.upsert({
          where: { id: draftId },
          create: {
            id: draftId,
            workspaceId: context.workspaceId,
            businessUnitId: context.businessUnitId,
            operatorId: context.operatorId,
            year: context.fiscalYear.year,
            kind: "PURCHASE",
            payload: { purchaseId: purchase.id },
            archivedAt: new Date(),
          },
          update: { archivedAt: new Date() },
        });
      }
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
    await rejectRetiredPurchaseWrite();
    const rawContext = formData.get("inputContext");
    const expected =
      typeof rawContext === "string" && rawContext !== "null"
        ? z
            .object({ businessUnitId: z.uuid(), operatorId: z.uuid(), year: z.number().int() })
            .parse(JSON.parse(rawContext))
        : undefined;
    const draftId = formData.get("draftId"),
      updatedAt = formData.get("updatedAt");
    const purchase = await persistUnifiedPurchase(
      parsePayload(formData, unifiedPurchaseSchema),
      expected,
      typeof draftId === "string" ? z.uuid().parse(draftId) : undefined,
      typeof updatedAt === "string" && updatedAt ? z.iso.datetime().parse(updatedAt) : undefined,
    );
    redirect(`/purchases/${purchase.id}`);
  } catch (error) {
    if (typeof error === "object" && error && "digest" in error) throw error;
    return { error: message(error) };
  }
}

export async function finalizePurchaseAction(formData: FormData): Promise<void> {
  await assertTrustedOrigin();
  await rejectRetiredPurchaseWrite();
  const parsed = z
    .object({
      id: z.string().uuid(),
      idempotencyKey: z.string().uuid(),
      receivedDate: z.string().optional(),
    })
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
  const receivedDate = parsed.receivedDate
    ? tokyoDate(parsed.receivedDate)
    : purchase.purchasedDate;
  await requireInventoryContext(receivedDate);
  if (receivedDate < purchase.purchasedDate)
    throw new Error("入庫日は仕入日以降を指定してください。");
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
      await lockInventoryDomain(tx, context.businessUnitId);
      await checkWorkflowContext(tx, {
        workspaceId: context.workspaceId,
        businessUnitId: context.businessUnitId,
        operatorId: context.operatorId,
        year: context.fiscalYear.year,
        reportingEntityId: context.reportingEntityId,
        userAccountId: context.session.userAccountId,
        sessionId: context.session.id,
      });
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
          occurredAt: new Date(`${receivedDate.toISOString().slice(0, 10)}T00:00:00+09:00`),
        },
      });
      for (const [index, line] of purchase.lines.entries()) {
        await lockInventoryTarget(tx, line.itemVariantId, context.businessUnitId);
        const lot = await tx.inventoryLot.create({
          data: {
            itemVariantId: line.itemVariantId,
            trackingMode: line.trackingMode,
            purchaseLineId: line.id,
            receivedDate,
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
  await rejectRetiredPurchaseWrite();
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
    await lockInventoryDomain(tx, context.businessUnitId);
    await checkWorkflowContext(tx, {
      workspaceId: context.workspaceId,
      businessUnitId: context.businessUnitId,
      operatorId: context.operatorId,
      year: context.fiscalYear.year,
      reportingEntityId: context.reportingEntityId,
      userAccountId: context.session.userAccountId,
      sessionId: context.session.id,
    });
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
  await rejectRetiredPurchaseWrite();
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
      await lockInventoryDomain(tx, context.businessUnitId);
      await checkWorkflowContext(tx, {
        workspaceId: context.workspaceId,
        businessUnitId: context.businessUnitId,
        operatorId: context.operatorId,
        year: context.fiscalYear.year,
        reportingEntityId: context.reportingEntityId,
        userAccountId: context.session.userAccountId,
        sessionId: context.session.id,
      });
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
        if (
          await tx.inventoryReservation.count({
            where: {
              status: "RESERVED",
              OR: [{ inventoryLotId: lot.id }, { uniqueStockUnit: { inventoryLotId: lot.id } }],
            },
          })
        )
          throw new Error(
            "出品・注文に確保済みの在庫があります。関連出品の終了・返送確認を先に行ってください。",
          );
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

export async function executeInventoryOperationAction(
  _state: InventoryActionState,
  _formData: FormData,
): Promise<InventoryActionState> {
  await assertTrustedOrigin();
  await requireInventoryContext();
  void _state;
  void _formData;
  return {
    error: "在庫操作画面を開き直してください。保存結果を確認できる新しい操作へ切り替わりました。",
  };
}
