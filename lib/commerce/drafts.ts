import type { PrismaClient } from "@/generated/prisma/client";
import type { WorkflowContext } from "@/lib/sales/workflow-context";
import { WorkflowError } from "@/lib/sales/workflow-errors";
import { runWorkflow } from "@/lib/sales/workflow-runner";
import { toJson } from "@/lib/sales/request-store";
import { commerceDraftRebaseSchema } from "./input";

export async function readCommerceDraft(
  db: PrismaClient,
  c: WorkflowContext,
  id: string,
  kind: string,
) {
  const draft = await db.workflowDraft.findFirst({
    where: {
      id,
      kind,
      workspaceId: c.workspaceId,
      businessUnitId: c.businessUnitId,
      operatorId: c.operatorId,
      year: c.year,
    },
  });
  if (!draft)
    throw new WorkflowError("CONTEXT_CHANGED", "元の入力者・部門・年度に戻してください。");
  return draft;
}

export async function rebaseCommerceDraft(db: PrismaClient, c: WorkflowContext, raw: unknown) {
  const input = commerceDraftRebaseSchema.parse(raw);
  return runWorkflow(db, c, input, "DRAFT_REBASE", input.date, async (tx) => {
    const current = await tx.workflowDraft.findFirst({
      where: {
        id: input.draftId,
        kind: input.kind,
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        operatorId: c.operatorId,
        year: c.year,
      },
    });
    if (!current || current.revision !== input.revision || current.archivedAt)
      throw new WorkflowError(
        "CONFLICT",
        "保存内容が変わりました。元の記録と手元の入力を再確認してください。",
      );
    const baseline = current.baseSnapshot as { reportingEntityId?: string } | null;
    if (baseline?.reportingEntityId !== c.reportingEntityId)
      throw new WorkflowError("OWNERSHIP_CHANGED", "入力開始時の帰属を確認できません。");
    if (
      await tx.workflowRequest.count({
        where: {
          workspaceId: c.workspaceId,
          businessUnitId: c.businessUnitId,
          id: { not: input.idempotencyKey },
          status: "PREPARED",
          payload: { path: ["draftId"], equals: current.id },
        },
      })
    )
      throw new WorkflowError(
        "CONFLICT",
        "元の確定要求の結果を確認・取消してから選び直してください。",
      );
    const selected = toJson(input.choice === "LOCAL" ? input.values : current.payload);
    await tx.workflowDraft.create({
      data: {
        id: input.idempotencyKey,
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        operatorId: c.operatorId,
        year: c.year,
        kind: input.kind,
        revision: 1,
        baseSnapshot: current.baseSnapshot ?? undefined,
        payload: selected,
      },
    });
    await tx.workflowDraft.update({ where: { id: current.id }, data: { archivedAt: new Date() } });
    return {
      id: input.idempotencyKey,
      detail: {
        originalDraftId: current.id,
        choice: input.choice,
        baseline: current.baseSnapshot,
        saved: current.payload,
        local: input.values,
      },
    };
  });
}
