import Link from "next/link";
import { requireInventoryContext } from "@/lib/inventory/context";
import { inputContext, recoveryRequest } from "@/lib/sales/workflow-view";
import { stocktakeRecordSchema } from "@/lib/validation/workflow";
import { StocktakeForm } from "@/components/forms/stocktake-form";

export default async function StocktakePage({
  searchParams,
}: {
  searchParams: Promise<{ operation?: string; item?: string }>;
}) {
  const c = await requireInventoryContext(),
    query = await searchParams;
  const scope = { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId };
  const [variants, locations, revision, recovery] = await Promise.all([
    c.db.itemVariant.findMany({
      where: {
        active: true,
        inventoryItem: { ...scope, status: "ACTIVE" },
        OR: [
          { inventoryItem: { managementType: "QUANTITY" } },
          {
            costBalances: { some: { businessUnitId: c.businessUnitId, trackingMode: "QUANTITY" } },
          },
        ],
      },
      include: { inventoryItem: true },
      orderBy: { inventoryItem: { name: "asc" } },
    }),
    c.db.storageLocation.findMany({
      where: {
        workspaceId: c.workspaceId,
        active: true,
        OR: [{ businessUnitId: null }, { businessUnitId: c.businessUnitId }],
      },
      orderBy: { code: "asc" },
    }),
    c.db.inventoryRevision.findUnique({ where: { businessUnitId: c.businessUnitId } }),
    recoveryRequest(c, query.operation, "STOCKTAKE"),
  ]);
  const initial = stocktakeRecordSchema.safeParse(recovery?.payload);
  return (
    <div className="page narrow-page">
      <header className="page-header">
        <div>
          <h1>数えた数量を確認・訂正する</h1>
          <p>数えた日の、その場所の帳簿数との差を確認します。現在残数との差では処理しません。</p>
        </div>
      </header>
      <section className="card">
        {c.fiscalYear.status === "LOCKED" ? (
          <p>ロック済み年度は閲覧と保存結果の照会のみ可能です。</p>
        ) : null}
        <StocktakeForm
          context={inputContext(c)}
          blocked={c.fiscalYear.status === "LOCKED"}
          revision={(revision?.revision ?? 0n).toString()}
          today={new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" })}
          variants={variants.map((v) => ({
            id: v.id,
            label: `${v.inventoryItem.name} ${Object.values(v.attributesJson as Record<string, string>).join(" / ")}`,
          }))}
          locations={locations}
          initial={initial.success ? initial.data : undefined}
          initialVariant={variants.find((v) => v.inventoryItemId === query.item)?.id}
        />
        <Link href="/inventory">在庫一覧へ戻る</Link>
      </section>
    </div>
  );
}
