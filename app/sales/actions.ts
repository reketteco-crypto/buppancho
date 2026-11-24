"use server";

import { lockMasterDomain, assertMasterVersion } from "@/lib/settings/master-version";
import { masterAction, type MasterResult } from "@/lib/settings/master-result";

import { lockInventoryDomain } from "@/lib/inventory/domain-lock";
import { effectiveCosts } from "@/lib/inventory/effective-cost";
import { checkWorkflowContext } from "@/lib/sales/workflow";

import { allocateReturnedComponents } from "@/lib/sales/return-allocation";

import Decimal from "decimal.js";
import { Prisma } from "@/generated/prisma/client";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { assertTrustedOrigin } from "@/lib/auth/origin";
import { writeAudit } from "@/lib/audit/write";
import { nextWorkspaceCode } from "@/lib/inventory/codes";
import { averageUnitCost, movingAverageOutCost, parseYen } from "@/lib/inventory/money";
import { lockInventoryTarget, requireInventoryContext } from "@/lib/inventory/context";
import { canChangeListingStatus } from "@/lib/sales/availability";
import { estimatedFee, parsePercent } from "@/lib/sales/money";
import {
  cancellationSchema,
  completionSchema,
  listingSchema,
  parseJsonField,
  returnSchema,
  saleSchema,
  salesSkuSchema,
  shipmentSchema,
} from "@/lib/validation/sales";

async function rejectLegacySalesWrite(): Promise<void> {
  await requireInventoryContext();
  throw new Error("旧方式の更新は終了しました。販売の出品一覧から出品・完了を記録してください。");
}

export type SalesActionState = { error?: string; success?: string };

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError)
    return error.issues[0]?.message ?? "入力内容を確認してください。";
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
    return "同じ操作または外部IDがすでに登録されています。再読み込みしてください。";
  return error instanceof Error ? error.message : "処理を完了できませんでした。";
}

function tokyoDateTime(value: string): Date {
  const normalized = value.trim();
  const date = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalized)
    ? new Date(`${normalized}:00+09:00`)
    : new Date(normalized);
  if (Number.isNaN(date.getTime())) throw new Error("日時を確認してください。");
  return date;
}

function tokyoFiscalDate(value: Date): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value;
  return new Date(`${part("year")}-${part("month")}-${part("day")}T00:00:00.000Z`);
}

function optionalYen(value: string): bigint | null {
  return value ? parseYen(value) : null;
}

function returnDispositionFor(
  input: z.infer<typeof returnSchema>,
  itemVariantId: string,
  uniqueStockUnitId: string | null,
) {
  const selected = input.dispositions.find((row) =>
    uniqueStockUnitId
      ? row.uniqueStockUnitId === uniqueStockUnitId
      : row.uniqueStockUnitId === null && row.itemVariantId === itemVariantId,
  );
  if (!selected) throw new Error("構成品ごとの返品処理を選択してください。");
  return selected.disposition;
}

async function requireOrder(
  context: Awaited<ReturnType<typeof requireInventoryContext>>,
  id: string,
  completing = false,
) {
  const order = await context.db.salesOrder.findFirst({
    where: { id, workspaceId: context.workspaceId, businessUnitId: context.businessUnitId },
    include: {
      lines: {
        include: {
          reservations: true,
          consumptions: true,
          salesSku: { include: { components: true } },
        },
      },
      shipment: true,
      returns: { include: { lines: true } },
    },
  });
  if (!order) throw new Error("注文が見つかりません。");
  if (order.reportingEntityId !== context.reportingEntityId)
    throw new Error("注文の申告主体が現在の割当と異なります。在庫移管の確認が必要です。");
  if (context.fiscalYear.status === "LOCKED")
    throw new Error("ロック済み年度の注文は変更できません。年度設定を確認してください。");
  const orderedYear = Number(
    new Intl.DateTimeFormat("en", { timeZone: "Asia/Tokyo", year: "numeric" }).format(
      order.completedAt ?? order.orderedAt ?? order.createdAt,
    ),
  );
  if (orderedYear !== context.fiscalYear.year && !(completing && !order.completedAt))
    throw new Error(
      "年度をまたぐ注文の変更はフェーズ2では行えません。対象年度を確認してください。",
    );
  return order;
}

export async function updateSalesChannelAction(formData: FormData): Promise<MasterResult> {
  return masterAction(async () => {
    await assertTrustedOrigin();
    const context = await requireInventoryContext();
    const parsed = z
      .object({
        id: z.string().uuid(),
        feeRatePercent: z
          .string()
          .trim()
          .refine((value) => {
            if (!value) return true;
            try {
              parsePercent(value);
              return true;
            } catch {
              return false;
            }
          }, "手数料率は0～100の数値で入力してください。"),
        shippingPayer: z.enum(["", "seller", "buyer"]),
      })
      .parse(Object.fromEntries(formData));
    const channel = await context.db.salesChannel.findFirst({
      where: { id: parsed.id, workspaceId: context.workspaceId },
    });
    if (!channel) throw new Error("販路が見つかりません。");
    const active = formData.get("active") === "on";
    await context.db.$transaction(async (tx) => {
      await lockMasterDomain(tx, context.workspaceId);
      await assertMasterVersion(
        tx,
        context.workspaceId,
        "sales_channel",
        channel.id,
        formData.get("revision"),
      );
      await lockInventoryDomain(tx, context.businessUnitId);
      await checkWorkflowContext(tx, {
        workspaceId: context.workspaceId,
        businessUnitId: context.businessUnitId,
        operatorId: context.operatorId,
        year: context.fiscalYear.year,
        reportingEntityId: context.reportingEntityId,
        userAccountId: context.session.userAccountId,
        sessionId: context.session.id,
      });
      await tx.salesChannel.update({
        where: { id: channel.id },
        data: {
          defaultFeeRate: parsed.feeRatePercent ? parsePercent(parsed.feeRatePercent) : null,
          defaultShippingPayer: parsed.shippingPayer || null,
          active,
        },
      });
      await writeAudit(tx, {
        workspaceId: context.workspaceId,
        userAccountId: context.session.userAccountId,
        operatorId: context.operatorId,
        action: "sales_channel.update",
        entityType: "sales_channel",
        entityId: channel.id,
        before: {
          defaultFeeRate: channel.defaultFeeRate?.toString() ?? null,
          active: channel.active,
        },
        after: { feeRatePercent: parsed.feeRatePercent || null, active },
      });
    });
    revalidatePath("/settings/sales-channels");
  });
}

