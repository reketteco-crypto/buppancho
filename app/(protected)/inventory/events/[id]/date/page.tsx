import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireInventoryContext } from "@/lib/inventory/context";
import { inputContext, recoveryRequest } from "@/lib/sales/workflow-view";
import { effectiveOperationDates, eventDay } from "@/lib/inventory/event-dates";
import { operationLabels } from "@/lib/inventory/operation-labels";
import { DateCorrectionForm } from "@/components/forms/date-correction-form";
import { dateCorrectionSchema } from "@/lib/inventory/date-correction";

export default async function EventDatePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ operation?: string }>;
}) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const c = await requireInventoryContext();
  const scope = { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId };
  const operation = await c.db.inventoryOperation.findFirst({
    where: { id, ...scope },
    include: {
      movements: { include: { itemVariant: { include: { inventoryItem: true } } } },
    },
  });
  const observation = await c.db.stocktakeObservation.findFirst({
    where: { operationId: id, ...scope },
  });
  if (!operation || (!operation.movements.length && !observation)) notFound();
  const currentDate = (await effectiveOperationDates(c.db, [operation])).get(id)!;
  const corrections = await c.db.eventDateCorrection.findMany({
    where: { operationId: id, ...scope },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const recovery = await recoveryRequest(c, (await searchParams).operation, "DATE_CORRECT");
  const parsed = dateCorrectionSchema.safeParse(recovery?.payload);
  const initial = parsed.success && parsed.data.operationId === id ? parsed.data : undefined;
  const blocked =
    c.fiscalYear.status === "LOCKED"
      ? "ロック済み年度では日付訂正できません。"
      : currentDate.slice(0, 4) !== String(c.fiscalYear.year)
        ? `${currentDate.slice(0, 4)}年度へ切り替えてから日付を訂正してください。`
        : undefined;
  const products = [
    ...new Map(
      operation.movements.map((m) => [m.itemVariant.inventoryItem.id, m.itemVariant.inventoryItem]),
    ).values(),
  ];
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
        <div>
          <h1>記録日を訂正する</h1>
          <p>
            {operationLabels[operation.operationType] ?? "在庫操作"}／現在の日付：{currentDate}
          </p>
        </div>
      </header>
      <section className="card form-stack">
        {products.map((p) => (
          <Link key={p.id} href={`/inventory/${p.id}`}>
            {p.name}の在庫履歴へ
          </Link>
        ))}
        <p>最初に記録した日付：{eventDay(operation.occurredAt)}</p>
        {c.fiscalYear.status === "CLOSING" && (
          <p className="message">
            この年度は決算処理中です。後続の原価への影響を確認してください。
          </p>
        )}
        <DateCorrectionForm
          context={inputContext(c)}
          operationId={id}
          currentDate={currentDate}
          initial={initial}
          blocked={blocked}
        />
      </section>
      <section className="card form-stack">
        <h2>日付訂正の履歴</h2>
        {corrections.length ? (
          corrections.map((r) => (
            <article key={r.id}>
              <p>
                {r.previousDate.toISOString().slice(0, 10)} →{" "}
                {r.effectiveDate.toISOString().slice(0, 10)}
              </p>
              <p>{r.reason}</p>
              <Link href={`/inventory/date-corrections/${r.id}`}>この訂正結果を確認する</Link>
            </article>
          ))
        ) : (
          <p>日付訂正はありません。</p>
        )}
      </section>
    </div>
  );
}
