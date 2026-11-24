import Link from "next/link";
import { notFound } from "next/navigation";
import { randomUUID } from "node:crypto";
import { commerceContext, todayTokyo } from "@/lib/commerce/view";
import { Precise } from "@/lib/commerce/allocation";
import { CatalogEditor } from "./catalog-editor";
import { ListBackLink } from "@/components/list-display-state";
export async function CatalogDetail({
  id,
  kind,
  edit,
  unit,
}: {
  id: string;
  kind: "ITEM_SAVE" | "SUPPLY_SAVE";
  edit?: string;
  unit?: string;
}) {
  if (!/^[a-f0-9-]{36}$/.test(id)) notFound();
  const c = await commerceContext(),
    scope = `${c.workspaceId}:${c.businessUnitId}:${c.reportingEntityId}:${c.operatorId}:${c.fiscalYear.year}`,
    where = { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId };
  const item =
      kind === "ITEM_SAVE"
        ? await c.db.inventoryItem.findFirst({
            where: { id, ...where },
            include: {
              variants: {
                include: { costBalances: { where: { businessUnitId: c.businessUnitId } } },
              },
            },
          })
        : null,
    supply =
      kind === "SUPPLY_SAVE" ? await c.db.supplyItem.findFirst({ where: { id, ...where } }) : null;
  if (!item && !supply) notFound();
  const value = item ?? supply!,
    variantIds = item?.variants.map((v) => v.id) ?? [];
  const focused =
    unit && /^[a-f0-9-]{36}$/.test(unit)
      ? await c.db.uniqueStockUnit.findFirst({
          where: { id: unit, workspaceId: c.workspaceId, itemVariantId: { in: variantIds } },
        })
      : null;
  if (unit && !focused) notFound();
  const purchases = await c.db.purchaseDocumentLine.findMany({
    where: {
      ...(item ? { itemVariantId: { in: variantIds } } : { supplyItemId: id }),
      document: { ...where, reportingEntityId: c.reportingEntityId },
    },
    include: { document: true },
    orderBy: [
      { document: { purchasedDate: "desc" } },
      { document: { createdAt: "desc" } },
      { position: "desc" },
    ],
    take: 30,
  });
  const skus = await c.db.salesSku.findMany({
    where: {
      ...where,
      ...(item
        ? {
            components: {
              some: {
                OR: [
                  { itemVariantId: { in: variantIds } },
                  { uniqueStockUnit: { itemVariantId: { in: variantIds } } },
                ],
              },
            },
          }
        : { supplySettings: { some: { supplyItemId: id } } }),
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 30,
  });
  const base = `/products/${item ? "items" : "supplies"}/${id}`,
    query = focused ? `unit=${focused.id}&` : "",
    locations =
      edit === "1" && item
        ? await c.db.storageLocation.findMany({
            where: {
              workspaceId: c.workspaceId,
              active: true,
              OR: [{ businessUnitId: null }, { businessUnitId: c.businessUnitId }],
            },
            select: { id: true, name: true },
          })
        : [];
  const provisional = item
    ? await c.db.inventoryLot.count({
        where: {
          itemVariantId: { in: variantIds },
          remainingQuantity: { gt: 0 },
          costStatus: "PROVISIONAL",
        },
      })
    : 0;
  const money = (v: bigint) => `¥${v.toLocaleString("ja-JP")}`,
    balances = item?.variants.flatMap((v) => v.costBalances) ?? [],
    latest = purchases.find(
      (p) =>
        p.document.status !== "CANCELLED" &&
        p.document.purchasedDate.toISOString().slice(0, 10) <= todayTokyo(),
    );
  return (
    <div className="commerce">
      <header className="commerce-heading catalog-detail-heading">
        <div>
          <p className="commerce-overline">
            {item?.itemCode ?? (supply!.kind === "MATERIAL" ? "資材" : "備品")}
            {focused ? ` · ${focused.individualCode}` : ""}
          </p>
          <h1>{value.name}</h1>
        </div>
        {edit !== "1" ? (
          <Link className="button" href={`${base}?${query}edit=1`}>
            編集
          </Link>
        ) : (
          <Link
            className="button secondary"
            href={`${base}${focused ? `?unit=${focused.id}` : ""}`}
          >
            編集をやめる
          </Link>
        )}
      </header>
      {edit === "1" ? (
        <CatalogEditor
          kind={kind}
          scope={scope}
          locations={locations}
          initial={{
            context: c.context,
            idempotencyKey: randomUUID(),
            date: todayTokyo(),
            id,
            revision: value.revision,
            name: value.name,
            memo: value.memo ?? "",
            active: item ? item.status === "ACTIVE" : supply!.active,
            ...(item
              ? { category: item.category ?? "", locationId: item.defaultStorageLocationId ?? "" }
              : {}),
          }}
        />
      ) : (
        <div className="commerce-editor">
          {item ? (
            <>
              <div className="commerce-summary-line">
                <span>在庫数</span>
                <strong>{balances.reduce((s, b) => s + b.quantity, 0)} 点</strong>
              </div>
              <div className="commerce-summary-line">
                <span>管理方式</span>
                <span>{item.managementType === "QUANTITY" ? "数量で管理" : "1点ごとに管理"}</span>
              </div>
              <div className="commerce-summary-line">
                <span>在庫原価{provisional > 0 ? "（暫定）" : ""}</span>
                <strong>{money(balances.reduce((s, b) => s + b.carryingCostTotalJpy, 0n))}</strong>
              </div>
              {focused && (
                <p className="commerce-secondary">
                  個体の状態：{focused.condition} ·{" "}
                  {
                    {
                      IN_STOCK: "在庫あり",
                      RESERVED: "確保中",
                      SOLD: "販売済み",
                      RETURNED: "返品",
                      DISPOSED: "廃棄",
                      LOST: "紛失",
                      PERSONAL_USE: "私用",
                      PURCHASE_CANCELLED: "購入取消",
                      SUPPLIER_RETURNED: "取引先へ返送",
                    }[focused.status]
                  }
                </p>
              )}
            </>
          ) : (
            <div className="commerce-summary-line">
              <span>最新購入単価 / {supply!.unit}</span>
              <strong>
                {latest
                  ? `¥${new Precise(latest.landedCostJpy.toString()).div(latest.quantity).toDecimalPlaces(8).toString()}`
                  : "未確認"}
                {latest && !latest.document.costFinal && <small>暫定</small>}
              </strong>
            </div>
          )}
          {value.memo && <p className="commerce-section">{value.memo}</p>}
          {((item && item.status !== "ACTIVE") || (supply && !supply.active)) && (
            <p className="commerce-caption">無効になっています。</p>
          )}
          <section className="commerce-section">
            <h2>最近の購入</h2>
            {purchases.map((p) => (
              <Link className="commerce-row" key={p.id} href={`/purchases/${p.documentId}`}>
                <div>
                  <strong>{p.name}</strong>
                  <small className="commerce-secondary">
                    {p.document.purchasedDate.toISOString().slice(0, 10)} ·{" "}
                    {p.document.supplierName}
                    {p.document.status === "CANCELLED" ? " · 取消済み" : ""}
                  </small>
                </div>
                <span className="commerce-number">
                  {money(p.landedCostJpy)}
                  <small>
                    {p.quantity} 点{!p.document.costFinal ? " · 暫定" : ""}
                  </small>
                </span>
              </Link>
            ))}
            {!purchases.length && <p className="commerce-secondary">購入記録はありません。</p>}
          </section>
          <section className="commerce-section">
            <h2>この在庫を使う販売商品</h2>
            {skus.map((s) => (
              <Link className="commerce-row" key={s.id} href={`/products/skus/${s.id}`}>
                <strong>{s.name}</strong>
              </Link>
            ))}
            {!skus.length && (
              <p className="commerce-secondary">この在庫を使う販売商品はありません。</p>
            )}
          </section>
          {item && (
            <div className="commerce-action-row">
              <Link href={`/inventory/${item.id}`}>在庫と履歴の詳細</Link>
              <Link href="/inventory/stocktake/new">棚卸</Link>
              <Link href="/inventory/operations/new">在庫調整</Link>
            </div>
          )}
        </div>
      )}
      <div className="commerce-action-row">
        <ListBackLink
          context={scope}
          href={item ? "/products" : "/products?tab=supplies"}
          className="commerce-text-button"
        >
          商品一覧へ
        </ListBackLink>
      </div>
    </div>
  );
}
