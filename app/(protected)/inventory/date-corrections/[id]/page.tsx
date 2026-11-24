import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireInventoryContext } from "@/lib/inventory/context";
import { formatYen } from "@/lib/inventory/money";
import { effectiveOperationDates } from "@/lib/inventory/event-dates";

export default async function DateCorrectionResult({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const c = await requireInventoryContext();
  const scope = { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId };
  const record = await c.db.eventDateCorrection.findFirst({ where: { id, ...scope } });
  if (!record) notFound();
  const operation = await c.db.inventoryOperation.findFirst({
    where: { id: record.operationId, ...scope },
    include: { movements: { include: { itemVariant: { include: { inventoryItem: true } } } } },
  });
  if (!operation) notFound();
  const latest = (await effectiveOperationDates(c.db, [operation])).get(operation.id)!;
  const [run, operator] = await Promise.all([
    c.db.valuationRun.findFirst({
      where: { requestId: record.requestId, ...scope },
      include: { adjustments: true },
    }),
    c.db.operator.findFirst({ where: { id: record.operatorId, workspaceId: c.workspaceId } }),
  ]);
  const products = [
    ...new Map(
      operation.movements.map((m) => [m.itemVariant.inventoryItem.id, m.itemVariant.inventoryItem]),
    ).values(),
  ];
  const observation = await c.db.stocktakeObservation.findFirst({
    where: { operationId: operation.id, ...scope },
  });
  if (observation) {
    const variant = await c.db.itemVariant.findFirst({
      where: { id: observation.itemVariantId, inventoryItem: scope },
      include: { inventoryItem: true },
    });
    if (variant && !products.some((p) => p.id === variant.inventoryItem.id))
      products.push(variant.inventoryItem);
  }
  return (
    <div className="page narrow-page">
      <header className="page-header">
        <h1>日付訂正の記録</h1>
      </header>
      <section className="card form-stack">
        <p role="status" className="message success">
          日付訂正を記録しました。数量移動は追加せず、必要な管理原価の訂正を追記しています。
        </p>
        <dl className="detail-grid">
          <div>
            <dt>今回の訂正</dt>
            <dd>
              {record.previousDate.toISOString().slice(0, 10)} →{" "}
              {record.effectiveDate.toISOString().slice(0, 10)}
            </dd>
          </div>
          <div>
            <dt>現在の有効日付</dt>
            <dd>{latest}</dd>
          </div>
          <div>
            <dt>理由</dt>
            <dd>{record.reason}</dd>
          </div>
          <div>
            <dt>記録者・記録日時</dt>
            <dd>
              {operator?.displayName ?? "記録者"}／
              {record.createdAt.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}
            </dd>
          </div>
        </dl>
        <p>原価訂正：{run?.adjustments.length ?? 0}件</p>
        {run?.adjustments.map((a) => (
          <p key={a.id}>
            {(
              { MOVEMENT: "在庫移動", CONSUMPTION: "販売原価", DISPOSITION: "返品原価" } as Record<
                string,
                string
              >
            )[a.targetType] ?? "管理原価"}
            ：¥{formatYen(a.beforeJpy)} → ¥{formatYen(a.afterJpy)}
          </p>
        ))}
        <Link href={`/inventory/events/${operation.id}/date`}>
          元の記録と日付訂正履歴を確認する
        </Link>
        {products.map((p) => (
          <Link key={p.id} href={`/inventory/${p.id}`}>
            {p.name}の在庫履歴へ
          </Link>
        ))}
        <Link href="/inventory">在庫一覧へ</Link>
      </section>
    </div>
  );
}
