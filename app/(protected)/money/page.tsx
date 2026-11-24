import { ownerData, ownerLedger } from "@/lib/commerce/owner-ledger";
import { accountBalanceView } from "@/lib/commerce/account-label";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { commerceContext, todayTokyo } from "@/lib/commerce/view";
import { accountBalances } from "@/lib/commerce/money";
import {
  loadMoneyHistory,
  moneyHistoryHref,
  type MoneyHistoryQuery,
} from "@/lib/commerce/money-history";
import { moneyDisplayScope } from "@/lib/commerce/money-navigation";
import { MoneyHistory } from "@/components/commerce/money-history";
import { eventDate } from "@/lib/validation/workflow";
import { AccountEditor } from "@/components/commerce/money-form";
import { ListDisplayState } from "@/components/list-display-state";
export default async function MoneyPage({
  searchParams,
}: {
  searchParams: Promise<MoneyHistoryQuery>;
}) {
  const c = await commerceContext(),
    query = await searchParams,
    history = await c.db.$transaction((tx) => loadMoneyHistory(tx, c, query, c.fiscalYear.year), {
      isolationLevel: "RepeatableRead",
    }),
    today = todayTokyo(),
    basisDate =
      c.fiscalYear.year === Number(today.slice(0, 4))
        ? today
        : eventDate.safeParse(history.query.to).success
          ? history.query.to!
          : `${c.fiscalYear.year}-12-31`,
    accounts = await accountBalances(c.db, c, new Date(`${basisDate}T00:00:00Z`)),
    owner = await c.db.$transaction(async (tx) => ownerLedger(await ownerData(tx, c), basisDate)),
    base = { context: c.context, idempotencyKey: randomUUID(), date: today },
    href = moneyHistoryHref(history.query, { open: history.open || undefined }),
    scope = moneyDisplayScope(c);
  const returnParam = `returnTo=${encodeURIComponent(href)}`;
  const pagination = (position: string) => (
    <nav className="catalog-pagination" aria-label={`${position}の履歴ページ送り`}>
      <span>
        {history.total
          ? `${(history.page - 1) * 50 + 1}–${Math.min(history.page * 50, history.total)} / ${history.total}件`
          : "0件"}{" "}
        · {history.page} / {history.pages}ページ
      </span>
      <div>
        {history.page > 1 ? (
          <Link
            href={`${moneyHistoryHref(history.query, { page: String(history.page - 1), open: undefined })}#money-history`}
          >
            前へ
          </Link>
        ) : (
          <span aria-disabled="true">前へ</span>
        )}
        {history.page < history.pages ? (
          <Link
            href={`${moneyHistoryHref(history.query, { page: String(history.page + 1), open: undefined })}#money-history`}
          >
            次へ
          </Link>
        ) : (
          <span aria-disabled="true">次へ</span>
        )}
      </div>
    </nav>
  );
  return (
    <div className="commerce">
      <header className="commerce-heading">
        <h1>お金</h1>
        <Link className="button" href={`/money/new?${returnParam}`}>
          その他の経費を記録
        </Link>
      </header>
      <ListDisplayState context={scope} />
      <section className="money-tasks" aria-label="記録する内容を選ぶ">
        <Link href="/sales">
          <strong>売上の入金</strong>
          <span>販売詳細から、売上と結び付けて記録</span>
        </Link>
        <Link href="/purchases">
          <strong>仕入の支払</strong>
          <span>購入詳細から、購入と結び付けて記録</span>
        </Link>
        <Link href={`/money/move?${returnParam}`}>
          <strong>口座間の移動</strong>
          <span>振替・カード引落・私用資金の移動</span>
        </Link>
        <Link href={`/money/move?kind=OWNER_REIMBURSEMENT&${returnParam}`}>
          <strong>立替の精算</strong>
          <span>本人へ返す金額と充当内訳を確認</span>
        </Link>
      </section>
      <div className="commerce-action-row">
        <Link className="commerce-text-button" href={`/money/new?kind=INCOME&${returnParam}`}>
          その他の収入を記録
        </Link>
        <Link className="commerce-text-button" href="/money/reports">
          収支・残高の集計
        </Link>
        <Link className="commerce-text-button" href="/settings/accounts">
          口座の設定
        </Link>
      </div>
      <div className="commerce-editor">
        {(owner.unpaid > 0n || owner.receivable > 0n) && (
          <section className="commerce-section" aria-label="本人立替">
            <h2>本人立替</h2>
            <p className="commerce-caption">{basisDate.replaceAll("-", "/")}時点</p>
            {owner.unpaid > 0n && (
              <div className="commerce-row">
                <span>未精算額</span>
                <strong className="commerce-number">¥{owner.unpaid.toLocaleString("ja-JP")}</strong>
                <Link href={`/money/move?kind=OWNER_REIMBURSEMENT&${returnParam}`}>精算する</Link>
              </div>
            )}
            {owner.receivable > 0n && (
              <div className="commerce-row">
                <span>本人からの返金待ち</span>
                <strong className="commerce-number">
                  ¥{owner.receivable.toLocaleString("ja-JP")}
                </strong>
                <Link href={`/money/move?kind=OWNER_REPAYMENT&${returnParam}`}>返金を記録</Link>
              </div>
            )}
            <details className="commerce-disclosure">
              <summary>未精算の内訳</summary>
              {[...owner.debts, ...owner.credits].map((r) => (
                <div className="commerce-summary-line" key={r.id}>
                  <span>
                    {r.date} · <Link href={r.href || "/money"}>{r.name}</Link>
                  </span>
                  <span>¥{r.amount.toLocaleString("ja-JP")}</span>
                </div>
              ))}
            </details>
          </section>
        )}
        <section className="commerce-section">
          <h2>口座残高</h2>
          <p className="commerce-caption">{basisDate.replaceAll("-", "/")}時点</p>
          {!accounts.length && (
            <p>
              入出金を記録する口座を準備しましょう。
              <Link href="/settings/accounts">口座を設定する</Link>
            </p>
          )}
          {accounts.map((a) => (
            <div className="commerce-row" key={a.id}>
              <span>{a.name}</span>
              <strong className="commerce-number">
                {a.accountKind === "CREDIT_CARD" && (
                  <small>{accountBalanceView(a.accountKind, a.balance).label}</small>
                )}
                ¥{accountBalanceView(a.accountKind, a.balance).amount.toLocaleString("ja-JP")}
              </strong>
              {a.accountKind === "CREDIT_CARD" && (
                <Link
                  className="commerce-text-button"
                  href={`/money/move?card=${a.id}&${returnParam}`}
                >
                  引落を記録
                </Link>
              )}
            </div>
          ))}
          <details className="commerce-disclosure">
            <summary>口座を追加</summary>
            <AccountEditor
              returnTo={href}
              key={accounts.length}
              initial={{ ...base, id: "", revision: 0, name: "", balance: "0", active: true }}
            />
          </details>
        </section>
      </div>
      <section id="money-history" className="money-history-section" aria-label="お金の履歴">
        <nav className="commerce-tabs" aria-label="お金の表示">
          <Link
            href={`${moneyHistoryHref(history.query, { tab: "entries", page: "1", open: undefined })}#money-history`}
            aria-current={history.tab === "entries" ? "page" : undefined}
          >
            入出金履歴
          </Link>
          <Link
            href={`${moneyHistoryHref(history.query, { tab: "records", page: "1", open: undefined })}#money-history`}
            aria-current={history.tab === "records" ? "page" : undefined}
          >
            その他の費用・収入
          </Link>
        </nav>
        <form className="commerce-toolbar money-history-filters" action="/money#money-history">
          <input type="hidden" name="tab" value={history.tab} />
          <label className="field">
            開始日
            <input type="date" name="from" defaultValue={history.query.from} required />
          </label>
          <label className="field">
            終了日
            <input type="date" name="to" defaultValue={history.query.to} required />
          </label>
          {history.tab === "entries" ? (
            <label className="field">
              口座
              <select name="account" defaultValue={history.query.account}>
                <option value="">すべて</option>
                {history.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.active ? "" : "（無効）"}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <input type="hidden" name="account" value={history.query.account} />
          )}
          <button className="button secondary" type="submit">
            表示
          </button>
        </form>
        {history.error && (
          <p className="field-error" role="alert">
            {history.error}
          </p>
        )}
        {pagination("上部")}
        <MoneyHistory
          key={moneyHistoryHref(history.query)}
          rows={history.rows}
          context={c.context}
          date={today}
          initialOpen={history.open}
          href={href}
          records={history.tab === "records"}
        />
        {pagination("下部")}
      </section>
    </div>
  );
}