export async function createSalesSkuAction(
  _state: SalesActionState,
  formData: FormData,
): Promise<SalesActionState> {
  try {
    await assertTrustedOrigin();
    await rejectLegacySalesWrite();
    const context = await requireInventoryContext();
    const input = salesSkuSchema.parse({
      ...Object.fromEntries(formData),
      components: parseJsonField(formData, "components"),
    });
    const prior = await context.db.salesSku.findUnique({
      where: { requestKey: input.idempotencyKey },
    });
    if (prior) redirect(`/sales/skus/${prior.id}`);
    const targets = await context.db.itemVariant.findMany({
      where: {
        workspaceId: context.workspaceId,
        inventoryItem: { businessUnitId: context.businessUnitId },
        OR: [
          { id: { in: input.components.map((item) => item.itemVariantId).filter(Boolean) } },
          {
            uniqueStockUnits: {
              some: {
                id: { in: input.components.map((item) => item.uniqueStockUnitId).filter(Boolean) },
              },
            },
          },
        ],
      },
      include: { uniqueStockUnits: true },
    });
    for (const component of input.components) {
      const valid = component.itemVariantId
        ? targets.some((row) => row.id === component.itemVariantId)
        : targets.some((row) =>
            row.uniqueStockUnits.some((unit) => unit.id === component.uniqueStockUnitId),
          );
      if (!valid) throw new Error("現在の販売部門で使用できない構成品が含まれています。");
    }
    const sku = await context.db.$transaction(async (tx) => {
      await lockInventoryDomain(tx, context.businessUnitId);
      await checkWorkflowContext(tx, {
        workspaceId: context.workspaceId,
        businessUnitId: context.businessUnitId,
        operatorId: context.operatorId,
        year: context.fiscalYear.year,
        reportingEntityId: context.reportingEntityId,
        userAccountId: context.session.userAccountId,
        sessionId: context.session.id,
      });
      const created = await tx.salesSku.create({
        data: {
          workspaceId: context.workspaceId,
          businessUnitId: context.businessUnitId,
          skuCode: await nextWorkspaceCode(tx, context.workspaceId, "SALES_SKU"),
          name: input.name,
          skuType: input.skuType,
          description: input.description || null,
          expectedPriceJpy: optionalYen(input.expectedPriceJpy),
          requestKey: input.idempotencyKey,
          components: {
            create: input.components.map((component) => ({
              itemVariantId: component.itemVariantId || null,
              uniqueStockUnitId: component.uniqueStockUnitId || null,
              requiredQuantity: component.requiredQuantity,
            })),
          },
        },
      });
      await writeAudit(tx, {
        workspaceId: context.workspaceId,
        userAccountId: context.session.userAccountId,
        operatorId: context.operatorId,
        action: "sales_sku.create",
        entityType: "sales_sku",
        entityId: created.id,
        after: { skuCode: created.skuCode, name: created.name, skuType: created.skuType },
      });
      return created;
    });
    redirect(`/sales/skus/${sku.id}`);
  } catch (error) {
    if (error && typeof error === "object" && "digest" in error) throw error;
    return { error: errorMessage(error) };
  }
}

export async function createListingAction(
  _state: SalesActionState,
  formData: FormData,
): Promise<SalesActionState> {
  try {
    await assertTrustedOrigin();
    await rejectLegacySalesWrite();
    const listedAt = tokyoDateTime(String(formData.get("listedAt") ?? ""));
    const context = await requireInventoryContext(tokyoFiscalDate(listedAt));
    const input = listingSchema.parse({
      ...Object.fromEntries(formData),
      listedQuantity: Number(formData.get("listedQuantity")),
    });
    const prior = await context.db.listing.findUnique({
      where: { requestKey: input.idempotencyKey },
    });
    if (prior) redirect(`/sales/listings/${prior.id}`);
    const [sku, channel] = await Promise.all([
      context.db.salesSku.findFirst({
        where: {
          id: input.salesSkuId,
          workspaceId: context.workspaceId,
          businessUnitId: context.businessUnitId,
          active: true,
        },
      }),
      context.db.salesChannel.findFirst({
        where: { workspaceId: context.workspaceId, type: "MERCARI", active: true },
      }),
    ]);
    if (!sku) throw new Error("販売SKUを使用できません。");
    if (!channel?.defaultFeeRate)
      throw new Error("先に販路設定でメルカリの既定手数料率を確認してください。");
    const listing = await context.db.$transaction(async (tx) => {
      await lockInventoryDomain(tx, context.businessUnitId);
      await checkWorkflowContext(tx, {
        workspaceId: context.workspaceId,
        businessUnitId: context.businessUnitId,
        operatorId: context.operatorId,
        year: context.fiscalYear.year,
        reportingEntityId: context.reportingEntityId,
        userAccountId: context.session.userAccountId,
        sessionId: context.session.id,
      });
      const row = await tx.listing.create({
        data: {
          salesSkuId: sku.id,
          salesChannelId: channel.id,
          externalListingId: input.externalListingId || null,
          url: input.url || null,
          listedAt,
          currentPriceJpy: parseYen(input.currentPriceJpy),
          listedQuantity: input.listedQuantity,
          expectedShippingJpy: optionalYen(input.expectedShippingJpy),
          feeRate: parsePercent(input.feeRatePercent),
          status: input.status,
          requestKey: input.idempotencyKey,
        },
      });
      await tx.listingPriceHistory.create({
        data: {
          listingId: row.id,
          priceJpy: row.currentPriceJpy,
          effectiveAt: listedAt,
          reason: "初回出品",
          operatorId: context.operatorId,
          idempotencyKey: input.idempotencyKey,
        },
      });
      await writeAudit(tx, {
        workspaceId: context.workspaceId,
        userAccountId: context.session.userAccountId,
        operatorId: context.operatorId,
        action: "listing.create",
        entityType: "listing",
        entityId: row.id,
        after: {
          priceJpy: row.currentPriceJpy.toString(),
          quantity: row.listedQuantity,
          status: row.status,
        },
      });
      return row;
    });
    redirect(`/sales/listings/${listing.id}`);
  } catch (error) {
    if (error && typeof error === "object" && "digest" in error) throw error;
    return { error: errorMessage(error) };
  }
}

export async function updateListingPriceAction(
  _state: SalesActionState,
  formData: FormData,
): Promise<SalesActionState> {
  try {
    await assertTrustedOrigin();
    await rejectLegacySalesWrite();
    const context = await requireInventoryContext();
    const input = z
      .object({
        id: z.string().uuid(),
        priceJpy: z.string(),
        reason: z.string().trim().min(1).max(500),
        idempotencyKey: z.string().uuid(),
      })
      .parse(Object.fromEntries(formData));
    if (
      await context.db.listingPriceHistory.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      })
    )
      return { success: "価格は更新済みです。" };
    const listing = await context.db.listing.findFirst({
      where: {
        id: input.id,
        salesSku: { workspaceId: context.workspaceId, businessUnitId: context.businessUnitId },
      },
    });
    if (!listing) throw new Error("出品が見つかりません。");
    if (listing.workflowVersion === 2)
      throw new Error("新方式の出品詳細から価格変更を記録してください。");
    if (listing.status === "ENDED") throw new Error("終了した出品の価格は変更できません。");
    const price = parseYen(input.priceJpy);
    await context.db.$transaction(async (tx) => {
      await lockInventoryDomain(tx, context.businessUnitId);
      await checkWorkflowContext(tx, {
        workspaceId: context.workspaceId,
        businessUnitId: context.businessUnitId,
        operatorId: context.operatorId,
        year: context.fiscalYear.year,
        reportingEntityId: context.reportingEntityId,
        userAccountId: context.session.userAccountId,
        sessionId: context.session.id,
      });
      await tx.listing.update({ where: { id: listing.id }, data: { currentPriceJpy: price } });
      await tx.listingPriceHistory.create({
        data: {
          listingId: listing.id,
          priceJpy: price,
          effectiveAt: new Date(),
          reason: input.reason,
          operatorId: context.operatorId,
          idempotencyKey: input.idempotencyKey,
        },
      });
      await writeAudit(tx, {
        workspaceId: context.workspaceId,
        userAccountId: context.session.userAccountId,
        operatorId: context.operatorId,
        action: "listing.price.update",
        entityType: "listing",
        entityId: listing.id,
        before: { priceJpy: listing.currentPriceJpy.toString() },
        after: { priceJpy: price.toString(), reason: input.reason },
      });
    });
    revalidatePath(`/sales/listings/${listing.id}`);
    return { success: "価格を更新しました。" };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

