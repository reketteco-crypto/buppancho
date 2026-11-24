import { requireInventoryContext } from "@/lib/inventory/context";
import { skuAvailability } from "@/lib/sales/availability";

export const todayTokyo = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
export async function commerceContext() {
  const current = await requireInventoryContext();
  return {
    ...current,
    context: {
      reportingEntityId: current.reportingEntityId,
      businessUnitId: current.businessUnitId,
      operatorId: current.operatorId,
      year: current.fiscalYear.year,
    },
  };
}
export type ProductOption = {
  id: string;
  name: string;
  code: string;
  mode: "QUANTITY" | "UNIQUE";
  quantity: number;
};
export type ChannelOption = {
  receivingAccountId?: string;
  feeDeducted?: boolean;
  shippingDeducted?: boolean;
  id: string;
  name: string;
  revision: number;
  rate: string;
  shipping: string;
  methodId: string;
};
export type MethodOption = {
  id: string;
  name: string;
  revision: number;
  shipping: string;
  allocation: string;
};
export type SkuOption = {
  composition?: string;
  hasSupplies?: boolean;
  id: string;
  name: string;
  code: string;
  revision: number;
  price: string;
  available: number;
  channels: { channelId: string; price: string; shipping: string; methodId: string }[];
};
export async function purchaseOptions(c: Awaited<ReturnType<typeof commerceContext>>) {
  const [suppliers, locations] = await Promise.all([
    c.db.counterparty.findMany({
      where: { workspaceId: c.workspaceId, active: true },
      orderBy: { name: "asc" },
    }),
    c.db.storageLocation.findMany({
      where: {
        workspaceId: c.workspaceId,
        active: true,
        OR: [{ businessUnitId: null }, { businessUnitId: c.businessUnitId }],
      },
      orderBy: { code: "asc" },
    }),
  ]);
  return {
    suppliers: suppliers.map((s) => ({
      id: s.id,
      name: s.name,
      revision: s.revision,
      currency: s.defaultCurrency,
      allocation: s.defaultAllocationMethod,
    })),
    locations: locations.map((l) => ({ id: l.id, name: l.name })),
  };
}

export async function commerceOptions(c: Awaited<ReturnType<typeof commerceContext>>) {
  const scope = { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId };
  const [products, purchase, channels, methods, skus, held, units] = await Promise.all([
    c.db.itemVariant.findMany({
      where: {
        workspaceId: c.workspaceId,
        active: true,
        inventoryItem: { businessUnitId: c.businessUnitId, status: "ACTIVE" },
      },
      include: { inventoryItem: true, costBalances: true },
      orderBy: { inventoryItem: { name: "asc" } },
    }),
    purchaseOptions(c),
    c.db.salesChannel.findMany({
      where: { workspaceId: c.workspaceId, active: true },
      orderBy: { name: "asc" },
    }),
    c.db.deliveryMethod.findMany({
      where: { workspaceId: c.workspaceId, active: true },
      orderBy: { name: "asc" },
    }),
    c.db.salesSku.findMany({
      where: { ...scope, active: true },
      include: { components: true, channelSettings: true, supplySettings: true },
      orderBy: { name: "asc" },
    }),
    c.db.inventoryReservation.findMany({
      where: {
        itemVariant: {
          workspaceId: c.workspaceId,
          inventoryItem: { businessUnitId: c.businessUnitId },
        },
        status: "RESERVED",
      },
      select: {
        itemVariantId: true,
        uniqueStockUnitId: true,
        inventoryLotId: true,
        quantity: true,
      },
    }),
    c.db.uniqueStockUnit.findMany({
      where: {
        workspaceId: c.workspaceId,
        status: "IN_STOCK",
        itemVariant: { inventoryItem: { businessUnitId: c.businessUnitId } },
      },
      select: { id: true },
    }),
  ]);
  const quantity = new Map(
    products.map((p) => [
      p.id,
      p.costBalances
        .filter((b) => b.businessUnitId === c.businessUnitId && b.trackingMode === "QUANTITY")
        .reduce((s, b) => s + b.quantity, 0),
    ]),
  );
  const heldQty = new Map<string, number>(),
    heldUnits = new Set(held.flatMap((h) => (h.uniqueStockUnitId ? [h.uniqueStockUnitId] : []))),
    availableUnits = new Set(units.map((u) => u.id));
  for (const h of held)
    if (h.inventoryLotId)
      heldQty.set(h.itemVariantId, (heldQty.get(h.itemVariantId) || 0) + h.quantity);
  return {
    products: products.map(
      (p): ProductOption => ({
        id: p.id,
        name: p.inventoryItem.name,
        code: p.variantCode,
        mode: p.inventoryItem.managementType,
        quantity: p.costBalances
          .filter((b) => b.businessUnitId === c.businessUnitId)
          .reduce((s, b) => s + b.quantity, 0),
      }),
    ),
    ...purchase,
    channels: channels.map(
      (ch): ChannelOption => ({
        id: ch.id,
        name: ch.name,
        revision: ch.revision,
        receivingAccountId: ch.receivingAccountId || "",
        feeDeducted: ch.feeDeducted,
        shippingDeducted: ch.shippingDeducted,
        rate: ch.defaultFeeRate?.mul(100).toString() ?? "",
        shipping: ch.defaultShippingJpy?.toString() ?? "",
        methodId: ch.defaultDeliveryMethodId ?? "",
      }),
    ),
    methods: methods.map(
      (m): MethodOption => ({
        id: m.id,
        name: m.name,
        revision: m.revision,
        shipping: m.defaultShippingJpy?.toString() ?? "",
        allocation: m.defaultAllocationMethod,
      }),
    ),
    skus: skus.map(
      (s): SkuOption => ({
        id: s.id,
        hasSupplies: s.supplySettings.length > 0,
        name: s.name,
        code: s.skuCode,
        composition: `1販売単位で${s.components.reduce((sum, part) => sum + part.requiredQuantity, 0)}点を使用`,
        revision: s.revision,
        price: s.expectedPriceJpy?.toString() ?? "",
        available: skuAvailability(
          s.components.map((part) => ({
            requiredQuantity: part.requiredQuantity,
            availableQuantity: part.uniqueStockUnitId
              ? availableUnits.has(part.uniqueStockUnitId) && !heldUnits.has(part.uniqueStockUnitId)
                ? 1
                : 0
              : Math.max(
                  0,
                  (quantity.get(part.itemVariantId!) || 0) -
                    (heldQty.get(part.itemVariantId!) || 0),
                ),
          })),
        ),
        channels: s.channelSettings.map((ch) => ({
          channelId: ch.salesChannelId,
          price: ch.priceJpy?.toString() ?? "",
          shipping: ch.shippingJpy?.toString() ?? "",
          methodId: ch.deliveryMethodId ?? "",
        })),
      }),
    ),
  };
}
