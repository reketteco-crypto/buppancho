"use server";

import {
  listingEstimateSchema,
  previewListingEstimate,
  type ListingEstimate,
} from "@/lib/sales/listing-estimate";

import { revalidatePath } from "next/cache";
import { inputOriginSchema, assertInputOrigin } from "@/lib/sales/input-origin";
import { assertSubmittedOrigin } from "@/lib/sales/workflow-context";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assertTrustedOrigin } from "@/lib/auth/origin";
import { requireInventoryContext } from "@/lib/inventory/context";
import {
  recordListing,
  recordCompletion,
  recordListingEvent,
  amendAmounts,
  recordPrice,
  jsonValue,
  checkWorkflowContext,
  previewCompletion,
} from "@/lib/sales/workflow";
import {
  listingRecordSchema,
  completionRecordSchema,
  listingEventSchema,
  amountAmendSchema,
  priceRecordSchema,
  workflowContextSchema,
} from "@/lib/validation/workflow";
import {
  requestResult,
  fingerprint,
  prepareRequest,
  assertRequestOwner,
  rejectInvalidRequest,
} from "@/lib/sales/request-store";
import { WorkflowError } from "@/lib/sales/workflow-errors";
import { lockInventoryDomain } from "@/lib/inventory/domain-lock";
import { recordInventoryOperation } from "@/lib/inventory/workflow";
import { recordStocktake } from "@/lib/inventory/stocktake-workflow";
import { recordListingReturn, closeListingReturn } from "@/lib/sales/listing-return-workflow";
import { listingReturnSchema, listingReturnCloseSchema } from "@/lib/validation/workflow";
import {
  loadListingReturnDraftReview,
  rebaseListingReturn,
} from "@/lib/sales/listing-return-drafts";
import {
  listingReturnDraftInputSchema,
  listingReturnSnapshotSchema,
  listingReturnRebaseSchema,
} from "@/lib/sales/listing-return-input";
import { stocktakeRecordSchema } from "@/lib/validation/workflow";
import { recordPurchase, recordPurchaseEvent } from "@/lib/inventory/purchase-workflow";
import {
  loadPurchaseReview,
  rebasePurchase,
  purchaseReviewSchema,
  purchaseRebaseSchema,
  type PurchaseReview,
} from "@/lib/inventory/purchase-conflict";
import { purchaseBaselineSchema } from "@/lib/inventory/purchase-comparison";
import {
  captureValuationPreview,
  type SharedValuationPreview,
} from "@/lib/inventory/shared-valuation";
import { dateCorrectionSchema, recordDateCorrection } from "@/lib/inventory/date-correction";
import {
  returnInputSchema,
  returnSnapshotSchema,
  returnReviewSchema,
  returnPreviewSchema,
  returnRecordSchema,
  returnRebaseSchema,
} from "@/lib/sales/return-types";
import {
  recordReturn,
  rebaseReturn,
  loadReturnReview,
  previewReturnWorkflow,
  type ReturnPreview,
  type ReturnReview,
} from "@/lib/sales/return-workflow";
import { purchaseRecordSchema, purchaseEventSchema } from "@/lib/validation/workflow";
import {
  inventoryRecordSchema,
  workflowKindSchema,
  type WorkflowKind,
} from "@/lib/validation/workflow";