export async function updateListingStatusAction(formData: FormData): Promise<void> {
  await assertTrustedOrigin();
  await rejectLegacySalesWrite();
  const context = await requireInventoryContext();
  const input = z
    .object({
      id: z.string().uuid(),
      status: z.enum(["DRAFT", "ACTIVE", "PAUSED", "SOLD_OUT", "ENDED"]),
      idempotencyKey: z.string().uuid(),
    })
    .parse(Object.fromEntries(formData));
  const listing = await context.db.listing.findFirst({
    where: {
      id: input.id,
      salesSku: { workspaceId: context.workspaceId, businessUnitId: context.businessUnitId },
    },
  });
  if (!listing) throw new Error("出品が見つかりません。");
  if (listing.workflowVersion === 2)
    throw new Error(
      "新方式の出品は詳細画面から出来事を記録してください。状態だけの変更はできません。",
    );
  if (!canChangeListingStatus(listing.status, input.status))
    throw new Error("許可されていない出品状態の変更です。");
  if (listing.status !== input.status) {
    await context.db.$transaction(async (tx) => {
      await lockInventoryDomain(tx, context.businessUnitId);
      await checkWorkflowContext(tx, {
        workspaceId: context.workspaceId,
        businessUnitId: context.businessUnitId,
        operatorId: context.operatorId,
        year: context.fiscalYear.year,
        reportingEntityId: context.reportingEntityId,
        userAccountId: context.session.userAccountId,
        sessionId: context.session.id,
      });
      await tx.listing.update({ where: { id: listing.id }, data: { status: input.status } });
      await writeAudit(tx, {
        workspaceId: context.workspaceId,
        userAccountId: context.session.userAccountId,
        operatorId: context.operatorId,
        action: "listing.status.update",
        entityType: "listing",
        entityId: listing.id,
        before: { status: listing.status },
        after: { status: input.status },
        requestId: input.idempotencyKey,
      });
    });
  }
  revalidatePath(`/sales/listings/${listing.id}`);
  revalidatePath("/sales");
}

export async function confirmSaleAction(
  _state: SalesActionState,
  formData: FormData,
): Promise<SalesActionState> {
  try {
    await assertTrustedOrigin();
    await rejectLegacySalesWrite();
    const orderedAt = tokyoDateTime(String(formData.get("orderedAt") ?? ""));
    const context = await requireInventoryContext(tokyoFiscalDate(orderedAt));
    const input = saleSchema.parse({
      ...Object.fromEntries(formData),
      quantity: Number(formData.get("quantity")),
    });
    const prior = await context.db.salesOrder.findUnique({
      where: { requestKey: input.idempotencyKey },
    });
    if (prior) redirect(`/sales/orders/${prior.id}`);
    const order = await context.db.$transaction(
      async (tx) => {
        await lockInventoryDomain(tx, context.businessUnitId);
        await checkWorkflowContext(tx, {
          workspaceId: context.workspaceId,
          businessUnitId: context.businessUnitId,
          operatorId: context.operatorId,
          year: context.fiscalYear.year,
          reportingEntityId: context.reportingEntityId,
          userAccountId: context.session.userAccountId,
          sessionId: context.session.id,
        });
        const listing = await tx.listing.findFirst({
          where: {
            id: input.listingId,
            status: "ACTIVE",
            salesSku: { workspaceId: context.workspaceId, businessUnitId: context.businessUnitId },
          },
          include: {
            salesSku: { include: { components: { include: { uniqueStockUnit: true } } } },
            salesChannel: true,
          },
        });
        if (!listing) throw new Error("出品中の対象が見つかりません。");
        if (listing.workflowVersion === 2)
          throw new Error(
            "この出品は在庫確保済みです。出品詳細から「取引完了を記録」を使ってください。",
          );
        if (listing.listedQuantity - listing.reservedQuantity < input.quantity)
          throw new Error("出品残数が不足しています。再読み込みしてください。");
        const variantIds = [
          ...new Set(
            listing.salesSku.components
              .map(
                (component) => component.itemVariantId ?? component.uniqueStockUnit?.itemVariantId,
              )
              .filter((id): id is string => Boolean(id)),
          ),
        ].sort();
        for (const variantId of variantIds)
          await lockInventoryTarget(tx, variantId, context.businessUnitId);
        const gross = listing.currentPriceJpy * BigInt(input.quantity);
        const created = await tx.salesOrder.create({
          data: {
            workspaceId: context.workspaceId,
            businessUnitId: context.businessUnitId,
            reportingEntityId: context.reportingEntityId,
            salesChannelId: listing.salesChannelId,
            externalOrderId: input.externalOrderId || null,
            orderedAt,
            status: "AWAITING_SHIPMENT",
            grossSalesJpy: gross,
            discountJpy: parseYen(input.discountJpy),
            feeJpy: estimatedFee(gross, listing.feeRate),
            shippingJpy: listing.expectedShippingJpy,
            packingJpy: optionalYen(input.packingJpy),
            otherCostJpy: optionalYen(input.otherCostJpy),
            memo: input.memo || null,
            requestKey: input.idempotencyKey,
            lines: {
              create: {
                listingId: listing.id,
                salesSkuId: listing.salesSkuId,
                quantity: input.quantity,
                unitPriceJpy: listing.currentPriceJpy,
              },
            },
            shipment: { create: {} },
          },
          include: { lines: true },
        });
        const line = created.lines[0]!;
        for (const component of listing.salesSku.components) {
          const needed = component.requiredQuantity * input.quantity;
          if (component.uniqueStockUnitId) {
            const unit = await tx.uniqueStockUnit.findFirst({
              where: {
                id: component.uniqueStockUnitId,
                workspaceId: context.workspaceId,
                status: "IN_STOCK",
              },
            });
            const held = await tx.inventoryReservation.count({
              where: { uniqueStockUnitId: component.uniqueStockUnitId, status: "RESERVED" },
            });
            if (!unit || held)
              throw new Error("別操作で個体在庫が引当済みです。再読み込みしてください。");
            await tx.inventoryReservation.create({
              data: {
                salesOrderLineId: line.id,
                itemVariantId: unit.itemVariantId,
                inventoryLotId: null,
                uniqueStockUnitId: unit.id,
                storageLocationId: unit.storageLocationId,
                quantity: 1,
              },
            });
            await tx.uniqueStockUnit.update({
              where: { id: unit.id },
              data: { status: "RESERVED" },
            });
          } else {
            const variantId = component.itemVariantId!;
            const [lots, held] = await Promise.all([
              tx.inventoryLot.findMany({
                where: {
                  itemVariantId: variantId,
                  trackingMode: "QUANTITY",
                  remainingQuantity: { gt: 0 },
                },
                orderBy: [{ receivedDate: "asc" }, { id: "asc" }],
              }),
              tx.inventoryReservation.groupBy({
                by: ["inventoryLotId"],
                where: {
                  itemVariantId: variantId,
                  status: "RESERVED",
                  inventoryLotId: { not: null },
                },
                _sum: { quantity: true },
              }),
            ]);
            const heldByLot = new Map(
              held.map((row) => [row.inventoryLotId, row._sum.quantity ?? 0]),
            );
            let remaining = needed;
            for (const lot of lots) {
              const available = lot.remainingQuantity - (heldByLot.get(lot.id) ?? 0);
              const quantity = Math.min(available, remaining);
              if (quantity > 0)
                await tx.inventoryReservation.create({
                  data: {
                    salesOrderLineId: line.id,
                    itemVariantId: variantId,
                    inventoryLotId: lot.id,
                    storageLocationId: lot.storageLocationId,
                    quantity,
                  },
                });
              remaining -= quantity;
              if (!remaining) break;
            }
            if (remaining)
              throw new Error("在庫不足または別操作で引当済みです。再読み込みしてください。");
          }
        }
        await tx.listing.update({
          where: { id: listing.id },
          data: { reservedQuantity: { increment: input.quantity } },
        });
        await tx.salesOrderEvent.create({
          data: {
            salesOrderId: created.id,
            fromStatus: "DRAFT",
            toStatus: "AWAITING_SHIPMENT",
            occurredAt: orderedAt,
            operatorId: context.operatorId,
            idempotencyKey: input.idempotencyKey,
          },
        });
        await writeAudit(tx, {
          workspaceId: context.workspaceId,
          userAccountId: context.session.userAccountId,
          operatorId: context.operatorId,
          action: "sales_order.confirm",
          entityType: "sales_order",
          entityId: created.id,
          after: {
            grossSalesJpy: gross.toString(),
            quantity: input.quantity,
            status: "AWAITING_SHIPMENT",
          },
        });
        return created;
      },
      { isolationLevel: "Serializable" },
    );
    redirect(`/sales/orders/${order.id}`);
  } catch (error) {
    if (error && typeof error === "object" && "digest" in error) throw error;
    return { error: errorMessage(error) };
  }
}

