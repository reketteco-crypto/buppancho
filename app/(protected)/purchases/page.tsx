import Link from "next/link";
import { Plus, ChevronRight } from "lucide-react";
import { commerceContext } from "@/lib/commerce/view";
import { formatYen } from "@/lib/inventory/money";
import { transactionScope } from "@/lib/commerce/scope";

export default async function PurchasesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const c = await commerceContext(),
    query = await searchParams;
  const q = (query.q ?? "").trim().slice(0, 100),
    status = ["ORDERED", "PARTIALLY_RECEIVED", "RECEIVED"].includes(query.status ?? "")
      ? query.status
      : undefined;
  const scope = transactionScope(c);
  const [documents, legacy] = await Promise.all([
    c.db.purchaseDocument.findMany({
      where: {
        ...scope,
        ...(status ? { status } : {}),
        ...(q
          ? {
              OR: [
                { supplierName: { contains: q, mode: "insensitive" } },
                { code: { contains: q, mode: "insensitive" } },
                { lines: { some: { name: { contains: q, mode: "insensitive" } } } },
              ],
            }
          : {}),
      },
      include: { lines: { orderBy: { position: "asc" } } },
      orderBy: [{ purchasedDate: "desc" }, { createdAt: "desc" }],
      take: 100,
    }),
    c.db.purchase.findMany({
      where: scope,
      include: { supplier: true },
      orderBy: { purchasedDate: "desc" },
      take: 50,
    }),
  ]);
  const labels: Record<string, string> = {
    ORDERED: "受取待ち",
    PARTIALLY_RECEIVED: "一部受取",
    RECEIVED: "受取済み",
    CANCELLED: "取消済み",
  };
  return (
    <div className="commerce">
      <header className="commerce-heading">
        <h1>購入</h1>
        <Link className="button" href="/purchases/new">
          <Plus size={16} />
          購入を記録
        </Link>
      </header>
      <div className="commerce-action-row">
        <Link className="commerce-text-button" href="/purchases/deliveries/new">
          複数の購入をまとめて配送
        </Link>
      </div>
      <form className="commerce-toolbar">
        <input
          aria-label="購入を検索"
          name="q"
          defaultValue={q}
          placeholder="商品名・取引先で検索"
        />
        <select aria-label="受取状況" name="status" defaultValue={status ?? ""}>
          <option value="">すべて</option>
          <option value="ORDERED">受取待ち</option>
          <option value="PARTIALLY_RECEIVED">一部受取</option>
          <option value="RECEIVED">受取済み</option>
        </select>
        <button className="button secondary" type="submit">
          絞り込む
        </button>
      </form>
      {documents.length ? (
        <div className="commerce-list">
          {documents.map((p) => (
            <Link className="commerce-row" key={p.id} href={`/purchases/${p.id}`}>
              <div>
                <strong>{p.supplierName}</strong>
                <span className="commerce-secondary">
                  {p.purchasedDate.toISOString().slice(0, 10)} ·{" "}
                  {p.lines.map((l) => l.name).join("、")}
                </span>
              </div>
              <span className={`commerce-badge${p.status !== "RECEIVED" ? " pending" : ""}`}>
                {labels[p.status]}
              </span>
              <span className="commerce-number">
                ¥{formatYen(p.totalJpy)}
                {!p.costFinal && <small>原価は暫定</small>}
              </span>
              <ChevronRight size={16} />
            </Link>
          ))}
        </div>
      ) : (
        <div className="commerce-empty">
          <h2>{q || status ? "該当する購入はありません" : "購入を記録しましょう"}</h2>
          <p>商品・資材・備品を、ひとつの購入にまとめられます。</p>
        </div>
      )}
      {legacy.length > 0 && (
        <details className="commerce-disclosure">
          <summary>以前の購入記録</summary>
          <div className="commerce-list">
            {legacy.map((p) => (
              <Link className="commerce-row" href={`/purchases/${p.id}`} key={p.id}>
                <div>
                  <strong>{p.supplier.name}</strong>
                  <span className="commerce-secondary">{p.purchaseCode}</span>
                </div>
                <span>{formatYen(p.purchaseTotalJpy)}</span>
              </Link>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
