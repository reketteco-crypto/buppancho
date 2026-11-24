import { notFound, redirect } from "next/navigation";
import { purchaseRebaseSchema } from "@/lib/inventory/purchase-conflict";
import { PurchaseForm, type PurchaseUiSnapshot } from "@/components/forms/purchase-form";
import { inputContext, recoveryRequest } from "@/lib/sales/workflow-view";
import { purchaseRequestSnapshot } from "@/lib/inventory/purchase-recovery";
import { requireInventoryContext } from "@/lib/inventory/context";
import { loadPurchaseReview } from "@/lib/inventory/purchase-conflict";
import { purchaseBaselineSchema } from "@/lib/inventory/purchase-comparison";
import { transactionScope } from "@/lib/commerce/scope";

export default async function EditPurchasePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ draft?: string; operation?: string }>;
}) {
  const { id } = await params;
  const context = await requireInventoryContext();
  const query = await searchParams;
  const rebase = await recoveryRequest(context, query.operation, "PURCHASE_REBASE");
  const rebasePayload = purchaseRebaseSchema.safeParse(rebase?.payload);
  if (
    rebase?.status === "APPLIED" &&
    rebase.targetId &&
    rebasePayload.success &&
    rebasePayload.data.purchaseId === id
  )
    redirect(`/purchases/${id}/edit?draft=${rebase.targetId}`);
  const resolution =
    rebasePayload.success && rebasePayload.data.purchaseId === id ? rebasePayload.data : undefined;
  const request = await recoveryRequest(context, query.operation, "PURCHASE_SAVE");
  if (request?.status === "APPLIED" && request.targetId === id)
    redirect(`/purchases/${id}?recorded=1`);
  const recovered = resolution
    ? ({ ...resolution.local, baseSnapshot: resolution.baseSnapshot } as PurchaseUiSnapshot)
    : request
      ? purchaseRequestSnapshot(request.payload)
      : undefined;
  const purchase = await context.db.purchase.findFirst({
    where: {
      id,
      ...transactionScope(context),
      purchaseType: { in: ["DOMESTIC", "USED_BUNDLE"] },
    },
    include: { lines: true },
  });
  if (!purchase) notFound();
  const requestedDraft = resolution?.draftId ?? query.draft;
  const draft = await context.db.workflowDraft.findFirst({
    where: {
      ...(requestedDraft ? { id: requestedDraft } : {}),
      workspaceId: context.workspaceId,
      businessUnitId: context.businessUnitId,
      operatorId: context.operatorId,
      year: context.fiscalYear.year,
      kind: "PURCHASE",
      ...(requestedDraft ? {} : { archivedAt: null }),
      payload: { path: ["purchaseId"], equals: purchase.id },
    },
    orderBy: { updatedAt: "desc" },
  });
  const restored = draft?.payload as unknown as
    | (PurchaseUiSnapshot & { updatedAt?: string })
    | undefined;
  if (!recovered && requestedDraft && !draft)
    return (
      <div className="page">
        <h1>入力先・更新内容の確認が必要です</h1>
        <p>
          入力者・部門・年度、または別端末から仕入れが変更されました。途中保存は保持しています。元の選択と仕入れ詳細を確認してください。
        </p>
        <a href={`/purchases/${id}`}>仕入れ詳細を確認</a>
      </div>
    );
  const [suppliers, locations, variants] = await Promise.all([
    context.db.counterparty.findMany({
      where: { workspaceId: context.workspaceId, type: "SUPPLIER", active: true },
      orderBy: { name: "asc" },
    }),
    context.db.storageLocation.findMany({
      where: {
        workspaceId: context.workspaceId,
        active: true,
        OR: [{ businessUnitId: null }, { businessUnitId: context.businessUnitId }],
      },
      orderBy: { code: "asc" },
    }),
    context.db.itemVariant.findMany({
      where: {
        active: true,
        inventoryItem: {
          workspaceId: context.workspaceId,
          businessUnitId: context.businessUnitId,
          status: "ACTIVE",
        },
      },
      include: { inventoryItem: true },
      orderBy: { inventoryItem: { name: "asc" } },
    }),
  ]);
  const review = await loadPurchaseReview(
    context.db,
    { ...context, year: context.fiscalYear.year, userAccountId: context.session.userAccountId },
    { purchaseId: id, draftId: draft?.id },
  );
  const base = draft ? purchaseBaselineSchema.safeParse(draft.baseSnapshot) : null;
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">{purchase.purchaseCode}</p>
          <h1>仕入下書きを編集</h1>
          <p className="muted">保存すると既存の下書き明細を置き換えます。</p>
        </div>
      </header>
      <PurchaseForm
        forceReview={!!resolution}
        context={inputContext(context)}
        review={review}
        baseline={
          recovered
            ? (recovered.baseSnapshot ?? null)
            : draft
              ? base?.success
                ? base.data
                : null
              : review.baseline
        }
        draft={draft ? { id: draft.id, revision: draft.revision } : undefined}
        restored={recovered?.purchaseId === id ? recovered : restored}
        suppliers={suppliers.map((row) => ({ id: row.id, label: row.name }))}
        locations={locations.map((row) => ({ id: row.id, label: `${row.code} ${row.name}` }))}
        variants={variants.map((row) => ({
          id: row.id,
          label: review.labels.variants.find((x) => x.id === row.id)!.label,
          sourceName: row.inventoryItem.name,
        }))}
        today={purchase.purchasedDate.toISOString().slice(0, 10)}
        initial={{
          purchaseId: purchase.id,
          revision: purchase.revision,
          updatedAt: purchase.updatedAt.toISOString(),
          requestKey: purchase.requestKey,
          purchasedDate: purchase.purchasedDate.toISOString().slice(0, 10),
          supplierId: purchase.supplierId,
          storageLocationId: purchase.storageLocationId,
          orderNumber: purchase.orderNumber ?? "",
          purchaseTotalJpy: purchase.purchaseTotalJpy.toString(),
          memo: purchase.memo ?? "",
          lines: review.input!.lines,
        }}
      />
    </div>
  );
}
