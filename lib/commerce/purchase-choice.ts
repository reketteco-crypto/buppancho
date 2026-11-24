import type { BuyInput } from "./input";

export type Measurement = { value: string; date: string; code: string };
export type PurchaseMeasurements = { weight?: Measurement; volume?: Measurement };
export type PurchaseChoice = {
  id: string;
  variantId: string;
  name: string;
  code: string;
  mode: "QUANTITY" | "UNIQUE";
  measurements: PurchaseMeasurements;
  history?: {
    name: string;
    sourceName: string | null;
    date: string;
    code: string;
    supplier: string;
    quantity: number;
    amount: string;
    currency: string;
    priceBasis: string;
  };
};
export type PurchaseChoices = {
  rows: PurchaseChoice[];
  total: number;
  page: number;
  pages: number;
};

export function applyPurchaseChoice(line: BuyInput["lines"][number], choice: PurchaseChoice) {
  if ((line.purpose && line.purpose !== "STOCK") || line.trackingMode !== choice.mode)
    throw new Error("商品の用途・管理方法を確認してください。");
  return {
    ...line,
    variantId: choice.variantId,
    name: choice.name,
    weight: choice.measurements.weight?.value ?? "",
    volume: choice.measurements.volume?.value ?? "",
  };
}
