import type { BuyInput } from "./input";
import { Precise } from "./allocation";
import { averageUnitCost } from "@/lib/inventory/money";
import type { calculatePurchase } from "./purchase-calculation";

export type PurchaseStockCost = {
  quantity: number;
  cost: string;
  unitCost: string | null;
};
export type PurchaseCostRow = {
  clientId: string;
  variantId: string | null;
  quantity: number;
  cost: string;
  unitCost: string;
  before: PurchaseStockCost;
  after: PurchaseStockCost;
  provisional: boolean;
};
export type PurchaseCostPreview = {
  status: "READY" | "PENDING" | "ORDER_REQUIRED";
  basis: "RECEIPT" | "CURRENT";
  rows: PurchaseCostRow[];
  message?: string;
  choices?: { id: string; label: string }[];
};
export type PurchaseCostBalance = {
  variantId: string;
  beforeQuantity: number;
  beforeCost: string;
  quantity: number;
  cost: string;
  provisional: boolean;
};

export const isQuantityStock = (line: BuyInput["lines"][number]) =>
  (!line.purpose || line.purpose === "STOCK") && line.trackingMode === "QUANTITY";

export function purchaseUnitCostLabel(total: string | bigint, quantity: number) {
  const exact = new Precise(total.toString()).div(quantity);
  const rounded = exact.toDecimalPlaces(2, Precise.ROUND_HALF_UP);
  const [whole, fraction] = rounded.toFixed(2).split(".");
  const digits = fraction!.replace(/0+$/, "");
  return `${rounded.eq(exact) ? "" : "約"}¥${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${digits ? `.${digits}` : ""}`;
}

export function purchaseCostRows(
  input: BuyInput,
  totals: ReturnType<typeof calculatePurchase>,
  balances: PurchaseCostBalance[],
): PurchaseCostRow[] {
  if (!totals.final) throw new Error("費用の金額と原価への配分を確認してください。");
  const stock = (quantity: number, cost: string): PurchaseStockCost => ({
    quantity,
    cost,
    unitCost: quantity > 0 ? averageUnitCost(BigInt(cost), quantity) : null,
  });
  return input.lines.flatMap((line, index) => {
    if (!isQuantityStock(line)) return [];
    const balance = balances.find((b) => b.variantId === (line.variantId || line.clientId));
    if (!balance) throw new Error("在庫原価を確認できません。再取得してください。");
    const cost = totals.landed[index]!.toString();
    return [
      {
        clientId: line.clientId,
        variantId: line.variantId || null,
        quantity: line.quantity,
        cost,
        unitCost: averageUnitCost(BigInt(cost), line.quantity),
        before: stock(balance.beforeQuantity, balance.beforeCost),
        after: stock(balance.quantity, balance.cost),
        provisional: balance.provisional,
      },
    ];
  });
}
