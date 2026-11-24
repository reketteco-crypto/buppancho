import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { z } from "zod";
import { componentsSchema, optionalMoney, workflowContextSchema } from "@/lib/validation/workflow";
import { lockInventoryDomain } from "@/lib/inventory/domain-lock";
import { movingAverageOutCost } from "@/lib/inventory/money";
import { checkWorkflowContext, type WorkflowContext } from "@/lib/sales/workflow-context";
import { estimatedFee, managementProfit, percentDisplay } from "@/lib/sales/money";

export const listingEstimateSchema = z.object({
  context: workflowContextSchema,
  components: componentsSchema,
  price: optionalMoney,
  expectedFeeSource: z.enum(["RATE", "AMOUNT", "UNKNOWN"]).optional(),
  expectedFee: optionalMoney.optional(),
  expectedShipping: optionalMoney,
  expectedPacking: optionalMoney.optional(),
  expectedOther: optionalMoney.optional(),
});
export function estimateProfit(values: {
  price: bigint | null;
  cost: bigint | null;
  fee: bigint | null;
  shipping: bigint | null;
  packing: bigint | null;
  other: bigint | null;
}) {
  const labels = {
    price: "出品価格",
    cost: "管理原価",
    fee: "見込み手数料",
    shipping: "見込み送料",
    packing: "見込み梱包費",
    other: "見込みその他費用",
  };
  const missing = (Object.keys(labels) as (keyof typeof labels)[])
    .filter((key) => values[key] === null)
    .map((key) => labels[key]);
  return {
    missing,
    profit: missing.length
      ? null
      : managementProfit({
          gross: values.price!,
          cogs: values.cost!,
          fee: values.fee!,
          shipping: values.shipping!,
          packing: values.packing!,
          other: values.other!,
        }),
  };
}

export async function estimateComponentCost(
  tx: Prisma.TransactionClient,
  c: Pick<WorkflowContext, "workspaceId" | "businessUnitId">,
  components: z.infer<typeof componentsSchema>,
) {
  let total = 0n,
    final = true;
  for (const part of components) {
    if (part.uniqueStockUnitId) {
      const unit = await tx.uniqueStockUnit.findFirst({
        where: {
          id: part.uniqueStockUnitId,
          workspaceId: c.workspaceId,
          status: { in: ["IN_STOCK", "RESERVED"] },
          itemVariant: {
            active: true,
            inventoryItem: { businessUnitId: c.businessUnitId, status: "ACTIVE" },
          },
        },
        include: { inventoryLot: true },
      });
      if (!unit) return { cost: null, final: false };
      total += unit.acquisitionCostJpy;
      final &&= unit.inventoryLot?.costStatus === "FINAL";
    } else {
      const variant = await tx.itemVariant.findFirst({
        where: {
          id: part.itemVariantId!,
          active: true,
          inventoryItem: {
            workspaceId: c.workspaceId,
            businessUnitId: c.businessUnitId,
            status: "ACTIVE",
          },
        },
        include: {
          costBalances: { where: { businessUnitId: c.businessUnitId, trackingMode: "QUANTITY" } },
          inventoryLots: { where: { trackingMode: "QUANTITY", remainingQuantity: { gt: 0 } } },
        },
      });
      const balance = variant?.costBalances[0];
      if (!balance || balance.quantity < part.requiredQuantity) return { cost: null, final: false };
      total += movingAverageOutCost(
        balance.carryingCostTotalJpy,
        balance.quantity,
        part.requiredQuantity,
      );
      final &&=
        !!variant.inventoryLots.length &&
        variant.inventoryLots.every((lot) => lot.costStatus === "FINAL");
    }
  }
  return { cost: total, final };
}

export async function previewListingEstimate(
  db: PrismaClient,
  c: WorkflowContext,
  input: z.infer<typeof listingEstimateSchema>,
) {
  return db.$transaction(async (tx) => {
    await lockInventoryDomain(tx, c.businessUnitId);
    await checkWorkflowContext(tx, c);
    const channel = await tx.salesChannel.findFirst({
      where: { workspaceId: c.workspaceId, type: "MERCARI" },
      orderBy: { id: "asc" },
    });
    const { cost, final } = await estimateComponentCost(tx, c, input.components);
    const feeSource = input.expectedFeeSource ?? "RATE";
    const fee =
      feeSource === "AMOUNT"
        ? (input.expectedFee ?? null)
        : feeSource === "RATE" &&
            input.price !== null &&
            channel?.active &&
            channel.defaultFeeRate !== null
          ? estimatedFee(input.price, channel.defaultFeeRate)
          : null;
    const values = {
      price: input.price,
      cost,
      fee,
      shipping: input.expectedShipping,
      packing: input.expectedPacking ?? null,
      other: input.expectedOther ?? null,
    };
    const { profit, missing } = estimateProfit(values);
    return {
      ...(Object.fromEntries(
        Object.entries(values).map(([key, value]) => [key, value?.toString() ?? null]),
      ) as Record<keyof typeof values, string | null>),
      profit: profit?.toString() ?? null,
      missing,
      final,
      channelRevision: channel?.revision ?? null,
      feeRate:
        !channel?.active || channel.defaultFeeRate === null
          ? null
          : percentDisplay(channel.defaultFeeRate),
    };
  });
}
export type ListingEstimate = Awaited<ReturnType<typeof previewListingEstimate>>;
