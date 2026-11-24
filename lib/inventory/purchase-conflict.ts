import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { z } from "zod";
import { type WorkflowContext } from "@/lib/sales/workflow-context";
import { WorkflowError } from "@/lib/sales/workflow-errors";
import { runWorkflow } from "@/lib/sales/workflow-runner";
import { toJson } from "@/lib/sales/request-store";
import {
  purchaseBaselineSchema,
  purchaseValues,
  type PurchaseBaseline,
} from "@/lib/inventory/purchase-comparison";
import type { PurchaseUiSnapshot } from "@/components/forms/purchase-form";

type Tx = Prisma.TransactionClient;
const contextSchema = z.object({
  businessUnitId: z.uuid(),
  operatorId: z.uuid(),
  year: z.number().int(),
});
export const purchaseReviewSchema = z.object({
  context: contextSchema,
  purchaseId: z.uuid().optional(),
  draftId: z.uuid().optional(),
});
const text = z.string().max(10000);
const measures = z.record(z.string(), text);
export const purchaseDraftInputSchema = z
  .object({
    purchaseId: z.uuid().optional(),
    revision: z.number().int().nonnegative().optional(),
    updatedAt: text.optional(),
    date: text,
    supplierId: text,
    locationId: text,
    orderNumber: text,
    total: text,
    memo: text,
    requestKey: text,
    step: z.number().int(),
    products: z
      .array(
        z.object({
          clientRef: text,
          itemCode: text,
          name: text,
          category: text,
          memo: text,
          defaultConditionCategory: z.enum(["NEW", "USED", "UNSPECIFIED"]),
          defaultTrackingMode: z.enum(["QUANTITY", "UNIQUE"]),
          variants: z
            .array(z.object({ clientRef: text, variantCode: text, attributes: measures }))
            .max(500),
        }),
      )
      .max(500),
    lines: z
      .array(
        z
          .object({
            clientRef: text,
            variant: z.discriminatedUnion("source", [
              z.object({ source: z.literal("EXISTING"), variantId: text }),
              z.object({ source: z.literal("NEW"), productRef: text, variantRef: text }),
            ]),
            trackingMode: z.enum(["QUANTITY", "UNIQUE"]),
            conditionCategory: z.enum(["NEW", "USED", "UNSPECIFIED"]),
            conditionDescription: text,
            sourceName: text,
            sourceUrl: text,
            quantity: z.number().int(),
            amountJpy: text,
            individualCode: text.optional(),
            measurements: measures.optional(),
            commonMeasurements: measures.optional(),
            memo: text.optional(),
          })
          .passthrough(),
      )
      .max(500),
  })
  .passthrough();