async function addOrderEvent(
  tx: Prisma.TransactionClient,
  context: Awaited<ReturnType<typeof requireInventoryContext>>,
  orderId: string,
  fromStatus: Prisma.SalesOrderUpdateInput["status"],
  toStatus: "SHIPPED" | "AWAITING_COMPLETION" | "COMPLETED" | "CANCELLED" | "RETURNED",
  idempotencyKey: string,
  reason?: string,
) {
  await tx.salesOrderEvent.create({
    data: {
      salesOrderId: orderId,
      fromStatus: fromStatus as never,
      toStatus,
      occurredAt: new Date(),
      operatorId: context.operatorId,
      reason,
      idempotencyKey,
    },
  });
}

export async function shipOrderAction(
  _state: SalesActionState,
  formData: FormData,
): Promise<SalesActionState> {
  try {
    await assertTrustedOrigin();
    await rejectLegacySalesWrite();
    const shippedAt = tokyoDateTime(String(formData.get("shippedAt") ?? ""));
    const context = await requireInventoryContext(tokyoFiscalDate(shippedAt));
    const input = shipmentSchema.parse(Object.fromEntries(formData));
    if (
      await context.db.salesOrderEvent.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      })
    )
      return { success: "発送は記録済みです。" };
    const order = await requireOrder(context, input.orderId);
    if (order.status !== "AWAITING_SHIPMENT") throw new Error("発送待ちの注文だけ発送できます。");
    await context.db.$transaction(async (tx) => {
      await lockInventoryDomain(tx, context.businessUnitId);
      await checkWorkflowContext(tx, {
        workspaceId: context.workspaceId,
        businessUnitId: context.businessUnitId,
        operatorId: context.operatorId,
        year: context.fiscalYear.year,
        reportingEntityId: context.reportingEntityId,
        userAccountId: context.session.userAccountId,
        sessionId: context.session.id,
      });
      await tx.shipment.update({
        where: { salesOrderId: order.id },
        data: {
          shippedAt,
          shippingMethod: input.shippingMethod,
          trackingNumber: input.trackingNumber || null,
          actualShippingJpy: parseYen(input.actualShippingJpy),
          status: "SHIPPED",
        },
      });
      await tx.salesOrder.update({
        where: { id: order.id },
        data: { status: "SHIPPED", shippingJpy: parseYen(input.actualShippingJpy) },
      });
      await addOrderEvent(tx, context, order.id, order.status, "SHIPPED", input.idempotencyKey);
    });
    revalidatePath(`/sales/orders/${order.id}`);
    return { success: "発送を記録しました。" };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

export async function awaitCompletionAction(formData: FormData): Promise<void> {
  await assertTrustedOrigin();
  await rejectLegacySalesWrite();
  const context = await requireInventoryContext();
  const input = z
    .object({ orderId: z.string().uuid(), idempotencyKey: z.string().uuid() })
    .parse(Object.fromEntries(formData));
  if (
    await context.db.salesOrderEvent.findUnique({ where: { idempotencyKey: input.idempotencyKey } })
  )
    return;
  const order = await requireOrder(context, input.orderId);
  if (order.status !== "SHIPPED") throw new Error("発送済み注文だけ取引完了待ちへ変更できます。");
  await context.db.$transaction(async (tx) => {
    await lockInventoryDomain(tx, context.businessUnitId);
    await checkWorkflowContext(tx, {
      workspaceId: context.workspaceId,
      businessUnitId: context.businessUnitId,
      operatorId: context.operatorId,
      year: context.fiscalYear.year,
      reportingEntityId: context.reportingEntityId,
      userAccountId: context.session.userAccountId,
      sessionId: context.session.id,
    });
    await tx.salesOrder.update({
      where: { id: order.id },
      data: { status: "AWAITING_COMPLETION" },
    });
    await tx.shipment.update({ where: { salesOrderId: order.id }, data: { status: "DELIVERED" } });
    await addOrderEvent(
      tx,
      context,
      order.id,
      order.status,
      "AWAITING_COMPLETION",
      input.idempotencyKey,
    );
  });
  revalidatePath(`/sales/orders/${order.id}`);
}

