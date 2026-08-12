import type { Prisma } from "@/generated/prisma/client";
import { headers } from "next/headers";

type AuditClient = Pick<Prisma.TransactionClient, "auditLog">;

export async function writeAudit(
  db: AuditClient,
  input: {
    workspaceId: string;
    userAccountId?: string | null;
    operatorId?: string | null;
    action: string;
    entityType: string;
    entityId: string;
    before?: Prisma.InputJsonValue;
    after?: Prisma.InputJsonValue;
    requestId?: string | null;
  },
) {
  const requestId = input.requestId ?? (await headers()).get("x-request-id");
  return db.auditLog.create({
    data: {
      workspaceId: input.workspaceId,
      userAccountId: input.userAccountId,
      operatorId: input.operatorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      beforeJson: input.before,
      afterJson: input.after,
      requestId,
    },
  });
}
