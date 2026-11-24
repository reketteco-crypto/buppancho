import Decimal from "decimal.js";

export const Precise = Decimal.clone({ precision: 80 });
export const allocationMethods = [
  "VALUE",
  "QUANTITY",
  "WEIGHT",
  "VOLUME",
  "EQUAL",
  "MANUAL",
] as const;
export type AllocationMethod = (typeof allocationMethods)[number];
export const allocationLabels: Record<AllocationMethod, string> = {
  VALUE: "商品金額比",
  QUANTITY: "数量比",
  WEIGHT: "重量比",
  VOLUME: "容積比",
  EQUAL: "明細均等",
  MANUAL: "手動",
};
export type AllocationLine = {
  id: string;
  amount: string;
  quantity: number;
  weight?: string | null;
  volume?: string | null;
  manual?: string | null;
};

/** Stable largest-remainder allocation. Negative amounts use the same rounding as refunds. */
export function allocateYen(total: bigint, weights: Decimal.Value[]): bigint[] {
  const values = weights.map((v) => new Precise(v));
  if (values.some((v) => !v.isFinite() || v.isNegative()))
    throw new Error("配分の基準は0以上で入力してください。");
  const sum = values.reduce((s, v) => s.plus(v), new Precise(0));
  if (sum.isZero()) {
    if (total !== 0n) throw new Error("配分の基準がありません。");
    return values.map(() => 0n);
  }
  const sign = total < 0n ? -1n : 1n;
  const amount = new Precise((total * sign).toString());
  const exact = values.map((v) => amount.mul(v).div(sum));
  const allocated = exact.map((v) => BigInt(v.floor().toFixed(0)));
  const remainder = total * sign - allocated.reduce((s, v) => s + v, 0n);
  const order = exact
    .map((v, i) => ({ i, fraction: v.minus(v.floor()) }))
    .sort((a, b) => b.fraction.comparedTo(a.fraction) || a.i - b.i);
  for (let i = 0; BigInt(i) < remainder; i++) allocated[order[i]!.i]! += 1n;
  return allocated.map((v) => v * sign);
}

export function allocateCharge(
  total: bigint | null,
  method: AllocationMethod,
  lines: AllocationLine[],
) {
  if (total === null) return { allocations: null, missing: "金額が未入力です。" };
  if (!lines.length) return { allocations: null, missing: "配分先を選択してください。" };
  if (method === "MANUAL") {
    if (total === 0n)
      return { allocations: lines.map((l) => ({ lineId: l.id, amount: 0n })), missing: null };
    if (lines.some((l) => l.manual == null || !/^\d+$/.test(l.manual)))
      return { allocations: null, missing: "すべての配分額を整数円で入力してください。" };
    const amounts = lines.map((l) => BigInt(l.manual!)),
      sign = total < 0n ? -1n : 1n;
    if (amounts.reduce((s, v) => s + v, 0n) !== total * sign)
      return { allocations: null, missing: "配分額の合計を費用金額と一致させてください。" };
    return {
      allocations: lines.map((l, i) => ({ lineId: l.id, amount: amounts[i]! * sign })),
      missing: null,
    };
  }
  const key = method === "WEIGHT" ? "weight" : method === "VOLUME" ? "volume" : null;
  if (
    total !== 0n &&
    key &&
    lines.some((l) => l[key] == null || l[key] === "" || new Precise(l[key]!).lte(0))
  )
    return {
      allocations: null,
      missing: `${allocationLabels[method]}の基準をすべての対象明細へ入力してください。`,
    };
  const weights = lines.map((l) =>
    method === "VALUE"
      ? l.amount
      : method === "QUANTITY"
        ? l.quantity
        : method === "EQUAL"
          ? 1
          : l[key!] || "0",
  );
  try {
    return {
      allocations: allocateYen(total, weights).map((amount, i) => ({
        lineId: lines[i]!.id,
        amount,
      })),
      missing: null,
    };
  } catch (e) {
    return {
      allocations: null,
      missing: e instanceof Error ? e.message : "配分条件を確認してください。",
    };
  }
}

export function convertMoney(
  amount: string,
  currency: string,
  rate: string,
  actualJpy?: string | null,
): bigint {
  const value = new Precise(amount);
  if (!value.isFinite() || value.isNegative()) throw new Error("金額は0以上で入力してください。");
  if (actualJpy != null && actualJpy !== "") {
    if (!/^(0|[1-9]\d*)$/.test(actualJpy))
      throw new Error("実支払額は0以上の整数円で入力してください。");
    return BigInt(actualJpy);
  }
  if (currency === "JPY") {
    if (!value.isInteger()) throw new Error("円の金額は整数で入力してください。");
    return BigInt(value.toFixed(0));
  }
  if (!rate || !new Precise(rate).isFinite() || new Precise(rate).lte(0))
    throw new Error("円換算レートを入力してください。");
  return BigInt(value.mul(rate).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));
}
