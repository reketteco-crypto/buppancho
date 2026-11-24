import { amountText, quantityText, dateText, type Sheet, type ImportCandidate } from "./candidate";
import { rakumartCandidate } from "./rakumart";
export function tabularCandidate(sheets: Sheet[]): Omit<ImportCandidate, "fileName" | "digest"> {
  const specific = rakumartCandidate(sheets);
  if (specific) return specific;
  for (const sheet of sheets) {
    const index = sheet.rows.findIndex(
      (r) =>
        r.some((c) => /^(商品名|品名|名称|name)$/i.test(c.trim())) &&
        r.some((c) => /^(数量|個数|quantity)$/i.test(c.trim())),
    );
    if (index < 0) continue;
    const headers = sheet.rows[index]!.map((h) => h.trim());
    const col = (regex: RegExp) => headers.findIndex((h) => regex.test(h));
    const name = col(/^(商品名|品名|名称|name)$/i),
      qty = col(/^(数量|個数|quantity)$/i),
      price = col(/^(単価|unit.?price)$/i),
      currency = col(/^(通貨|currency)$/i),
      date = col(/^(日付|購入日|date)$/i);
    const rows = sheet.rows.slice(index + 1).filter((r) => !!r[name]?.trim());
    const currencies = [...new Set(rows.map((r) => r[currency] || "JPY"))];
    return {
      adapterId: "table.headers.v1",
      kind: "PURCHASE",
      currency: currencies.length === 1 ? currencies[0] : undefined,
      date: dateText(rows[0]?.[date]),
      lines: rows.map((r) => ({
        name: r[name]!,
        quantity: quantityText(r[qty]),
        amount: amountText(r[price]),
      })),
      charges: [],
      unresolved: [
        "取引先・購入日・金額を確認してください。",
        ...(currencies.length > 1
          ? ["複数の通貨があります。通貨ごとに購入を分けてください。"]
          : []),
        ...(price < 0 ? ["単価列がありません。単価を入力してください。"] : []),
      ],
    };
  }
  throw new Error(
    "商品名・数量・単価の列を読み取れませんでした。手入力するか、列名を確認してください。",
  );
}
export function invoiceCandidate(lines: string[]): Omit<ImportCandidate, "fileName" | "digest"> {
  const charges: ImportCandidate["charges"] = [];
  for (const line of lines) {
    const name = line.includes("地方消費税")
      ? "地方消費税"
      : line.includes("関税")
        ? "関税"
        : line.includes("消費税")
          ? "消費税"
          : line.includes("通関料")
            ? "通関料"
            : line.includes("立替手数料")
              ? "立替手数料"
              : undefined;
    if (!name) continue;
    const amounts = line.match(/[¥￥]?\s*\d[\d,]*(?:\.\d+)?\s*円?/g);
    const amount = amountText(amounts?.at(-1));
    if (amount !== undefined && !charges.some((c) => c.name === name && c.amount === amount))
      charges.push({ name, amount, currency: "JPY" });
  }
  if (!charges.length)
    throw new Error("費用金額を読み取れませんでした。画像のPDFは手入力してください。");
  return {
    adapterId: "invoice.labels.v1",
    kind: "COST",
    lines: [],
    charges,
    unresolved: ["請求書の費用名・金額と、追加先の購入または配送を確認してください。"],
  };
}
