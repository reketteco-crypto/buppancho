import type { Prisma } from "@/generated/prisma/client";
import type { WorkflowContext } from "@/lib/sales/workflow-context";
import { WorkflowError } from "@/lib/sales/workflow-errors";
import { receiptCostPlan } from "./receipt-cost";
import { effectiveLotReceiptDates } from "@/lib/inventory/event-dates";

type Tx = Prisma.TransactionClient;
export async function receiptPlan(
  tx: Tx,
  lineId: string,
  pending?: { id: string; quantity: number; deliveryLineId?: string },
) {
  const line = await tx.purchaseDocumentLine.findUniqueOrThrow({
    where: { id: lineId },
    include: {
      receipts: {
        orderBy: [{ receipt: { createdAt: "asc" } }, { id: "asc" }],
        include: { deliveryLinks: true },
      },
      deliveries: {
        include: {
          delivery: {
            include: {
              charges: {
                where: { supersededBy: null, capitalized: true },
                include: { allocations: true },
              },
            },
          },
        },
      },
    },
  });
  const deliveries = line.deliveries.map((d) => ({
    id: d.id,
    quantity: d.quantity,
    cost: d.delivery.charges
      .flatMap((c) => c.allocations)
      .filter((a) => a.lineId === lineId)
      .reduce((s, a) => s + a.amountJpy, 0n),
  }));
  const base = line.landedCostJpy - deliveries.reduce((s, d) => s + d.cost, 0n);
  const receipts = line.receipts.map((r) => ({
    id: r.id,
    quantity: r.quantity,
    deliveryLineId: r.deliveryLineId,
    links: r.deliveryLinks,
  }));
  if (pending)
    receipts.push({ ...pending, deliveryLineId: pending.deliveryLineId ?? null, links: [] });
  return receiptCostPlan(line.quantity, base, receipts, deliveries);
}

export async function linkReceipts(
  tx: Tx,
  c: WorkflowContext,
  key: string,
  links: { receiptLineId: string; deliveryLineId: string; quantity: number }[],
  allowedDeliveryIds: string[],
) {
  for (const link of links) {
    const delivery = await tx.inboundDeliveryLine.findFirst({
      where: {
        id: link.deliveryLineId,
        deliveryId: { in: allowedDeliveryIds },
        delivery: {
          workspaceId: c.workspaceId,
          businessUnitId: c.businessUnitId,
          reportingEntityId: c.reportingEntityId,
        },
      },
      include: { delivery: true, receipts: true, receiptLinks: true },
    });
    const receipt = await tx.purchaseReceiptLine.findFirst({
      where: {
        id: link.receiptLineId,
        receipt: {
          workspaceId: c.workspaceId,
          businessUnitId: c.businessUnitId,
          reportingEntityId: c.reportingEntityId,
        },
      },
      include: { receipt: true, deliveryLinks: true },
    });
    const receivedDate = receipt?.inventoryLotId
      ? (await effectiveLotReceiptDates(tx, [receipt.inventoryLotId])).get(receipt.inventoryLotId)
      : receipt?.receipt.receivedDate.toISOString().slice(0, 10);
    if (
      !delivery ||
      !receipt ||
      receipt.lineId !== delivery.purchaseLineId ||
      receipt.deliveryLineId ||
      !receivedDate ||
      receivedDate < delivery.delivery.shippedDate.toISOString().slice(0, 10) ||
      link.quantity + receipt.deliveryLinks.reduce((s, l) => s + l.quantity, 0) >
        receipt.quantity ||
      link.quantity +
        delivery.receipts.reduce((s, l) => s + l.quantity, 0) +
        delivery.receiptLinks.reduce((s, l) => s + l.quantity, 0) >
        delivery.quantity
    )
      throw new WorkflowError("VALIDATION", "配送と受取の対応数量・日付を確認してください。");
    await tx.receiptDeliveryLink.create({ data: { ...link, requestId: key } });
  }
}