import {
  workflowResult,
  type WorkflowResult,
  type WorkflowFeedback,
} from "@/lib/sales/workflow-result";
export type { WorkflowResult, WorkflowFeedback } from "@/lib/sales/workflow-result";
export async function previewListingEstimateAction(
  payload: unknown,
): Promise<{ preview?: ListingEstimate } & WorkflowFeedback> {
  try {
    const input = listingEstimateSchema.parse(payload);
    const { db, c } = await contextFor(input.context);
    return { preview: await previewListingEstimate(db, c, input) };
  } catch (error) {
    return failure(error);
  }
}
async function contextFor(expected: z.infer<typeof workflowContextSchema>, readOnly = false) {
  await assertTrustedOrigin();
  const context = await requireInventoryContext();
  if (
    !readOnly &&
    expected.reportingEntityId !== undefined &&
    expected.reportingEntityId !== context.reportingEntityId
  )
    throw new WorkflowError(
      "OWNERSHIP_CHANGED",
      "入力開始後に申告主体が変更されています。元の帰属を確認してください。",
    );
  if (
    context.businessUnitId !== expected.businessUnitId ||
    context.operatorId !== expected.operatorId ||
    (!readOnly && context.fiscalYear.year !== expected.year)
  )
    throw new WorkflowError(
      "CONTEXT_CHANGED",
      "入力中に入力者・部門・年度が変更されました。元の選択に戻して保存するか、入力をやり直してください。",
    );
  if (!readOnly && context.fiscalYear.status === "LOCKED")
    throw new WorkflowError(
      "YEAR_LOCKED",
      "ロック済み年度には保存できません。入力内容はこの画面に保持されています。",
    );
  return {
    db: context.db,
    c: {
      workspaceId: context.workspaceId,
      businessUnitId: context.businessUnitId,
      operatorId: context.operatorId,
      year: context.fiscalYear.year,
      reportingEntityId: context.reportingEntityId,
      userAccountId: context.session.userAccountId,
      sessionId: context.session.id,
    },
  };
}
function failure(e: unknown): WorkflowFeedback {
  if (e instanceof WorkflowError)
    return {
      error: e.message,
      code: e.code,
      status: "REJECTED",
      ...(e.detail && typeof e.detail === "object" && "fields" in e.detail
        ? { fields: e.detail.fields as Record<string, string> }
        : {}),
    };
  if (e instanceof z.ZodError)
    return {
      error: "入力項目を確認してください。",
      status: "REJECTED",
      code: "VALIDATION",
      fields: Object.fromEntries(e.issues.map((i) => [i.path.join("."), i.message])),
    };
  if (e && typeof e === "object" && "code" in e && e.code === "P2002")
    return { error: "二重登録を防ぎました。出品一覧または保存結果を確認してください。" };
  if (e && typeof e === "object" && "code" in e && e.code === "P2034")
    return {
      error: "別操作と競合しました。入力を保持したまま、保存結果を確認して再実行できます。",
    };
  return {
    error:
      e instanceof Error && !("code" in e)
        ? e.message
        : "通信を確認中です。保存結果を確認してから同じ操作を再実行してください。",
  };
}
export async function submitWorkflowAction(
  kind: WorkflowKind,
  payload: unknown,
): Promise<WorkflowResult> {
  if (kind === "YEAR_SWITCH") return switchCompletionYearAction(payload);
  try {
    const expected = z.object({ context: workflowContextSchema }).parse(payload).context;
    const { db, c } = await contextFor(expected, true);
    if (
      [
        "LIST",
        "COMPLETE",
        "EVENT",
        "PRICE",
        "LISTING_RETURN",
        "LISTING_RETURN_CLOSE",
        "LISTING_RETURN_REBASE",
      ].includes(kind)
    ) {
      const retired =
        kind === "LIST"
          ? listingRecordSchema.parse(payload)
          : kind === "COMPLETE"
            ? completionRecordSchema.parse(payload)
            : kind === "EVENT"
              ? listingEventSchema.parse(payload)
              : kind === "PRICE"
                ? priceRecordSchema.parse(payload)
                : kind === "LISTING_RETURN"
                  ? listingReturnSchema.parse(payload)
                  : kind === "LISTING_RETURN_CLOSE"
                    ? listingReturnCloseSchema.parse(payload)
                    : listingReturnRebaseSchema.parse(payload);
      return await rejectInvalidRequest(db, c, retired.idempotencyKey, kind, retired, {
        workflow:
          "出品操作の受付は終了しました。販売の記録から入力してください。以前の履歴と保存結果は参照できます。",
      });
    }
    if (kind === "EVENT" && (payload as { event?: string }).event === "MIGRATE")
      throw new WorkflowError(
        "VALIDATION",
        "旧方式の移行操作は終了しました。新しい出品を記録してください。",
      );
    const current = await requireInventoryContext();
    if (kind === "LISTING_RETURN" || kind === "LISTING_RETURN_CLOSE")
      z.object({
        draftId: z.uuid(),
        draftRevision: z.number().int().nonnegative(),
        draftInput: listingReturnDraftInputSchema,
        baseSnapshot: listingReturnSnapshotSchema.nullable(),
      }).parse(payload);
    if (current.fiscalYear.year !== expected.year)
      throw new WorkflowError(
        "CONTEXT_CHANGED",
        "入力した出来事の年度へ切り替えてから保存してください。",
      );
    const id =
      kind === "LISTING_RETURN_REBASE"
        ? await rebaseListingReturn(db, c, listingReturnRebaseSchema.parse(payload))
        : kind === "LISTING_RETURN"
          ? await recordListingReturn(db, c, listingReturnSchema.parse(payload))
          : kind === "LISTING_RETURN_CLOSE"
            ? await closeListingReturn(db, c, listingReturnCloseSchema.parse(payload))
            : kind === "STOCKTAKE"
              ? await recordStocktake(db, c, stocktakeRecordSchema.parse(payload))
              : kind === "DATE_CORRECT"
                ? await recordDateCorrection(db, c, dateCorrectionSchema.parse(payload))
                : kind === "RETURN" || kind === "REFUND"
                  ? await recordReturn(
                      db,
                      c,
                      returnRecordSchema.parse({ ...(payload as object), kind }),
                    )
                  : kind === "RETURN_REBASE"
                    ? await rebaseReturn(db, c, returnRebaseSchema.parse(payload))
                    : kind === "PURCHASE_REBASE"
                      ? await rebasePurchase(db, c, purchaseRebaseSchema.parse(payload))
                      : kind === "PURCHASE_SAVE"
                        ? await recordPurchase(db, c, purchaseRecordSchema.parse(payload))
                        : kind === "PURCHASE_RECEIVE" || kind === "PURCHASE_CANCEL"
                          ? await recordPurchaseEvent(
                              db,
                              c,
                              purchaseEventSchema.parse(payload),
                              kind,
                            )
                          : kind === "INVENTORY"
                            ? await recordInventoryOperation(
                                db,
                                c,
                                inventoryRecordSchema.parse(payload),
                              )
                            : kind === "LIST"
                              ? await recordListing(db, c, listingRecordSchema.parse(payload))
                              : kind === "COMPLETE"
                                ? await recordCompletion(
                                    db,
                                    c,
                                    completionRecordSchema
                                      .refine(
                                        (v) => !!v.valuationFingerprint,
                                        "完了日の原価と影響を確認してから記録してください。",
                                      )
                                      .parse(payload),
                                  )
                                : kind === "EVENT"
                                  ? await recordListingEvent(
                                      db,
                                      c,
                                      listingEventSchema.parse(payload),
                                    )
                                  : kind === "PRICE"
                                    ? await recordPrice(db, c, priceRecordSchema.parse(payload))
                                    : await amendAmounts(db, c, amountAmendSchema.parse(payload));
    revalidatePath("/", "layout");
    if (kind === "RETURN" || kind === "REFUND")
      return requestResult(
        db,
        c,
        z.object({ idempotencyKey: z.uuid() }).parse(payload).idempotencyKey,
      );
    return { id, saved: true, status: "APPLIED" };
  } catch (e) {
    const error = failure(e);
    try {
      const envelope = z
        .object({ idempotencyKey: z.uuid(), context: workflowContextSchema })
        .parse(payload);
      const { db, c } = await contextFor(envelope.context, true);
      if (e instanceof z.ZodError) {
        try {
          return await rejectInvalidRequest(
            db,
            c,
            envelope.idempotencyKey,
            kind,
            payload,
            error.fields ?? {},
          );
        } catch {
          // The key may already belong to another request. Its real state wins.
          return requestResult(db, c, envelope.idempotencyKey);
        }
      }
      const result = await requestResult(db, c, envelope.idempotencyKey);
      // A payload mismatch says nothing about whether the original request ran.
      // Keep its actual state; do not unlock editing by inventing a rejection.
      if (e instanceof WorkflowError && e.code === "KEY_REUSED")
        return workflowResult({ ...result, ...error, status: result.status });
      if (result.status === "REJECTED")
        return workflowResult({ ...result, ...error, status: "REJECTED" });
      return workflowResult({ ...error, ...result });
    } catch {
      return workflowResult({ ...error, status: "UNKNOWN" });
    }
  }
}
export async function previewWorkflowValuationAction(
  raw: unknown,
): Promise<WorkflowFeedback & { preview?: SharedValuationPreview }> {
  try {
    const envelope = z
      .object({
        kind: z.enum([
          "INVENTORY",
          "PURCHASE_RECEIVE",
          "PURCHASE_CANCEL",
          "DATE_CORRECT",
          "STOCKTAKE",
          "LISTING_RETURN",
        ]),
        payload: z.record(z.string(), z.unknown()),
      })
      .parse(raw);
    const expected = z.object({ context: workflowContextSchema }).parse(envelope.payload).context;
    const { db, c } = await contextFor(expected);
    const payload = { ...envelope.payload, idempotencyKey: randomUUID() };
    const preview = await captureValuationPreview(() =>
      envelope.kind === "LISTING_RETURN"
        ? recordListingReturn(db, c, listingReturnSchema.parse(payload))
        : envelope.kind === "STOCKTAKE"
          ? recordStocktake(db, c, stocktakeRecordSchema.parse(payload))
          : envelope.kind === "INVENTORY"
            ? recordInventoryOperation(db, c, inventoryRecordSchema.parse(payload))
            : envelope.kind === "DATE_CORRECT"
              ? recordDateCorrection(db, c, dateCorrectionSchema.parse(payload))
              : recordPurchaseEvent(db, c, purchaseEventSchema.parse(payload), envelope.kind),
    );
    return { preview };
  } catch (error) {
    return failure(error);
  }
}
export async function lookupWorkflowAction(
  key: string,
  expected: z.infer<typeof workflowContextSchema>,
): Promise<WorkflowResult> {
  try {
    const { db, c } = await contextFor(workflowContextSchema.parse(expected), true);
    const result = await requestResult(db, c, z.uuid().parse(key));
    return workflowResult(result);
  } catch (e) {
    return workflowResult({ ...failure(e), status: "UNKNOWN" });
  }
}

