import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ReturnWorkflowForm } from "@/components/forms/return-workflow-form";
import { requireInventoryContext } from "@/lib/inventory/context";
import { loadReturnReview } from "@/lib/sales/return-workflow";
import {
  blankReturnInput,
  returnInputSchema,
  returnSnapshotSchema,
  type ReturnKind,
} from "@/lib/sales/return-types";
import { inputContext, recoveryRequest } from "@/lib/sales/workflow-view";
import { transactionScope } from "@/lib/commerce/scope";

export default async function ReturnPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    draft?: string;
    kind?: string;
    operation?: string;
    operationKind?: string;
  }>;
}) {
  const { id } = await params,
    query = await searchParams,
    c = await requireInventoryContext();
  const kind: ReturnKind = query.kind === "REFUND" ? "REFUND" : "RETURN";
  const order = await c.db.salesOrder.findFirst({
    where: {
      id,
      ...transactionScope(c),
    },
    select: { id: true, recordingMode: true },
  });
  if (!order) notFound();
  const direct = order.recordingMode === "DIRECT";
  const business = await recoveryRequest(c, query.operation, kind),
    resolution = await recoveryRequest(c, query.operation, "RETURN_REBASE");
  const request = resolution ?? business;
  const payload = request?.payload as
    | { orderId?: string; draftId?: string; input?: unknown; baseSnapshot?: unknown }
    | undefined;
  if (payload?.orderId && payload.orderId !== id) notFound();
  if (request?.status === "APPLIED" && request.targetId) {
    if (resolution) redirect(`/sales/orders/${id}/return?kind=${kind}&draft=${request.targetId}`);
    const record = await c.db.salesReturn.findFirst({
      where: { requestKey: request.id, salesOrderId: id },
      select: { id: true },
    });
    redirect(`/sales/orders/${id}${record ? `?return=${record.id}` : ""}`);
  }
  const draftId = payload?.draftId ?? query.draft;
  const draft = draftId
    ? await c.db.workflowDraft.findFirst({
        where: {
          id: draftId,
          workspaceId: c.workspaceId,
          businessUnitId: c.businessUnitId,
          operatorId: c.operatorId,
          year: c.fiscalYear.year,
          kind,
        },
      })
    : null;
  if (draftId && !draft && !request)
    return (
      <div className="page">
        <h1>元の入力先を確認してください</h1>
        <p>保存済み入力は保持しています。元の入力者・部門・年度に戻してください。</p>
        <Link href={`/sales/orders/${id}`}>完了実績へ</Link>
      </div>
    );
  const review = await loadReturnReview(
    c.db,
    { ...c, year: c.fiscalYear.year, userAccountId: c.session.userAccountId },
    { kind, orderId: id, draftId: draft?.id },
  );
  if (!query.operation && review.activeRequest)
    redirect(
      `/sales/orders/${id}/return?kind=${kind}&draft=${draft!.id}&operation=${review.activeRequest.id}&operationKind=${review.activeRequest.kind}`,
    );
  const restored = returnInputSchema.safeParse(payload?.input ?? draft?.payload);
  if (restored.success && (restored.data.orderId !== id || restored.data.kind !== kind)) notFound();
  const baseline = returnSnapshotSchema.safeParse(
    request ? payload?.baseSnapshot : draft?.baseSnapshot,
  );
  const initial = restored.success
    ? restored.data
    : {
        ...blankReturnInput(kind, id),
        date: new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }),
        lineId:
          kind === "RETURN"
            ? (review.snapshot.lines.find((l) => l.components.some((c) => c.processed < c.quantity))
                ?.id ?? "")
            : "",
      };
  return (
    <div className={direct ? "commerce" : "page narrow-page"}>
      <header className="page-header">
        <div>
          <h1>{kind === "RETURN" ? "返品を記録" : "返金を記録"}</h1>
          {!direct && <p>未確認の内容は途中保存し、最新の実績・在庫を確認してから確定します。</p>}
        </div>
        <Link className="button secondary" href={`/sales/orders/${id}`}>
          完了実績へ戻る
        </Link>
      </header>
      <ReturnWorkflowForm
        compact={direct}
        context={inputContext(c)}
        initial={initial}
        baseline={draft || request ? (baseline.success ? baseline.data : null) : review.snapshot}
        review={review}
        draft={draft ? { id: draft.id, revision: draft.revision } : undefined}
        forceReview={!!resolution}
      />
    </div>
  );
}
