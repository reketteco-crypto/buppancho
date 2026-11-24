import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import type { WorkflowContext } from "@/lib/sales/workflow-context";
import { checkWorkflowContext } from "@/lib/sales/workflow-context";
import { lockInventoryDomain } from "@/lib/inventory/domain-lock";
import { WorkflowError } from "@/lib/sales/workflow-errors";
import { captureValuationPreview } from "@/lib/inventory/shared-valuation";
import { effectiveCosts } from "@/lib/inventory/effective-cost";
import { buySchema } from "./input";
import {
  isQuantityStock,
  purchaseCostRows,
  type PurchaseCostBalance,
  type PurchaseCostPreview,
} from "./purchase-cost";
import { recordBuy, purchaseCalculation } from "./workflow";

// Financial projections do not depend on the payment or on a saved draft revision.
export const purchaseCostPreviewSchema = z
  .object(buySchema.shape)
  .omit({ payment: true })
  .refine((i) => new Set(i.lines.map((l) => l.clientId)).size === i.lines.length, {
    message: "明細が重複しています。",
    path: ["lines"],
  });

async function currentBalances(tx: Prisma.TransactionClient, c: WorkflowContext, ids: string[]) {
  const variants = await tx.itemVariant.findMany({
    where: {
      id: { in: ids },
      workspaceId: c.workspaceId,
      active: true,
      inventoryItem: {
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        status: "ACTIVE",
        managementType: "QUANTITY",
      },
    },
    include: {
      costBalances: { where: { businessUnitId: c.businessUnitId, trackingMode: "QUANTITY" } },
      stockMovements: {
        where: {
          businessUnitId: c.businessUnitId,
          uniqueStockUnitId: null,
          movementType: { notIn: ["LOCATION_TRANSFER", "RETURN_DEFECTIVE", "RETURN_DISPOSAL"] },
        },
      },
      inventoryLots: {
        include: {
          purchaseLine: { include: { purchase: true } },
          documentReceiptLine: { include: { receipt: true } },
        },
      },
    },
  });
  if (variants.length !== ids.length)
    throw new WorkflowError(
      "VALIDATION",
      "選択した商品を使用できません。商品を選び直してください。",
    );
  const costs = await effectiveCosts(
    tx,
    "MOVEMENT",
    variants.flatMap((v) => v.stockMovements),
  );
  return variants.map((variant) => {
    if (
      variant.inventoryLots.some(
        (lot) =>
          (lot.purchaseLine &&
            lot.purchaseLine.purchase.reportingEntityId !== c.reportingEntityId) ||
          (lot.documentReceiptLine &&
            lot.documentReceiptLine.receipt.reportingEntityId !== c.reportingEntityId),
      )
    )
      throw new WorkflowError("OWNERSHIP_CHANGED", "別の申告主体の在庫が含まれます。");
    const balance = variant.costBalances[0];
    const quantity = variant.stockMovements.reduce((sum, m) => sum + m.quantity, 0);
    const cost = variant.stockMovements.reduce((sum, m) => sum + costs.get(m.id)!, 0n);
    const lotQuantity = variant.inventoryLots
      .filter((lot) => lot.trackingMode === "QUANTITY")
      .reduce((sum, lot) => sum + lot.remainingQuantity, 0);
    if (
      (variant.stockMovements.length > 0 && !balance) ||
      quantity < 0 ||
      cost < 0n ||
      (quantity === 0 && cost !== 0n) ||
      quantity !== lotQuantity ||
      quantity !== (balance?.quantity ?? 0) ||
      cost !== (balance?.carryingCostTotalJpy ?? 0n)
    )
      throw new WorkflowError(
        "HISTORY_INCOMPLETE",
        "在庫履歴と原価残高が一致しません。履歴を確認してください。",
      );
    return {
      variantId: variant.id,
      beforeQuantity: quantity,
      beforeCost: cost.toString(),
      quantity,
      cost: cost.toString(),
      provisional: variant.inventoryLots.some(
        (lot) => lot.remainingQuantity > 0 && lot.costStatus !== "FINAL",
      ),
    };
  });
}

export async function purchaseCostPreview(
  db: PrismaClient,
  c: WorkflowContext,
  raw: unknown,
): Promise<PurchaseCostPreview> {
  const input = purchaseCostPreviewSchema.parse(raw);
  const basis = input.received ? "RECEIPT" : "CURRENT";
  const totals = purchaseCalculation(input);
  if (!totals.final)
    return {
      status: "PENDING",
      basis,
      rows: [],
      message: "費用の金額と原価への配分を確認してください。",
    };
  if (!input.lines.some(isQuantityStock)) return { status: "READY", basis, rows: [] };
  let balances: PurchaseCostBalance[];
  if (input.received) {
    const prepared = buySchema.safeParse({
      ...input,
      idempotencyKey: randomUUID(),
      draftId: randomUUID(),
      draftRevision: 0,
      createSkus: false,
    });
    if (!prepared.success)
      return {
        status: "PENDING",
        basis,
        rows: [],
        message: prepared.error.issues[0]?.message || "購入の入力項目を確認してください。",
      };
    const preview = await captureValuationPreview(() => recordBuy(db, c, prepared.data));
    if (preview.requiresOrder)
      return {
        status: "ORDER_REQUIRED",
        basis,
        rows: [],
        choices: preview.choices,
        message: "同日の記録順序を選ぶと補充後の平均原価を計算できます。",
      };
    balances = preview.receiptBalances ?? [];
  } else {
    balances = await db.$transaction(
      async (tx) => {
        await lockInventoryDomain(tx, c.businessUnitId);
        await checkWorkflowContext(tx, c, input.date);
        const lines = input.lines.filter(isQuantityStock);
        const ids = [...new Set(lines.flatMap((l) => (l.variantId ? [l.variantId] : [])))];
        const result = await currentBalances(tx, c, ids);
        for (const line of lines.filter((l) => !l.variantId))
          result.push({
            variantId: line.clientId,
            beforeQuantity: 0,
            beforeCost: "0",
            quantity: 0,
            cost: "0",
            provisional: false,
          });
        for (const balance of result) {
          const matching = input.lines.flatMap((l, i) =>
            isQuantityStock(l) && (l.variantId || l.clientId) === balance.variantId ? [i] : [],
          );
          balance.quantity += matching.reduce((sum, i) => sum + input.lines[i]!.quantity, 0);
          balance.cost = (
            BigInt(balance.cost) + matching.reduce((sum, i) => sum + totals.landed[i]!, 0n)
          ).toString();
        }
        return result;
      },
      { isolationLevel: "RepeatableRead" },
    );
  }
  return { status: "READY", basis, rows: purchaseCostRows(input, totals, balances) };
}