export async function cancelWorkflowRequestAction(
  key: string,
  expected: z.infer<typeof workflowContextSchema>,
): Promise<WorkflowResult> {
  try {
    const { db, c } = await contextFor(workflowContextSchema.parse(expected), true);
    const result = await requestResult(db, c, z.uuid().parse(key), true);
    return workflowResult(result);
  } catch (e) {
    return workflowResult({ ...failure(e), status: "UNKNOWN" });
  }
}
export async function resumeWorkflowRequestAction(
  key: string,
  expected: z.infer<typeof workflowContextSchema>,
): Promise<WorkflowResult> {
  try {
    const { db, c } = await contextFor(workflowContextSchema.parse(expected), true),
      result = await requestResult(db, c, z.uuid().parse(key));
    if (result.status !== "PREPARED") return workflowResult(result);
    const payload = { ...(result.payload as Record<string, unknown>) };
    for (const field of ["fee", "shipping", "packing", "other", "expectedShipping"])
      if (payload[field] === null) payload[field] = "";
    const kind = workflowKindSchema.parse(result.kind);
    return submitWorkflowAction(kind, payload);
  } catch (e) {
    return workflowResult({ ...failure(e), status: "UNKNOWN" });
  }
}

export type ValuationPreview = {
  orderImpacts: {
    id: string;
    name: string;
    date: string;
    beforeCost: string | null;
    afterCost: string | null;
    beforeProfit: string | null;
    afterProfit: string | null;
  }[];
  fingerprint: string;
  cost: string;
  final: boolean;
  requiresOrder: boolean;
  choices: { id: string; label: string }[];
  changes: {
    type: string;
    id: string;
    before: string;
    after: string;
    date: string;
    orderId?: string;
  }[];
  balances: { variantId: string; before: string; after: string; quantity: number }[];
};
export async function previewCompletionAction(
  payload: unknown,
): Promise<{ preview?: ValuationPreview } & WorkflowFeedback> {
  try {
    const input = completionRecordSchema.parse(payload),
      { db, c } = await contextFor(input.context);
    const result = await previewCompletion(db, c, input);
    return {
      preview: {
        orderImpacts: result.orderImpacts.map((x) => ({
          ...x,
          beforeCost: x.beforeCost?.toString() ?? null,
          afterCost: x.afterCost?.toString() ?? null,
          beforeProfit: x.beforeProfit?.toString() ?? null,
          afterProfit: x.afterProfit?.toString() ?? null,
        })),
        fingerprint: result.fingerprint,
        cost: result.cost.toString(),
        final: result.final,
        requiresOrder: result.requiresOrder,
        choices: result.choices,
        changes: result.changes.map((x) => ({
          ...x,
          before: x.before.toString(),
          after: x.after.toString(),
        })),
        balances: [...result.balances].map(([variantId, b]) => ({
          variantId,
          before: b.before.toString(),
          after: b.after.toString(),
          quantity: b.quantity,
        })),
      },
    };
  } catch (e) {
    return failure(e);
  }
}
export async function loadListingReturnDraftReviewAction(raw: unknown) {
  try {
    const input = z
      .object({ context: workflowContextSchema, listingId: z.uuid(), draftId: z.uuid().optional() })
      .parse(raw);
    const { db, c } = await contextFor(input.context, true);
    const review = await db.$transaction(async (tx) => {
      await lockInventoryDomain(tx, c.businessUnitId);
      if (input.draftId)
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`draft:${input.draftId}`},0))`;
      return loadListingReturnDraftReview(tx, c, input);
    });
    return { review };
  } catch (error) {
    return { error: failure(error).error, code: failure(error).code };
  }
}
export async function saveWorkflowDraftAction(payload: unknown): Promise<WorkflowFeedback> {
  try {
    const input = z
      .object({
        id: z.uuid(),
        requestId: z.uuid().optional(),
        context: workflowContextSchema,
        kind: z.enum(["LISTING", "PURCHASE", "COMPLETION", "RETURN", "REFUND", "LISTING_RETURN"]),
        revision: z.number().int().min(0),
        payload: z.record(z.string(), z.unknown()),
        baseSnapshot: z
          .union([
            purchaseBaselineSchema,
            returnSnapshotSchema,
            listingReturnSnapshotSchema,
            inputOriginSchema,
          ])
          .nullable()
          .optional(),
      })
      .parse(payload);
    if (JSON.stringify(input).length > 200000)
      throw new Error("入力内容が大きすぎます。明細を分けてください。");
    const { db, c } = await contextFor(input.context, true);
    return await db.$transaction(async (tx) => {
      await lockInventoryDomain(tx, c.businessUnitId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`draft:${input.id}`},0))`;
      const prior = await tx.workflowDraft.findUnique({ where: { id: input.id } });
      if (
        prior &&
        (prior.workspaceId !== c.workspaceId ||
          prior.businessUnitId !== c.businessUnitId ||
          prior.operatorId !== c.operatorId ||
          prior.year !== input.context.year ||
          prior.kind !== input.kind)
      )
        throw new Error("別の入力者・部門・年度の途中保存です。元の選択に戻してください。");
      if (input.requestId) {
        const receipt = await tx.draftSaveReceipt.findUnique({ where: { id: input.requestId } });
        if (receipt) {
          if (receipt.draftId !== input.id || receipt.fingerprint !== fingerprint(input))
            throw new WorkflowError("KEY_REUSED", "途中保存キーの内容が一致しません。");
          return { id: input.id, revision: receipt.revision, saved: true };
        }
      }
      // A lost acknowledgement remains readable after a year lock. New writes do not.
      if (c.year !== input.context.year)
        throw new WorkflowError(
          "CONTEXT_CHANGED",
          "元の年度へ戻してから途中保存してください。入力先は変更していません。",
        );
      await checkWorkflowContext(tx, c);
      assertSubmittedOrigin(input, c);
      if (input.kind === "LISTING") assertInputOrigin(prior?.baseSnapshot ?? input.baseSnapshot, c);
      const original = purchaseBaselineSchema.safeParse(prior?.baseSnapshot ?? input.baseSnapshot);
      if (
        input.kind === "PURCHASE" &&
        original.success &&
        original.data.reportingEntityId &&
        original.data.reportingEntityId !== c.reportingEntityId
      )
        throw new WorkflowError(
          "OWNERSHIP_CHANGED",
          "入力開始後に申告主体が変更されています。帰属を確認してください。",
        );
      if (prior?.archivedAt)
        return {
          code: "CONFLICT",
          revision: prior.revision,
          payload: prior.payload,
          error:
            "この入力は記録済み、または選び直し済みです。元の入力を保持して結果を確認してください。",
        };
      if ((prior?.revision ?? 0) !== input.revision)
        return {
          error: "別端末の途中保存と競合しています。再読み込みする前に入力を確認してください。",
          code: "CONFLICT",
          revision: prior?.revision ?? 0,
          payload: prior?.payload ?? {},
        };
      if (input.kind === "PURCHASE" && typeof input.payload.purchaseId === "string") {
        const purchase = await tx.purchase.findFirst({
          where: {
            id: z.uuid().parse(input.payload.purchaseId),
            workspaceId: c.workspaceId,
            businessUnitId: c.businessUnitId,
          },
        });
        if (!purchase)
          throw new WorkflowError(
            "CONTEXT_CHANGED",
            "元の入力先へ戻して仕入れを確認してください。",
          );
        if (purchase.reportingEntityId !== c.reportingEntityId)
          throw new WorkflowError(
            "OWNERSHIP_CHANGED",
            "仕入れの申告主体が変更されています。帰属を確認してください。",
          );
        if (purchase.status !== "DRAFT" || purchase.revision !== input.payload.revision)
          return {
            code: "CONFLICT",
            revision: prior?.revision ?? 0,
            payload: prior?.payload ?? {},
            error:
              purchase.status === "DRAFT"
                ? "仕入れ本体が別端末で更新されました。内容を比較してください。"
                : "入庫・取消により仕入れの状態が変わりました。入力を保持して最新実績を確認してください。",
          };
      }
      const data = {
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        operatorId: c.operatorId,
        year: c.year,
        kind: input.kind,
        payload: jsonValue(input.payload),
        revision: (prior?.revision ?? 0) + 1,
      };
      if (input.kind === "LISTING_RETURN") {
        const planned = listingReturnDraftInputSchema.parse(input.payload);
        const review = await loadListingReturnDraftReview(tx, c, {
          listingId: planned.listingId,
          draftId: prior?.id,
        });
        if (review.activeRequest || review.code)
          throw new WorkflowError(
            (review.code ?? "CONFLICT") as "CONFLICT" | "YEAR_LOCKED",
            review.message ?? "元の保存要求の結果を先に確認してください。",
          );
        const base = listingReturnSnapshotSchema.safeParse(
          prior?.baseSnapshot ?? input.baseSnapshot,
        );
        if (
          planned.caseId !== review.snapshot.caseId ||
          (base.success &&
            (base.data.caseId !== planned.caseId ||
              base.data.listingId !== planned.listingId ||
              base.data.reportingEntityId !== c.reportingEntityId ||
              base.data.context.businessUnitId !== c.businessUnitId ||
              base.data.context.operatorId !== c.operatorId ||
              base.data.context.year !== c.year))
        )
          throw new WorkflowError(
            "CONTEXT_CHANGED",
            "入力先・返送案件が入力開始時と異なります。付け替えていません。",
          );
        if (base.success && base.data.revision !== review.snapshot.revision)
          return {
            code: "CONFLICT",
            revision: prior?.revision ?? 0,
            payload: prior?.payload ?? {},
            error: "返送案件が更新されました。手元入力と現在の記録を比較してください。",
          };
      }
      if (input.kind === "RETURN" || input.kind === "REFUND") {
        const planned = returnInputSchema.parse(input.payload);
        if (planned.kind !== input.kind)
          throw new WorkflowError("CONTEXT_CHANGED", "途中保存の操作が異なります。");
        const review = await loadReturnReview(tx, c, {
          kind: input.kind,
          orderId: planned.orderId,
          draftId: prior?.id,
        });
        if (review.activeRequest?.status === "PREPARED")
          throw new WorkflowError(
            "CONFLICT",
            "元の保存要求が未解決です。先に保存結果を確認してください。",
          );
        if (review.code)
          throw new WorkflowError(
            review.code as "CONFLICT" | "YEAR_LOCKED" | "OWNERSHIP_CHANGED" | "CONTEXT_CHANGED",
            review.message!,
          );
        const base = returnSnapshotSchema.safeParse(prior?.baseSnapshot ?? input.baseSnapshot);
        if (
          base.success &&
          (base.data.orderId !== planned.orderId ||
            base.data.reportingEntityId !== c.reportingEntityId)
        )
          throw new WorkflowError(
            "OWNERSHIP_CHANGED",
            "入力開始時と対象・申告主体が異なります。帰属を確認してください。",
          );
        if (base.success && base.data.revision !== review.snapshot.revision)
          return {
            code: "CONFLICT",
            revision: prior?.revision ?? 0,
            payload: prior?.payload ?? {},
            error: "実績が別端末で更新されました。手元入力と最新実績を比較してください。",
          };
      }
      const row = prior
        ? await tx.workflowDraft.update({ where: { id: prior.id }, data })
        : await tx.workflowDraft.create({
            data: {
              id: input.id,
              ...data,
              baseSnapshot: input.baseSnapshot ? jsonValue(input.baseSnapshot) : undefined,
            },
          });
      if (input.requestId)
        await tx.draftSaveReceipt.create({
          data: {
            id: input.requestId,
            draftId: row.id,
            fingerprint: fingerprint(input),
            revision: row.revision,
          },
        });
      await tx.auditLog.create({
        data: {
          workspaceId: c.workspaceId,
          operatorId: c.operatorId,
          userAccountId: c.userAccountId,
          action: "workflow.draft.save",
          entityType: "workflow_draft",
          entityId: row.id,
          afterJson: { revision: row.revision, kind: row.kind },
          requestId: input.id,
        },
      });
      return { id: row.id, revision: row.revision, saved: true };
    });
  } catch (e) {
    return failure(e);
  }
}

