import Link from "next/link";
import { ArrowUpRight, ShoppingBag, BadgeJapaneseYen } from "lucide-react";
import { commerceContext, todayTokyo } from "@/lib/commerce/view";
import { transactionScope } from "@/lib/commerce/scope";
import { inputDrafts } from "@/lib/commerce/input-drafts";
import { salesSummary } from "@/lib/commerce/sales-list";
export default async function HomePage() {
  const c = await commerceContext(),
    scope = transactionScope(c);
  const today = todayTokyo(),
    month = today.slice(5, 7);
  const [summary, drafts, waiting] = await Promise.all([
    c.db.$transaction((tx) => salesSummary(tx, c, c.fiscalYear.year, month)),
    inputDrafts(c.db, { ...c, year: c.fiscalYear.year }),
    c.db.purchaseDocument.count({
      where: { ...scope, status: { in: ["ORDERED", "PARTIALLY_RECEIVED"] } },
    }),
  ]);
  const { revenue, unknown } = summary;
  return (
    <div className="commerce">
      <header className="commerce-heading">
        <div>
          <p className="commerce-overline">
            {new Date().toLocaleDateString("ja-JP", {
              timeZone: "Asia/Tokyo",
              year: "numeric",
              month: "long",
              day: "numeric",
              weekday: "long",
            })}
          </p>
          <h1>日々の記録を、ひとつに。</h1>
        </div>
      </header>
      <div className="commerce-home-actions">
        <Link href="/purchases/new">
          <ShoppingBag size={22} />
          <span>購入を記録</span>
          <ArrowUpRight size={18} />
        </Link>
        <Link href="/sales/new">
          <BadgeJapaneseYen size={22} />
          <span>販売を記録</span>
          <ArrowUpRight size={18} />
        </Link>
      </div>
      {drafts.length > 0 && (
        <section className="commerce-section">
          <h2>入力の続き</h2>
          {drafts.map((d) => (
            <Link className="commerce-row" key={d.id} href={d.href}>
              <div>
                <strong>{d.title}</strong>
                {d.kind === "COMMERCE_SALE_BATCH" && (
                  <span className="commerce-secondary">
                    全{d.total.toLocaleString("ja-JP")}件 · 入力途中
                    {d.remaining.toLocaleString("ja-JP")}件 · 保存済み
                    {d.saved.toLocaleString("ja-JP")}件
                  </span>
                )}
                <span className="commerce-secondary">
                  {d.updatedAt.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}
                </span>
              </div>
              <ArrowUpRight size={16} />
            </Link>
          ))}
        </section>
      )}
      <section className="commerce-section">
        <h2>
          {c.fiscalYear.year === Number(today.slice(0, 4))
            ? "今月の販売"
            : `${c.fiscalYear.year}年${Number(month)}月の販売`}
        </h2>
        <div className="commerce-account-grid commerce-section">
          <div className="commerce-account">
            <span className="commerce-secondary">売上</span>
            <strong>¥{revenue.toLocaleString("ja-JP")}</strong>
          </div>
          <div className="commerce-account">
            <span className="commerce-secondary">販売件数</span>
            <strong>
              {summary.count}
              <small> 件</small>
            </strong>
          </div>
        </div>
      </section>
      {(waiting > 0 || unknown > 0) && (
        <section className="commerce-section">
          <h2>確認すること</h2>
          {waiting > 0 && (
            <Link className="commerce-row" href="/purchases?status=ORDERED">
              <div>
                <strong>受取待ちの購入</strong>
              </div>
              <span>{waiting} 件</span>
              <ArrowUpRight size={16} />
            </Link>
          )}
          {unknown > 0 && (
            <Link className="commerce-row" href="/sales">
              <div>
                <strong>費用・原価が未確認の販売</strong>
              </div>
              <span>{unknown} 件</span>
              <ArrowUpRight size={16} />
            </Link>
          )}
        </section>
      )}
    </div>
  );
}