export async function completeOrderAction(
  _state: SalesActionState,
  formData: FormData,
): Promise<SalesActionState> {
  try {
    await assertTrustedOrigin();
    await rejectLegacySalesWrite();
    const completedAt = tokyoDateTime(String(formData.get("completedAt") ?? ""));
    const context = await requireInventoryContext(tokyoFiscalDate(completedAt));
    const input = completionSchema.parse(Object.fromEntries(formData));
    if (
      await context.db.salesOrderEvent.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      })
    )
      return { success: "取引完了は記録済みです。" };
    const original = await requireOrder(context, input.orderId, true);
    if (!["AWAITING_SHIPMENT", "SHIPPED", "AWAITING_COMPLETION"].includes(original.status))
      throw new Error("発送済みの注文だけ取引完了にできます。");
    await context.db.$transaction(
      async (tx) => {
        await lockInventoryDomain(tx, context.businessUnitId);
        await checkWorkflowContext(tx, {
          workspaceId: context.workspaceId,
          businessUnitId: context.businessUnitId,
          operatorId: context.operatorId,
          year: context.fiscalYear.year,
          reportingEntityId: context.reportingEntityId,
          userAccountId: context.session.userAccountId,
          sessionId: context.session.id,
        });
        const order = await tx.salesOrder.findUniqueOrThrow({
          where: { id: original.id },
          include: { lines: { include: { reservations: { where: { status: "RESERVED" } } } } },
        });
        if (!["AWAITING_SHIPMENT", "SHIPPED", "AWAITING_COMPLETION"].includes(order.status))
          throw new Error("完了記録済み、または状態が更新されました。再読み込みしてください。");
        if (
          order.reportingEntityId !== context.reportingEntityId ||
          order.revision !== original.revision
        )
          throw new Error("注文の帰属・内容が変わりました。再確認してください。");
        if (order.orderedAt && completedAt < order.orderedAt)
          throw new Error("完了日は購入日以降にしてください。");
        const variantIds = [
          ...new Set(
            order.lines.flatMap((line) => line.reservations.map((row) => row.itemVariantId)),
          ),
        ].sort();
        for (const id of variantIds) await lockInventoryTarget(tx, id, context.businessUnitId);
        const laterMovement = await tx.stockMovement.findFirst({
          where: {
            businessUnitId: context.businessUnitId,
            itemVariantId: { in: variantIds },
            movementAt: {
              gte: new Date(
                `${tokyoFiscalDate(completedAt).toISOString().slice(0, 10)}T00:00:00+09:00`,
              ),
            },
            movementType: { not: "LOCATION_TRANSFER" },
          },
        });
        if (laterMovement)
          throw new Error(
            "旧注文の同日・後日入力には原価影響の確認が必要です。現在原価で確定せず、元の注文履歴の確認へ進んでください。",
          );
        const reservedLots = await tx.inventoryLot.findMany({
          where: {
            id: {
              in: order.lines.flatMap((l) =>
                l.reservations.flatMap((r) => (r.inventoryLotId ? [r.inventoryLotId] : [])),
              ),
            },
          },
        });
        if (reservedLots.some((l) => l.receivedDate > tokyoFiscalDate(completedAt)))
          throw new Error("確保したロットは完了日にまだ入庫していません。");
        const operation = await tx.inventoryOperation.create({
          data: {
            workspaceId: context.workspaceId,
            businessUnitId: context.businessUnitId,
            operatorId: context.operatorId,
            operationType: "SALE_COMPLETION",
            sourceType: "sales_order",
            sourceId: order.id,
            idempotencyKey: input.idempotencyKey,
            occurredAt: completedAt,
          },
        });
        let movementIndex = 0;
        for (const variantId of variantIds) {
          const reservations = order.lines
            .flatMap((line) => line.reservations.map((row) => ({ ...row, lineId: line.id })))
            .filter((row) => row.itemVariantId === variantId);
          const quantityRows = reservations.filter((row) => !row.uniqueStockUnitId);
          const uniqueRows = reservations.filter((row) => row.uniqueStockUnitId);
          if (quantityRows.length) {
            const balance = await tx.inventoryCostBalance.findUniqueOrThrow({
              where: {
                itemVariantId_businessUnitId_trackingMode: {
                  itemVariantId: variantId,
                  businessUnitId: context.businessUnitId,
                  trackingMode: "QUANTITY",
                },
              },
            });
            const totalQuantity = quantityRows.reduce((sum, row) => sum + row.quantity, 0);
            const outgoing = movingAverageOutCost(
              balance.carryingCostTotalJpy,
              balance.quantity,
              totalQuantity,
            );
            let allocated = 0n;
            for (const [index, row] of quantityRows.entries()) {
              const cost =
                index === quantityRows.length - 1
                  ? outgoing - allocated
                  : BigInt(
                      new Decimal(outgoing.toString())
                        .mul(row.quantity)
                        .div(totalQuantity)
                        .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
                        .toFixed(0),
                    );
              allocated += cost;
              await tx.inventoryLot.update({
                where: { id: row.inventoryLotId! },
                data: { remainingQuantity: { decrement: row.quantity } },
              });
              const lot = await tx.inventoryLot.findUniqueOrThrow({
                where: { id: row.inventoryLotId! },
              });
              await tx.orderComponentConsumption.create({
                data: {
                  salesOrderLineId: row.lineId,
                  itemVariantId: variantId,
                  inventoryLotId: row.inventoryLotId,
                  storageLocationId: row.storageLocationId,
                  quantity: row.quantity,
                  unitCostJpy: new Decimal(cost.toString()).div(row.quantity).toFixed(6),
                  costTotalJpy: cost,
                  costStatus: lot.costStatus,
                },
              });
              await tx.stockMovement.create({
                data: {
                  operationId: operation.id,
                  itemVariantId: variantId,
                  inventoryLotId: row.inventoryLotId,
                  movementType: "SALE_OUT",
                  quantity: -row.quantity,
                  costTotalJpy: -cost,
                  movementAt: completedAt,
                  businessUnitId: context.businessUnitId,
                  storageLocationFromId: row.storageLocationId,
                  sourceType: "sales_order",
                  sourceId: order.id,
                  idempotencyKey: `${input.idempotencyKey}:${movementIndex++}`,
                  operatorId: context.operatorId,
                },
              });
            }
            const nextQuantity = balance.quantity - totalQuantity,
              nextTotal = balance.carryingCostTotalJpy - outgoing;
            await tx.inventoryCostBalance.update({
              where: { id: balance.id },
              data: {
                quantity: nextQuantity,
                carryingCostTotalJpy: nextTotal,
                averageUnitCostJpy: nextQuantity ? averageUnitCost(nextTotal, nextQuantity) : 0,
              },
            });
          }
          for (const row of uniqueRows) {
            const unit = await tx.uniqueStockUnit.findUniqueOrThrow({
              where: { id: row.uniqueStockUnitId! },
            });
            await tx.uniqueStockUnit.update({ where: { id: unit.id }, data: { status: "SOLD" } });
            await tx.inventoryLot.update({
              where: { id: unit.inventoryLotId },
              data: { remainingQuantity: { decrement: 1 } },
            });
            await tx.orderComponentConsumption.create({
              data: {
                salesOrderLineId: row.lineId,
                itemVariantId: variantId,
                inventoryLotId: null,
                uniqueStockUnitId: unit.id,
                storageLocationId: row.storageLocationId,
                quantity: 1,
                unitCostJpy: unit.acquisitionCostJpy.toString(),
                costTotalJpy: unit.acquisitionCostJpy,
              },
            });
            await tx.stockMovement.create({
              data: {
                operationId: operation.id,
                itemVariantId: variantId,
                inventoryLotId: unit.inventoryLotId,
                uniqueStockUnitId: unit.id,
                movementType: "SALE_OUT",
                quantity: -1,
                costTotalJpy: -unit.acquisitionCostJpy,
                movementAt: completedAt,
                businessUnitId: context.businessUnitId,
                storageLocationFromId: row.storageLocationId,
                sourceType: "sales_order",
                sourceId: order.id,
                idempotencyKey: `${input.idempotencyKey}:${movementIndex++}`,
                operatorId: context.operatorId,
              },
            });
            const balance = await tx.inventoryCostBalance.findUnique({
              where: {
                itemVariantId_businessUnitId_trackingMode: {
                  itemVariantId: variantId,
                  businessUnitId: context.businessUnitId,
                  trackingMode: "UNIQUE",
                },
              },
            });
            if (balance) {
              const q = balance.quantity - 1,
                t = balance.carryingCostTotalJpy - unit.acquisitionCostJpy;
              await tx.inventoryCostBalance.update({
                where: { id: balance.id },
                data: {
                  quantity: q,
                  carryingCostTotalJpy: t,
                  averageUnitCostJpy: q ? averageUnitCost(t, q) : 0,
                },
              });
            }
          }
        }
        for (const line of order.lines) {
          const aggregate = await tx.orderComponentConsumption.aggregate({
            where: { salesOrderLineId: line.id },
            _sum: { costTotalJpy: true },
          });
          await tx.salesOrderLine.update({
            where: { id: line.id },
            data: { managementCogsJpy: aggregate._sum.costTotalJpy ?? 0n },
          });
          if (line.reservations.length)
            await tx.inventoryReservation.updateMany({
              where: { id: { in: line.reservations.map((r) => r.id) } },
              data: { status: "CONSUMED" },
            });
          const listingId = line.reservations.length
            ? (await tx.salesOrderLine.findUnique({ where: { id: line.id } }))?.listingId
            : null;
          if (listingId) {
            const listing = await tx.listing.update({
              where: { id: listingId },
              data: {
                listedQuantity: { decrement: line.quantity - line.returnedQuantity },
                reservedQuantity: { decrement: line.quantity - line.returnedQuantity },
              },
            });
            if (listing.listedQuantity === 0)
              await tx.listing.update({ where: { id: listing.id }, data: { status: "SOLD_OUT" } });
          }
        }
        await tx.salesOrder.update({
          where: { id: order.id },
          data: {
            status: "COMPLETED",
            completedAt,
            accountingRecognitionDate: completedAt,
            feeJpy: parseYen(input.feeJpy),
            costStatus: "FINAL",
          },
        });
        await addOrderEvent(tx, context, order.id, order.status, "COMPLETED", input.idempotencyKey);
        await writeAudit(tx, {
          workspaceId: context.workspaceId,
          userAccountId: context.session.userAccountId,
          operatorId: context.operatorId,
          action: "sales_order.complete",
          entityType: "sales_order",
          entityId: order.id,
          after: { completedAt: completedAt.toISOString() },
        });
      },
      { isolationLevel: "Serializable" },
    );
    revalidatePath(`/sales/orders/${original.id}`);
    revalidatePath("/sales");
    return { success: "取引を完了し、在庫と管理原価を確定しました。" };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

