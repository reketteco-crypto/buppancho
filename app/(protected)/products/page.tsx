import Link from "next/link";
import { InputReturnLink } from "@/components/input-return-link";
import { withInputReturn } from "@/lib/settings/return-path";
import { commerceContext, todayTokyo } from "@/lib/commerce/view";
import { catalogStocks, catalogSkuAvailability, catalogPageSize } from "@/lib/commerce/catalog";
import { supplyPrices } from "@/lib/commerce/supplies";
import { BatchSkuEditor, ProductTabs } from "@/components/commerce/catalog-selection";
import { ListDisplayState } from "@/components/list-display-state";
export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string;
    q?: string;
    page?: string;
    batch?: string;
    focus?: string;
    returnTo?: string;
  }>;
}) {
  const c = await commerceContext(),
    query = await searchParams,
    tab = query.tab === "skus" ? "skus" : query.tab === "supplies" ? "supplies" : "inventory",
    q = (query.q ?? "").trim().slice(0, 100),
    requested = /^[1-9]\d{0,6}$/.test(query.page ?? "") ? Number(query.page) : 1;
  const scope = `${c.workspaceId}:${c.businessUnitId}:${c.reportingEntityId}:${c.operatorId}:${c.fiscalYear.year}`;
  const batch =
    query.batch && /^[a-f0-9-]{36}$/.test(query.batch)
      ? await c.db.workflowEvent.findFirst({
          where: {
            id: query.batch,
            workspaceId: c.workspaceId,
            businessUnitId: c.businessUnitId,
            operatorId: c.operatorId,
            year: c.fiscalYear.year,
            kind: "SKU_BATCH",
          },
          select: { detail: true },
        })
      : null;
  const detail = batch?.detail as
    | { request?: { context?: { reportingEntityId?: string } }; result?: { skuIds?: string[] } }
    | undefined;
  const savedIds = query.batch
    ? detail?.request?.context?.reportingEntityId === c.reportingEntityId
      ? (detail.result?.skuIds ?? [])
      : []
    : query.focus && /^[a-f0-9-]{36}$/.test(query.focus)
      ? [query.focus]
      : null;
  const where = {
    ...(tab === "skus" && savedIds ? { id: { in: savedIds } } : {}),
    workspaceId: c.workspaceId,
    businessUnitId: c.businessUnitId,
    active: true,
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            ...(tab === "skus" ? [{ skuCode: { contains: q, mode: "insensitive" as const } }] : []),
          ],
        }
      : {}),
  };
  const stock = tab === "inventory" ? await catalogStocks(c.db, c, { q, page: requested }) : null;
  const total =
    stock?.total ??
    (tab === "skus"
      ? await c.db.salesSku.count({ where })
      : await c.db.supplyItem.count({ where }));
  const pages = Math.max(1, Math.ceil(total / catalogPageSize)),
    page = stock?.page ?? Math.min(pages, requested),
    skip = (page - 1) * catalogPageSize;
  const skus =
    tab === "skus"
      ? await c.db.salesSku.findMany({
          where,
          orderBy: [{ name: "asc" }, { skuCode: "asc" }, { id: "asc" }],
          take: catalogPageSize,
          skip,
          include: { components: true },
        })
      : [];
  const available = await catalogSkuAvailability(c.db, c, skus);
  const supplies =
      tab === "supplies"
        ? await c.db.supplyItem.findMany({
            where,
            orderBy: [{ name: "asc" }, { id: "asc" }],
            take: catalogPageSize,
            skip,
          })
        : [],
    prices =
      tab === "supplies"
        ? await supplyPrices(
            c.db,
            c,
            todayTokyo(),
            supplies.map((s) => s.id),
          )
        : [];
  const href = (p: number) =>
    `/products?${new URLSearchParams({ tab, q, page: String(p), ...(query.batch ? { batch: query.batch } : {}), ...(query.focus ? { focus: query.focus } : {}) })}`;
  const pagination = (position: string) => (
    <nav className="catalog-pagination" aria-label={`${position}のページ送り`}>
      <span>
        {total ? `${skip + 1}–${Math.min(skip + catalogPageSize, total)} / ${total}件` : "0件"} ·{" "}
        {page} / {pages}ページ
      </span>
      <div>
        {page > 1 ? (
          <Link href={withInputReturn(href(page - 1), query.returnTo)} scroll={false}>
            前へ
          </Link>
        ) : (
          <span aria-disabled="true">前へ</span>
        )}
        {page < pages ? (
          <Link href={withInputReturn(href(page + 1), query.returnTo)} scroll={false}>
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
        <h1>商品</h1>
        <Link
          className="button"
          href={withInputReturn(
            tab === "skus"
              ? "/products/skus/new"
              : tab === "supplies"
                ? "/purchases/new?purpose=MATERIAL"
                : "/purchases/new",
            query.returnTo,
          )}
        >
          {tab === "skus" ? "セット・販売商品を作成" : "購入を記録"}
        </Link>
      </header>
      <InputReturnLink returnTo={query.returnTo} />
      <ListDisplayState context={scope} />
      <ProductTabs scope={scope} tab={tab} returnTo={query.returnTo} />
      {tab === "skus" && savedIds && (
        <p className="commerce-caption">
          保存した販売商品を表示中 ·{" "}
          <Link href={withInputReturn("/products?tab=skus", query.returnTo)}>すべての販売商品</Link>
        </p>
      )}
      <form className="commerce-toolbar">
        <input type="hidden" name="tab" value={tab} />
        {query.returnTo && <input type="hidden" name="returnTo" value={query.returnTo} />}
        <input
          aria-label="商品を検索"
          name="q"
          defaultValue={q}
          placeholder="商品名・コードで検索"
        />
        <button className="button secondary">検索</button>
      </form>
      {pagination("上部")}
      {tab === "inventory" ? (
        <BatchSkuEditor
          context={c.context}
          date={todayTokyo()}
          products={stock!.rows}
          scope={scope}
        />
      ) : tab === "skus" ? (
        <div className="commerce-list">
          {skus.map((s) => (
            <div className="commerce-row" key={s.id}>
              <div>
                <Link href={withInputReturn(`/products/skus/${s.id}`, query.returnTo)}>
                  <strong>{s.name}</strong>
                </Link>
                <span className="commerce-secondary">{s.skuCode}</span>
              </div>
              <span>{available.get(s.id) ?? 0} 点</span>
              <Link className="button secondary" href={`/sales/new?sku=${s.id}`}>
                販売を記録
              </Link>
            </div>
          ))}
        </div>
      ) : (
        <div className="commerce-list">
          {supplies.map((s) => {
            const price = prices.find((p) => p.id === s.id);
            return (
              <div className="commerce-row" key={s.id}>
                <div>
                  <Link href={`/products/supplies/${s.id}`}>
                    <strong>{s.name}</strong>
                  </Link>
                  <small className="commerce-secondary">
                    {s.kind === "MATERIAL" ? "資材" : "備品"}
                  </small>
                </div>
                <span className="commerce-number">
                  {price?.unitCost ? `¥${price.unitCost}` : "未確認"}
                  <small>最新購入単価 / {s.unit}</small>
                </span>
              </div>
            );
          })}
        </div>
      )}
      {!total && (
        <div className="commerce-empty">
          <h2>
            {q
              ? "条件に合う商品がありません"
              : tab === "skus"
                ? "販売する商品を準備しましょう"
                : "購入したものを登録しましょう"}
          </h2>
          <p>
            {q
              ? "商品名やコードの一部で検索してみてください。"
              : tab === "skus"
                ? "単品なら在庫商品を選んで一括登録できます。セットなら構成する商品と使用数を登録します。"
                : "購入と受取を記録すると、商品や資材・備品をここで確認できます。"}
          </p>
          {!q && (
            <Link
              className="button secondary"
              href={withInputReturn(
                tab === "skus" ? "/products" : "/purchases/new",
                query.returnTo,
              )}
            >
              {tab === "skus" ? "在庫商品から選ぶ" : "購入を記録"}
            </Link>
          )}
        </div>
      )}
      {pagination("下部")}
      <div className="commerce-action-row">
        {tab === "supplies" && <Link href="/purchases/new?purpose=EQUIPMENT">備品を購入</Link>}
        <Link href="/inventory/operations/new">廃棄・紛失・在庫移動</Link>
        <Link href="/inventory/stocktake/new">棚卸</Link>
        <Link href="/inventory">在庫の詳細</Link>
      </div>
    </div>
  );
}
