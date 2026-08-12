import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { AppShell } from "@/components/layout/app-shell";

export const dynamic = "force-dynamic";

export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const workspaceId = session.userAccount.workspaceId;
  const db = getDb();
  const [operators, assignments] = await Promise.all([
    db.operator.findMany({ where: { workspaceId, active: true }, orderBy: { createdAt: "asc" } }),
    db.businessUnitAssignment.findMany({
      where: {
        businessUnit: { workspaceId, active: true },
        fiscalYearProfile: { reportingEntity: { workspaceId } },
      },
      include: { businessUnit: true, fiscalYearProfile: { select: { year: true } } },
      orderBy: [{ fiscalYearProfile: { year: "desc" } }, { businessUnit: { createdAt: "asc" } }],
    }),
  ]);
  return (
    <AppShell
      workspaceName={session.userAccount.workspace.name}
      operators={operators}
      assignments={assignments.map((item) => ({
        year: item.fiscalYearProfile.year,
        businessUnit: item.businessUnit,
        defaultOperatorId: item.defaultOperatorId,
      }))}
      activeOperatorId={session.activeOperatorId}
      activeBusinessUnitId={session.activeBusinessUnitId}
      selectedYear={session.selectedYear}
    >
      {children}
    </AppShell>
  );
}
