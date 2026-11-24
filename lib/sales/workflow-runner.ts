import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { lockInventoryDomain } from "@/lib/inventory/domain-lock";
import { prepareRequest, assertRequestOwner, toJson } from "@/lib/sales/request-store";
import {
  WorkflowError,
  workflowRecoveryMessage,
  type WorkflowErrorCode,
} from "@/lib/sales/workflow-errors";
import {
  checkWorkflowContext,
  assertSubmittedOrigin,
  type WorkflowContext,
} from "@/lib/sales/workflow-context";
import type { WorkflowKind } from "@/lib/validation/workflow";
import { valuationSession } from "@/lib/inventory/valuation-session";
import { assertStoredStocktakes } from "@/lib/inventory/stocktake-integrity";
import { lockMasterDomain } from "@/lib/settings/master-version";
import {
  sharedValuationKinds,
  valuationCheckpoint,
  evaluateMutation,
  applyMutationValuation,
  PreviewRollback,
} from "@/lib/inventory/shared-valuation";

type Tx = Prisma.TransactionClient;
export type WorkflowHooks = {
  lockWorkspace?: boolean;
  validatePlan?: (tx: Tx, plan: Awaited<ReturnType<typeof evaluateMutation>>) => Promise<void>;
  after?: (tx: Tx, targetId: string) => Promise<void>;
};
const jsonValue = toJson;
const scope = (c: WorkflowContext) => ({
  workspaceId: c.workspaceId,
  businessUnitId: c.businessUnitId,
});
const instant = (date: string) => new Date(`${date}T00:00:00+09:00`);
async function lock(tx: Tx, key: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`;
}
async function record(
  tx: Tx,
  c: WorkflowContext,
  key: string,
  kind: WorkflowKind,
  targetId: string,
  date: string,
  detail: unknown,
) {
  const commerceEntities: Record<string, string> = {
    ITEM_SAVE: "inventory_item",
    SUPPLY_SAVE: "supply_item",
    MATERIAL_USE: "material_use",
    OTHER_RECORD: "other_record",
    CATEGORY_SAVE: "money_category",
    SUPPLIER_CONFIG: "counterparty",
    ACCOUNT_SAVE: "money_account",
    MONEY_RECORD: "money_transaction",
    PURCHASE_RETURN: "supplier_return",
    BUY: "purchase_document",
    BUY_CANCEL: "purchase_document",
    DELIVERY: "inbound_delivery",
    PURCHASE_COST: "purchase_charge",
    PURCHASE_REFUND: "purchase_charge",
    RECEIVE: "purchase_document",
    SALE: "sales_order",
    SKU_SAVE: "sales_sku",
    SKU_BATCH: "sales_sku",
    CHANNEL_SAVE: "sales_channel",
    DELIVERY_METHOD: "delivery_method",
    DRAFT_REBASE: "workflow_draft",
  };
  await tx.workflowEvent.create({
    data: {
      id: key,
      ...scope(c),
      operatorId: c.operatorId,
      year: c.year,
      kind,
      targetId,
      occurredAt: instant(date),
      detail: jsonValue(detail),
    },
  });
  await tx.auditLog.create({
    data: {
      workspaceId: c.workspaceId,
      userAccountId: c.userAccountId,
      operatorId: c.operatorId,
      action: `workflow.${kind}`,
      entityType:
        commerceEntities[kind] ??
        (kind === "PURCHASE_REBASE" || kind === "RETURN_REBASE" || kind === "LISTING_RETURN_REBASE"
          ? "workflow_draft"
          : kind.startsWith("PURCHASE_")
            ? "purchase"
            : kind === "STOCKTAKE"
              ? "inventory_item"
              : kind === "DATE_CORRECT"
                ? "event_date_correction"
                : kind === "INVENTORY"
                  ? "inventory_item"
                  : ["AMEND", "COMPLETE", "REFUND", "RETURN"].includes(kind)
                    ? "sales_order"
                    : "listing"),
      entityId: targetId,
      afterJson: jsonValue(detail),
      requestId: key,
    },
  });
}

export async function runWorkflow(
  db: PrismaClient,
  c: WorkflowContext,
  input: { idempotencyKey: string },
  kind: WorkflowKind,
  date: string,
  fn: (tx: Tx) => Promise<{ id: string; detail: unknown }>,
  hooks?: WorkflowHooks,
) {
  const preview = !!valuationSession.getStore()?.preview;
  if (!preview) await prepareRequest(db, c, input.idempotencyKey, kind, input);
  try {
    return await db.$transaction(
      async (tx) => {
        await lock(tx, `workflow:${input.idempotencyKey}`);
        const savedRequest = preview
          ? null
          : await tx.workflowRequest.findUniqueOrThrow({
              where: { id: input.idempotencyKey },
            });
        if (savedRequest) assertRequestOwner(savedRequest, c);
        if (savedRequest?.status === "APPLIED") return savedRequest.targetId!;
        if (savedRequest?.status === "REJECTED")
          throw new WorkflowError(
            (savedRequest.errorCode ?? "VALIDATION") as WorkflowErrorCode,
            savedRequest.errorMessage ?? workflowRecoveryMessage(savedRequest.errorCode),
          );
        if (savedRequest && savedRequest.status !== "PREPARED")
          throw new WorkflowError(
            "CANCELLED",
            "この保存要求は取消済み、または確認・修正が必要です。内容を確認して新しい要求で保存してください。",
          );
        if (
          hooks?.lockWorkspace ||
          [
            "ITEM_SAVE",
            "SUPPLY_SAVE",
            "DELIVERY_METHOD",
            "CHANNEL_SAVE",
            "SUPPLIER_SAVE",
            "SUPPLIER_CONFIG",
            "CATEGORY_SAVE",
            "OTHER_RECORD",
          ].includes(kind)
        )
          await lockMasterDomain(tx, c.workspaceId);
        await lockInventoryDomain(tx, c.businessUnitId);
        assertSubmittedOrigin(input, c);
        if ("draftId" in input && typeof input.draftId === "string")
          await lock(tx, `draft:${input.draftId}`);
        await checkWorkflowContext(
          tx,
          c,
          kind === "PURCHASE_REBASE" || kind === "RETURN_REBASE" || kind === "LISTING_RETURN_REBASE"
            ? undefined
            : date,
        );
        const prior = await tx.workflowEvent.findUnique({ where: { id: input.idempotencyKey } });
        const request = jsonValue(input);
        if (prior) {
          if (
            prior.workspaceId !== c.workspaceId ||
            prior.businessUnitId !== c.businessUnitId ||
            prior.kind !== kind ||
            JSON.stringify((prior.detail as { request: unknown }).request) !==
              JSON.stringify(request)
          ) {
            // JSONB key order is not stable; compare canonical representations below.
            if (
              !sameJson((prior.detail as { request: unknown }).request, request) ||
              prior.workspaceId !== c.workspaceId ||
              prior.businessUnitId !== c.businessUnitId ||
              prior.kind !== kind
            )
              throw new Error("操作キーが別の記録に使用されています。保存結果を確認してください。");
          }
          await tx.workflowRequest.update({
            where: { id: input.idempotencyKey },
            data: { status: "APPLIED", targetId: prior.targetId },
          });
          return prior.targetId;
        }
        const valuationInput = input as {
          idempotencyKey: string;
          valuationFingerprint?: string;
          valuationPosition?: string;
        };
        const useValuation =
          sharedValuationKinds.has(kind) &&
          (preview ||
            !!valuationInput.valuationFingerprint ||
            [
              "BUY_CANCEL",
              "BUY",
              "RECEIVE",
              "SALE",
              "DELIVERY",
              "PURCHASE_COST",
              "PURCHASE_REFUND",
              "PURCHASE_RETURN",
            ].includes(kind));
        const checkpoint = useValuation ? await valuationCheckpoint(tx, c, input) : null;
        const plan = checkpoint
          ? await evaluateMutation(tx, c, valuationInput, checkpoint, () => fn(tx))
          : null;
        if (preview && plan) throw new PreviewRollback(plan);
        if (plan && hooks?.validatePlan) await hooks.validatePlan(tx, plan);
        if (
          plan &&
          (plan.requiresOrder ||
            (!hooks?.validatePlan && plan.fingerprint !== valuationInput.valuationFingerprint))
        )
          throw new WorkflowError(
            "VALUATION_REQUIRED",
            "原価・在庫・同日順序の確認条件が変わりました。影響を再確認してください。",
          );
        const result = plan
          ? await valuationSession.run(
              {
                evaluating: true,
                costs: plan.costs,
                order: plan.order,
                requestKey: input.idempotencyKey,
              },
              () => fn(tx),
            )
          : await fn(tx);
        await assertStoredStocktakes(tx, c);
        if (plan) await applyMutationValuation(tx, c, input.idempotencyKey, kind, result.id, plan);
        await record(tx, c, input.idempotencyKey, kind, result.id, date, {
          request,
          result: result.detail,
        });
        await tx.workflowRequest.update({
          where: { id: input.idempotencyKey },
          data: { status: "APPLIED", targetId: result.id },
        });
        await hooks?.after?.(tx, result.id);
        return result.id;
      },
      { timeout: 20000 },
    );
  } catch (caught) {
    if (preview || caught instanceof PreviewRollback) throw caught;
    const error =
      caught && typeof caught === "object" && "code" in caught && caught.code === "P2002"
        ? new WorkflowError(
            "DUPLICATE",
            "二重登録を防ぎました。同じ出品ID・個体コードなどの記録がないか一覧を確認してください。",
          )
        : caught;
    if (error instanceof WorkflowError || (error instanceof Error && !("code" in error))) {
      await db.$transaction(async (tx) => {
        await lock(tx, `workflow:${input.idempotencyKey}`);
        await tx.workflowRequest.updateMany({
          where: { id: input.idempotencyKey, status: "PREPARED" },
          data: {
            status: "REJECTED",
            errorCode: error instanceof WorkflowError ? error.code : "VALIDATION",
            errorMessage:
              error instanceof WorkflowError ? error.message.slice(0, 2000) || null : null,
            errorFields:
              error instanceof WorkflowError &&
              error.detail &&
              typeof error.detail === "object" &&
              "fields" in error.detail
                ? toJson(error.detail.fields)
                : undefined,
          },
        });
      });
    }
    throw error;
  }
}
function sameJson(a: unknown, b: unknown): boolean {
  const canonical = (v: unknown): string =>
    v && typeof v === "object"
      ? Array.isArray(v)
        ? `[${v.map(canonical).join(",")}]`
        : `{${Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
            .join(",")}}`
      : JSON.stringify(v);
  return canonical(a) === canonical(b);
}
