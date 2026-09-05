import type { Prisma } from "@/generated/prisma/client";
import { getDb } from "@/lib/db/client";
import { requireSession } from "@/lib/auth/session";

export async function requireInventoryContext(date?: Date) {
  const session = await requireSession();
  const workspaceId = session.userAccount.workspaceId;
  if (!session.activeOperatorId || !session.activeBusinessUnitId || !session.selectedYear) {
    throw new Error("入力者・販売部門・対象年度を選択してください。");
  }
  const db = getDb();
  const [operator, assignment] = await Promise.all([
    db.operator.findFirst({
      where: { id: session.activeOperatorId, workspaceId, active: true },
    }),
    db.businessUnitAssignment.findFirst({
      where: {
        businessUnitId: session.activeBusinessUnitId,
        businessUnit: { workspaceId, active: true },
        fiscalYearProfile: {
          year: session.selectedYear,
          reportingEntity: { workspaceId, active: true },
        },
      },
      include: { fiscalYearProfile: true },
    }),
  ]);
  if (!operator || !assignment) throw new Error("現在の入力コンテキストを使用できません。");
  if (date) {
    if (date < assignment.effectiveFrom || date > assignment.effectiveTo) {
      throw new Error("取引日は選択中の年度・部門の有効期間内にしてください。");
    }
    if (assignment.fiscalYearProfile.status === "LOCKED") {
      throw new Error("ロック済み年度には在庫取引を登録できません。");
    }
  }
  return {
    db,
    session,
    workspaceId,
    operatorId: operator.id,
    businessUnitId: assignment.businessUnitId,
    reportingEntityId: assignment.fiscalYearProfile.reportingEntityId,
    fiscalYear: assignment.fiscalYearProfile,
  };
}

export async function lockInventoryTarget(
  tx: Prisma.TransactionClient,
  variantId: string,
  businessUnitId: string,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${variantId}:${businessUnitId}`}, 0))`;
}

export function tokyoDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("日付を確認してください。");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new Error("日付を確認してください。");
  return date;
}
