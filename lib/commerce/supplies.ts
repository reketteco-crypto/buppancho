import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { WorkflowContext } from "@/lib/sales/workflow-context";
import { WorkflowError } from "@/lib/sales/workflow-errors";
import { runWorkflow } from "@/lib/sales/workflow-runner";
import { allocateYen, Precise } from "./allocation";
import { materialUseSchema } from "./input";
import { effectiveSourceDates } from "@/lib/inventory/event-dates";
type Tx = Prisma.TransactionClient;
export type SupplyPrice = {
  id: string;
  name: string;
  kind: string;
  unit: string;
  revision: number;
  unitCost: string;
  sourceLineId: string | null;
  final: boolean;
};
export async function supplyPrices(
  db: Pick<Tx, "supplyItem">,
  c: Pick<WorkflowContext, "workspaceId" | "businessUnitId" | "reportingEntityId">,
  date: string,
  ids?: string[],
): Promise<SupplyPrice[]> {
  const items = await db.supplyItem.findMany({
    where: {
      workspaceId: c.workspaceId,
      businessUnitId: c.businessUnitId,
      active: true,
      ...(ids ? { id: { in: ids } } : {}),
    },
    orderBy: { name: "asc" },
    include: {
      purchases: {
        where: {
          document: {
            workspaceId: c.workspaceId,
            businessUnitId: c.businessUnitId,
            reportingEntityId: c.reportingEntityId,
            status: { not: "CANCELLED" },
            purchasedDate: { lte: new Date(`${date}T00:00:00Z`) },
          },
        },
        orderBy: [
          { document: { purchasedDate: "desc" } },
          { document: { createdAt: "desc" } },
          { position: "desc" },
        ],
        take: 1,
        include: { document: true },
      },
    },
  });
  return items.map((s) => {
    const p = s.purchases[0];
    return {
      id: s.id,
      name: s.name,
      kind: s.kind,
      unit: s.unit,
      revision: s.revision,
      unitCost: p
        ? new Precise(p.landedCostJpy.toString()).div(p.quantity).toDecimalPlaces(8).toString()
        : "",
      sourceLineId: p?.id ?? null,
      final: p?.document.costFinal ?? false,
    };
  });
}
export async function skuMaterialQuote(
  tx: Tx,
  c: WorkflowContext,
  skuId: string,
  quantity: number,
  date: string,
  overrides: Record<string, string> = {},
) {
  const settings = await tx.skuSupplySetting.findMany({
    where: {
      skuId,
      sku: { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId, active: true },
    },
    include: { supplyItem: true },
    orderBy: [{ purpose: "asc" }, { supplyItemId: "asc" }],
  });
  if (Object.keys(overrides).some((id) => !settings.some((s) => s.id === id)))
    throw new WorkflowError("CONFLICT", "SKUの資材構成が変わりました。確認してください。");
  const prices = await supplyPrices(tx, c, date);
  const rows = settings.map((s) => {
    const price = prices.find((p) => p.id === s.supplyItemId);
    if (!price || price.kind !== "MATERIAL")
      throw new WorkflowError("CONFLICT", "SKUの資材を使用できません。");
    const unitCost = s.unitCostJpy?.toString() ?? price.unitCost;
    const amount =
      overrides[s.id] !== undefined && overrides[s.id] !== ""
        ? new Precise(overrides[s.id]!)
        : new Precise(s.quantity.toString()).mul(quantity);
    if (amount.gt(1000000))
      throw new WorkflowError("VALIDATION", "資材の使用量は100万以下で入力してください。");
    return {
      settingId: s.id,
      supplyItemId: s.supplyItemId,
      name: price.name,
      purpose: s.purpose,
      quantity: amount.toString(),
      unitCost,
      sourceLineId: s.unitCostJpy !== null ? null : price.sourceLineId,
      final: s.unitCostJpy !== null || price.final,
    };
  });
  const exact = rows.map((r) =>
    r.unitCost === "" ? null : new Precise(r.unitCost).mul(r.quantity),
  );
  const known = exact.filter((v) => v !== null),
    total = BigInt(
      known
        .reduce((s, v) => s.plus(v), new Precise(0))
        .toDecimalPlaces(0)
        .toFixed(0),
    );
  if (total > 999999999999999n)
    throw new WorkflowError("VALIDATION", "資材原価は15桁以内にしてください。");
  const allocated = allocateYen(total, known);
  let index = 0;
  const uses = rows.map((r, i) => ({ ...r, cost: exact[i] === null ? null : allocated[index++]! }));
  return {
    quote: rows.map((r) => ({
      settingId: r.settingId,
      unitCost: r.unitCost,
      sourceLineId: r.sourceLineId,
      final: r.final,
    })),
    uses,
    cost: exact.some((r) => r === null) ? null : total,
    final: rows.every((r) => r.final && r.unitCost !== ""),
  };
}
export async function recordMaterialUse(db: PrismaClient, c: WorkflowContext, raw: unknown) {
  const input = materialUseSchema.parse(raw);
  return runWorkflow(db, c, input, "MATERIAL_USE", input.date, async (tx) => {
    const sale = await tx.salesOrder.findFirst({
      where: {
        id: input.saleId,
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        reportingEntityId: c.reportingEntityId,
        recordingMode: "DIRECT",
      },
    });
    if (!sale || sale.revision !== input.saleRevision || !sale.completedAt)
      throw new WorkflowError("CONFLICT", "販売の版・使用日を確認してください。");
    const completedDate = (
      await effectiveSourceDates(tx, c, "sales_order", [{ id: sale.id, date: sale.completedAt }])
    ).get(sale.id)!;
    if (completedDate > input.date)
      throw new WorkflowError("VALIDATION", "資材の使用日は販売の完了日以降にしてください。");
    const supply = (await supplyPrices(tx, c, input.date)).find(
      (s) => s.id === input.supplyItemId && s.kind === "MATERIAL",
    );
    if (!supply) throw new WorkflowError("VALIDATION", "使用する資材を選んでください。");
    const previous = input.supersedesId
      ? await tx.materialUse.findFirst({
          where: {
            id: input.supersedesId,
            saleId: sale.id,
            supplyItemId: supply.id,
            supersededBy: null,
            workspaceId: c.workspaceId,
            businessUnitId: c.businessUnitId,
            reportingEntityId: c.reportingEntityId,
          },
        })
      : null;
    if (input.supersedesId && !previous)
      throw new WorkflowError("CONFLICT", "資材使用の記録が更新されています。");
    if (
      !input.manualPrice &&
      (input.unitCost !== supply.unitCost || input.sourceLineId !== supply.sourceLineId)
    )
      throw new WorkflowError(
        "CONFLICT",
        "資材の購入単価が変わりました。最新単価を確認してください。",
      );
    const exact = input.unitCost === "" ? null : new Precise(input.unitCost).mul(input.quantity),
      cost = exact === null ? null : BigInt(exact.toDecimalPlaces(0).toFixed(0));
    if (cost !== null && cost > 999999999999999n)
      throw new WorkflowError("VALIDATION", "資材原価は15桁以内にしてください。");
    const use = await tx.materialUse.create({
      data: {
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        reportingEntityId: c.reportingEntityId,
        saleId: sale.id,
        supplyItemId: supply.id,
        supplyName: supply.name,
        purchaseLineId: input.manualPrice ? null : supply.sourceLineId,
        purpose: input.purpose,
        quantity: input.quantity,
        unitCostJpy: input.unitCost || null,
        costJpy: cost,
        costFinal: input.unitCost !== "" && (input.manualPrice || supply.final),
        date: new Date(`${input.date}T00:00:00Z`),
        reason: input.reason,
        supersedesId: previous?.id,
        requestId: input.idempotencyKey,
      },
    });
    await tx.salesOrder.update({ where: { id: sale.id }, data: { revision: { increment: 1 } } });
    return {
      id: sale.id,
      detail: { useId: use.id, cost: cost?.toString() ?? null, reason: input.reason },
    };
  });
}
