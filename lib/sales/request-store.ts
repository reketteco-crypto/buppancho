import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { WorkflowContext } from "@/lib/sales/workflow";
import { WorkflowError, workflowRecoveryMessage } from "@/lib/sales/workflow-errors";
import { workflowResult, type WorkflowResult } from "@/lib/sales/workflow-result";
export function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
export function fingerprint(value: unknown): string {
  const ordered = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(ordered)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, ordered(x)]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(ordered(toJson(value))))
    .digest("hex");
}
export function assertRequestOwner(
  row: { workspaceId: string; businessUnitId: string; operatorId: string; userAccountId: string },
  c: WorkflowContext,
) {
  if (
    row.workspaceId !== c.workspaceId ||
    row.businessUnitId !== c.businessUnitId ||
    row.operatorId !== c.operatorId ||
    row.userAccountId !== c.userAccountId
  )
    throw new WorkflowError(
      "CONTEXT_CHANGED",
      "元の入力者・部門へ戻して保存結果を確認してください。",
    );
}
export async function prepareRequest(
  db: PrismaClient,
  c: WorkflowContext,
  key: string,
  kind: string,
  payload: unknown,
) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`workflow:${key}`},0))`;
    const prior = await tx.workflowRequest.findUnique({ where: { id: key } });
    if (prior) {
      assertRequestOwner(prior, c);
      if (prior.kind !== kind || prior.fingerprint !== fingerprint(payload))
        throw new WorkflowError(
          "KEY_REUSED",
          "同じ操作キーで内容を変更できません。元の要求を取り消してから再確認してください。",
        );
      return prior;
    }
    return tx.workflowRequest.create({
      data: {
        id: key,
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        operatorId: c.operatorId,
        userAccountId: c.userAccountId,
        year: c.year,
        kind,
        payload: toJson(payload),
        fingerprint: fingerprint(payload),
      },
    });
  });
}
export async function requestResult(
  db: PrismaClient,
  c: WorkflowContext,
  key: string,
  cancel = false,
): Promise<WorkflowResult> {
  return db.$transaction(async (tx) => {
    const available = await tx.$queryRaw<
      { locked: boolean }[]
    >`SELECT pg_try_advisory_xact_lock(hashtextextended(${`workflow:${key}`},0)) AS locked`;
    const row = await tx.workflowRequest.findUnique({ where: { id: key } });
    if (row) assertRequestOwner(row, c);
    if (!available[0]?.locked) return workflowResult({ status: "PROCESSING" });
    if (!row) {
      if (cancel) {
        await tx.workflowRequest.create({
          data: {
            id: key,
            workspaceId: c.workspaceId,
            businessUnitId: c.businessUnitId,
            operatorId: c.operatorId,
            userAccountId: c.userAccountId,
            year: c.year,
            kind: "CANCELLED",
            fingerprint: "",
            payload: {},
            status: "CANCELLED",
          },
        });
        await tx.auditLog.create({
          data: {
            workspaceId: c.workspaceId,
            userAccountId: c.userAccountId,
            operatorId: c.operatorId,
            action: "workflow.request.cancel",
            entityType: "workflow_request",
            entityId: key,
            requestId: key,
            afterJson: { status: "CANCELLED", received: false },
          },
        });
        return workflowResult({ status: "CANCELLED" });
      }
      return workflowResult({ status: "UNKNOWN" });
    }
    if (cancel && row.status === "PREPARED") {
      await tx.workflowRequest.update({ where: { id: key }, data: { status: "CANCELLED" } });
      await tx.auditLog.create({
        data: {
          workspaceId: c.workspaceId,
          userAccountId: c.userAccountId,
          operatorId: c.operatorId,
          action: "workflow.request.cancel",
          entityType: "workflow_request",
          entityId: key,
          requestId: key,
          afterJson: { status: "CANCELLED" },
        },
      });
      return workflowResult({ status: "CANCELLED" });
    }
    const returnRecord =
      row.status === "APPLIED" && ["RETURN", "REFUND"].includes(row.kind)
        ? await tx.salesReturn.findFirst({
            where: {
              requestKey: row.id,
              salesOrderId: row.targetId ?? "00000000-0000-0000-0000-000000000000",
              salesOrder: { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
            },
            select: { id: true },
          })
        : null;
    return workflowResult({
      status: row.status as "PREPARED" | "APPLIED" | "REJECTED" | "CANCELLED",
      recordId: returnRecord?.id,
      id: row.targetId ?? undefined,
      kind: row.kind,
      payload: row.payload,
      ...(row.status === "REJECTED"
        ? {
            code: row.errorCode ?? "VALIDATION",
            error: row.errorMessage ?? workflowRecoveryMessage(row.errorCode),
            fields: (row.errorFields as Record<string, string> | undefined) ?? undefined,
          }
        : {}),
    });
  });
}

// Invalid input is terminal too: acknowledge it durably, rather than returning
// UNKNOWN and forcing the user to cancel before fixing an ordinary field error.
export async function rejectInvalidRequest(
  db: PrismaClient,
  c: WorkflowContext,
  key: string,
  kind: string,
  payload: unknown,
  fields: Record<string, string>,
) {
  await prepareRequest(db, c, key, kind, payload);
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`workflow:${key}`},0))`;
    const row = await tx.workflowRequest.findUniqueOrThrow({ where: { id: key } });
    assertRequestOwner(row, c);
    if (row.status !== "PREPARED") return;
    await tx.workflowRequest.update({
      where: { id: key },
      data: {
        status: "REJECTED",
        errorCode: "VALIDATION",
        errorMessage: "入力項目を確認してください。",
        errorFields: fields,
      },
    });
  });
  return requestResult(db, c, key);
}
