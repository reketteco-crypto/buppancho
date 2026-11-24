import { mercariSalesCandidate, readCsv } from "./mercari-sales";
import type { SalesBatchRow } from "../sales-batch-types";

export { salesHistoryDate } from "./sales-history-date";

const adapters = [
  {
    name: "メルカリ販売CSV",
    matches: (header: string[]) =>
      ["商品ID", "商品名", "商品代金", "販売手数料", "配送料", "購入日時", "更新日時"].every(
        (key) => header.includes(key),
      ),
    read: mercariSalesCandidate,
  },
];

export function readSalesHistory(
  text: string,
  fileName: string,
  uuid: () => string,
): SalesBatchRow[] {
  const header = readCsv(text)[0] ?? [];
  const adapter = adapters.find((candidate) => candidate.matches(header));
  if (!adapter)
    throw new Error(
      "対応する販売履歴の形式を確認できません。現在はメルカリ販売CSVに対応しています。手入力でも追加できます。",
    );
  return adapter.read(text, fileName, uuid);
}
