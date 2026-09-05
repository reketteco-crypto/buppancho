import Decimal from "decimal.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export function parseYen(value: string): bigint {
  const normalized = value.trim();
  if (!/^(0|[1-9][0-9]*)$/.test(normalized)) {
    throw new Error("金額は0以上の整数円で入力してください。");
  }
  return BigInt(normalized);
}

export function formatYen(value: bigint | string): string {
  return BigInt(value).toLocaleString("ja-JP");
}

export function averageUnitCost(total: bigint, quantity: number): string {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error("数量を確認してください。");
  return new Decimal(total.toString()).div(quantity).toDecimalPlaces(6).toFixed(6);
}

export function movingAverageOutCost(
  carryingTotal: bigint,
  currentQuantity: number,
  outgoingQuantity: number,
): bigint {
  if (
    !Number.isInteger(currentQuantity) ||
    !Number.isInteger(outgoingQuantity) ||
    currentQuantity <= 0 ||
    outgoingQuantity <= 0 ||
    outgoingQuantity > currentQuantity
  ) {
    throw new Error("在庫数量を確認してください。");
  }
  if (outgoingQuantity === currentQuantity) return carryingTotal;
  return BigInt(
    new Decimal(carryingTotal.toString())
      .mul(outgoingQuantity)
      .div(currentQuantity)
      .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
      .toFixed(0),
  );
}
