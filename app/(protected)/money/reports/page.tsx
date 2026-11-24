import { ownerData, ownerLedger } from "@/lib/commerce/owner-ledger";
import { accountBalanceView } from "@/lib/commerce/account-label";
import { commerceContext } from "@/lib/commerce/view";
import { businessReport } from "@/lib/commerce/reports";
import { accountBalances } from "@/lib/commerce/money";
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const c = await commerceContext(),
    q = await searchParams,
    year = c.fiscalYear.year,
    month = /^(0[1-9]|1[0-2])$/.test(q.month || "") ? q.month : undefined;
  const start = `${year}-${month || "01"}-01`,
    end = month
      ? new Date(Date.UTC(year, Number(month), 0)).toISOString().slice(0, 10)
      : `${year}-12-31`;
  const report = await c.db.$transaction((tx) => businessReport(tx, c, start, end)),
    balances = await accountBalances(c.db, c, new Date(`${end}T00:00:00Z`));
  const owner = await c.db.$transaction(async (tx) => ownerLedger(await ownerData(tx, c), end));
  const money = (n: bigint | null) => (n === null ? "未確認" : `¥${n.toLocaleString("ja-JP")}`);
  const rows: [[string, bigint], ...[string, bigint][]] = [
    ["商品売上（返金後）", report.revenue],
    ["その他収入・返送差額", report.otherIncome],
    ["売上原価（良品返品反映）", report.cogs],
    ["販売手数料・送料", report.salesExpenses],
    ["資材・備品・購入付随経費", report.purchasesExpense],
    ["その他費用", report.otherExpense],
    ["在庫調整", report.stockExpense],
    ["振込手数料", report.transferFees],
  ];
  return (
    <div className="commerce">
      <header className="commerce-heading">
        <h1>収支・残高</h1>
      </header>
      <div className="commerce-editor">
        <form className="commerce-toolbar">
          <span>{year}年</span>
          <select name="month" aria-label="集計月" defaultValue={month || ""}>
            <option value="">年間</option>
            {Array.from({ length: 12 }, (_, i) => (
              <option key={i} value={String(i + 1).padStart(2, "0")}>
                {i + 1}月
              </option>
            ))}
          </select>
          <button className="button secondary" type="submit">
            表示
          </button>
        </form>
        <section className="commerce-section">
          <span className="commerce-secondary">
            管理上の損益 · {start}〜{end}
          </span>
          <strong className="commerce-total">{money(report.profit)}</strong>
          {report.provisional > 0 && (
            <p className="commerce-caption">
              確認待ち {report.provisional}件 · 確認済み金額からの差引 {money(report.knownProfit)}
            </p>
          )}
          <div className="commerce-list">
            {rows.map(([name, value]) => (
              <div className="commerce-summary-line" key={name}>
                <span>{name}</span>
                <span className="commerce-number">{money(value)}</span>
              </div>
            ))}
          </div>
        </section>
        <details className="commerce-disclosure">
          <summary>資材の集計方法</summary>
          <p>
            資材は購入時の経費に含めます。販売ごとの使用原価は商品別利益に使い、この損益からは重ねて差し引きません。
          </p>
        </details>
        <section className="commerce-section">
          <h2>期末残高</h2>
          {(owner.unpaid > 0n || owner.receivable > 0n) && (
            <>
              <div className="commerce-summary-line">
                <span>本人立替の未精算額</span>
                <strong>{money(owner.unpaid)}</strong>
              </div>
              <div className="commerce-summary-line">
                <span>本人からの返金待ち</span>
                <strong>{money(owner.receivable)}</strong>
              </div>
            </>
          )}
          {balances.map((a) => (
            <div className="commerce-row" key={a.id}>
              <span>{a.name}</span>
              <strong className="commerce-number">
                {a.accountKind === "CREDIT_CARD" && (
                  <small>{accountBalanceView(a.accountKind, a.balance).label}</small>
                )}
                {money(accountBalanceView(a.accountKind, a.balance).amount)}
              </strong>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
