import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { WorkflowContext } from "@/lib/sales/workflow-context";
import { WorkflowError } from "@/lib/sales/workflow-errors";
import { runWorkflow } from "@/lib/sales/workflow-runner";
import { toJson } from "@/lib/sales/request-store";
import { nextWorkspaceCode } from "@/lib/inventory/codes";
import { allocateCharge, Precise } from "./allocation";
import { chargeMoney } from "./purchase-calculation";
import { deliverySchema, purchaseCostSchema, type BuyInput } from "./input";
import { refreshDocumentCostStates, reviseAcquisitionCosts } from "./acquisition";

import { linkReceipts } from "./receipt-delivery";

type Tx = Prisma.TransactionClient;
const scope = (c: WorkflowContext) => ({
  workspaceId: c.workspaceId,
  businessUnitId: c.businessUnitId,
});
type CostSourceLine = {
  id: string;
  quantity: number;
  productAmountJpy: bigint;
  landedCostJpy: bigint;
  documentId: string;
  weightG: { toString(): string } | null;
  volumeCm3: { toString(): string } | null;
  receivedQuantity: number;
};
function conflict(): never {
  throw new WorkflowError(
    "CONFLICT",
    "購入・配送が更新されました。手元の入力を保持して再確認してください。",
  );
}

async function appendCharge(
  tx: Tx,
  c: WorkflowContext,
  input: {
    purchaseId?: string;
    date: string;
    deliveryId?: string;
    charge: BuyInput["charges"][number];
    supersedesId?: string;
    reason: string;
    bases: Record<string, { weight: string; volume: string; manual: string }>;
    refund: boolean;
  },
  source: CostSourceLine[],
  quantities: Map<string, number>,
) {
  const previous = input.supersedesId
    ? await tx.purchaseCharge.findFirst({
        where: {
          id: input.supersedesId,
          documentId: input.purchaseId ?? null,
          deliveryId: input.deliveryId ?? null,
          supersededBy: null,
        },
        include: { allocations: true },
      })
    : null;
  if (input.supersedesId && !previous) conflict();
  const charge = input.charge;
  if (charge.lineIds.some((id) => !source.some((l) => l.id === id)))
    throw new WorkflowError("VALIDATION", "費用の配分先を確認してください。");
  const targets = source.filter((l) => !charge.lineIds.length || charge.lineIds.includes(l.id));
  let amount: bigint | null;
  try {
    amount = chargeMoney(charge, "JPY", "1");
  } catch {
    throw new WorkflowError("VALIDATION", "費用の通貨・換算レート・実支払額を確認してください。");
  }
  if (input.refund && amount === null)
    throw new WorkflowError("VALIDATION", "返金額を入力してください。");
  if (amount !== null && input.refund) amount = -amount;
  if (amount !== null && (amount > 999999999999999n || amount < -999999999999999n))
    throw new WorkflowError("VALIDATION", "費用金額は15桁以内にしてください。");
  const effectiveBases = Object.fromEntries(
    targets.map((l) => [
      l.id,
      {
        weight: input.bases[l.id]?.weight ?? l.weightG?.toString() ?? "",
        volume: input.bases[l.id]?.volume ?? l.volumeCm3?.toString() ?? "",
        manual: charge.manual[l.id] ?? input.bases[l.id]?.manual ?? "",
      },
    ]),
  );
  const allocation = allocateCharge(
    amount,
    charge.method,
    targets.map((l) => {
      const basis = effectiveBases[l.id]!;
      const quantity = quantities.get(l.id) ?? l.quantity;
      const weight = basis.weight,
        volume = basis.volume;
      return {
        id: l.id,
        amount: new Precise(l.productAmountJpy.toString()).mul(quantity).div(l.quantity).toString(),
        quantity,
        weight: weight ? new Precise(weight).mul(quantity).toString() : "",
        volume: volume ? new Precise(volume).mul(quantity).toString() : "",
        manual: charge.manual[l.id] ?? basis?.manual,
      };
    }),
  );
  const record = await tx.purchaseCharge.create({
    data: {
      documentId: input.purchaseId,
      recordedDate: new Date(`${input.date}T00:00:00Z`),
      deliveryId: input.deliveryId,
      name: charge.name,
      amountJpy: amount,
      amountForeign: charge.amount || null,
      currency: charge.currency || "JPY",
      exchangeRate: charge.exchangeRate || ((charge.currency || "JPY") === "JPY" ? "1" : null),
      rateBasis: charge.actualJpy
        ? "ACTUAL"
        : (charge.currency || "JPY") === "JPY"
          ? "JPY"
          : "ENTERED",
      allocationMethod: charge.method,
      capitalized: charge.capitalized,
      allocated: allocation.allocations !== null,
      supersedesId: previous?.id,
      reason: input.reason,
      refund: input.refund,
      basisSnapshot: toJson({ targets: targets.map((l) => l.id), bases: effectiveBases }),
      allocations: {
        create: (allocation.allocations ?? []).map((a) => ({
          lineId: a.lineId,
          amountJpy: a.amount,
        })),
      },
    },
  });
  const deltas = new Map(source.map((l) => [l.id, 0n]));
  if (previous?.capitalized)
    for (const a of previous.allocations)
      deltas.set(a.lineId, (deltas.get(a.lineId) ?? 0n) - a.amountJpy);
  if (charge.capitalized)
    for (const a of allocation.allocations ?? [])
      deltas.set(a.lineId, (deltas.get(a.lineId) ?? 0n) + a.amount);
  for (const line of source) {
    const delta = deltas.get(line.id) ?? 0n;
    if (line.landedCostJpy + delta < 0n)
      throw new WorkflowError("VALIDATION", "返金・訂正額が商品の原価を超えています。");
    if (delta)
      await tx.purchaseDocumentLine.update({
        where: { id: line.id },
        data: { landedCostJpy: { increment: delta } },
      });
  }
  const invoiceDelta = (amount ?? 0n) - (previous?.amountJpy ?? 0n);
  if (input.purchaseId) {
    const document = await tx.purchaseDocument.findFirstOrThrow({
      where: { id: input.purchaseId, ...scope(c), reportingEntityId: c.reportingEntityId },
    });
    if (document.totalJpy + invoiceDelta < 0n)
      throw new WorkflowError("VALIDATION", "返金額が購入合計を超えています。");
    await tx.purchaseDocument.update({
      where: { id: document.id },
      data: { totalJpy: { increment: invoiceDelta } },
    });
  } else
    await tx.inboundDelivery.update({
      where: { id: input.deliveryId! },
      data: { revision: { increment: 1 } },
    });
  return { record, invoiceDelta };
}

