import Link from "next/link";
import { Plus, ChevronRight } from "lucide-react";
import { commerceContext } from "@/lib/commerce/view";
import {
  loadSalesList,
  salesListHref,
  salesListScope,
  salesPageSize,
  type SalesListQuery,
} from "@/lib/commerce/sales-list";
import { ListDisplayState } from "@/components/list-display-state";
export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<SalesListQuery>;
}) {
  const c = await commerceContext(),
    query = await searchParams;
  const { rows, total, page, pages, q, month } = await c.db.$transaction(
    (tx) => loadSalesList(tx, c, query, c.fiscalYear.year),
    { isolationLevel: "RepeatableRead" },
  );
  const pagination = (position: string) => (
    <nav className="catalog-pagination" aria-label={`${position}の販売ページ送り`}>
      <span>
        {total
          ? `${(page - 1) * salesPageSize + 1}–${Math.min(page * salesPageSize, total)} / ${total}件`
          : "0件"}{" "}
        · {page} / {pages}ページ
      </span>
      <div>
        {page > 1 ? (
          <Link href={salesListHref({ q, month }, page - 1)}>前へ</Link>
        ) : (
          <span aria-disabled="true">前へ</span>
        )}
        {page < pages ? (
          <Link href={salesListHref({ q, month }, page + 1)}>次へ</Link>
        ) : (
          <span aria-disabled="true">次へ</span>
        )}
      </div>
    </nav>
  );
  return (
    <div className="commerce">
      <header className="commerce-heading">
        <h1>販売</h1>
        <div className="commerce-heading-actions">
          <Link className="button secondary" href="/sales/batch">
            まとめて入力
          </Link>
          <Link className="button" href="/sales/new">
            <Plus size={16} />
            販売を記録
          </Link>
        </div>
      </header>
      <ListDisplayState context={salesListScope(c, c.fiscalYear.year)} />
      <form className="commerce-toolbar">
        <input
          aria-label="販売を検索"
          name="q"
          defaultValue={q}
          placeholder="販売商品名・商品ID・購入者で検索"
        />
        <select name="month" aria-label="販売月" defaultValue={month}>
          <option value="">すべての月</option>
          {Array.from({ length: 12 }, (_, i) => (
            <option key={i} value={String(i + 1).padStart(2, "0")}>
              {i + 1}月
            </option>
          ))}
        </select>
        <button className="button secondary" type="submit">
          絞り込む
        </button>
      </form>
      {pagination("上部")}
      {rows.length ? (
        <div className="commerce-list">
          {rows.map((o) => (
            <Link className="commerce-row" key={o.id} href={`/sales/orders/${o.id}`}>
              <div>
                <strong>{o.lines.map((l) => l.displayName ?? "商品").join("、")}</strong>
                <span className="commerce-secondary">
                  {o.date} · {o.salesChannel.name}
                  {o.externalOrderId ? ` · ${o.externalOrderId}` : ""}
                </span>
              </div>
              <span className="commerce-number">
                ¥{o.grossSalesJpy.toLocaleString("ja-JP")}
                {o.feeJpy === null || o.shippingJpy === null || o.costStatus === "PROVISIONAL" ? (
                  <small>費用・原価を確認</small>
                ) : null}
              </span>
              <ChevronRight size={16} />
            </Link>
          ))}
        </div>
      ) : (
        <div className="commerce-empty">
          <h2>販売の記録はありません</h2>
          <p>取引が完了したら、SKUから販売を記録できます。</p>
        </div>
      )}
      {pagination("下部")}
    </div>
  );
}