export async function cancelOrderAction(
  _state: SalesActionState,
  formData: FormData,
): Promise<SalesActionState> {
  try {
    await assertTrustedOrigin();
    await rejectLegacySalesWrite();
    const context = await requireInventoryContext();
    const input = cancellationSchema.parse(Object.fromEntries(formData));
    if (
      await context.db.salesOrderEvent.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      })
    )
      return { success: "取消済みです。" };
    const order = await requireOrder(context, input.orderId);
    if (!["DRAFT", "CONFIRMED", "AWAITING_SHIPMENT"].includes(order.status))
      throw new Error("発送済みの注文は返品として処理してください。");
    await context.db.$transaction(
      async (tx) => {
        await lockInventoryDomain(tx, context.businessUnitId);
        await checkWorkflowContext(tx, {
          workspaceId: context.workspaceId,
          businessUnitId: context.businessUnitId,
          operatorId: context.operatorId,
          year: context.fiscalYear.year,
          reportingEntityId: context.reportingEntityId,
          userAccountId: context.session.userAccountId,
          sessionId: context.session.id,
        });
        for (const line of order.lines) {
          await tx.inventoryReservation.updateMany({
            where: { salesOrderLineId: line.id, status: "RESERVED" },
            data: { status: "RELEASED" },
          });
          const reservedUnits = line.reservations
            .filter(
              (reservation) => reservation.status === "RESERVED" && reservation.uniqueStockUnitId,
            )
            .map((reservation) => reservation.uniqueStockUnitId!);
          if (reservedUnits.length) {
            await tx.uniqueStockUnit.updateMany({
              where: { id: { in: reservedUnits }, status: "RESERVED" },
              data: { status: "IN_STOCK" },
            });
          }
          if (line.listingId)
            await tx.listing.update({
              where: { id: line.listingId },
              data: { reservedQuantity: { decrement: line.quantity } },
            });
        }
        await tx.salesOrder.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
        await addOrderEvent(
          tx,
          context,
          order.id,
          order.status,
          "CANCELLED",
          input.idempotencyKey,
          input.reason,
        );
        await writeAudit(tx, {
          workspaceId: context.workspaceId,
          userAccountId: context.session.userAccountId,
          operatorId: context.operatorId,
          action: "sales_order.cancel",
          entityType: "sales_order",
          entityId: order.id,
          after: { reason: input.reason },
        });
      },
      { isolationLevel: "Serializable" },
    );
    revalidatePath(`/sales/orders/${order.id}`);
    return { success: "注文を取り消し、引当を解除しました。" };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

async function returnBeforeCompletion(
  context: Awaited<ReturnType<typeof requireInventoryContext>>,
  order: Awaited<ReturnType<typeof requireOrder>>,
  input: z.infer<typeof returnSchema>,
  returnedAt: Date,
): Promise<void> {
  const line = order.lines.find((row) => row.id === input.lineId);
  if (!line || line.returnedQuantity + input.quantity > line.quantity)
    throw new Error("返品数量が販売数量を超えています。");
  await context.db.$transaction(
    async (tx) => {
      await lockInventoryDomain(tx, context.businessUnitId);
      await checkWorkflowContext(tx, {
        workspaceId: context.workspaceId,
        businessUnitId: context.businessUnitId,
        operatorId: context.operatorId,
        year: context.fiscalYear.year,
        reportingEntityId: context.reportingEntityId,
        userAccountId: context.session.userAccountId,
        sessionId: context.session.id,
      });
      const current = await tx.salesOrderLine.findUniqueOrThrow({
        where: { id: line.id },
        include: { reservations: { where: { status: "RESERVED" } } },
      });
      if (current.returnedQuantity + input.quantity > current.quantity)
        throw new Error("別操作で返品済みです。再読み込みしてください。");
      const variantIds = [...new Set(current.reservations.map((row) => row.itemVariantId))].sort();
      for (const id of variantIds) await lockInventoryTarget(tx, id, context.businessUnitId);
      const returned = await tx.salesReturn.create({
        data: {
          salesOrderId: order.id,
          returnedAt,
          salesRefundJpy: parseYen(input.salesRefundJpy),
          feeRefundJpy: parseYen(input.feeRefundJpy),
          shippingRefundJpy: parseYen(input.shippingRefundJpy),
          memo: input.memo || null,
          requestKey: input.idempotencyKey,
          lines: { create: { salesOrderLineId: line.id, quantity: input.quantity } },
        },
        include: { lines: true },
      });
      const returnLine = returned.lines[0]!;
      const operation = await tx.inventoryOperation.create({
        data: {
          workspaceId: context.workspaceId,
          businessUnitId: context.businessUnitId,
          operatorId: context.operatorId,
          operationType: "SALE_RETURN",
          sourceType: "sales_return",
          sourceId: returned.id,
          idempotencyKey: input.idempotencyKey,
          occurredAt: returnedAt,
        },
      });
      let movement = 0;
      const reservationGroups = new Map<string, typeof current.reservations>();
      for (const reservation of current.reservations) {
        const key = reservation.uniqueStockUnitId ?? `variant:${reservation.itemVariantId}`;
        reservationGroups.set(key, [...(reservationGroups.get(key) ?? []), reservation]);
      }
      for (const rows of reservationGroups.values()) {
        const firstReservation = rows[0]!;
        const variantId = firstReservation.itemVariantId;
        const disposition = returnDispositionFor(
          input,
          variantId,
          firstReservation.uniqueStockUnitId,
        );
        const skuComponent = line.salesSku.components.find((component) =>
          firstReservation.uniqueStockUnitId
            ? component.uniqueStockUnitId === firstReservation.uniqueStockUnitId
            : component.uniqueStockUnitId === null && component.itemVariantId === variantId,
        );
        if (!skuComponent) throw new Error("返品対象のSKU構成を確認できません。");
        const targetQuantity = skuComponent.requiredQuantity * input.quantity;
        let remaining = targetQuantity;
        const balance = await tx.inventoryCostBalance.findFirst({
          where: {
            itemVariantId: variantId,
            businessUnitId: context.businessUnitId,
            trackingMode: firstReservation.uniqueStockUnitId ? "UNIQUE" : "QUANTITY",
          },
        });
        const outgoingCost =
          disposition !== "RESTOCK" && balance
            ? movingAverageOutCost(balance.carryingCostTotalJpy, balance.quantity, targetQuantity)
            : balance
              ? BigInt(
                  new Decimal(balance.averageUnitCostJpy.toString())
                    .mul(targetQuantity)
                    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
                    .toFixed(0),
                )
              : 0n;
        let allocatedCost = 0n;
        for (const [index, reservation] of rows.entries()) {
          const quantity = Math.min(reservation.quantity, remaining);
          if (!quantity) continue;
          const last = quantity === remaining || index === rows.length - 1;
          const cost = last
            ? outgoingCost - allocatedCost
            : BigInt(
                new Decimal(outgoingCost.toString())
                  .mul(quantity)
                  .div(targetQuantity)
                  .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
                  .toFixed(0),
              );
          allocatedCost += cost;
          remaining -= quantity;
          if (quantity === reservation.quantity) {
            await tx.inventoryReservation.update({
              where: { id: reservation.id },
              data: { status: disposition === "RESTOCK" ? "RELEASED" : "CONSUMED" },
            });
          } else {
            await tx.inventoryReservation.update({
              where: { id: reservation.id },
              data: { quantity: { decrement: quantity } },
            });
            await tx.inventoryReservation.create({
              data: {
                salesOrderLineId: current.id,
                itemVariantId: reservation.itemVariantId,
                inventoryLotId: reservation.inventoryLotId,
                uniqueStockUnitId: reservation.uniqueStockUnitId,
                storageLocationId: reservation.storageLocationId,
                quantity,
                status: disposition === "RESTOCK" ? "RELEASED" : "CONSUMED",
              },
            });
          }
          let consumptionId: string | null = null;
          if (disposition !== "RESTOCK") {
            if (reservation.uniqueStockUnitId) {
              const unit = await tx.uniqueStockUnit.findUniqueOrThrow({
                where: { id: reservation.uniqueStockUnitId },
              });
              await tx.uniqueStockUnit.update({
                where: { id: unit.id },
                data: { status: disposition === "DEFECTIVE" ? "RETURNED" : "DISPOSED" },
              });
            } else {
              await tx.inventoryLot.update({
                where: { id: reservation.inventoryLotId! },
                data: { remainingQuantity: { decrement: quantity } },
              });
            }
            const consumption = await tx.orderComponentConsumption.create({
              data: {
                salesOrderLineId: current.id,
                itemVariantId: variantId,
                inventoryLotId: reservation.inventoryLotId,
                uniqueStockUnitId: reservation.uniqueStockUnitId,
                storageLocationId: reservation.storageLocationId,
                quantity,
                unitCostJpy: new Decimal(cost.toString()).div(quantity).toFixed(6),
                costTotalJpy: cost,
              },
            });
            consumptionId = consumption.id;
            await tx.stockMovement.create({
              data: {
                operationId: operation.id,
                itemVariantId: variantId,
                inventoryLotId: reservation.inventoryLotId,
                uniqueStockUnitId: reservation.uniqueStockUnitId,
                movementType: "SALE_OUT",
                quantity: -quantity,
                costTotalJpy: -cost,
                movementAt: returnedAt,
                businessUnitId: context.businessUnitId,
                storageLocationFromId: reservation.storageLocationId,
                sourceType: "sales_return",
                sourceId: returned.id,
                idempotencyKey: `${input.idempotencyKey}:${movement++}`,
                operatorId: context.operatorId,
              },
            });
          } else if (reservation.uniqueStockUnitId) {
            await tx.uniqueStockUnit.update({
              where: { id: reservation.uniqueStockUnitId },
              data: { status: "IN_STOCK" },
            });
          }
          await tx.returnComponentDisposition.create({
            data: {
              salesReturnLineId: returnLine.id,
              consumptionId,
              itemVariantId: variantId,
              inventoryLotId: reservation.inventoryLotId,
              uniqueStockUnitId: reservation.uniqueStockUnitId,
              storageLocationId: reservation.storageLocationId,
              quantity,
              disposition,
              costTotalJpy: cost,
            },
          });
          if (disposition !== "RESTOCK") {
            await tx.stockMovement.create({
              data: {
                operationId: operation.id,
                itemVariantId: variantId,
                inventoryLotId: reservation.inventoryLotId,
                uniqueStockUnitId: reservation.uniqueStockUnitId,
                movementType: disposition === "DEFECTIVE" ? "RETURN_DEFECTIVE" : "RETURN_DISPOSAL",
                quantity,
                costTotalJpy: cost,
                movementAt: returnedAt,
                businessUnitId: context.businessUnitId,
                storageLocationToId: reservation.storageLocationId,
                sourceType: "sales_return",
                sourceId: returned.id,
                idempotencyKey: `${input.idempotencyKey}:${movement++}`,
                operatorId: context.operatorId,
              },
            });
          }
          if (!remaining) break;
        }
        if (remaining) throw new Error("返品対象の引当を確認できません。再読み込みしてください。");
        if (disposition !== "RESTOCK" && balance) {
          const q = balance.quantity - targetQuantity;
          const t = balance.carryingCostTotalJpy - outgoingCost;
          await tx.inventoryCostBalance.update({
            where: { id: balance.id },
            data: {
              quantity: q,
              carryingCostTotalJpy: t,
              averageUnitCostJpy: q ? averageUnitCost(t, q) : 0,
            },
          });
        }
      }
      const updated = await tx.salesOrderLine.update({
        where: { id: current.id },
        data: { returnedQuantity: { increment: input.quantity } },
      });
      if (current.listingId) {
        await tx.listing.update({
          where: { id: current.listingId },
          data: {
            reservedQuantity: { decrement: input.quantity },
            ...(input.dispositions.every((row) => row.disposition === "RESTOCK")
              ? {}
              : { listedQuantity: { decrement: input.quantity } }),
          },
        });
      }
      const allLines = await tx.salesOrderLine.findMany({ where: { salesOrderId: order.id } });
      const fullyReturned = allLines.every((row) =>
        row.id === updated.id
          ? updated.returnedQuantity === updated.quantity
          : row.returnedQuantity === row.quantity,
      );
      if (fullyReturned) {
        await tx.salesOrder.update({ where: { id: order.id }, data: { status: "RETURNED" } });
        await tx.shipment.update({
          where: { salesOrderId: order.id },
          data: { status: "RETURNED" },
        });
        await addOrderEvent(
          tx,
          context,
          order.id,
          order.status,
          "RETURNED",
          `${input.idempotencyKey.slice(0, -1)}${input.idempotencyKey.endsWith("0") ? "1" : "0"}`,
          input.memo || undefined,
        );
      }
      await writeAudit(tx, {
        workspaceId: context.workspaceId,
        userAccountId: context.session.userAccountId,
        operatorId: context.operatorId,
        action: "sales_return.before_completion",
        entityType: "sales_return",
        entityId: returned.id,
        after: { quantity: input.quantity, dispositions: input.dispositions },
      });
    },
    { isolationLevel: "Serializable" },
  );
}