export async function recordPurchaseCost(
  db: PrismaClient,
  c: WorkflowContext,
  raw: unknown,
  refund = false,
) {
  const input = purchaseCostSchema.parse({ ...(raw as object), refund });
  const kind = refund ? "PURCHASE_REFUND" : "PURCHASE_COST";
  return runWorkflow(db, c, input, kind, input.date, async (tx) => {
    let lines: CostSourceLine[], quantities: Map<string, number>;
    if (input.purchaseId) {
      const document = await tx.purchaseDocument.findFirst({
        where: { id: input.purchaseId, ...scope(c), reportingEntityId: c.reportingEntityId },
        include: { lines: { orderBy: { position: "asc" } } },
      });
      if (!document || document.revision !== input.revision || document.status === "CANCELLED")
        conflict();
      lines = document.lines;
      quantities = new Map(lines.map((l) => [l.id, l.quantity]));
    } else {
      const delivery = await tx.inboundDelivery.findFirst({
        where: { id: input.deliveryId, ...scope(c), reportingEntityId: c.reportingEntityId },
        include: { lines: { orderBy: { position: "asc" }, include: { purchaseLine: true } } },
      });
      if (!delivery || delivery.revision !== input.revision) conflict();
      lines = delivery.lines.map((l) => l.purchaseLine);
      quantities = new Map(delivery.lines.map((l) => [l.purchaseLineId, l.quantity]));
    }
    await linkReceipts(
      tx,
      c,
      input.idempotencyKey,
      input.receiptLinks,
      input.deliveryId ? [input.deliveryId] : [],
    );
    const { record } = await appendCharge(tx, c, input, lines, quantities);
    for (const charge of input.additionalCharges) {
      const current = await tx.purchaseDocumentLine.findMany({
        where: { id: { in: lines.map((l) => l.id) }, document: scope(c) },
      });
      current.sort(
        (a, b) => lines.findIndex((l) => l.id === a.id) - lines.findIndex((l) => l.id === b.id),
      );
      await appendCharge(tx, c, { ...input, charge, supersedesId: undefined }, current, quantities);
    }
    const ids = lines.map((l) => l.id);
    await refreshDocumentCostStates(tx, c, [...new Set(lines.map((l) => l.documentId))]);
    const acquisition = await reviseAcquisitionCosts(
      tx,
      c,
      input.idempotencyKey,
      ids,
      input.reason,
    );
    return {
      id: input.purchaseId ?? input.deliveryId!,
      detail: { chargeId: record.id, reason: input.reason, refund, acquisition },
    };
  });
}

