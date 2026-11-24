import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { z } from "zod";
import { checkWorkflowContext, type WorkflowContext } from "@/lib/sales/workflow-context";
import { WorkflowError } from "@/lib/sales/workflow-errors";
import { runWorkflow } from "@/lib/sales/workflow-runner";
import { fingerprint, toJson } from "@/lib/sales/request-store";
import { lockInventoryDomain } from "@/lib/inventory/domain-lock";
import { lockInventoryTarget } from "@/lib/inventory/context";
import { averageUnitCost } from "@/lib/inventory/money";
import { effectiveCosts } from "@/lib/inventory/effective-cost";
import { effectiveSourceDates, hasLaterInventoryEvents } from "@/lib/inventory/event-dates";
import { allocateReturnedComponents } from "@/lib/sales/return-allocation";
import { allocateComponentReturn } from "@/lib/sales/component-return-allocation";
import { managementProfit } from "@/lib/sales/money";
import {
  captureValuationPreview,
  type SharedValuationPreview,
} from "@/lib/inventory/shared-valuation";
import {
  historicalPreviewAllowed,
  valuationSession,
  plannedMovementCost,
  plannedOperationOrder,
} from "@/lib/inventory/valuation-session";
import {
  blankReturnInput,
  returnInputSchema,
  returnSnapshotSchema,
  validateReturnInput,
  type ReturnInput,
  type ReturnKind,
  type ReturnSnapshot,
  type returnPreviewSchema,
  returnRecordSchema,
  type returnRebaseSchema,
} from "@/lib/sales/return-types";

type Tx = Prisma.TransactionClient;
const instant = (date: string) => new Date(`${date}T00:00:00+09:00`);
const day = (date: Date) => date.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
const scope = (c: WorkflowContext) => ({
  workspaceId: c.workspaceId,
  businessUnitId: c.businessUnitId,
});
const context = (c: WorkflowContext) => ({
  businessUnitId: c.businessUnitId,
  operatorId: c.operatorId,
  year: c.year,
});

