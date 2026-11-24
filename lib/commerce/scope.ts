import type { WorkflowContext } from "@/lib/sales/workflow-context";

export type TransactionScope = Pick<
  WorkflowContext,
  "workspaceId" | "businessUnitId" | "reportingEntityId"
>;

/** Use only for business records that persist all three ownership fields. */
export const transactionScope = (c: TransactionScope) => ({
  workspaceId: c.workspaceId,
  businessUnitId: c.businessUnitId,
  reportingEntityId: c.reportingEntityId,
});
