import Link from "next/link";
import { ChevronRight } from "lucide-react";
const entries = [
  ["購入", "/purchases/new"],
  ["販売", "/sales/new"],
  ["その他の経費", "/money/new"],
  ["その他の収入", "/money/new?kind=INCOME"],
  ["単品・セットの販売商品", "/products/skus/new"],
  ["販売履歴をまとめて入力", "/sales/batch"],
  ["廃棄・紛失・在庫移動", "/inventory/operations/new"],
  ["棚卸", "/inventory/stocktake/new"],
];
export default function RegisterPage() {
  return (
    <div className="commerce">
      <header className="commerce-heading">
        <h1>記録する</h1>
      </header>
      <div className="commerce-editor commerce-list">
        {entries.map(([label, href]) => (
          <Link className="commerce-row" key={href} href={href!}>
            <div>
              <strong>{label}</strong>
            </div>
            <ChevronRight size={16} />
          </Link>
        ))}
      </div>
    </div>
  );
}