export async function recordDelivery(db: PrismaClient, c: WorkflowContext, raw: unknown) {
  const input = deliverySchema.parse(raw);
  return runWorkflow(db, c, input, "DELIVERY", input.date, async (tx) => {
    const lines = await tx.purchaseDocumentLine.findMany({
      where: {
        id: { in: input.lines.map((l) => l.lineId) },
        document: {
          ...scope(c),
          reportingEntityId: c.reportingEntityId,
          status: { not: "CANCELLED" },
        },
      },
      include: { document: true, deliveries: true },
    });
    if (lines.length !== input.lines.length)
      throw new WorkflowError("VALIDATION", "配送する商品を確認してください。");
    lines.sort(
      (a, b) =>
        input.lines.findIndex((l) => l.lineId === a.id) -
        input.lines.findIndex((l) => l.lineId === b.id),
    );
    for (const row of input.lines) {
      const line = lines.find((l) => l.id === row.lineId)!;
      if (line.document.revision !== row.purchaseRevision) conflict();
      if (line.document.purchasedDate > new Date(`${input.date}T00:00:00Z`))
        throw new WorkflowError("VALIDATION", "配送日は購入日以降を指定してください。");
      if (row.quantity + line.deliveries.reduce((s, l) => s + l.quantity, 0) > line.quantity)
        throw new WorkflowError("VALIDATION", "注文数を超えて配送できません。");
    }
    const method = input.deliveryMethodId
      ? await tx.deliveryMethod.findFirst({
          where: { id: input.deliveryMethodId, workspaceId: c.workspaceId, active: true },
        })
      : null;
    if (
      input.deliveryMethodId &&
      (!method || (input.methodRevision !== undefined && method.revision !== input.methodRevision))
    )
      conflict();
    if (
      input.counterpartyId &&
      !(await tx.counterparty.findFirst({
        where: { id: input.counterpartyId, workspaceId: c.workspaceId, active: true },
      }))
    )
      throw new WorkflowError("VALIDATION", "配送の取引先を確認してください。");
    if (input.charges.length && lines.some((l) => l.receivedQuantity > 0) && !input.reason)
      throw new WorkflowError(
        "VALIDATION",
        "受取済み商品の原価へ費用を追加する理由を入力してください。",
      );
    const delivery = await tx.inboundDelivery.create({
      data: {
        ...scope(c),
        reportingEntityId: c.reportingEntityId,
        code: `D-${await nextWorkspaceCode(tx, c.workspaceId, "PURCHASE")}`,
        shippedDate: new Date(`${input.date}T00:00:00Z`),
        deliveryMethodId: method?.id,
        methodName: method?.name,
        counterpartyId: input.counterpartyId || null,
        reference: input.reference || null,
        memo: input.memo || null,
        requestKey: input.idempotencyKey,
        lines: {
          create: input.lines.map((l, i) => ({
            purchaseLineId: l.lineId,
            quantity: l.quantity,
            position: i,
          })),
        },
      },
      include: { lines: true },
    });
    await linkReceipts(
      tx,
      c,
      input.idempotencyKey,
      input.receiptLinks.map((l) => ({
        receiptLineId: l.receiptLineId,
        quantity: l.quantity,
        deliveryLineId: delivery.lines.find((d) => d.purchaseLineId === l.lineId)?.id ?? l.lineId,
      })),
      [delivery.id],
    );
    const quantities = new Map(input.lines.map((l) => [l.lineId, l.quantity]));
    for (const charge of input.charges) {
      const current = await tx.purchaseDocumentLine.findMany({
        where: { id: { in: lines.map((l) => l.id) }, document: scope(c) },
      });
      current.sort(
        (a, b) => lines.findIndex((l) => l.id === a.id) - lines.findIndex((l) => l.id === b.id),
      );
      await appendCharge(
        tx,
        c,
        {
          deliveryId: delivery.id,
          date: input.date,
          charge,
          reason: input.reason || "配送費用",
          bases: input.bases,
          refund: false,
        },
        current,
        quantities,
      );
    }
    const documents = [...new Set(lines.map((l) => l.documentId))];
    if (input.charges.length) {
      await refreshDocumentCostStates(tx, c, documents);
      await reviseAcquisitionCosts(
        tx,
        c,
        input.idempotencyKey,
        lines.map((l) => l.id),
        input.reason || "配送費用",
      );
    }
    return { id: delivery.id, detail: { code: delivery.code, purchaseIds: documents } };
  });
}