async function dataFor(tx: Tx, c: WorkflowContext, orderId: string) {
  const order = await tx.salesOrder.findFirst({
    where: {
      id: orderId,
      ...scope(c),
      reportingEntityId: c.reportingEntityId,
      OR: [{ completionListingId: { not: null } }, { recordingMode: "DIRECT" }],
    },
    include: {
      businessUnit: true,
      reportingEntity: true,
      lines: {
        orderBy: { id: "asc" },
        include: {
          salesSku: true,
          consumptions: {
            orderBy: { id: "asc" },
            include: {
              dispositions: true,
              itemVariant: { include: { inventoryItem: true } },
              uniqueStockUnit: true,
              inventoryLot: true,
              storageLocation: true,
            },
          },
        },
      },
      returns: { include: { lines: { include: { dispositions: true } } } },
    },
  });
  if (!order?.completedAt)
    throw new WorkflowError(
      "CONTEXT_CHANGED",
      "この入力先では完了実績を参照できません。元の部門を確認してください。",
    );
  const consumptions = order.lines.flatMap((l) => l.consumptions);
  const dispositions = order.returns.flatMap((r) => r.lines.flatMap((l) => l.dispositions));
  const [costs, returnCosts, revision, fiscal] = await Promise.all([
    effectiveCosts(tx, "CONSUMPTION", consumptions),
    effectiveCosts(tx, "DISPOSITION", dispositions),
    tx.inventoryRevision.findUnique({ where: { businessUnitId: c.businessUnitId } }),
    tx.fiscalYearProfile.findFirst({
      where: { reportingEntityId: c.reportingEntityId, year: c.year },
    }),
  ]);
  const completedDates = await effectiveSourceDates(tx, scope(c), "sales_order", [
    { id: order.id, date: order.completedAt },
  ]);
  const snapshot: ReturnSnapshot = {
    type: "RETURN",
    orderId,
    revision: order.revision,
    context: context(c),
    reportingEntityId: order.reportingEntityId,
    contextLabel: `${(await tx.operator.findUnique({ where: { id: c.operatorId } }))?.displayName ?? "入力者"}・${order.businessUnit.name}・${c.year}年度`,
    ownershipLabel: order.reportingEntity.displayName,
    completedDate: completedDates.get(order.id)!,
    status: order.status,
    inventoryRevision: (revision?.revision ?? 0n).toString(),
    yearStatus: fiscal?.status ?? "UNCONFIGURED",
    yearVersion: fiscal?.updatedAt.toISOString() ?? "",
    netSales: (order.grossSalesJpy - order.discountJpy).toString(),
    fee: order.feeJpy?.toString() ?? null,
    shipping: order.shippingJpy?.toString() ?? null,
    packing: order.packingJpy?.toString() ?? null,
    other: order.otherCostJpy?.toString() ?? null,
    cogs: order.lines.some((l) => l.managementCogsJpy === null)
      ? null
      : order.lines.reduce((s, l) => s + l.managementCogsJpy!, 0n).toString(),
    finalCost: order.costStatus === "FINAL",
    salesRefund: order.returns.reduce((s, r) => s + r.salesRefundJpy, 0n).toString(),
    feeRefund: order.returns.reduce((s, r) => s + r.feeRefundJpy, 0n).toString(),
    shippingRefund: order.returns.reduce((s, r) => s + r.shippingRefundJpy, 0n).toString(),
    restockedCost: dispositions
      .filter((d) => d.disposition === "RESTOCK")
      .reduce((s, d) => s + returnCosts.get(d.id)!, 0n)
      .toString(),
    lines: order.lines.map((l) => ({
      id: l.id,
      label: l.displayName ?? l.salesSku.name,
      quantity: l.quantity,
      returned: l.returnedQuantity,
      componentOnly: order.returns.some((r) =>
        r.lines.some((x) => x.salesOrderLineId === l.id && x.componentOnly),
      ),
      components: [
        ...new Set(l.consumptions.map((x) => x.uniqueStockUnitId ?? x.itemVariantId)),
      ].map((key) => {
        const rows = l.consumptions.filter((x) => (x.uniqueStockUnitId ?? x.itemVariantId) === key),
          first = rows[0]!;
        return {
          key,
          label: `${first.itemVariant.inventoryItem.name} ${Object.entries(
            first.itemVariant.attributesJson as Record<string, string>,
          )
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, v]) => v)
            .join("・")} ${first.uniqueStockUnit?.individualCode ?? ""}`.trim(),
          quantity: rows.reduce((s, r) => s + r.quantity, 0),
          processed: rows.reduce(
            (s, r) => s + r.dispositions.reduce((n, d) => n + d.quantity, 0),
            0,
          ),
          cost: rows.reduce((s, r) => s + costs.get(r.id)!, 0n).toString(),
          processedCost: rows
            .reduce(
              (s, r) => s + r.dispositions.reduce((n, d) => n + returnCosts.get(d.id)!, 0n),
              0n,
            )
            .toString(),
          location: first.storageLocation.name,
        };
      }),
    })),
  };
  return { order, snapshot, costs, returnCosts };
}
function assertDraft(
  draft: {
    workspaceId: string;
    businessUnitId: string;
    operatorId: string;
    year: number;
    kind: string;
    payload: unknown;
  } | null,
  c: WorkflowContext,
  kind: ReturnKind,
  orderId: string,
) {
  if (
    draft &&
    (draft.workspaceId !== c.workspaceId ||
      draft.businessUnitId !== c.businessUnitId ||
      draft.operatorId !== c.operatorId ||
      draft.year !== c.year ||
      draft.kind !== kind ||
      (draft.payload as { orderId?: string }).orderId !== orderId)
  )
    throw new WorkflowError(
      "CONTEXT_CHANGED",
      "元の入力者・部門・年度・対象実績へ戻してください。入力先は変更していません。",
    );
}
function assertBaseline(base: unknown, c: WorkflowContext, orderId: string) {
  const result = returnSnapshotSchema.safeParse(base);
  if (!result.success) return;
  if (
    result.data.orderId !== orderId ||
    result.data.context.businessUnitId !== c.businessUnitId ||
    result.data.context.operatorId !== c.operatorId ||
    result.data.context.year !== c.year
  )
    throw new WorkflowError(
      "CONTEXT_CHANGED",
      "元の対象実績・入力者・部門・年度へ戻してください。",
    );
  if (result.data.reportingEntityId !== c.reportingEntityId)
    throw new WorkflowError(
      "OWNERSHIP_CHANGED",
      "入力開始後に申告主体が変更されています。帰属を確認してください。",
    );
}
export async function loadReturnReview(
  tx: Tx,
  c: WorkflowContext,
  input: { orderId: string; kind: ReturnKind; draftId?: string },
) {
  const draft = input.draftId
    ? await tx.workflowDraft.findUnique({ where: { id: input.draftId } })
    : null;
  assertDraft(draft, c, input.kind, input.orderId);
  const { snapshot } = await dataFor(tx, c, input.orderId);
  const fiscal = await tx.fiscalYearProfile.findFirst({
    where: { reportingEntityId: c.reportingEntityId, year: c.year },
  });
  let code: string | undefined, message: string | undefined;
  if (!["COMPLETED", "RETURNED"].includes(snapshot.status)) {
    code = "CONFLICT";
    message = "この実績は返品・返金できる状態ではありません。最新の履歴を確認してください。";
  }
  if (
    input.kind === "RETURN" &&
    snapshot.lines.every((l) => l.components.every((v) => v.processed >= v.quantity))
  ) {
    code = "CONFLICT";
    message =
      "全数返品済みです。新しい現物返品はできません。手元入力と最新履歴を確認してください。";
  }
  if (snapshot.completedDate.slice(0, 4) !== String(c.year)) {
    code = "CONTEXT_CHANGED";
    message = "元取引の完了年度へ戻してください。年度をまたぐ返品・返金は今回の対象外です。";
  }
  const original = returnSnapshotSchema.safeParse(draft?.baseSnapshot);
  if (
    snapshot.reportingEntityId !== c.reportingEntityId ||
    (original.success && original.data.reportingEntityId !== c.reportingEntityId)
  ) {
    code = "OWNERSHIP_CHANGED";
    message = "申告主体が変更されています。帰属の確認が必要です。";
  }
  if (fiscal?.status === "LOCKED") {
    code = "YEAR_LOCKED";
    message =
      "年度がロックされました。閲覧・保存結果の照会のみ可能です。手元入力は保持しています。";
  }
  if (draft?.archivedAt) {
    code = "CONFLICT";
    message = "この入力は記録済み、または選び直し済みです。元入力と保存結果を確認してください。";
  }
  const foreignPending = input.draftId
    ? await tx.workflowRequest.findFirst({
        where: {
          ...scope(c),
          operatorId: c.operatorId,
          year: c.year,
          userAccountId: { not: c.userAccountId },
          status: "PREPARED",
          kind: { in: ["RETURN", "REFUND", "RETURN_REBASE"] },
          payload: { path: ["draftId"], equals: input.draftId },
        },
        select: { id: true },
      })
    : null;
  if (foreignPending) {
    code = "CONFLICT";
    message =
      "別のログイン利用者の保存要求が未解決です。元の利用者が結果を照会・取消してから再確認してください。";
  }
  const requests = input.draftId
    ? await tx.workflowRequest.findMany({
        where: {
          ...scope(c),
          operatorId: c.operatorId,
          userAccountId: c.userAccountId,
          year: c.year,
          kind: { in: ["RETURN", "REFUND", "RETURN_REBASE"] },
          status: { in: ["PREPARED", "APPLIED"] },
          payload: { path: ["draftId"], equals: input.draftId },
        },
        orderBy: { createdAt: "desc" },
      })
    : [];
  const active =
    requests.find((r) => r.status === "PREPARED") ??
    (draft?.archivedAt ? requests.find((r) => r.status === "APPLIED") : undefined);
  const previous = input.draftId
    ? await tx.workflowRequest.findFirst({
        where: {
          ...scope(c),
          operatorId: c.operatorId,
          userAccountId: c.userAccountId,
          year: c.year,
          kind: "RETURN_REBASE",
          status: "APPLIED",
          targetId: input.draftId,
        },
        select: { payload: true },
      })
    : null;
  const previousPayload = previous?.payload as
    | { input?: unknown; baseSnapshot?: unknown; choice?: string }
    | undefined;
  const previousInput = returnInputSchema.safeParse(previousPayload?.input);
  const previousBase = returnSnapshotSchema.safeParse(previousPayload?.baseSnapshot);
  return {
    snapshot,
    draftRevision: draft?.revision ?? 0,
    code,
    message,
    canResolve: !code,
    closing: fiscal?.status === "CLOSING",
    activeRequest: active ? { id: active.id, kind: active.kind, status: active.status } : null,
    previous: previousInput.success
      ? {
          input: previousInput.data,
          baseline: previousBase.success ? previousBase.data : null,
          choice: previousPayload?.choice,
        }
      : null,
  };
}
export type ReturnReview = Awaited<ReturnType<typeof loadReturnReview>>;

