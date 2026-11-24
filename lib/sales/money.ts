import Decimal from "decimal.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export function parsePercent(value: string): string {
  const normalized = value.trim();
  if (!/^(?:100(?:\.0{1,4})?|(?:\d|[1-9]\d)(?:\.\d{1,4})?)$/.test(normalized)) {
    throw new Error("手数料率は0～100の数値で入力してください。");
  }
  return new Decimal(normalized).div(100).toDecimalPlaces(6).toFixed(6);
}

export function percentDisplay(rate: Decimal.Value): string {
  return new Decimal(rate).mul(100).toDecimalPlaces(4).toString();
}

export function estimatedFee(gross: bigint, rate: Decimal.Value): bigint {
  return BigInt(
    new Decimal(gross.toString()).mul(rate).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0),
  );
}

export function managementProfit(input: {
  gross: bigint;
  discount?: bigint;
  fee?: bigint | null;
  shipping?: bigint | null;
  packing?: bigint | null;
  other?: bigint | null;
  cogs?: bigint | null;
  salesRefund?: bigint;
  feeRefund?: bigint;
  shippingRefund?: bigint;
  restockedCost?: bigint;
}): bigint {
  return (
    input.gross -
    (input.discount ?? 0n) -
    (input.fee ?? 0n) -
    (input.shipping ?? 0n) -
    (input.packing ?? 0n) -
    (input.other ?? 0n) -
    (input.cogs ?? 0n) -
    (input.salesRefund ?? 0n) +
    (input.feeRefund ?? 0n) +
    (input.shippingRefund ?? 0n) +
    (input.restockedCost ?? 0n)
  );
}