export async function returnOrderAction(
  _state: SalesActionState,
  formData: FormData,
): Promise<SalesActionState> {
  try {
    await assertTrustedOrigin();
    await rejectLegacySalesWrite();
    const returnedAt = tokyoDateTime(String(formData.get("returnedAt") ?? ""));
    const context = await requireInventoryContext(tokyoFiscalDate(returnedAt));
    const input = returnSchema.parse({
      ...Object.fromEntries(formData),
      quantity: Number(formData.get("quantity")),
      dispositions: parseJsonField(formData, "dispositions"),
    });
    if (await context.db.salesReturn.findUnique({ where: { requestKey: input.idempotencyKey } }))
      return { success: "返品は記録済みです。" };
    const order = await requireOrder(context, input.orderId);
    if (["SHIPPED", "AWAITING_COMPLETION"].includes(order.status)) {
      await returnBeforeCompletion(context, order, input, returnedAt);
      revalidatePath(`/sales/orders/${order.id}`);
      return { success: "完了前の返品を記録し、引当と在庫状態を更新しました。" };
    }
    if (order.status !== "COMPLETED")
      throw new Error("発送済みまたは取引完了後の注文を返品できます。");
    if (order.completedAt && tokyoFiscalDate(returnedAt) < tokyoFiscalDate(order.completedAt))
      throw new Error("返品日は元取引の完了日以降にしてください。");
    const line = order.lines.find((row) => row.id === input.lineId);
    if (!line || line.returnedQuantity + input.quantity > line.quantity)
      throw new Error("返品数量が販売数量を超えています。");
    await context.db.$transaction(
      async (tx) => {
        await lockInventoryDomain(tx, context.businessUnitId);
        await checkWorkflowContext(tx, {
          workspaceId: context.workspaceId,
          businessUnitId: context.businessUnitId,
          operatorId: context.operatorId,
          year: context.fiscalYear.year,
          reportingEntityId: context.reportingEntityId,
          userAccountId: context.session.userAccountId,
          sessionId: context.session.id,
        });
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`order:${order.id}`},0))`;
        const current = await tx.salesOrderLine.findUniqueOrThrow({
          where: { id: line.id },
          include: { consumptions: { include: { dispositions: true } } },
        });
        if (current.returnedQuantity + input.quantity > current.quantity)
          throw new Error("別操作で返品済みです。再読み込みしてください。");
        const priorRefunds = await tx.salesReturn.aggregate({
          where: { salesOrderId: order.id },
          _sum: { salesRefundJpy: true },
        });
        const freshOrder = await tx.salesOrder.findUniqueOrThrow({ where: { id: order.id } });
        if (
          freshOrder.revision !== order.revision ||
          freshOrder.status !== "COMPLETED" ||
          freshOrder.reportingEntityId !== context.reportingEntityId
        )
          throw new Error(
            "別操作で注文の原価・金額・状態が変わりました。最新の内容を確認して返品をやり直してください。",
          );
        if (
          (priorRefunds._sum.salesRefundJpy ?? 0n) + parseYen(input.salesRefundJpy) >
          order.grossSalesJpy - order.discountJpy
        )
          throw new Error("返金の累計が売上額を超えています。過去の返金履歴を確認してください。");
        await tx.salesOrder.update({
          where: { id: order.id },
          data: { revision: { increment: 1 } },
        });
        const variantIds = [
          ...new Set(current.consumptions.map((row) => row.itemVariantId)),
        ].sort();
        for (const id of variantIds) await lockInventoryTarget(tx, id, context.businessUnitId);
        const returned = await tx.salesReturn.create({
          data: {
            salesOrderId: order.id,
            returnedAt,
            salesRefundJpy: parseYen(input.salesRefundJpy),
            feeRefundJpy: parseYen(input.feeRefundJpy),
            shippingRefundJpy: parseYen(input.shippingRefundJpy),
            memo: input.memo || null,
            requestKey: input.idempotencyKey,
            lines: { create: { salesOrderLineId: line.id, quantity: input.quantity } },
          },
          include: { lines: true },
        });
        const returnLine = returned.lines[0]!;
        const operation = await tx.inventoryOperation.create({
          data: {
            workspaceId: context.workspaceId,
            businessUnitId: context.businessUnitId,
            operatorId: context.operatorId,
            operationType: "SALE_RETURN",
            sourceType: "sales_return",
            sourceId: returned.id,
            idempotencyKey: input.idempotencyKey,
            occurredAt: returnedAt,
          },
        });
        let movement = 0;
        const returnedQuantities = allocateReturnedComponents(
          current.consumptions,
          current.quantity,
          current.returnedQuantity,
          input.quantity,
        );
        const currentConsumptionCosts = await effectiveCosts(
          tx,
          "CONSUMPTION",
          current.consumptions,
        );
        const currentDispositionCosts = await effectiveCosts(
          tx,
          "DISPOSITION",
          current.consumptions.flatMap((x) => x.dispositions),
        );
        for (const consumption of current.consumptions) {
          const returnUnit = consumption.uniqueStockUnitId
            ? await tx.uniqueStockUnit.findUniqueOrThrow({
                where: { id: consumption.uniqueStockUnitId },
              })
            : null;
          const returnLotId = returnUnit?.inventoryLotId ?? consumption.inventoryLotId;
          if (!returnLotId)
            throw new Error("元の仕入ロットが見つかりません。返品は保存されていません。");
          const disposition = returnDispositionFor(
            input,
            consumption.itemVariantId,
            consumption.uniqueStockUnitId,
          );
          const used = consumption.dispositions.reduce((s, row) => s + row.quantity, 0);
          const quantity = returnedQuantities.get(consumption.id)!;
          if (!quantity) continue;
          const usedCost = consumption.dispositions.reduce(
            (sum, row) => sum + currentDispositionCosts.get(row.id)!,
            0n,
          );
          const cost =
            quantity === consumption.quantity - used
              ? currentConsumptionCosts.get(consumption.id)! - usedCost
              : (currentConsumptionCosts.get(consumption.id)! * BigInt(quantity)) /
                BigInt(consumption.quantity);
          await tx.returnComponentDisposition.create({
            data: {
              salesReturnLineId: returnLine.id,
              consumptionId: consumption.id,
              itemVariantId: consumption.itemVariantId,
              inventoryLotId: consumption.inventoryLotId,
              uniqueStockUnitId: consumption.uniqueStockUnitId,
              storageLocationId: consumption.storageLocationId,
              quantity,
              disposition,
              costTotalJpy: cost,
            },
          });
          if (disposition === "RESTOCK") {
            if (consumption.uniqueStockUnitId) {
              await tx.uniqueStockUnit.update({
                where: { id: consumption.uniqueStockUnitId },
                data: { status: "IN_STOCK", storageLocationId: consumption.storageLocationId },
              });
              await tx.inventoryLot.updateMany({
                where: { id: returnLotId, remainingQuantity: { lt: 1 } },
                data: { remainingQuantity: { increment: quantity } },
              });
            } else {
              await tx.inventoryLot.update({
                where: { id: returnLotId },
                data: { remainingQuantity: { increment: quantity } },
              });
            }
            const tracking = consumption.uniqueStockUnitId ? "UNIQUE" : "QUANTITY";
            const balance = await tx.inventoryCostBalance.findUnique({
              where: {
                itemVariantId_businessUnitId_trackingMode: {
                  itemVariantId: consumption.itemVariantId,
                  businessUnitId: context.businessUnitId,
                  trackingMode: tracking,
                },
              },
            });
            const q = (balance?.quantity ?? 0) + quantity,
              t = (balance?.carryingCostTotalJpy ?? 0n) + cost;
            await tx.inventoryCostBalance.upsert({
              where: {
                itemVariantId_businessUnitId_trackingMode: {
                  itemVariantId: consumption.itemVariantId,
                  businessUnitId: context.businessUnitId,
                  trackingMode: tracking,
                },
              },
              create: {
                itemVariantId: consumption.itemVariantId,
                businessUnitId: context.businessUnitId,
                trackingMode: tracking,
                quantity: q,
                carryingCostTotalJpy: t,
                averageUnitCostJpy: averageUnitCost(t, q),
              },
              update: {
                quantity: q,
                carryingCostTotalJpy: t,
                averageUnitCostJpy: averageUnitCost(t, q),
              },
            });
          } else if (consumption.uniqueStockUnitId) {
            await tx.uniqueStockUnit.update({
              where: { id: consumption.uniqueStockUnitId },
              data: {
                status: disposition === "DEFECTIVE" ? "RETURNED" : "DISPOSED",
                storageLocationId: consumption.storageLocationId,
              },
            });
          }
          await tx.stockMovement.create({
            data: {
              operationId: operation.id,
              itemVariantId: consumption.itemVariantId,
              inventoryLotId: consumption.inventoryLotId,
              uniqueStockUnitId: consumption.uniqueStockUnitId,
              movementType:
                disposition === "RESTOCK"
                  ? "RETURN_IN"
                  : disposition === "DEFECTIVE"
                    ? "RETURN_DEFECTIVE"
                    : "RETURN_DISPOSAL",
              quantity,
              costTotalJpy: cost,
              movementAt: returnedAt,
              businessUnitId: context.businessUnitId,
              storageLocationToId: consumption.storageLocationId,
              sourceType: "sales_return",
              sourceId: returned.id,
              idempotencyKey: `${input.idempotencyKey}:${movement++}`,
              operatorId: context.operatorId,
            },
          });
        }
        const updated = await tx.salesOrderLine.update({
          where: { id: line.id },
          data: { returnedQuantity: { increment: input.quantity } },
        });
        const allLines = await tx.salesOrderLine.findMany({ where: { salesOrderId: order.id } });
        const fullyReturned = allLines.every((row) =>
          row.id === updated.id
            ? updated.returnedQuantity === updated.quantity
            : row.returnedQuantity === row.quantity,
        );
        if (fullyReturned) {
          await tx.salesOrder.update({ where: { id: order.id }, data: { status: "RETURNED" } });
          await addOrderEvent(
            tx,
            context,
            order.id,
            order.status,
            "RETURNED",
            `${input.idempotencyKey.slice(0, -1)}${input.idempotencyKey.endsWith("0") ? "1" : "0"}`,
            input.memo || undefined,
          );
        }
        await writeAudit(tx, {
          workspaceId: context.workspaceId,
          userAccountId: context.session.userAccountId,
          operatorId: context.operatorId,
          action: "sales_return.create",
          entityType: "sales_return",
          entityId: returned.id,
          after: { quantity: input.quantity, dispositions: input.dispositions },
        });
      },
      { isolationLevel: "Serializable" },
    );
    revalidatePath(`/sales/orders/${order.id}`);
    return { success: "返品を記録しました。" };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}
