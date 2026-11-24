/** This adapter only proposes common input. Stock, cost and settlement code never imports it. */
import { amountText, quantityText, type Sheet, type ImportCandidate } from "./candidate";
type Data = Omit<ImportCandidate, "fileName" | "digest">;
export function rakumartCandidate(sheets: Sheet[]): Data | undefined {
  const delivery = sheets.find((s) => s.name.includes("配送依頼書詳細"));
  if (delivery) {
    const lines = delivery.rows
      .filter((r) => /^P/.test(r[0] || "") && /^\d+$/.test(r[1] || ""))
      .map((r) => ({
        name: r[5] || "",
        quantity: quantityText(r[8]),
        sourceReference: r[2],
        amount: amountText(r[9]),
      }));
    const charges = delivery.rows.flatMap((r) => {
      const name = r[9] || "";
      // Agency fees are recorded from the order document and repeat on delivery documents.
      return /国際運賃/.test(name)
        ? [{ name: name.replace(/（円）/g, ""), amount: amountText(r[10]), currency: "JPY" }]
        : [];
    });
    if (!lines.length) return undefined;
    return {
      adapterId: "rakumart.delivery.v1",
      kind: "DELIVERY",
      reference: delivery.rows.find((r) => /^P/.test(r[0] || ""))?.[0],
      currency: "CNY",
      exchangeRate: amountText(delivery.rows[1]?.[13]),
      lines,
      charges,
      unresolved: [
        "配送日・対応する購入明細を確認してください。",
        ...(lines.some((l) => !l.quantity) ? ["発送数量を読み取れない明細があります。"] : []),
      ],
    };
  }
  const order = sheets.find((s) => s.rows[0]?.[4]?.includes("注文番号"));
  if (!order) return undefined;
  const lines = order.rows
    .filter((r) => /^\d+$/.test(r[0] || "") && !!r[3])
    .map((r) => ({ name: r[3]!, quantity: quantityText(r[4]), amount: amountText(r[8]) }));
  if (!lines.length) return undefined;
  const charges = order.rows.flatMap((r) => {
    const name = r[15] || "";
    return /中国国内送料|手数料|オプション費用|その他費用/.test(name)
      ? [{ name, amount: amountText(r[16]), currency: "CNY" }]
      : [];
  });
  if (!charges.some((ch) => ch.name.includes("国内送料"))) {
    // Retain separate source fees; the common editor controls their allocation.
    for (const r of order.rows.filter((r) => /^\d+$/.test(r[0] || "") && !!r[3]))
      if (amountText(r[9]))
        charges.push({ name: `国内送料 ${r[0]}`, amount: amountText(r[9]), currency: "CNY" });
  }
  const rate = order.rows.find((r) => /レート/.test(r[15] || ""));
  return {
    adapterId: "rakumart.order.v1",
    kind: "PURCHASE",
    reference: order.rows[0]![4]!.replace(/^.*注文番号[:：\s]*/, "").trim() || undefined,
    currency: "CNY",
    exchangeRate: amountText(rate?.[16]),
    lines,
    charges,
    unresolved: [
      "購入日・取引先を確認してください。",
      ...(lines.some((l) => l.quantity === undefined || l.amount === undefined)
        ? ["金額・数量を読み取れない明細があります。"]
        : []),
    ],
  };
}