export async function loadReturnReviewAction(
  payload: unknown,
): Promise<{ review?: ReturnReview } & WorkflowFeedback> {
  try {
    const input = returnReviewSchema.parse(payload),
      { db, c } = await contextFor(input.context, true);
    if (c.year !== input.context.year)
      throw new WorkflowError("CONTEXT_CHANGED", "元の年度へ戻して比較してください。");
    return { review: await loadReturnReview(db, c, input) };
  } catch (e) {
    return failure(e);
  }
}
export async function previewReturnAction(
  payload: unknown,
): Promise<{ preview?: ReturnPreview } & WorkflowFeedback> {
  try {
    const input = returnPreviewSchema.parse(payload),
      { db, c } = await contextFor(input.context);
    return { preview: await previewReturnWorkflow(db, c, input) };
  } catch (e) {
    return failure(e);
  }
}

export async function loadPurchaseReviewAction(
  payload: unknown,
): Promise<{ review?: PurchaseReview; error?: string; code?: string }> {
  try {
    const input = purchaseReviewSchema.parse(payload);
    const { db, c } = await contextFor(input.context, true);
    if (c.year !== input.context.year)
      throw new WorkflowError(
        "CONTEXT_CHANGED",
        "元の年度へ戻して比較してください。入力先は変更していません。",
      );
    return { review: await loadPurchaseReview(db, c, input) };
  } catch (error) {
    return {
      error:
        error instanceof WorkflowError
          ? error.message
          : "比較内容を取得できません。通信と元の入力先を確認してください。",
      code: error instanceof WorkflowError ? error.code : "UNKNOWN",
    };
  }
}

