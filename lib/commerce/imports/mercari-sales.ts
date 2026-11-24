import { salesHistoryDate } from "./sales-history-date";
import { emptySalesBatchRow, type SalesBatchRow } from "../sales-batch-types";

// CSV is parsed as text throughout. Monetary values never pass through Number.
export function readCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    value = "",
    quoted = false,
    closed = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else value += c;
    } else if (c === '"' && value === "" && !closed) quoted = true;
    else if (c === ",") {
      row.push(value);
      value = "";
      closed = false;
    } else if (c === "\r" || c === "\n") {
      row.push(value);
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
      value = "";
      closed = false;
      if (c === "\r" && source[i + 1] === "\n") i++;
    } else {
      if (closed) throw new Error("CSVの引用符を確認してください。");
      // The supplied exporter leaves quotes inside unquoted product names literal.
      // Only a quote at the start of a field opens a quoted field.
      value += c;
    }
  }
  if (quoted) throw new Error("CSVの引用符が閉じられていません。");
  row.push(value);
  if (row.some((v) => v !== "")) rows.push(row);
  return rows;
}

export function mercariSalesCandidate(
  text: string,
  fileName: string,
  uuid: () => string,
): SalesBatchRow[] {
  const [header, ...records] = readCsv(text);
  const required = ["商品ID", "商品名", "商品代金", "販売手数料", "配送料", "購入日時", "更新日時"];
  if (
    !header ||
    new Set(header).size !== header.length ||
    required.some((v) => !header.includes(v))
  )
    throw new Error("メルカリ販売CSVの見出しを確認してください。");
  if (records.length > 5000) throw new Error("CSVは5,000件以内に分けてください。");
  return records.map((cells, i) => {
    if (cells.length !== header.length)
      throw new Error(`CSVの${i + 2}行目の列数を確認してください。`);
    const get = (name: string) => cells[header.indexOf(name)] ?? "";
    return {
      ...emptySalesBatchRow(uuid()),
      priceBasis: "TOTAL",
      date: salesHistoryDate(get("更新日時")),
      sourceName: get("商品名"),
      externalId: get("商品ID"),
      buyer: get("購入者"),
      price: get("商品代金"),
      fee: get("販売手数料"),
      shipping: get("配送料"),
      source: {
        file: fileName,
        purchasedAt: get("購入日時"),
        updatedAt: get("更新日時"),
        url: get("取引情報URL") || get("商品URL"),
        profit: get("販売利益"),
        amount: get("商品代金"),
        fee: get("販売手数料"),
        shipping: get("配送料"),
      },
      memo: get("配送の方法") ? `取込元配送方法：${get("配送の方法")}` : "",
    };
  });
}
