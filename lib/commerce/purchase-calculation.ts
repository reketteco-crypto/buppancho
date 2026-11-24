import type { BuyInput } from "./input";
import { allocateCharge, allocateYen, convertMoney, Precise } from "./allocation";

export class PurchaseCalculationError extends Error {}
function invalid(message: string): never {
  throw new PurchaseCalculationError(message);
}
export function chargeMoney(
  charge: BuyInput["charges"][number],
  currency: string,
  rate: string,
): bigint | null {
  if (charge.actualJpy !== undefined && charge.actualJpy !== "") return BigInt(charge.actualJpy);
  if (charge.amount === "") return null;
  const selected = charge.currency || currency;
  return convertMoney(
    charge.amount,
    selected,
    charge.exchangeRate || (selected === currency ? rate : selected === "JPY" ? "1" : ""),
  );
}

/** One pure calculation is shared by the editor, API and imported candidates. */
export function calculatePurchase(input: BuyInput) {
  try {
    const currency = input.currency || "JPY";
    const charges = [...input.charges];
    if (input.taxMode === "EXCLUDED")
      charges.push({
        name: "消費税",
        amount: input.taxAmount,
        currency: "JPY",
        exchangeRate: "1",
        method: "VALUE",
        capitalized: true,
        lineIds: [],
        manual: {},
      });
    const goods = input.lines.map((line) =>
      new Precise(line.amount).mul(line.priceBasis === "UNIT" ? line.quantity : 1),
    );
    if (currency === "JPY" && goods.some((g) => !g.isInteger()))
      invalid("円の商品代金は整数で入力してください。");
    let rate = currency === "JPY" ? "1" : input.exchangeRate || "";
    let rateBasis = currency === "JPY" ? "JPY" : "ENTERED";
    if (
      currency !== "JPY" &&
      rate === "" &&
      input.actualOrderJpy !== undefined &&
      input.actualOrderJpy !== ""
    ) {
      let fixed = 0n;
      let denominator = goods.reduce((s, g) => s.plus(g), new Precise(0));
      for (const charge of charges) {
        if (charge.amount === "" && !charge.actualJpy)
          invalid("実支払額で計算する場合は、費用金額も確認してください。");
        if ((charge.currency || currency) === currency && !charge.actualJpy && !charge.exchangeRate)
          denominator = denominator.plus(charge.amount || "0");
        else fixed += chargeMoney(charge, currency, "") ?? 0n;
      }
      const remaining = BigInt(input.actualOrderJpy) - fixed;
      if (remaining < 0n || denominator.lte(0))
        invalid("実支払額と商品・費用の金額を確認してください。");
      rate = new Precise(remaining.toString()).div(denominator).toFixed(10);
      rateBasis = "ACTUAL";
    }
    if (
      !rate ||
      !new Precise(rate).isFinite() ||
      new Precise(rate).lt(0) ||
      (rateBasis === "ENTERED" && new Precise(rate).isZero())
    )
      invalid("円換算レート、または円建ての実支払額を入力してください。");
    const chargeAmounts = charges.map((charge) =>
      rateBasis === "ACTUAL" &&
      new Precise(rate).isZero() &&
      (charge.currency || currency) === currency &&
      !charge.exchangeRate &&
      !charge.actualJpy
        ? 0n
        : chargeMoney(charge, currency, rate),
    );
    const exact = goods.map((g) => g.mul(rate));
    let baseTotal = BigInt(
      exact
        .reduce((s, g) => s.plus(g), new Precise(0))
        .toDecimalPlaces(0)
        .toFixed(0),
    );
    const hasActual = input.actualOrderJpy !== undefined && input.actualOrderJpy !== "";
    if (hasActual) {
      if (chargeAmounts.some((a) => a === null))
        invalid("実支払額で計算する場合は、費用金額も確認してください。");
      baseTotal =
        BigInt(input.actualOrderJpy!) - chargeAmounts.reduce<bigint>((s, a) => s + (a ?? 0n), 0n);
      if (baseTotal < 0n) invalid("実支払額が費用の合計を下回っています。");
    }
    const amounts = allocateYen(baseTotal, goods),
      landed = [...amounts];
    let final = true;
    const allocations = charges.map((charge, index) => {
      if (
        new Set(charge.lineIds).size !== charge.lineIds.length ||
        charge.lineIds.some((id) => !input.lines.some((l) => l.clientId === id))
      )
        invalid("費用の配分先を確認してください。");
      const targets = input.lines.filter(
        (l) => !charge.lineIds.length || charge.lineIds.includes(l.clientId),
      );
      const result = allocateCharge(
        chargeAmounts[index]!,
        charge.method,
        targets.map((l) => ({
          id: l.clientId,
          amount: amounts[input.lines.indexOf(l)]!.toString(),
          quantity: l.quantity,
          weight: l.weight ? new Precise(l.weight).mul(l.quantity).toFixed() : "",
          volume: l.volume ? new Precise(l.volume).mul(l.quantity).toFixed() : "",
          manual: charge.manual[l.clientId],
        })),
      );
      if (!result.allocations) final = false;
      if (result.allocations && charge.capitalized)
        for (const row of result.allocations)
          landed[input.lines.findIndex((l) => l.clientId === row.lineId)]! += row.amount;
      return { charge, amountJpy: chargeAmounts[index]!, ...result };
    });
    const total = baseTotal + chargeAmounts.reduce<bigint>((s, a) => s + (a ?? 0n), 0n);
    if (total > 999999999999999n || landed.some((v) => v < 0n || v > 999999999999999n))
      invalid("購入金額は15桁以内にしてください。");
    return { amounts, landed, allocations, final, total, currency, rate, rateBasis };
  } catch (e) {
    if (e instanceof PurchaseCalculationError) throw e;
    throw new PurchaseCalculationError("商品金額・通貨・円換算レートを確認してください。");
  }
}
