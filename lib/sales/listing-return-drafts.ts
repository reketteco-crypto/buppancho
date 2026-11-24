import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { z } from "zod";
import type { WorkflowContext } from "@/lib/sales/workflow-context";
import { WorkflowError } from "@/lib/sales/workflow-errors";
import { runWorkflow } from "@/lib/sales/workflow-runner";
import { fingerprint, toJson } from "@/lib/sales/request-store";
import { loadListingReturn } from "@/lib/sales/listing-return-workflow";
import { returnProgress } from "@/lib/sales/listing-return-domain";
import {
  blankListingReturnInput,
  listingReturnDraftInputSchema,
  listingReturnSnapshotSchema,
  type ListingReturnSnapshot,
  type listingReturnRebaseSchema,
} from "@/lib/sales/listing-return-input";
type Tx = Prisma.TransactionClient;
const scope = (c: WorkflowContext) => ({
  workspaceId: c.workspaceId,
  businessUnitId: c.businessUnitId,
});
const context = (c: WorkflowContext) => ({
  businessUnitId: c.businessUnitId,
  operatorId: c.operatorId,
  year: c.year,
});
export async function listingReturnDraftSnapshot(
  tx: Tx,
  c: WorkflowContext,
  listingId: string,
): Promise<ListingReturnSnapshot> {
  const listing = await tx.listing.findFirst({
    where: { id: listingId, salesSku: scope(c) },
    include: { completion: true },
  });
  if (!listing) throw new WorkflowError("CONTEXT_CHANGED", "元の部門・出品を確認してください。");
  const { row, members, handling } = await loadListingReturn(tx, c, listingId);
  const [reservations, revision, fiscal, operator, unit, owner] = await Promise.all([
    tx.inventoryReservation.findMany({
      where: { id: { in: members.map((m) => m.reservationId) } },
      include: {
        itemVariant: {
          include: {
            inventoryItem: true,
            costBalances: { where: { businessUnitId: c.businessUnitId } },
          },
        },
        storageLocation: true,
        uniqueStockUnit: true,
      },
    }),
    tx.inventoryRevision.findUnique({ where: { businessUnitId: c.businessUnitId } }),
    tx.fiscalYearProfile.findFirst({
      where: { reportingEntityId: c.reportingEntityId, year: c.year },
    }),
    tx.operator.findFirst({ where: { id: c.operatorId, workspaceId: c.workspaceId } }),
    tx.businessUnit.findFirst({ where: { id: c.businessUnitId, workspaceId: c.workspaceId } }),
    tx.reportingEntity.findFirst({
      where: { id: c.reportingEntityId, workspaceId: c.workspaceId },
    }),
  ]);
  return {
    type: "LISTING_RETURN",
    listingId,
    caseId: row.id,
    revision: listing.revision,
    context: context(c),
    reportingEntityId: row.reportingEntityId,
    contextLabel: `${operator?.displayName ?? "入力者"}・${unit?.name ?? "部門"}・${c.year}年度`,
    ownershipLabel: owner?.displayName ?? "申告主体",
    status: listing.completion ? "COMPLETED" : listing.status,
    returnPending: listing.returnPending,
    inventoryRevision: (revision?.revision ?? 0n).toString(),
    yearStatus: fiscal?.status ?? "UNCONFIGURED",
    yearVersion: fiscal?.updatedAt.toISOString() ?? "",
    members: members.map((m) => {
      const r = reservations.find((r) => r.id === m.reservationId);
      if (!r) throw new WorkflowError("HISTORY_INCOMPLETE", "返送元の確保履歴を確認できません。");
      const progress = returnProgress(
        m.quantity,
        handling.filter((h) => h.memberId === m.id),
      );
      return {
        id: m.id,
        label:
          `${r.itemVariant.inventoryItem.name} ${r.uniqueStockUnit?.individualCode ?? ""}`.trim(),
        quantity: m.quantity,
        good: progress.good,
        removed: progress.removed,
        pending: progress.pending,
        location: r.storageLocation.name,
        cost: r.itemVariant.costBalances.length
          ? r.itemVariant.costBalances.reduce((s, b) => s + b.carryingCostTotalJpy, 0n).toString()
          : null,
      };
    }),
  };
}
function assertDraft(
  draft: Prisma.WorkflowDraftGetPayload<object> | null,
  c: WorkflowContext,
  listingId: string,
) {
  if (
    draft &&
    (draft.workspaceId !== c.workspaceId ||
      draft.businessUnitId !== c.businessUnitId ||
      draft.operatorId !== c.operatorId ||
      draft.year !== c.year ||
      draft.kind !== "LISTING_RETURN" ||
      (draft.payload as { listingId?: string }).listingId !== listingId)
  )
    throw new WorkflowError("CONTEXT_CHANGED", "元の入力者・部門・年度・出品へ戻してください。");
}
function assertBase(raw: unknown, c: WorkflowContext, listingId: string, caseId: string) {
  const base = listingReturnSnapshotSchema.safeParse(raw);
  if (!base.success) return;
  if (
    base.data.listingId !== listingId ||
    base.data.caseId !== caseId ||
    base.data.context.businessUnitId !== c.businessUnitId ||
    base.data.context.operatorId !== c.operatorId ||
    base.data.context.year !== c.year
  )
    throw new WorkflowError(
      "CONTEXT_CHANGED",
      "元の入力先・返送案件へ戻してください。途中保存は付け替えていません。",
    );
  if (base.data.reportingEntityId !== c.reportingEntityId)
    throw new WorkflowError("OWNERSHIP_CHANGED", "入力開始時と申告主体が異なります。");
}
export async function loadListingReturnDraftReview(
  tx: Tx,
  c: WorkflowContext,
  input: { listingId: string; draftId?: string },
  excludeRequestId?: string,
) {
  const draft = input.draftId
    ? await tx.workflowDraft.findUnique({ where: { id: input.draftId } })
    : null;
  assertDraft(draft, c, input.listingId);
  const snapshot = await listingReturnDraftSnapshot(tx, c, input.listingId);
  const original = listingReturnSnapshotSchema.safeParse(draft?.baseSnapshot);
  if (original.success) assertBase(original.data, c, input.listingId, snapshot.caseId);
  let code: string | undefined, message: string | undefined;
  if (!snapshot.returnPending || snapshot.status === "ENDED" || snapshot.status === "COMPLETED") {
    code = "CONFLICT";
    message =
      "この返送案件は終了・再開・完了済みです。手元入力と現在の履歴は確認できますが、再確定できません。";
  }
  if (snapshot.yearStatus === "LOCKED") {
    code = "YEAR_LOCKED";
    message = "年度がロックされました。入力を保持し、保存結果の照会のみ行えます。";
  }
  if (snapshot.yearStatus === "UNCONFIGURED") {
    code = "CONTEXT_CHANGED";
    message = "対象年度の設定を確認してください。元の入力先と内容は保持しています。";
  }
  if (draft?.archivedAt) {
    code = "CONFLICT";
    message =
      "この下書きは記録済み、または選び直し済みです。退避入力と保存結果を確認してください。";
  }
  const requests = input.draftId
    ? await tx.workflowRequest.findMany({
        where: {
          ...scope(c),
          operatorId: c.operatorId,
          year: c.year,
          id: excludeRequestId ? { not: excludeRequestId } : undefined,
          kind: { in: ["LISTING_RETURN", "LISTING_RETURN_CLOSE", "LISTING_RETURN_REBASE"] },
          payload: { path: ["draftId"], equals: input.draftId },
          status: { in: ["PREPARED", "APPLIED"] },
        },
        orderBy: { createdAt: "desc" },
      })
    : [];
  const foreign = requests.find(
    (r) => r.status === "PREPARED" && r.userAccountId !== c.userAccountId,
  );
  if (foreign) {
    code = "CONFLICT";
    message =
      "別のログイン利用者の要求が未解決です。元の利用者が結果を確認してから再開してください。";
  }
  const active =
    requests.find((r) => r.status === "PREPARED" && r.userAccountId === c.userAccountId) ??
    (draft?.archivedAt
      ? requests.find((r) => r.status === "APPLIED" && r.userAccountId === c.userAccountId)
      : undefined);
  const previous = input.draftId
    ? await tx.workflowRequest.findFirst({
        where: {
          ...scope(c),
          userAccountId: c.userAccountId,
          operatorId: c.operatorId,
          year: c.year,
          kind: "LISTING_RETURN_REBASE",
          status: "APPLIED",
          targetId: input.draftId,
        },
        select: { payload: true },
      })
    : null;
  const previousRaw = previous?.payload as
    | { input?: unknown; baseSnapshot?: unknown; choice?: string }
    | undefined;
  const previousInput = listingReturnDraftInputSchema.safeParse(previousRaw?.input);
  const saved = listingReturnDraftInputSchema.safeParse(draft?.payload);
  return {
    snapshot,
    fingerprint: fingerprint(snapshot),
    code,
    message,
    canResolve: !code && !active,
    draftRevision: draft?.revision ?? 0,
    savedInput: saved.success ? saved.data : null,
    activeRequest: active ? { id: active.id, kind: active.kind, status: active.status } : null,
    previous: previousInput.success
      ? { input: previousInput.data, choice: previousRaw?.choice }
      : null,
  };
}
export type ListingReturnDraftReview = Awaited<ReturnType<typeof loadListingReturnDraftReview>>;
export async function assertListingReturnDraft(
  tx: Tx,
  c: WorkflowContext,
  input: {
    idempotencyKey: string;
    listingId: string;
    date?: string;
    reason?: string;
    draftId?: string;
    draftRevision?: number;
    baseSnapshot?: unknown;
    draftInput?: unknown;
  },
  caseId: string,
) {
  if (!input.draftId) return;
  const planned = listingReturnDraftInputSchema.parse(input.draftInput);
  if (
    planned.listingId !== input.listingId ||
    planned.caseId !== caseId ||
    planned.date !== input.date ||
    planned.reason.trim() !== input.reason
  )
    throw new WorkflowError("CONTEXT_CHANGED", "手元入力と確定対象・日付・理由が一致しません。");
  const business = input as typeof input & {
    rows?: { memberId: string; disposition: string; quantity: number }[];
    action?: string;
    goodsInHand?: boolean;
  };
  if (business.rows) {
    const keys = Object.keys(planned.quantities)
      .filter((k) => planned.quantities[k] !== "" && planned.quantities[k] !== "0")
      .sort();
    const actual = business.rows
      .map((r) => [`${r.memberId}:${r.disposition}`, String(r.quantity)] as const)
      .sort((a, b) => a[0].localeCompare(b[0]));
    if (
      planned.mode !== "HANDLE" ||
      fingerprint(
        keys.map((k) => [
          k,
          /^\d+$/.test(planned.quantities[k]!)
            ? String(Number(planned.quantities[k]))
            : planned.quantities[k],
        ]),
      ) !== fingerprint(actual)
    )
      throw new WorkflowError(
        "VALIDATION",
        "手元の数量と確定数量が一致しません。再確認してください。",
      );
  } else if (
    planned.mode !== "CLOSE" ||
    planned.closeAction !== business.action ||
    planned.goodsInHand !== business.goodsInHand
  )
    throw new WorkflowError("VALIDATION", "案件を閉じる方法と現物確認を再確認してください。");
  const draft = await tx.workflowDraft.findUnique({ where: { id: input.draftId } });
  assertDraft(draft, c, input.listingId);
  if (draft?.archivedAt || (draft?.revision ?? 0) !== input.draftRevision)
    throw new WorkflowError(
      "CONFLICT",
      "途中保存が更新・記録済みです。手元入力と現在の保存内容を比較してください。",
    );
  assertBase(draft?.baseSnapshot ?? input.baseSnapshot, c, input.listingId, caseId);
  const review = await loadListingReturnDraftReview(tx, c, input, input.idempotencyKey);
  if (review.code || review.activeRequest)
    throw new WorkflowError(
      (review.code ?? "CONFLICT") as "CONFLICT" | "YEAR_LOCKED",
      review.message ?? "先に元の要求の結果を照会・取消してください。",
    );
  const parsed = listingReturnSnapshotSchema.safeParse(draft?.baseSnapshot ?? input.baseSnapshot);
  if (parsed.success && parsed.data.revision !== review.snapshot.revision)
    throw new WorkflowError(
      "CONFLICT",
      "返送案件が別端末で更新されました。新しい下書きへ選び直して再確認してください。",
    );
}
export async function finalizeListingReturnDraft(
  tx: Tx,
  c: WorkflowContext,
  input: {
    idempotencyKey: string;
    listingId: string;
    date: string;
    reason: string;
    draftId?: string;
    draftRevision?: number;
    baseSnapshot?: unknown;
    draftInput?: unknown;
  },
  caseId: string,
  kind: "LISTING_RETURN" | "LISTING_RETURN_CLOSE",
) {
  if (input.draftId) {
    const draft = await tx.workflowDraft.findUnique({ where: { id: input.draftId } });
    if (draft)
      await tx.workflowDraft.update({
        where: { id: draft.id },
        data: {
          ...(input.draftInput ? { payload: toJson(input.draftInput) } : {}),
          archivedAt: new Date(),
        },
      });
    else
      await tx.workflowDraft.create({
        data: {
          ...scope(c),
          id: input.draftId,
          operatorId: c.operatorId,
          year: c.year,
          kind: "LISTING_RETURN",
          payload: toJson(input.draftInput ?? { listingId: input.listingId, caseId }),
          baseSnapshot: input.baseSnapshot ? toJson(input.baseSnapshot) : undefined,
          archivedAt: new Date(),
        },
      });
  }
  await tx.listingReturnSubmission.create({
    data: {
      id: input.idempotencyKey,
      draftId: input.draftId,
      caseId,
      kind,
      occurredDate: new Date(input.date),
      reason: input.reason,
    },
  });
}
export async function rebaseListingReturn(
  db: PrismaClient,
  c: WorkflowContext,
  input: z.infer<typeof listingReturnRebaseSchema>,
) {
  return runWorkflow(
    db,
    c,
    input,
    "LISTING_RETURN_REBASE",
    new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }),
    async (tx) => {
      const draft = await tx.workflowDraft.findUnique({ where: { id: input.draftId } });
      assertDraft(draft, c, input.listingId);
      if (draft?.archivedAt || (draft?.revision ?? 0) !== input.draftRevision)
        throw new WorkflowError(
          "CONFLICT",
          "選び直す前に下書きが更新されました。再確認してください。",
        );
      const review = await loadListingReturnDraftReview(tx, c, input, input.idempotencyKey);
      if (!review.canResolve)
        throw new WorkflowError(
          (review.code ?? "CONFLICT") as "CONFLICT" | "YEAR_LOCKED",
          review.message ?? "先に元の保存要求を確認してください。",
        );
      if (review.fingerprint !== input.currentFingerprint)
        throw new WorkflowError(
          "CONFLICT",
          "比較中に在庫・年度・返送状態が変わりました。比較を更新してください。",
        );
      assertBase(
        draft?.baseSnapshot ?? input.baseSnapshot,
        c,
        input.listingId,
        review.snapshot.caseId,
      );
      if (
        input.input.listingId !== input.listingId ||
        input.input.caseId !== review.snapshot.caseId
      )
        throw new WorkflowError("CONTEXT_CHANGED", "入力先と返送案件が異なります。");
      const next = await tx.workflowDraft.create({
        data: {
          ...scope(c),
          id: randomUUID(),
          operatorId: c.operatorId,
          year: c.year,
          kind: "LISTING_RETURN",
          revision: 1,
          baseSnapshot: toJson(review.snapshot),
          payload: toJson(
            input.choice === "LOCAL"
              ? input.input
              : blankListingReturnInput(input.listingId, review.snapshot.caseId),
          ),
        },
      });
      if (draft)
        await tx.workflowDraft.update({
          where: { id: draft.id },
          data: { archivedAt: new Date() },
        });
      else
        await tx.workflowDraft.create({
          data: {
            ...scope(c),
            id: input.draftId,
            operatorId: c.operatorId,
            year: c.year,
            kind: "LISTING_RETURN",
            payload: toJson(input.input),
            baseSnapshot: input.baseSnapshot ? toJson(input.baseSnapshot) : undefined,
            archivedAt: new Date(),
          },
        });
      return {
        id: next.id,
        detail: {
          sourceDraftId: input.draftId,
          choice: input.choice,
          input: input.input,
          baseSnapshot: input.baseSnapshot,
        },
      };
    },
  );
}