async function planFor(tx: Tx, c: WorkflowContext, input: ReturnInput) {
  const valid = validateReturnInput(input);
  if (Object.keys(valid.fields).length)
    throw new WorkflowError(
      "VALIDATION",
      "未確認の金額・入力項目があります。途中保存は可能ですが、返品・在庫はまだ更新していません。",
      { fields: valid.fields },
    );
  const data = await dataFor(tx, c, input.orderId);
  const { snapshot, order } = data;
  const review = await loadReturnReview(tx, c, { kind: input.kind, orderId: input.orderId });
  if (review.code)
    throw new WorkflowError(
      review.code as "CONFLICT" | "YEAR_LOCKED" | "CONTEXT_CHANGED" | "OWNERSHIP_CHANGED",
      review.message!,
    );
  if (input.date.slice(0, 4) !== String(c.year))
    throw new WorkflowError(
      "CONTEXT_CHANGED",
      "処理日は元取引と同じ年度内にしてください。年度をまたぐ返品・返金は未対応です。",
    );
  if (input.date < snapshot.completedDate)
    throw new WorkflowError("VALIDATION", "処理日は元取引の完了日以降を指定してください。", {
      fields: { date: "完了日以降を指定してください。" },
    });
  if (BigInt(snapshot.salesRefund) + valid.amounts.salesRefund > BigInt(snapshot.netSales))
    throw new WorkflowError(
      "VALIDATION",
      "売上返金の累計が取引金額を超えています。最新の返金履歴を確認してください。",
      { fields: { salesRefund: "返金可能額を超えています。" } },
    );
  const line = input.kind === "RETURN" ? order.lines.find((l) => l.id === input.lineId) : undefined;
  const componentOnly = input.kind === "RETURN" && input.scope === "COMPONENTS";
  const quantity = input.kind === "RETURN" && !componentOnly ? Number(input.quantity) : 0;
  if (
    input.kind === "RETURN" &&
    (!line || (!componentOnly && line.returnedQuantity + quantity > line.quantity))
  )
    throw new WorkflowError("VALIDATION", "返品する販売単位数が返品可能数を超えています。", {
      fields: { quantity: "最新の返品可能数を確認してください。" },
    });
  const allocations = [] as {
    consumption: (typeof order.lines)[number]["consumptions"][number];
    quantity: number;
    cost: bigint;
    disposition: "RESTOCK" | "DEFECTIVE" | "DISPOSED";
  }[];
  if (line) {
    if (!componentOnly && snapshot.lines.find((l) => l.id === line.id)?.componentOnly)
      throw new WorkflowError(
        "VALIDATION",
        "構成品の一部を処理済みです。構成品ごとの数量を指定してください。",
        {
          fields: { scope: "構成品ごとに返品を選択してください。" },
        },
      );
    const variantIds = [...new Set(line.consumptions.map((r) => r.itemVariantId))].sort();
    if (
      !line.consumptions.length ||
      line.managementCogsJpy === null ||
      line.consumptions.reduce((s, r) => s + data.costs.get(r.id)!, 0n) !== line.managementCogsJpy
    )
      throw new WorkflowError(
        "HISTORY_INCOMPLETE",
        "販売時の構成品・原価を照合できません。現在原価で代用せず入力を保持しています。",
      );
    const later = await hasLaterInventoryEvents(tx, c, variantIds, input.date);
    if (later && !historicalPreviewAllowed())
      throw new WorkflowError(
        "VALUATION_REQUIRED",
        "処理日より後の在庫履歴があります。入力を保持し、共通の原価影響確認を行ってから記録してください。",
      );
    const expected = [
      ...new Set(line.consumptions.map((r) => r.uniqueStockUnitId ?? r.itemVariantId)),
    ];
    const movements = await tx.stockMovement.findMany({
      where: {
        businessUnitId: c.businessUnitId,
        itemVariantId: { in: variantIds },
      },
    });
    const movementCosts = await effectiveCosts(tx, "MOVEMENT", movements);
    const usedMovements = new Set<string>();
    for (const consumption of line.consumptions) {
      const movement = movements.find(
        (m) =>
          !usedMovements.has(m.id) &&
          m.movementType === "SALE_OUT" &&
          m.sourceId === order.id &&
          m.itemVariantId === consumption.itemVariantId &&
          m.inventoryLotId ===
            (consumption.uniqueStockUnit?.inventoryLotId ?? consumption.inventoryLotId) &&
          m.uniqueStockUnitId === consumption.uniqueStockUnitId &&
          m.storageLocationFromId === consumption.storageLocationId &&
          m.quantity === -consumption.quantity &&
          m.costTotalJpy === -consumption.costTotalJpy,
      );
      if (!movement || movementCosts.get(movement.id) !== -data.costs.get(consumption.id)!)
        throw new WorkflowError(
          "HISTORY_INCOMPLETE",
          "元の販売出庫と訂正反映後原価を照合できません。入力を保持しています。",
        );
      usedMovements.add(movement.id);
    }
    for (const id of variantIds) {
      const mode = line.consumptions.some((r) => r.itemVariantId === id && r.uniqueStockUnitId)
        ? "UNIQUE"
        : "QUANTITY";
      const balance = await tx.inventoryCostBalance.findUnique({
        where: {
          itemVariantId_businessUnitId_trackingMode: {
            itemVariantId: id,
            businessUnitId: c.businessUnitId,
            trackingMode: mode,
          },
        },
      });
      if (mode === "QUANTITY") {
        const ledger = movements.filter(
          (m) =>
            m.itemVariantId === id &&
            !m.uniqueStockUnitId &&
            !["LOCATION_TRANSFER", "RETURN_DEFECTIVE", "RETURN_DISPOSAL"].includes(m.movementType),
        );
        const lots = await tx.inventoryLot.aggregate({
          where: { itemVariantId: id, trackingMode: mode },
          _sum: { remainingQuantity: true },
        });
        if (
          !balance ||
          balance.quantity !== ledger.reduce((s, m) => s + m.quantity, 0) ||
          balance.quantity !== (lots._sum.remainingQuantity ?? 0) ||
          balance.carryingCostTotalJpy !== ledger.reduce((s, m) => s + movementCosts.get(m.id)!, 0n)
        )
          throw new WorkflowError(
            "HISTORY_INCOMPLETE",
            "履歴・ロットと現在の在庫・原価残高が一致しません。入力を保持しています。",
          );
      } else {
        const units = await tx.uniqueStockUnit.findMany({
          where: {
            workspaceId: c.workspaceId,
            itemVariantId: id,
            status: { in: ["IN_STOCK", "RESERVED"] },
          },
        });
        if (
          !balance ||
          balance.quantity !== units.length ||
          balance.carryingCostTotalJpy !== units.reduce((s, u) => s + u.acquisitionCostJpy, 0n)
        )
          throw new WorkflowError(
            "HISTORY_INCOMPLETE",
            "個体一覧と在庫・原価残高が一致しません。入力を保持しています。",
          );
      }
    }
    if (Object.keys(input.dispositions).some((k) => !expected.includes(k)))
      throw new WorkflowError(
        "VALIDATION",
        "対象外の構成品が含まれています。最新の構成を確認してください。",
      );
    const allocated = componentOnly
      ? null
      : allocateReturnedComponents(
          line.consumptions,
          line.quantity,
          line.returnedQuantity,
          quantity,
        );
    for (const row of line.consumptions) {
      const q = allocated?.get(row.id) ?? 0;
      if (!q) continue;
      const key = row.uniqueStockUnitId ?? row.itemVariantId,
        disposition = input.dispositions[key];
      if (!disposition)
        throw new WorkflowError("VALIDATION", "構成品ごとの現物処理を選択してください。", {
          fields: { [`dispositions.${key}`]: "良品・不良・廃棄を選択してください。" },
        });
      if (
        row.itemVariant.workspaceId !== c.workspaceId ||
        row.itemVariant.inventoryItem.businessUnitId !== c.businessUnitId ||
        row.storageLocation.workspaceId !== c.workspaceId ||
        !row.storageLocation.active ||
        (row.storageLocation.businessUnitId &&
          row.storageLocation.businessUnitId !== c.businessUnitId)
      )
        throw new WorkflowError(
          "VALIDATION",
          "元の戻し先・構成品をこの部門で使用できません。在庫と保管場所を確認してください。",
        );
      if (row.uniqueStockUnit && row.uniqueStockUnit.status !== "SOLD")
        throw new WorkflowError(
          "CONFLICT",
          "対象個体の状態が変わりました。別在庫へ置き換えず、最新の個体履歴を確認してください。",
        );
      if (!row.uniqueStockUnit && !row.inventoryLot)
        throw new WorkflowError("HISTORY_INCOMPLETE", "元の仕入ロットを確認できません。");
      const used = row.dispositions.reduce((s, d) => s + d.quantity, 0),
        usedCost = row.dispositions.reduce((s, d) => s + data.returnCosts.get(d.id)!, 0n),
        cost = data.costs.get(row.id)!;
      const allocatedCost =
        q === row.quantity - used ? cost - usedCost : (cost * BigInt(q)) / BigInt(row.quantity);
      if (allocatedCost < 0n)
        throw new WorkflowError("HISTORY_INCOMPLETE", "返品累計原価と元の販売原価が一致しません。");
      allocations.push({ consumption: row, quantity: q, cost: allocatedCost, disposition });
    }
    if (componentOnly) {
      let planned;
      try {
        planned = allocateComponentReturn(
          line.consumptions.map((r) => ({
            ...r,
            cost: data.costs.get(r.id)!,
            processed: r.dispositions.reduce((s, d) => s + d.quantity, 0),
            processedCost: r.dispositions.reduce((s, d) => s + data.returnCosts.get(d.id)!, 0n),
          })),
          input.components ?? [],
        );
      } catch (error) {
        throw new WorkflowError(
          "VALIDATION",
          error instanceof Error ? error.message : "返品数量を確認してください。",
          {
            fields: { components: "元の構成と残り数量を確認してください。" },
          },
        );
      }
      for (const a of planned) {
        const r = a.row;
        if (
          r.itemVariant.workspaceId !== c.workspaceId ||
          r.itemVariant.inventoryItem.businessUnitId !== c.businessUnitId ||
          r.storageLocation.workspaceId !== c.workspaceId ||
          !r.storageLocation.active ||
          (r.storageLocation.businessUnitId &&
            r.storageLocation.businessUnitId !== c.businessUnitId)
        )
          throw new WorkflowError("VALIDATION", "元の構成品・戻し先をこの部門で使用できません。");
        if (r.uniqueStockUnit && r.uniqueStockUnit.status !== "SOLD")
          throw new WorkflowError(
            "CONFLICT",
            "対象個体は処理済みか状態が変わっています。最新の履歴を確認してください。",
          );
        if (!r.uniqueStockUnit && !r.inventoryLot)
          throw new WorkflowError("HISTORY_INCOMPLETE", "元の仕入ロットを確認できません。");
        allocations.push({
          consumption: r,
          quantity: a.quantity,
          cost: a.cost,
          disposition: a.disposition,
        });
      }
    }
  }
  const restocked = allocations
    .filter((a) => a.disposition === "RESTOCK")
    .reduce((s, a) => s + a.cost, 0n);
  const known =
    snapshot.finalCost &&
    [snapshot.cogs, snapshot.fee, snapshot.shipping, snapshot.packing, snapshot.other].every(
      (v) => v !== null,
    );
  const profit = known
    ? managementProfit({
        gross: BigInt(snapshot.netSales),
        fee: BigInt(snapshot.fee!),
        shipping: BigInt(snapshot.shipping!),
        packing: BigInt(snapshot.packing!),
        other: BigInt(snapshot.other!),
        cogs: BigInt(snapshot.cogs!),
        salesRefund: BigInt(snapshot.salesRefund) + valid.amounts.salesRefund,
        feeRefund: BigInt(snapshot.feeRefund) + valid.amounts.feeRefund,
        shippingRefund: BigInt(snapshot.shippingRefund) + valid.amounts.shippingRefund,
        restockedCost: BigInt(snapshot.restockedCost) + restocked,
      })
    : null;
  const confirmation = fingerprint({
    input,
    snapshot: {
      ...snapshot,
      inventoryRevision: input.kind === "RETURN" ? snapshot.inventoryRevision : "",
    },
  });
  return {
    ...data,
    allocations,
    line,
    quantity,
    componentOnly,
    amounts: valid.amounts,
    confirmation,
    profit,
  };
}
export async function previewReturn(
  db: PrismaClient,
  c: WorkflowContext,
  input: z.infer<typeof returnPreviewSchema>,
) {
  return db.$transaction(async (tx) => {
    await lockInventoryDomain(tx, c.businessUnitId);
    await checkWorkflowContext(tx, c);
    const draft = input.draftId
      ? await tx.workflowDraft.findUnique({ where: { id: input.draftId } })
      : null;
    assertDraft(draft, c, input.kind, input.orderId);
    if (input.input.kind !== input.kind || input.input.orderId !== input.orderId)
      throw new WorkflowError("CONTEXT_CHANGED", "入力と対象実績が一致しません。");
    const p = await planFor(tx, c, input.input);
    return {
      fingerprint: p.confirmation,
      revision: p.order.revision,
      inventoryRevision: p.snapshot.inventoryRevision,
      profit: p.profit?.toString() ?? null,
      snapshot: p.snapshot,
      amounts: Object.fromEntries(Object.entries(p.amounts).map(([k, v]) => [k, v.toString()])),
      cost: p.allocations.reduce((s, a) => s + a.cost, 0n).toString(),
      changes: p.allocations.map((a) => ({
        label: p.snapshot.lines
          .flatMap((l) => l.components)
          .find((x) => x.key === (a.consumption.uniqueStockUnitId ?? a.consumption.itemVariantId))!
          .label,
        quantity: a.quantity,
        cost: a.cost.toString(),
        disposition: a.disposition,
        location: a.consumption.storageLocation.name,
      })),
    };
  });
}
export async function previewReturnWorkflow(
  db: PrismaClient,
  c: WorkflowContext,
  input: z.infer<typeof returnPreviewSchema>,
) {
  // This phase reads the original sale and validates quantities/refunds. It does
  // not write stock or authorize a historical mutation by itself.
  const preview = await valuationSession.run({ evaluating: true }, () =>
    previewReturn(db, c, input),
  );
  let valuation: SharedValuationPreview | undefined;
  if (input.kind === "RETURN") {
    const draft = input.draftId
      ? await db.workflowDraft.findUnique({ where: { id: input.draftId } })
      : null;
    const request = {
      ...input,
      idempotencyKey: randomUUID(),
      draftId: input.draftId ?? randomUUID(),
      draftRevision: draft?.revision ?? 0,
      orderRevision: preview.revision,
      confirmationFingerprint: preview.fingerprint,
      baseSnapshot: input.baseSnapshot ?? null,
    };
    valuation = await captureValuationPreview(() =>
      recordReturn(db, c, returnRecordSchema.parse(request)),
    );
  }
  return { ...preview, valuation };
}
export type ReturnPreview = Awaited<ReturnType<typeof previewReturnWorkflow>>;

