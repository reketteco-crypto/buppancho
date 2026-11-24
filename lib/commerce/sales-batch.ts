import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { checkWorkflowContext, type WorkflowContext } from "@/lib/sales/workflow-context";
import { WorkflowError } from "@/lib/sales/workflow-errors";
import { fingerprint, toJson } from "@/lib/sales/request-store";
import { lockMasterDomain } from "@/lib/settings/master-version";
import { assertStoredStocktakes } from "@/lib/inventory/stocktake-integrity";
import { valuationSession } from "@/lib/inventory/valuation-session";
import {
  applyMutationValuation,
  evaluateMutation,
  valuationCheckpoint,
} from "@/lib/inventory/shared-valuation";
import { recordSale, recordSaleTransaction } from "./workflow";
import { saleSchema, type SaleInput } from "./input";
import { skuMaterialQuote } from "./supplies";
import { saleRecordId } from "./sale-ids";
import {
  salesBatchDataSchema,
  salesBatchChangesSchema,
  type SalesBatchData,
  type SalesBatchMapping,
  type SalesBatchPreviewRow,
  type SalesBatchReview,
  type SalesBatchRow,
} from "./sales-batch-types";

type Tx = Prisma.TransactionClient;
type Plan = Awaited<ReturnType<typeof evaluateMutation>>;
type StoredReview = {
  batchId: string;
  batchRevision: number;
  baseline: string;
  next: number;
  entries: { rowId: string; input: SaleInput; digest: string; preview: SalesBatchPreviewRow }[];
};
const BATCH = "COMMERCE_SALE_BATCH",
  REVIEW = "COMMERCE_SALE_REVIEW",
  MAPPING = "COMMERCE_SALE_MAPPING";
const scope = (c: WorkflowContext) => ({
  workspaceId: c.workspaceId,
  businessUnitId: c.businessUnitId,
  operatorId: c.operatorId,
  year: c.year,
});
const businessScope = (c: WorkflowContext) => ({
  workspaceId: c.workspaceId,
  businessUnitId: c.businessUnitId,
});
const conflict = (
  message = "入力または在庫が変わりました。手元の入力を保持し、確認し直してください。",
) => new WorkflowError("CONFLICT", message);

