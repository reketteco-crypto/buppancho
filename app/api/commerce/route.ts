import { accountBalances } from "@/lib/commerce/money";
import { ownerPlan } from "@/lib/commerce/owner-ledger";
import { z } from "zod";
import { catalogStocks, catalogSelectionNames } from "@/lib/commerce/catalog";
import { assertTrustedOrigin } from "@/lib/auth/origin";
import { requireInventoryContext } from "@/lib/inventory/context";
import { workflowContextSchema, componentsSchema } from "@/lib/validation/workflow";
import { estimateComponentCost } from "@/lib/sales/listing-estimate";
import { captureValuationPreview, sharedValuationKinds } from "@/lib/inventory/shared-valuation";
import { commerceSchemas, optionalDecimal, type CommerceKind } from "@/lib/commerce/input";
import { executeCommerce } from "@/lib/commerce/workflow";
import { readCommerceDraft } from "@/lib/commerce/drafts";
import { WorkflowError } from "@/lib/sales/workflow-errors";
import { lockInventoryDomain } from "@/lib/inventory/domain-lock";
import { checkWorkflowContext } from "@/lib/sales/workflow-context";
import { requestResult, fingerprint, toJson } from "@/lib/sales/request-store";
import { revalidatePath } from "next/cache";
import { skuMaterialQuote } from "@/lib/commerce/supplies";
import { eventDate } from "@/lib/validation/workflow";
import { purchaseChoices } from "@/lib/commerce/purchase-history";
import { purchaseCostPreview } from "@/lib/commerce/purchase-cost-preview";