export const purchaseRebaseSchema = purchaseReviewSchema.extend({
  idempotencyKey: z.uuid(),
  draftId: z.uuid(),
  draftRevision: z.number().int().nonnegative(),
  purchaseRevision: z.number().int().nonnegative(),
  choice: z.enum(["LATEST", "LOCAL"]),
  baseSnapshot: purchaseBaselineSchema.nullable(),
  local: purchaseDraftInputSchema,
});
export async function purchaseLabels(tx: Tx, c: WorkflowContext) {
  const [suppliers, locations, variants] = await Promise.all([
    tx.counterparty.findMany({
      where: { workspaceId: c.workspaceId, type: "SUPPLIER" },
      orderBy: { name: "asc" },
    }),
    tx.storageLocation.findMany({
      where: {
        workspaceId: c.workspaceId,
        OR: [{ businessUnitId: null }, { businessUnitId: c.businessUnitId }],
      },
      orderBy: { code: "asc" },
    }),
    tx.itemVariant.findMany({
      where: { workspaceId: c.workspaceId, inventoryItem: { businessUnitId: c.businessUnitId } },
      include: { inventoryItem: true },
      orderBy: { id: "asc" },
    }),
  ]);
  return {
    suppliers: suppliers.map((x) => ({ id: x.id, label: x.name })),
    locations: locations.map((x) => ({ id: x.id, label: `${x.code} ${x.name}` })),
    variants: variants.map((x) => ({
      id: x.id,
      label: `${x.inventoryItem.itemCode} ${x.inventoryItem.name} ${Object.entries(
        x.attributesJson as Record<string, string>,
      )
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, value]) => value)
        .join("・")}`,
    })),
  };
}
export async function loadPurchaseReview(
  tx: Tx,
  c: WorkflowContext,
  input: { purchaseId?: string; draftId?: string },
) {
  const draft = input.draftId
    ? await tx.workflowDraft.findUnique({ where: { id: input.draftId } })
    : null;
  if (
    draft &&
    (draft.workspaceId !== c.workspaceId ||
      draft.businessUnitId !== c.businessUnitId ||
      draft.operatorId !== c.operatorId ||
      draft.year !== c.year ||
      draft.kind !== "PURCHASE")
  )
    throw new WorkflowError("CONTEXT_CHANGED", "元の入力者・部門・年度へ戻して比較してください。");
  const parsedStored = purchaseDraftInputSchema.safeParse(draft?.payload);
  const stored = parsedStored.success ? (parsedStored.data as PurchaseUiSnapshot) : null;
  if (input.purchaseId && stored?.purchaseId && input.purchaseId !== stored.purchaseId)
    throw new WorkflowError("CONTEXT_CHANGED", "仕入れと途中保存の対応が異なります。");
  let purchaseId = input.purchaseId ?? stored?.purchaseId;
  if (!purchaseId && draft?.archivedAt) {
    const applied = await tx.workflowRequest.findFirst({
      where: {
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        operatorId: c.operatorId,
        kind: "PURCHASE_SAVE",
        status: "APPLIED",
        payload: { path: ["draftId"], equals: draft.id },
      },
    });
    purchaseId = applied?.targetId ?? undefined;
  }
  const labels = await purchaseLabels(tx, c);
  let snapshot = stored ?? null;
  let baseline: PurchaseBaseline | null = null;
  let code: string | undefined, message: string | undefined;
  if (purchaseId) {
    const purchase = await tx.purchase.findFirst({
      where: { id: purchaseId, workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    if (!purchase)
      throw new WorkflowError(
        "CONTEXT_CHANGED",
        "この入力先では仕入れを参照できません。元の部門を確認してください。",
      );
    snapshot = {
      purchaseId,
      revision: purchase.revision,
      updatedAt: purchase.updatedAt.toISOString(),
      date: purchase.purchasedDate.toISOString().slice(0, 10),
      supplierId: purchase.supplierId,
      locationId: purchase.storageLocationId,
      orderNumber: purchase.orderNumber ?? "",
      total: purchase.purchaseTotalJpy.toString(),
      memo: purchase.memo ?? "",
      requestKey: purchase.requestKey,
      products: [],
      step: 3,
      lines: purchase.lines.map((line) => ({
        clientRef: line.id,
        variant: { source: "EXISTING" as const, variantId: line.itemVariantId },
        trackingMode: line.trackingMode,
        conditionCategory: line.conditionCategory,
        conditionDescription: line.draftCondition ?? "",
        sourceName: line.sourceName,
        sourceUrl: line.sourceUrl ?? "",
        quantity: line.orderedQuantity,
        amountJpy: line.finalLandedCostJpy.toString(),
        individualCode: line.draftIndividualCode ?? "",
        measurements:
          line.trackingMode === "UNIQUE"
            ? ((line.draftMeasurementsJson ?? {}) as Record<string, string>)
            : {},
        commonMeasurements:
          line.trackingMode === "QUANTITY"
            ? ((line.draftMeasurementsJson ?? {}) as Record<string, string>)
            : {},
        memo: line.draftMemo ?? "",
      })),
    };
    if (!["DRAFT", "FINALIZED", "CANCELLED"].includes(purchase.status))
      throw new WorkflowError("VALIDATION", "この種類の仕入れは今回の編集対象外です。");
    baseline = {
      purchaseId,
      revision: purchase.revision,
      status: purchase.status as "DRAFT" | "FINALIZED" | "CANCELLED",
      reportingEntityId: purchase.reportingEntityId,
      context: { businessUnitId: c.businessUnitId, operatorId: c.operatorId, year: c.year },
      values: purchaseValues(snapshot, labels),
    };
    if (purchase.status !== "DRAFT") {
      code = "PURCHASE_STATE";
      message =
        purchase.status === "FINALIZED"
          ? "別の操作で入庫済みになりました。編集・再入庫はできません。手元の入力は下に残しています。"
          : "この仕入れは取消済みです。手元の入力と取消結果を確認してください。";
    }
    if (purchase.reportingEntityId !== c.reportingEntityId) {
      code = "OWNERSHIP_CHANGED";
      message = "申告主体が変更されています。帰属の確認が必要です。";
    }
    if (purchase.purchasedDate.getUTCFullYear() !== c.year) {
      code = "CONTEXT_CHANGED";
      message = "元の仕入年度へ戻してください。入力先は自動変更していません。";
    }
  } else if (snapshot) {
    baseline = {
      purchaseId: null,
      revision: 0,
      status: "NEW",
      reportingEntityId: c.reportingEntityId,
      context: { businessUnitId: c.businessUnitId, operatorId: c.operatorId, year: c.year },
      values: purchaseValues(snapshot, labels),
    };
  }
  const fiscal = await tx.fiscalYearProfile.findFirst({
    where: { reportingEntityId: c.reportingEntityId, year: c.year },
  });
  const original = purchaseBaselineSchema.safeParse(draft?.baseSnapshot);
  if (
    original.success &&
    original.data.reportingEntityId &&
    original.data.reportingEntityId !== c.reportingEntityId
  ) {
    code = "OWNERSHIP_CHANGED";
    message = "入力開始後に申告主体が変更されています。帰属の確認が必要です。";
  }
  if (fiscal?.status === "LOCKED") {
    code = "YEAR_LOCKED";
    message = "年度がロックされました。閲覧・保存結果の確認のみ可能です。入力は保持しています。";
  }
  if (draft?.archivedAt) {
    const resolved = await tx.workflowRequest.findFirst({
      where: {
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        operatorId: c.operatorId,
        kind: "PURCHASE_REBASE",
        status: "APPLIED",
        payload: { path: ["draftId"], equals: draft.id },
      },
    });
    if (!input.purchaseId || resolved) {
      code = "DRAFT_CLOSED";
      message =
        "この途中保存は記録済み、または選び直し済みです。元の入力を保持しています。最新の仕入れ・選び直した下書きを確認してください。";
    }
  }
  return {
    baseline,
    input: snapshot,
    labels,
    draftRevision: draft?.revision ?? 0,
    code,
    message,
    canResolve: !code,
    previous: draft
      ? await tx.workflowRequest
          .findFirst({
            where: {
              workspaceId: c.workspaceId,
              businessUnitId: c.businessUnitId,
              operatorId: c.operatorId,
              year: c.year,
              kind: "PURCHASE_REBASE",
              status: "APPLIED",
              targetId: draft.id,
            },
            select: { payload: true },
          })
          .then((row) => {
            const parsed = purchaseRebaseSchema.safeParse(row?.payload);
            return parsed.success
              ? {
                  input: parsed.data.local as PurchaseUiSnapshot,
                  baseline: parsed.data.baseSnapshot,
                  choice: parsed.data.choice,
                }
              : null;
          })
      : null,
  };
}
export type PurchaseReview = Awaited<ReturnType<typeof loadPurchaseReview>>;

export async function rebasePurchase(
  db: PrismaClient,
  c: WorkflowContext,
  input: z.infer<typeof purchaseRebaseSchema>,
) {
  if (JSON.stringify(input).length > 200000)
    throw new WorkflowError("VALIDATION", "入力内容が大きすぎます。");
  const date = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  return runWorkflow(db, c, input, "PURCHASE_REBASE", date, async (tx) => {
    const review = await loadPurchaseReview(tx, c, input);
    if (input.local.purchaseId !== input.purchaseId)
      throw new WorkflowError("CONTEXT_CHANGED", "手元の入力と対象仕入れが一致しません。");
    if (!review.canResolve)
      throw new WorkflowError(
        review.code === "YEAR_LOCKED"
          ? "YEAR_LOCKED"
          : review.code === "OWNERSHIP_CHANGED"
            ? "OWNERSHIP_CHANGED"
            : "CONFLICT",
        review.message!,
      );
    if (
      review.draftRevision !== input.draftRevision ||
      (review.baseline?.revision ?? 0) !== input.purchaseRevision
    )
      throw new WorkflowError(
        "CONFLICT",
        "比較中に再び内容が更新されました。最新の差分を確認してください。",
      );
    const draft = await tx.workflowDraft.findUnique({ where: { id: input.draftId } });
    const payload = input.choice === "LATEST" ? review.input : input.local;
    if (!payload) throw new WorkflowError("VALIDATION", "選択する保存内容がありません。");
    const target = await tx.workflowDraft.create({
      data: {
        id: randomUUID(),
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        operatorId: c.operatorId,
        year: c.year,
        kind: "PURCHASE",
        revision: 1,
        baseSnapshot: review.baseline ? toJson(review.baseline) : undefined,
        payload: toJson({
          ...payload,
          purchaseId: input.purchaseId,
          revision: review.baseline?.revision ?? 0,
          updatedAt: review.input?.updatedAt,
          requestKey: randomUUID(),
          step: 3,
          sourceDraftId: input.draftId,
          resolution: input.choice,
          replacedFields:
            input.choice === "LOCAL"
              ? Object.keys(review.baseline?.values ?? {}).filter(
                  (k) =>
                    review.baseline?.values[k] !==
                    purchaseValues(input.local as PurchaseUiSnapshot, review.labels)[k],
                )
              : [],
        }),
      },
    });
    if (draft && !draft.archivedAt)
      await tx.workflowDraft.update({ where: { id: draft.id }, data: { archivedAt: new Date() } });
    if (!draft)
      await tx.workflowDraft.create({
        data: {
          id: input.draftId,
          workspaceId: c.workspaceId,
          businessUnitId: c.businessUnitId,
          operatorId: c.operatorId,
          year: c.year,
          kind: "PURCHASE",
          payload: toJson(input.local),
          baseSnapshot: input.baseSnapshot ? toJson(input.baseSnapshot) : undefined,
          archivedAt: new Date(),
        },
      });
    return {
      id: target.id,
      detail: {
        sourceDraftId: input.draftId,
        choice: input.choice,
        purchaseId: input.purchaseId,
        revision: review.baseline?.revision ?? 0,
        local: input.local,
        baseSnapshot: input.baseSnapshot,
      },
    };
  });
}