export async function switchCompletionYearAction(payload: unknown): Promise<WorkflowResult> {
  try {
    const input = z
      .object({
        idempotencyKey: z.uuid(),
        context: workflowContextSchema,
        draftId: z.uuid(),
        draftRevision: z.number().int().nonnegative(),
        listingId: z.uuid(),
        targetDate: z.iso.date(),
        payload: z.record(z.string(), z.unknown()),
      })
      .parse(payload);
    if (JSON.stringify(input.payload).length > 200000)
      throw new Error("途中保存の内容が大きすぎます。");
    const { db, c } = await contextFor(input.context, true),
      year = Number(input.targetDate.slice(0, 4));
    await prepareRequest(db, c, input.idempotencyKey, "YEAR_SWITCH", input);
    const id = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`workflow:${input.idempotencyKey}`},0))`;
      const request = await tx.workflowRequest.findUniqueOrThrow({
        where: { id: input.idempotencyKey },
      });
      assertRequestOwner(request, c);
      if (request.status === "APPLIED") return request.targetId!;
      if (request.status !== "PREPARED")
        throw new WorkflowError(
          "CANCELLED",
          "この年度切替要求は取消済みです。保存結果を確認してください。",
        );
      await lockInventoryDomain(tx, c.businessUnitId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`draft:${input.draftId}`},0))`;
      await tx.$queryRaw`SELECT id FROM auth_session WHERE id=${c.sessionId}::uuid FOR UPDATE`;
      const session = await tx.authSession.findFirst({
        where: {
          id: c.sessionId,
          userAccountId: c.userAccountId,
          activeBusinessUnitId: c.businessUnitId,
          activeOperatorId: c.operatorId,
          selectedYear: input.context.year,
          revokedAt: null,
          expiresAt: { gt: new Date() },
          absoluteExpiresAt: { gt: new Date() },
        },
      });
      if (!session)
        throw new WorkflowError(
          "CONTEXT_CHANGED",
          "入力先・セッションが変わりました。再ログインして元の入力先を確認してください。",
        );
      const assignment = await tx.businessUnitAssignment.findFirst({
        where: {
          businessUnitId: c.businessUnitId,
          fiscalYearProfile: { year },
          effectiveFrom: { lte: new Date(input.targetDate) },
          effectiveTo: { gte: new Date(input.targetDate) },
        },
        include: { fiscalYearProfile: true },
      });
      if (!assignment)
        throw new WorkflowError(
          "CONTEXT_CHANGED",
          `${year}年度の部門設定がありません。年度設定を作成して、この画面へ戻ってください。`,
        );
      const entity = assignment.fiscalYearProfile.reportingEntityId;
      const listing = await tx.listing.findFirst({
        where: {
          id: input.listingId,
          salesSku: { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
        },
      });
      if (
        !listing ||
        !listing.originReportingEntityId ||
        listing.originReportingEntityId !== entity
      )
        throw new WorkflowError(
          "OWNERSHIP_CHANGED",
          "出品時の帰属を確認できないか、申告主体が変わります。在庫移管の確認が必要です。",
        );
      await checkWorkflowContext(
        tx,
        { ...c, year, reportingEntityId: entity, sessionId: undefined },
        input.targetDate,
      );
      const prior = await tx.workflowDraft.findUnique({ where: { id: input.draftId } });
      if (
        prior &&
        (prior.workspaceId !== c.workspaceId ||
          prior.businessUnitId !== c.businessUnitId ||
          prior.operatorId !== c.operatorId ||
          prior.year !== input.context.year ||
          prior.kind !== "COMPLETION" ||
          prior.archivedAt)
      )
        throw new WorkflowError(
          "CONFLICT",
          "途中保存が変更されました。元の保存内容を確認してください。",
        );
      if ((prior?.revision ?? 0) !== input.draftRevision)
        throw new WorkflowError(
          "CONFLICT",
          "年度切替の前に途中保存が更新されました。保存完了を待ち、最新の内容を確認してください。",
        );
      const draft = await tx.workflowDraft.create({
        data: {
          id: randomUUID(),
          workspaceId: c.workspaceId,
          businessUnitId: c.businessUnitId,
          operatorId: c.operatorId,
          year,
          kind: "COMPLETION",
          revision: 1,
          payload: jsonValue({ ...input.payload, listingId: listing.id }),
        },
      });
      await tx.workflowDraft.upsert({
        where: { id: input.draftId },
        create: {
          id: input.draftId,
          workspaceId: c.workspaceId,
          businessUnitId: c.businessUnitId,
          operatorId: c.operatorId,
          year: input.context.year,
          kind: "COMPLETION",
          payload: jsonValue(input.payload),
          archivedAt: new Date(),
        },
        update: { archivedAt: new Date() },
      });
      await tx.authSession.update({ where: { id: session.id }, data: { selectedYear: year } });
      await tx.workflowRequest.update({
        where: { id: input.idempotencyKey },
        data: { status: "APPLIED", targetId: draft.id },
      });
      await tx.auditLog.create({
        data: {
          workspaceId: c.workspaceId,
          userAccountId: c.userAccountId,
          operatorId: c.operatorId,
          action: "workflow.draft.year_switch",
          entityType: "workflow_draft",
          entityId: draft.id,
          requestId: input.idempotencyKey,
          beforeJson: { year: input.context.year, draftId: input.draftId },
          afterJson: { year, sourceDraftId: input.draftId },
        },
      });
      return draft.id;
    });
    return { id, saved: true, status: "APPLIED" };
  } catch (e) {
    const error = failure(e);
    try {
      const input = z
        .object({ idempotencyKey: z.uuid(), context: workflowContextSchema })
        .parse(payload);
      const { db, c } = await contextFor(input.context, true);
      const result = await requestResult(db, c, input.idempotencyKey);
      return workflowResult({ ...error, ...result });
    } catch {
      return workflowResult({ ...error, status: "UNKNOWN" });
    }
  }
}