const noStore = { "Cache-Control": "no-store" };
export async function POST(request: Request) {
  try {
    await assertTrustedOrigin();
    const text = await request.text();
    if (text.length > 250000) throw new WorkflowError("VALIDATION", "入力が大きすぎます。");
    const body = z
      .object({
        action: z.enum([
          "accounts",
          "purchase-choices",
          "purchase-cost-preview",
          "owner-preview",
          "selection",
          "preview",
          "save",
          "draft",
          "result",
          "cancel",
          "estimate",
          "draft-review",
        ]),
        kind: z.string(),
        payload: z.record(z.string(), z.unknown()),
      })
      .parse(JSON.parse(text));
    const expected = workflowContextSchema.parse(body.payload.context);
    const current = await requireInventoryContext();
    const c = {
      workspaceId: current.workspaceId,
      businessUnitId: current.businessUnitId,
      reportingEntityId: current.reportingEntityId,
      operatorId: current.operatorId,
      year: current.fiscalYear.year,
      userAccountId: current.session.userAccountId,
      sessionId: current.session.id,
    };
    const readOnly = body.action === "result" || body.action === "cancel";
    if (
      expected.businessUnitId !== c.businessUnitId ||
      expected.operatorId !== c.operatorId ||
      (!readOnly &&
        (expected.year !== c.year || expected.reportingEntityId !== c.reportingEntityId))
    )
      throw new WorkflowError(
        "CONTEXT_CHANGED",
        "入力先が変わっています。入力を保持して元の部門・年度を確認してください。",
      );
    if (body.action === "purchase-cost-preview") {
      return Response.json(
        { costPreview: await purchaseCostPreview(current.db, c, body.payload) },
        { headers: noStore },
      );
    }
    if (body.action === "purchase-choices") {
      const choices = await current.db.$transaction(
        async (tx) => {
          await checkWorkflowContext(tx, c);
          return purchaseChoices(tx, c, body.payload);
        },
        { isolationLevel: "RepeatableRead" },
      );
      return Response.json({ choices }, { headers: noStore });
    }
    if (body.action === "accounts") {
      const accounts = await current.db.$transaction(async (tx) => {
        await lockInventoryDomain(tx, c.businessUnitId);
        await checkWorkflowContext(tx, c);
        return (await accountBalances(tx, c))
          .filter((a) => a.active)
          .map((a) => ({
            id: a.id,
            name: a.name,
            revision: a.revision,
            accountKind: a.accountKind,
            balance: a.balance.toString(),
          }));
      });
      return Response.json({ accounts }, { headers: noStore });
    }
    if (body.action === "owner-preview") {
      const input = commerceSchemas.MONEY_RECORD.parse(body.payload);
      if (!["OWNER_REIMBURSEMENT", "OWNER_REPAYMENT"].includes(input.kind))
        throw new WorkflowError("VALIDATION", "精算する操作を選択してください。");
      const plan = await current.db.$transaction(async (tx) => {
        await lockInventoryDomain(tx, c.businessUnitId);
        await checkWorkflowContext(tx, c);
        return ownerPlan(tx, c, input);
      });
      return Response.json({ status: "PREVIEW", ownerPlan: plan }, { headers: noStore });
    }
    if (body.action === "selection") {
      const ids = z.array(z.uuid()).max(200).parse(body.payload.ids);
      const selection = await catalogStocks(current.db, c, { ids }),
        missing = ids.filter((id) => !selection.rows.some((row) => row.id === id));
      return Response.json(
        { ...selection, unavailable: await catalogSelectionNames(current.db, c, missing) },
        { headers: noStore },
      );
    }
    if (readOnly)
      return Response.json(
        await requestResult(
          current.db,
          c,
          z.uuid().parse(body.payload.idempotencyKey),
          body.action === "cancel",
        ),
        { headers: noStore },
      );
    if (body.action === "draft-review") {
      const draft = await readCommerceDraft(
        current.db,
        c,
        z.uuid().parse(body.payload.draftId),
        z.enum(["COMMERCE_PURCHASE", "COMMERCE_SALE"]).parse(body.kind),
      );
      const skus = await current.db.salesSku.findMany({
        where: { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
        select: { id: true, name: true },
      });
      return Response.json(
        {
          status: "REVIEW",
          conflict: {
            revision: draft.revision,
            archived: !!draft.archivedAt,
            baseline: draft.baseSnapshot,
            current: draft.payload,
            names: Object.fromEntries(skus.map((s) => [s.id, s.name])),
          },
        },
        { headers: noStore },
      );
    }
    if (body.action === "estimate") {
      const result = await current.db.$transaction(async (tx) => {
        await lockInventoryDomain(tx, c.businessUnitId);
        await checkWorkflowContext(tx, c);
        let components = body.payload.components;
        if (body.payload.skuId) {
          const sku = await tx.salesSku.findFirst({
            where: {
              id: z.uuid().parse(body.payload.skuId),
              workspaceId: c.workspaceId,
              businessUnitId: c.businessUnitId,
              active: true,
            },
            include: { components: true },
          });
          if (!sku) throw new WorkflowError("VALIDATION", "SKUを確認してください。");
          const quantity = z
            .number()
            .int()
            .positive()
            .max(1000000)
            .parse(body.payload.quantity ?? 1);
          if (quantity > 1 && sku.components.some((p) => p.uniqueStockUnitId))
            return { cost: null, final: false };
          components = sku.components.map((p) => ({
            itemVariantId: p.itemVariantId,
            uniqueStockUnitId: p.uniqueStockUnitId,
            requiredQuantity: p.requiredQuantity * quantity,
          }));
        }
        const estimate = await estimateComponentCost(tx, c, componentsSchema.parse(components));
        const materials = body.payload.skuId
          ? await skuMaterialQuote(
              tx,
              c,
              z.uuid().parse(body.payload.skuId),
              z
                .number()
                .int()
                .positive()
                .parse(body.payload.quantity ?? 1),
              eventDate.parse(
                body.payload.date ??
                  new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }),
              ),
              z.record(z.uuid(), optionalDecimal).parse(body.payload.supplyQuantities ?? {}),
            )
          : null;
        return {
          cost: estimate.cost?.toString() ?? null,
          final: estimate.final,
          materials: materials
            ? {
                ...materials,
                cost: materials.cost?.toString() ?? null,
                uses: materials.uses.map((r) => ({ ...r, cost: r.cost?.toString() ?? null })),
              }
            : undefined,
        };
      });
      return Response.json({ status: "ESTIMATE", estimate: result }, { headers: noStore });
    }
    if (body.action === "draft") {
      const input = z
        .object({
          draftId: z.uuid(),
          revision: z.number().int().min(0),
          requestKey: z.uuid(),
          values: z.record(z.string(), z.unknown()),
        })
        .parse(body.payload);
      const kind = z.enum(["COMMERCE_PURCHASE", "COMMERCE_SALE"]).parse(body.kind);
      const result = await current.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`draft:${input.draftId}`},0))`;
        await lockInventoryDomain(tx, c.businessUnitId);
        await checkWorkflowContext(tx, c);
        const prior = await tx.draftSaveReceipt.findUnique({ where: { id: input.requestKey } });
        const hash = fingerprint({ kind, ...input, requestKey: undefined });
        if (prior) {
          if (prior.draftId !== input.draftId || prior.fingerprint !== hash)
            throw new WorkflowError("KEY_REUSED", "途中保存の内容が変わっています。");
          const owner = await tx.workflowDraft.findUniqueOrThrow({ where: { id: input.draftId } });
          if (
            owner.workspaceId !== c.workspaceId ||
            owner.businessUnitId !== c.businessUnitId ||
            owner.operatorId !== c.operatorId
          )
            throw new WorkflowError("CONTEXT_CHANGED", "途中保存を参照できません。");
          return { id: input.draftId, revision: prior.revision };
        }
        const draft = await tx.workflowDraft.findUnique({ where: { id: input.draftId } });
        if (
          draft &&
          (draft.workspaceId !== c.workspaceId ||
            draft.businessUnitId !== c.businessUnitId ||
            draft.operatorId !== c.operatorId ||
            draft.year !== c.year ||
            draft.kind !== kind ||
            draft.archivedAt ||
            draft.revision !== input.revision)
        )
          throw new WorkflowError(
            "CONFLICT",
            "途中保存が更新されています。手元の入力を保持しています。",
          );
        if (!draft && input.revision !== 0)
          throw new WorkflowError("CONFLICT", "途中保存の版を確認してください。");
        const saved = draft
          ? await tx.workflowDraft.update({
              where: { id: draft.id },
              data: { payload: toJson(input.values), revision: { increment: 1 } },
            })
          : await tx.workflowDraft.create({
              data: {
                id: input.draftId,
                workspaceId: c.workspaceId,
                businessUnitId: c.businessUnitId,
                operatorId: c.operatorId,
                year: c.year,
                kind,
                revision: 1,
                baseSnapshot: {
                  reportingEntityId: c.reportingEntityId,
                  values: toJson(input.values),
                },
                payload: toJson(input.values),
              },
            });
        await tx.draftSaveReceipt.create({
          data: {
            id: input.requestKey,
            draftId: saved.id,
            fingerprint: hash,
            revision: saved.revision,
          },
        });
        await tx.auditLog.create({
          data: {
            workspaceId: c.workspaceId,
            userAccountId: c.userAccountId,
            operatorId: c.operatorId,
            action: "commerce.draft.save",
            entityType: "workflow_draft",
            entityId: saved.id,
            requestId: input.requestKey,
            afterJson: { revision: saved.revision, kind },
          },
        });
        return { id: saved.id, revision: saved.revision };
      });
      return Response.json({ status: "SAVED", ...result }, { headers: noStore });
    }
    if (!(body.kind in commerceSchemas))
      throw new WorkflowError("VALIDATION", "この操作を使用できません。");
    const kind = body.kind as CommerceKind;
    const input = commerceSchemas[kind].parse(body.payload);
    if (body.action === "preview") {
      if (!sharedValuationKinds.has(kind))
        throw new WorkflowError("VALIDATION", "この操作には原価確認はありません。");
      return Response.json(
        {
          status: "PREVIEW",
          preview: await captureValuationPreview(() => executeCommerce(current.db, c, kind, input)),
        },
        { headers: noStore },
      );
    }
    const id = await executeCommerce(current.db, c, kind, input);
    for (const path of ["/", "/purchases", "/products", "/sales", "/money", "/inventory"])
      revalidatePath(path);
    return Response.json({ status: "APPLIED", targetId: id }, { headers: noStore });
  } catch (e) {
    if (e instanceof z.ZodError)
      return Response.json(
        {
          status: "REJECTED",
          code: "VALIDATION",
          error: "入力項目を確認してください。",
          fields: Object.fromEntries(
            e.issues.map((issue) => [issue.path.join("."), issue.message]),
          ),
        },
        { status: 400, headers: noStore },
      );
    if (e instanceof WorkflowError)
      return Response.json(
        {
          status: "REJECTED",
          code: e.code,
          error: e.message,
          fields: z.object({ fields: z.record(z.string(), z.string()) }).safeParse(e.detail).data
            ?.fields,
        },
        { status: 409, headers: noStore },
      );
    return Response.json(
      { status: "UNKNOWN", error: "保存結果を確認してください。入力は保持しています。" },
      { status: 500, headers: noStore },
    );
  }
}