async function availableDraft(
  tx: Tx,
  c: WorkflowContext,
  input: {
    draftId: string;
    draftRevision: number;
    kind: ReturnKind;
    orderId: string;
    idempotencyKey: string;
  },
) {
  const draft = await tx.workflowDraft.findUnique({ where: { id: input.draftId } });
  assertDraft(draft, c, input.kind, input.orderId);
  if (draft?.archivedAt || (draft?.revision ?? 0) !== input.draftRevision)
    throw new WorkflowError(
      "CONFLICT",
      "途中保存が別操作で更新・記録済みになりました。元入力と保存結果を確認してください。",
    );
  const other = await tx.workflowRequest.findFirst({
    where: {
      ...scope(c),
      operatorId: c.operatorId,
      id: { not: input.idempotencyKey },
      kind: { in: ["RETURN", "REFUND", "RETURN_REBASE"] },
      status: "PREPARED",
      payload: { path: ["draftId"], equals: input.draftId },
    },
  });
  if (other)
    throw new WorkflowError(
      "CONFLICT",
      "元の保存要求が未解決です。先に元要求の結果照会・取消を行ってください。",
    );
  return draft;
}
export async function recordReturn(
  db: PrismaClient,
  c: WorkflowContext,
  input: z.infer<typeof returnRecordSchema>,
) {
  return runWorkflow(db, c, input, input.kind, input.input.date, async (tx) => {
    const draft = await availableDraft(tx, c, input);
    assertBaseline(draft?.baseSnapshot ?? input.baseSnapshot, c, input.orderId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`order:${input.orderId}`},0))`;
    const current = await dataFor(tx, c, input.orderId);
    if (current.order.revision !== input.orderRevision)
      throw new WorkflowError(
        "CONFLICT",
        "実績が別操作で更新されました。手元入力を保持して最新の実績と比較してください。",
      );
    const p = await planFor(tx, c, input.input);
    if (input.input.kind !== input.kind || input.input.orderId !== input.orderId)
      throw new WorkflowError("CONTEXT_CHANGED", "対象実績・操作が一致しません。");
    if (p.order.revision !== input.orderRevision)
      throw new WorkflowError(
        "CONFLICT",
        "実績が別操作で更新されました。手元入力を保持して最新の実績と比較してください。",
      );
    if (p.confirmation !== input.confirmationFingerprint)
      throw new WorkflowError(
        "VALUATION_REQUIRED",
        "確認後に在庫・原価・入力内容が変わりました。最新の内容で再確認してください。",
      );
    const original = returnSnapshotSchema.safeParse(draft?.baseSnapshot ?? input.baseSnapshot);
    if (original.success && original.data.reportingEntityId !== c.reportingEntityId)
      throw new WorkflowError(
        "OWNERSHIP_CHANGED",
        "入力開始後に申告主体が変わりました。帰属を確認してください。",
      );
    for (const variant of [
      ...new Set(p.allocations.map((a) => a.consumption.itemVariantId)),
    ].sort())
      await lockInventoryTarget(tx, variant, c.businessUnitId);
    if (!draft)
      await tx.workflowDraft.create({
        data: {
          id: input.draftId,
          ...scope(c),
          operatorId: c.operatorId,
          year: c.year,
          kind: input.kind,
          payload: toJson(input.input),
          baseSnapshot: input.baseSnapshot ? toJson(input.baseSnapshot) : undefined,
          archivedAt: new Date(),
        },
      });
    const returned = await tx.salesReturn.create({
      data: {
        salesOrderId: input.orderId,
        sourceDraftId: input.draftId,
        requestKey: input.idempotencyKey,
        returnedAt: instant(input.input.date),
        salesRefundJpy: p.amounts.salesRefund,
        feeRefundJpy: p.amounts.feeRefund,
        shippingRefundJpy: p.amounts.shippingRefund,
        memo: input.input.memo || null,
        ...(p.line
          ? {
              lines: {
                create: {
                  salesOrderLineId: p.line.id,
                  quantity: p.quantity,
                  componentOnly: p.componentOnly,
                },
              },
            }
          : {}),
      },
      include: { lines: true },
    });
    const operation = p.line
      ? await tx.inventoryOperation.create({
          data: {
            ...scope(c),
            operatorId: c.operatorId,
            operationType: "SALE_RETURN",
            sourceType: "sales_return",
            sourceId: returned.id,
            idempotencyKey: input.idempotencyKey,
            occurredAt: instant(input.input.date),
            valuationOrder:
              plannedOperationOrder() ??
              new Decimal(
                (
                  await tx.inventoryOperation.aggregate({
                    where: {
                      businessUnitId: c.businessUnitId,
                      occurredAt: {
                        gte: instant(input.input.date),
                        lt: new Date(`${input.input.date}T24:00:00+09:00`),
                      },
                    },
                    _max: { valuationOrder: true },
                  })
                )._max.valuationOrder?.toString() ?? "0",
              )
                .plus(1)
                .toFixed(30),
          },
        })
      : null;
    for (const a of p.allocations) {
      const r = a.consumption;
      const movementKey = `${input.idempotencyKey}:${r.id}${p.componentOnly ? `:${a.disposition}` : ""}`;
      a.cost = plannedMovementCost(movementKey, a.cost);
      await tx.returnComponentDisposition.create({
        data: {
          salesReturnLineId: returned.lines[0]!.id,
          consumptionId: r.id,
          itemVariantId: r.itemVariantId,
          inventoryLotId: r.inventoryLotId,
          uniqueStockUnitId: r.uniqueStockUnitId,
          storageLocationId: r.storageLocationId,
          quantity: a.quantity,
          disposition: a.disposition,
          costTotalJpy: a.cost,
        },
      });
      if (a.disposition === "RESTOCK") {
        const lotId = r.uniqueStockUnit?.inventoryLotId ?? r.inventoryLotId;
        if (!lotId)
          throw new WorkflowError("HISTORY_INCOMPLETE", "元の仕入ロットを確認できません。");
        await tx.inventoryLot.update({
          where: { id: lotId },
          data: { remainingQuantity: { increment: a.quantity } },
        });
        if (r.uniqueStockUnitId)
          await tx.uniqueStockUnit.update({
            where: { id: r.uniqueStockUnitId },
            data: { status: "IN_STOCK", storageLocationId: r.storageLocationId },
          });
        const tracking = r.uniqueStockUnitId ? "UNIQUE" : "QUANTITY";
        const balance = await tx.inventoryCostBalance.findUnique({
          where: {
            itemVariantId_businessUnitId_trackingMode: {
              itemVariantId: r.itemVariantId,
              businessUnitId: c.businessUnitId,
              trackingMode: tracking,
            },
          },
        });
        const q = (balance?.quantity ?? 0) + a.quantity,
          cost = (balance?.carryingCostTotalJpy ?? 0n) + a.cost;
        await tx.inventoryCostBalance.upsert({
          where: {
            itemVariantId_businessUnitId_trackingMode: {
              itemVariantId: r.itemVariantId,
              businessUnitId: c.businessUnitId,
              trackingMode: tracking,
            },
          },
          create: {
            itemVariantId: r.itemVariantId,
            businessUnitId: c.businessUnitId,
            trackingMode: tracking,
            quantity: q,
            carryingCostTotalJpy: cost,
            averageUnitCostJpy: averageUnitCost(cost, q),
          },
          update: {
            quantity: q,
            carryingCostTotalJpy: cost,
            averageUnitCostJpy: averageUnitCost(cost, q),
          },
        });
      } else if (r.uniqueStockUnitId)
        await tx.uniqueStockUnit.update({
          where: { id: r.uniqueStockUnitId },
          data: {
            status: a.disposition === "DEFECTIVE" ? "RETURNED" : "DISPOSED",
            storageLocationId: r.storageLocationId,
          },
        });
      await tx.stockMovement.create({
        data: {
          operationId: operation!.id,
          itemVariantId: r.itemVariantId,
          inventoryLotId: r.uniqueStockUnit?.inventoryLotId ?? r.inventoryLotId,
          uniqueStockUnitId: r.uniqueStockUnitId,
          movementType:
            a.disposition === "RESTOCK"
              ? "RETURN_IN"
              : a.disposition === "DEFECTIVE"
                ? "RETURN_DEFECTIVE"
                : "RETURN_DISPOSAL",
          quantity: a.quantity,
          costTotalJpy: a.cost,
          movementAt: instant(input.input.date),
          businessUnitId: c.businessUnitId,
          storageLocationToId: r.storageLocationId,
          sourceType: "sales_return",
          sourceId: returned.id,
          idempotencyKey: movementKey,
          operatorId: c.operatorId,
        },
      });
    }
    if (p.line)
      await tx.salesOrderLine.update({
        where: { id: p.line.id },
        data: { returnedQuantity: { increment: p.quantity } },
      });
    const allReturned =
      input.kind === "RETURN" &&
      p.order.lines.every((l) =>
        l.consumptions.every(
          (r) =>
            r.dispositions.reduce((s, d) => s + d.quantity, 0) +
              p.allocations
                .filter((a) => a.consumption.id === r.id)
                .reduce((s, a) => s + a.quantity, 0) ===
            r.quantity,
        ),
      );
    await tx.salesOrder.update({
      where: { id: input.orderId },
      data: { revision: { increment: 1 }, ...(allReturned ? { status: "RETURNED" } : {}) },
    });
    if (allReturned)
      await tx.salesOrderEvent.create({
        data: {
          salesOrderId: input.orderId,
          fromStatus: p.order.status,
          toStatus: "RETURNED",
          occurredAt: instant(input.input.date),
          operatorId: c.operatorId,
          idempotencyKey: input.idempotencyKey,
          reason: input.input.memo || null,
        },
      });
    if (draft)
      await tx.workflowDraft.update({
        where: { id: draft.id },
        data: { payload: toJson(input.input), archivedAt: new Date() },
      });
    return {
      id: input.orderId,
      detail: {
        returnId: returned.id,
        inventoryChanged: input.kind === "RETURN",
        quantity: p.quantity,
        changes: p.allocations.map((a) => ({
          consumptionId: a.consumption.id,
          quantity: a.quantity,
          cost: a.cost.toString(),
          disposition: a.disposition,
        })),
        amounts: toJson(p.amounts),
      },
    };
  });
}
export async function rebaseReturn(
  db: PrismaClient,
  c: WorkflowContext,
  input: z.infer<typeof returnRebaseSchema>,
) {
  return runWorkflow(db, c, input, "RETURN_REBASE", day(new Date()), async (tx) => {
    const draft = await availableDraft(tx, c, input);
    assertBaseline(draft?.baseSnapshot ?? input.baseSnapshot, c, input.orderId);
    const review = await loadReturnReview(tx, c, input);
    if (!review.canResolve)
      throw new WorkflowError(
        (review.code ?? "CONFLICT") as
          | "CONFLICT"
          | "YEAR_LOCKED"
          | "CONTEXT_CHANGED"
          | "OWNERSHIP_CHANGED",
        review.message!,
      );
    if (review.snapshot.revision !== input.orderRevision)
      throw new WorkflowError(
        "CONFLICT",
        "比較中に実績が再更新されました。最新の差分を確認してください。",
      );
    if (input.input.kind !== input.kind || input.input.orderId !== input.orderId)
      throw new WorkflowError("CONTEXT_CHANGED", "手元入力と対象が一致しません。");
    const next = await tx.workflowDraft.create({
      data: {
        ...scope(c),
        id: randomUUID(),
        operatorId: c.operatorId,
        year: c.year,
        kind: input.kind,
        revision: 1,
        baseSnapshot: toJson(review.snapshot),
        payload: toJson(
          input.choice === "LOCAL" ? input.input : blankReturnInput(input.kind, input.orderId),
        ),
      },
    });
    if (draft)
      await tx.workflowDraft.update({
        where: { id: draft.id },
        data: { payload: toJson(input.input), archivedAt: new Date() },
      });
    else
      await tx.workflowDraft.create({
        data: {
          ...scope(c),
          id: input.draftId,
          operatorId: c.operatorId,
          year: c.year,
          kind: input.kind,
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
  });
}