async function readDraft(tx: Tx, c: WorkflowContext, id: string, kind: string) {
  const row = await tx.workflowDraft.findFirst({
    where: { id, kind, ...scope(c), archivedAt: null },
  });
  if (
    !row ||
    (row.baseSnapshot as { reportingEntityId?: string } | null)?.reportingEntityId !==
      c.reportingEntityId
  )
    throw new WorkflowError(
      "CONTEXT_CHANGED",
      "元の入力者・部門・申告主体・年度で開いてください。",
    );
  return row;
}
async function audit(tx: Tx, c: WorkflowContext, id: string, action: string, detail: unknown) {
  await tx.auditLog.create({
    data: {
      workspaceId: c.workspaceId,
      userAccountId: c.userAccountId,
      operatorId: c.operatorId,
      entityType: "workflow_draft",
      entityId: id,
      action,
      afterJson: toJson(detail),
    },
  });
}
async function lockBatch(tx: Tx, c: WorkflowContext, id: string) {
  await lockMasterDomain(tx, c.workspaceId);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`draft:${id}`},0))`;
  await checkWorkflowContext(tx, c);
}
// A cursor for real committed state. It is advanced only inside a sale's transaction,
// never by comparing a client-provided or silently refreshed preview fingerprint.
async function state(tx: Tx, c: WorkflowContext) {
  const [checkpoint, skus, channels, methods, accounts, supplies, workspace] = await Promise.all([
    valuationCheckpoint(tx, c, {}),
    tx.salesSku.findMany({
      where: businessScope(c),
      include: { components: true, supplySettings: true, channelSettings: true },
      orderBy: { id: "asc" },
    }),
    tx.salesChannel.findMany({ where: { workspaceId: c.workspaceId }, orderBy: { id: "asc" } }),
    tx.deliveryMethod.findMany({ where: { workspaceId: c.workspaceId }, orderBy: { id: "asc" } }),
    tx.moneyAccount.findMany({
      where: { ...businessScope(c), reportingEntityId: c.reportingEntityId },
      orderBy: { id: "asc" },
    }),
    tx.supplyItem.findMany({ where: businessScope(c), orderBy: { id: "asc" } }),
    tx.workspace.findUniqueOrThrow({ where: { id: c.workspaceId }, select: { revision: true } }),
  ]);
  // Relations have no guaranteed database order.
  const ordered = skus.map((s) => ({
    ...s,
    components: s.components.sort((a, b) => a.id.localeCompare(b.id)),
    supplySettings: s.supplySettings.sort((a, b) => a.id.localeCompare(b.id)),
    channelSettings: s.channelSettings.sort((a, b) => a.id.localeCompare(b.id)),
  }));
  return fingerprint({
    checkpoint: checkpoint.fingerprint,
    skus: ordered,
    channels,
    methods,
    accounts,
    supplies,
    workspace,
  });
}
function planDigest(plan: Plan) {
  return fingerprint({
    cost: plan.cost,
    order: plan.order,
    changes: [...plan.changes].sort((a, b) =>
      `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`),
    ),
    balances: [...plan.balances].sort((a, b) =>
      `${a.variantId}:${a.trackingMode}`.localeCompare(`${b.variantId}:${b.trackingMode}`),
    ),
    impacts: [...plan.orderImpacts].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    ),
  });
}

export async function readSalesBatch(db: PrismaClient, c: WorkflowContext, id: string) {
  return db.$transaction(async (tx) => {
    await checkWorkflowContext(tx, c);
    const draft = await readDraft(tx, c, id, BATCH);
    const latest = await tx.workflowDraft.findFirst({
      where: {
        ...scope(c),
        kind: REVIEW,
        archivedAt: null,
        baseSnapshot: { path: ["batchId"], equals: id },
      },
      orderBy: { createdAt: "desc" },
    });
    const stored = latest?.payload as unknown as StoredReview | undefined;
    return {
      id: draft.id,
      revision: draft.revision,
      data: salesBatchDataSchema.parse(draft.payload),
      review:
        latest && stored
          ? ({
              id: latest.id,
              rows: stored.entries.map((e) => e.preview),
              issues: [],
            } as SalesBatchReview)
          : undefined,
      recovery:
        stored && stored.next < stored.entries.length
          ? { index: stored.next, key: stored.entries[stored.next]!.input.idempotencyKey }
          : undefined,
    };
  });
}

export async function forkSalesBatch(
  db: PrismaClient,
  c: WorkflowContext,
  id: string,
  newId: string,
  raw: unknown,
) {
  const input = z
    .object({
      revision: z.number().int().nonnegative(),
      baseline: salesBatchDataSchema,
      local: salesBatchDataSchema,
      reason: z.string().trim().min(1).max(1000),
    })
    .parse(raw);
  return db.$transaction(async (tx) => {
    await lockBatch(tx, c, id);
    const original = await readDraft(tx, c, id, BATCH);
    const existing = await tx.workflowDraft.findUnique({ where: { id: newId } });
    const snapshot = {
      reportingEntityId: c.reportingEntityId,
      originalDraftId: id,
      originalRevision: input.revision,
      baseline: input.baseline,
      local: input.local,
      reason: input.reason,
    };
    if (existing) {
      await readDraft(tx, c, newId, BATCH);
      if (fingerprint(existing.baseSnapshot) !== fingerprint(snapshot)) throw conflict();
      return { id: newId };
    }
    const reviews = await tx.workflowDraft.findMany({
      where: { ...scope(c), kind: REVIEW, baseSnapshot: { path: ["batchId"], equals: id } },
    });
    const keys = reviews.flatMap((r) =>
      (r.payload as unknown as StoredReview).entries.map((e) => e.input.idempotencyKey),
    );
    if (await tx.workflowRequest.count({ where: { id: { in: keys }, status: "PREPARED" } }))
      throw conflict("元の確定要求を照会・取消してから選び直してください。");
    const saved = salesBatchDataSchema.parse(original.payload);
    if (
      saved.rows.some(
        (r) => r.targetId && input.local.rows.find((l) => l.id === r.id)?.targetId !== r.targetId,
      )
    )
      throw conflict(
        "別の画面で販売が保存されています。元の販売結果を確認してから選び直してください。",
      );
    const data: SalesBatchData = {
      rows: input.local.rows.filter((r) => !r.targetId).map((r) => ({ ...r, id: randomUUID() })),
    };
    await tx.workflowDraft.create({
      data: {
        id: newId,
        ...scope(c),
        kind: BATCH,
        revision: 1,
        payload: toJson(data),
        baseSnapshot: toJson(snapshot),
      },
    });
    await audit(tx, c, newId, "sales.batch.fork", {
      originalDraftId: id,
      originalRevision: input.revision,
      currentRevision: original.revision,
      reason: input.reason,
    });
    return { id: newId };
  });
}

export async function saveSalesBatch(
  db: PrismaClient,
  c: WorkflowContext,
  id: string,
  revision: number,
  key: string,
  raw: unknown,
) {
  const input = salesBatchDataSchema.or(salesBatchChangesSchema).parse(raw);
  return db.$transaction(
    async (tx) => {
      await lockBatch(tx, c, id);
      const hash = fingerprint({ id, revision, data: input });
      const receipt = await tx.draftSaveReceipt.findUnique({ where: { id: key } });
      if (receipt) {
        await readDraft(tx, c, id, BATCH);
        if (receipt.draftId !== id || receipt.fingerprint !== hash) throw conflict();
        return { id, revision: receipt.revision };
      }
      const prior = await tx.workflowDraft.findUnique({ where: { id } });
      // Changes are applied only to the exact reviewed revision, never merged across clients.
      if (prior) await readDraft(tx, c, id, BATCH);
      if (prior ? prior.revision !== revision : revision !== 0) throw conflict();
      const originalData = prior ? salesBatchDataSchema.parse(prior.payload) : { rows: [] };
      const changed =
        "changedRows" in input ? new Map(input.changedRows.map((row) => [row.id, row])) : undefined;
      const data = salesBatchDataSchema.parse(
        "rows" in input
          ? input
          : {
              rows: [
                ...originalData.rows.map((row) => changed!.get(row.id) ?? row),
                ...input.changedRows.filter(
                  (row) => !originalData.rows.some((old) => old.id === row.id),
                ),
              ],
            },
      );
      if (prior) {
        await readDraft(tx, c, id, BATCH);
        if (prior.revision !== revision) throw conflict();
        const original = salesBatchDataSchema.parse(prior.payload);
        // Confirmed rows are immutable even if a client removes or edits them.
        for (const row of original.rows.filter((r) => r.targetId))
          if (fingerprint(data.rows.find((r) => r.id === row.id) ?? null) !== fingerprint(row))
            throw conflict("保存済みの行は変更できません。販売詳細から訂正してください。");
        if (
          data.rows.some(
            (r) =>
              r.targetId && !original.rows.some((p) => p.id === r.id && p.targetId === r.targetId),
          )
        )
          throw conflict();
      } else if (revision !== 0 || data.rows.some((r) => r.targetId)) throw conflict();
      const reviews = await tx.workflowDraft.findMany({
        where: {
          ...scope(c),
          kind: REVIEW,
          archivedAt: null,
          baseSnapshot: { path: ["batchId"], equals: id },
        },
      });
      for (const review of reviews) {
        const stored = review.payload as unknown as StoredReview;
        if (
          await tx.workflowRequest.count({
            where: {
              id: { in: stored.entries.map((e) => e.input.idempotencyKey) },
              status: "PREPARED",
            },
          })
        )
          throw conflict("元の確定要求を照会・取消してから編集してください。");
        await tx.workflowDraft.update({
          where: { id: review.id },
          data: { archivedAt: new Date() },
        });
      }
      const saved = prior
        ? await tx.workflowDraft.update({
            where: { id },
            data: { payload: toJson(data), revision: { increment: 1 } },
          })
        : await tx.workflowDraft.create({
            data: {
              id,
              ...scope(c),
              kind: BATCH,
              revision: 1,
              payload: toJson(data),
              baseSnapshot: { reportingEntityId: c.reportingEntityId },
            },
          });
      await tx.draftSaveReceipt.create({
        data: { id: key, draftId: id, fingerprint: hash, revision: saved.revision },
      });
      await audit(tx, c, id, "sales.batch.draft", {
        revision: saved.revision,
        rows: data.rows.length,
      });
      return { id, revision: saved.revision };
    },
    { timeout: 20000 },
  );
}

async function saleInput(
  tx: Tx,
  c: WorkflowContext,
  row: SalesBatchRow,
  batchId: string,
): Promise<SaleInput> {
  if (!row.completed || !row.date)
    throw new WorkflowError("VALIDATION", "完了日と取引完了済みの確認が必要です。");
  const sku = await tx.salesSku.findFirst({
    where: {
      id: row.skuId || "00000000-0000-0000-0000-000000000000",
      ...businessScope(c),
      active: true,
    },
  });
  const channel = await tx.salesChannel.findFirst({
    where: {
      id: row.channelId || "00000000-0000-0000-0000-000000000000",
      workspaceId: c.workspaceId,
      active: true,
    },
  });
  if (!sku || !channel)
    throw new WorkflowError("VALIDATION", "この入力先で使えるSKUと販路を選択してください。");
  if (
    row.externalId &&
    (await tx.salesOrder.count({
      where: {
        ...businessScope(c),
        reportingEntityId: c.reportingEntityId,
        salesChannelId: channel.id,
        externalOrderId: row.externalId,
      },
    }))
  )
    throw new WorkflowError("DUPLICATE", "同じ販路・商品IDの販売が登録されています。");
  let price = row.price;
  if (row.priceBasis === "TOTAL") {
    if (!/^(0|[1-9]\d{0,14})$/.test(price) || row.quantity < 1)
      throw new WorkflowError("VALIDATION", "販売金額と数量を確認してください。");
    if (BigInt(price) % BigInt(row.quantity))
      throw new WorkflowError(
        "VALIDATION",
        "販売金額を数量で割り切れません。販売単位全体に対応するセットSKUを選び、数量1で記録してください。",
      );
    price = (BigInt(price) / BigInt(row.quantity)).toString();
  }
  const materials = await skuMaterialQuote(
    tx,
    c,
    sku.id,
    row.quantity,
    row.date,
    row.supplyQuantities,
  );
  return saleSchema.parse({
    importSource: { batchId, rowId: row.id, sourceName: row.sourceName, ...row.source },
    idempotencyKey: randomUUID(),
    draftId: row.id,
    draftRevision: 0,
    context: {
      reportingEntityId: c.reportingEntityId,
      businessUnitId: c.businessUnitId,
      operatorId: c.operatorId,
      year: c.year,
    },
    date: row.date,
    skuId: sku.id,
    skuRevision: sku.revision,
    channelId: channel.id,
    channelRevision: channel.revision,
    quantity: row.quantity,
    price,
    fee: row.fee,
    shipping: row.shipping,
    externalId: row.externalId,
    buyer: row.buyer,
    deliveryMethodId: row.deliveryMethodId,
    memo: row.memo,
    supplyQuantities: row.supplyQuantities,
    materialQuote: materials.quote,
    ...(row.position ? { valuationPosition: row.position } : {}),
  });
}

export async function previewSalesBatch(
  db: PrismaClient,
  c: WorkflowContext,
  id: string,
  revision: number,
): Promise<SalesBatchReview> {
  return db.$transaction(
    async (tx) => {
      await lockBatch(tx, c, id);
      const draft = await readDraft(tx, c, id, BATCH);
      if (draft.revision !== revision) throw conflict();
      const activeReviews = await tx.workflowDraft.findMany({
        where: {
          ...scope(c),
          kind: REVIEW,
          archivedAt: null,
          baseSnapshot: { path: ["batchId"], equals: id },
        },
      });
      const pendingKeys = activeReviews.flatMap((r) =>
        (r.payload as unknown as StoredReview).entries.map((e) => e.input.idempotencyKey),
      );
      if (
        await tx.workflowRequest.count({ where: { id: { in: pendingKeys }, status: "PREPARED" } })
      )
        throw conflict("元の確定要求を照会・取消してから再確認してください。");
      const data = salesBatchDataSchema.parse(draft.payload);
      const selected = data.rows
        .filter((r) => r.selected && !r.excluded && !r.targetId)
        .sort(
          (a, b) => a.date.localeCompare(b.date) || data.rows.indexOf(a) - data.rows.indexOf(b),
        );
      if (!selected.length)
        throw new WorkflowError("VALIDATION", "確認する未保存の行を選択してください。");
      const baseline = await state(tx, c);
      const review: SalesBatchReview = { rows: [], issues: [] };
      const entries: StoredReview["entries"] = [];
      await tx.$executeRawUnsafe("SAVEPOINT sales_batch_preview");
      try {
        for (const row of selected) {
          try {
            const input = await saleInput(tx, c, row, id);
            await checkWorkflowContext(tx, c, input.date);
            const checkpoint = await valuationCheckpoint(tx, c, input);
            const plan = await evaluateMutation(tx, c, input, checkpoint, () =>
              recordSaleTransaction(tx, c, input),
            );
            if (plan.requiresOrder) {
              review.issues.push({
                rowId: row.id,
                message: "同日の計算順序を選択してください。",
                choices: plan.choices,
              });
              break;
            }
            const result = await valuationSession.run(
              {
                evaluating: true,
                requestKey: input.idempotencyKey,
                costs: plan.costs,
                order: plan.order,
              },
              () => recordSaleTransaction(tx, c, input),
            );
            await assertStoredStocktakes(tx, c);
            await applyMutationValuation(tx, c, input.idempotencyKey, "SALE", result.id, plan);
            const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: result.id } });
            const materials = await skuMaterialQuote(
              tx,
              c,
              input.skuId,
              input.quantity,
              input.date,
              input.supplyQuantities,
            );
            const provisional =
              order.costStatus !== "FINAL" || !materials.final || materials.cost === null;
            const preview: SalesBatchPreviewRow = {
              rowId: row.id,
              name: result.detail.name,
              date: input.date,
              cost: plan.cost,
              materials: materials.cost?.toString() ?? null,
              provisional,
              profit:
                provisional || input.fee === "" || input.shipping === ""
                  ? null
                  : (
                      BigInt(input.price) * BigInt(input.quantity) -
                      BigInt(input.fee) -
                      BigInt(input.shipping) -
                      BigInt(plan.cost) -
                      materials.cost!
                    ).toString(),
              balances: plan.balances,
              impacts: plan.orderImpacts,
            };
            entries.push({ rowId: row.id, input, digest: planDigest(plan), preview });
            review.rows.push(preview);
          } catch (error) {
            if (
              !(error instanceof WorkflowError) &&
              !(error instanceof z.ZodError) &&
              !(error && typeof error === "object" && "code" in error && error.code === "P2002")
            )
              throw error;
            review.issues.push({
              rowId: row.id,
              message:
                error instanceof WorkflowError
                  ? error.message
                  : error instanceof z.ZodError
                    ? "数量・商品代金・手数料・送料等の入力を確認してください。"
                    : "同じ商品ID等の行が重複しています。",
            });
            break;
          }
        }
      } finally {
        await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT sales_batch_preview");
        await tx.$executeRawUnsafe("RELEASE SAVEPOINT sales_batch_preview");
      }
      if (review.issues.length) return review;
      const reviewId = randomUUID();
      const stored: StoredReview = {
        batchId: id,
        batchRevision: revision,
        baseline,
        next: 0,
        entries,
      };
      await tx.workflowDraft.create({
        data: {
          id: reviewId,
          ...scope(c),
          kind: REVIEW,
          payload: toJson(stored),
          baseSnapshot: { reportingEntityId: c.reportingEntityId, batchId: id },
        },
      });
      await audit(tx, c, reviewId, "sales.batch.preview", {
        batchId: id,
        revision,
        count: entries.length,
      });
      return { ...review, id: reviewId };
    },
    { timeout: 120000 },
  );
}

export async function salesBatchProgress(db: PrismaClient, c: WorkflowContext, reviewId: string) {
  return db.$transaction(async (tx) => {
    await checkWorkflowContext(tx, c);
    const draft = await readDraft(tx, c, reviewId, REVIEW);
    const stored = draft.payload as unknown as StoredReview;
    return {
      next: stored.next,
      count: stored.entries.length,
      nextKey: stored.entries[stored.next]?.input.idempotencyKey,
      rowId: stored.entries[stored.next]?.rowId,
      done: stored.next === stored.entries.length,
    };
  });
}

export async function saveSalesBatchNext(
  db: PrismaClient,
  c: WorkflowContext,
  reviewId: string,
  index: number,
) {
  const stored = await db.$transaction(async (tx) => {
    await checkWorkflowContext(tx, c);
    return (await readDraft(tx, c, reviewId, REVIEW)).payload as unknown as StoredReview;
  });
  const entry = stored.entries[index];
  if (!entry || index > stored.next) throw conflict("先行する保存要求の結果を確認してください。");
  const targetId = await recordSale(db, c, entry.input, {
    lockWorkspace: true,
    validatePlan: async (tx, plan) => {
      const review = (await readDraft(tx, c, reviewId, REVIEW)).payload as unknown as StoredReview;
      const batch = await readDraft(tx, c, review.batchId, BATCH);
      if (
        review.next !== index ||
        review.batchRevision !== batch.revision ||
        review.entries[index]?.input.idempotencyKey !== entry.input.idempotencyKey ||
        review.baseline !== (await state(tx, c)) ||
        review.entries[index]?.digest !== planDigest(plan)
      )
        throw conflict(
          "一括確認後に入力・在庫・原価条件が変わりました。元要求を照会・取消し、残りを再確認してください。",
        );
    },
    after: async (tx, targetId) => {
      const review = (await readDraft(tx, c, reviewId, REVIEW)).payload as unknown as StoredReview;
      const batch = await readDraft(tx, c, review.batchId, BATCH);
      const data = salesBatchDataSchema.parse(batch.payload);
      const row = data.rows.find((r) => r.id === entry.rowId);
      if (!row || row.targetId) throw conflict();
      row.targetId = targetId;
      await tx.workflowDraft.update({
        where: { id: batch.id },
        data: { payload: toJson(data), revision: { increment: 1 } },
      });
      review.next++;
      review.batchRevision++;
      review.baseline = await state(tx, c);
      await tx.workflowDraft.update({
        where: { id: reviewId },
        data: { payload: toJson(review), revision: { increment: 1 } },
      });
    },
  });
  return { targetId, rowId: entry.rowId };
}

export async function salesBatchMappings(
  db: PrismaClient,
  c: WorkflowContext,
): Promise<SalesBatchMapping[]> {
  return db.$transaction(async (tx) => {
    await checkWorkflowContext(tx, c);
    const drafts = await tx.workflowDraft.findMany({
      where: {
        ...businessScope(c),
        kind: MAPPING,
        archivedAt: null,
        baseSnapshot: { path: ["reportingEntityId"], equals: c.reportingEntityId },
      },
    });
    const mappings = drafts.map((d) => d.payload as unknown as SalesBatchMapping);
    const skus = await tx.salesSku.findMany({
      where: { ...businessScope(c), active: true, id: { in: mappings.map((m) => m.skuId) } },
      select: { id: true },
    });
    const channels = await tx.salesChannel.findMany({
      where: {
        workspaceId: c.workspaceId,
        active: true,
        id: { in: mappings.map((m) => m.channelId) },
      },
      select: { id: true },
    });
    return mappings.filter(
      (m) => skus.some((s) => s.id === m.skuId) && channels.some((ch) => ch.id === m.channelId),
    );
  });
}
export async function rememberSalesBatchMapping(
  db: PrismaClient,
  c: WorkflowContext,
  raw: unknown,
  key: string,
) {
  const mapping = z
    .object({
      sourceName: z.string().trim().min(1).max(2000),
      channelId: z.uuid(),
      skuId: z.uuid(),
    })
    .parse(raw);
  const id = saleRecordId(
    c.businessUnitId,
    `mapping:${c.reportingEntityId}:${mapping.channelId}:${mapping.sourceName}`,
  );
  return db.$transaction(async (tx) => {
    await lockBatch(tx, c, id);
    if (
      !(await tx.salesSku.count({
        where: { id: mapping.skuId, ...businessScope(c), active: true },
      })) ||
      !(await tx.salesChannel.count({
        where: { id: mapping.channelId, workspaceId: c.workspaceId, active: true },
      }))
    )
      throw conflict("対応先のSKU・販路を確認してください。");
    const hash = fingerprint(mapping);
    const receipt = await tx.draftSaveReceipt.findUnique({ where: { id: key } });
    if (receipt) {
      if (receipt.draftId !== id || receipt.fingerprint !== hash) throw conflict();
      return mapping;
    }
    const prior = await tx.workflowDraft.findUnique({ where: { id } });
    const saved = prior
      ? await tx.workflowDraft.update({
          where: { id },
          data: { payload: toJson(mapping), revision: { increment: 1 } },
        })
      : await tx.workflowDraft.create({
          data: {
            id,
            ...scope(c),
            kind: MAPPING,
            revision: 1,
            payload: toJson(mapping),
            baseSnapshot: { reportingEntityId: c.reportingEntityId },
          },
        });
    await tx.draftSaveReceipt.create({
      data: { id: key, draftId: id, fingerprint: hash, revision: saved.revision },
    });
    await audit(tx, c, id, "sales.batch.mapping", mapping);
    return mapping;
  });
}
