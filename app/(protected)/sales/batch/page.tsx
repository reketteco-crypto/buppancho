import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { commerceContext, commerceOptions } from "@/lib/commerce/view";
import { readSalesBatch, salesBatchMappings } from "@/lib/commerce/sales-batch";
import { SalesBatchEditor } from "@/components/commerce/sales-batch-editor";

export default async function SalesBatchPage({
  searchParams,
}: {
  searchParams: Promise<{ draft?: string; new?: string }>;
}) {
  const c = await commerceContext(),
    query = await searchParams;
  if (!query.draft && !query.new) redirect(`/sales/batch?new=${randomUUID()}`);
  const id = z.uuid().safeParse(query.draft || query.new);
  if (!id.success) notFound();
  const workflow = {
    ...c,
    year: c.fiscalYear.year,
    userAccountId: c.session.userAccountId,
    sessionId: c.session.id,
  };
  const [options, mappings, drafts] = await Promise.all([
    commerceOptions(c),
    salesBatchMappings(c.db, workflow),
    c.db.workflowDraft.findMany({
      where: {
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        operatorId: c.operatorId,
        year: c.fiscalYear.year,
        kind: "COMMERCE_SALE_BATCH",
        archivedAt: null,
        baseSnapshot: { path: ["reportingEntityId"], equals: c.reportingEntityId },
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true, updatedAt: true },
    }),
  ]);
  const initial = query.draft
    ? await readSalesBatch(c.db, workflow, query.draft)
    : { id: id.data, revision: 0, data: { rows: [] }, review: undefined, recovery: undefined };
  return (
    <div className="commerce commerce-batch-page">
      <header className="commerce-heading">
        <h1>販売をまとめて入力</h1>
        <Link href="/sales">販売一覧へ</Link>
      </header>
      <SalesBatchEditor
        key={initial.id}
        initial={initial}
        context={c.context}
        skus={options.skus}
        channels={options.channels}
        methods={options.methods}
        initialMappings={mappings}
      />
      {drafts.length > 0 && (
        <details className="commerce-disclosure">
          <summary>まとめ入力の途中保存（{drafts.length}件）</summary>
          <ul>
            {drafts.map((d) => (
              <li key={d.id}>
                <Link href={`/sales/batch?draft=${d.id}`}>
                  {d.updatedAt.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}の入力
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
