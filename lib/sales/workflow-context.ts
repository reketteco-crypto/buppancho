import type { Prisma } from "@/generated/prisma/client";
import { WorkflowError } from "@/lib/sales/workflow-errors";
export type WorkflowContext = {
  workspaceId: string;
  businessUnitId: string;
  operatorId: string;
  year: number;
  reportingEntityId: string;
  userAccountId: string;
  sessionId?: string;
};

type Tx = Prisma.TransactionClient;
export function assertSubmittedOrigin(input: unknown, c: WorkflowContext) {
  const expected = (input as { context?: { reportingEntityId?: unknown } })?.context
    ?.reportingEntityId;
  if (expected !== undefined && expected !== c.reportingEntityId)
    throw new WorkflowError(
      "OWNERSHIP_CHANGED",
      "入力開始後に申告主体が変更されています。入力を保持し、元の帰属を確認してください。",
    );
}
const dateOnly = (date: string) => new Date(`${date}T00:00:00Z`);
export async function checkWorkflowContext(tx: Tx, c: WorkflowContext, date?: string) {
  if (c.sessionId) {
    await tx.$queryRaw`SELECT id FROM auth_session WHERE id=${c.sessionId}::uuid FOR SHARE`;
    const session = await tx.authSession.findFirst({
      where: {
        id: c.sessionId,
        userAccountId: c.userAccountId,
        activeOperatorId: c.operatorId,
        activeBusinessUnitId: c.businessUnitId,
        selectedYear: c.year,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        absoluteExpiresAt: { gt: new Date() },
        userAccount: { workspaceId: c.workspaceId, active: true },
      },
    });
    if (!session)
      throw new WorkflowError(
        "CONTEXT_CHANGED",
        "セッションまたは入力先が変わりました。再ログイン・対象確認後に再実行してください。",
      );
  }
  const [assignment, operator] = await Promise.all([
    tx.businessUnitAssignment.findFirst({
      where: {
        businessUnitId: c.businessUnitId,
        businessUnit: { workspaceId: c.workspaceId, active: true },
        fiscalYearProfile: {
          year: c.year,
          reportingEntityId: c.reportingEntityId,
          reportingEntity: { workspaceId: c.workspaceId },
        },
        ...(date
          ? { effectiveFrom: { lte: dateOnly(date) }, effectiveTo: { gte: dateOnly(date) } }
          : {}),
      },
      include: { fiscalYearProfile: true },
    }),
    tx.operator.findFirst({
      where: { id: c.operatorId, workspaceId: c.workspaceId, active: true },
    }),
  ]);
  if (!assignment || !operator)
    throw new WorkflowError(
      "CONTEXT_CHANGED",
      "入力者・部門・年度が変わりました。入力を保持して、対象を選び直してください。",
    );
  await tx.$queryRaw`SELECT id FROM business_unit_assignment WHERE id=${assignment.id}::uuid FOR SHARE`;
  const currentAssignment = await tx.businessUnitAssignment.findUniqueOrThrow({
    where: { id: assignment.id },
  });
  if (currentAssignment.fiscalYearProfileId !== assignment.fiscalYearProfileId)
    throw new WorkflowError(
      "OWNERSHIP_CHANGED",
      "年度別割当が変更されました。帰属を確認してください。",
    );
  // Also serialize against year-lock updates, rather than relying on a stale page value.
  await tx.$queryRaw`SELECT id FROM fiscal_year_profile WHERE id=${assignment.fiscalYearProfile.id}::uuid FOR SHARE`;
  const fiscal = await tx.fiscalYearProfile.findUniqueOrThrow({
    where: { id: assignment.fiscalYearProfile.id },
  });
  if (fiscal.status === "LOCKED")
    throw new WorkflowError("YEAR_LOCKED", "ロック済み年度は変更できません。閲覧のみ可能です。");
}
