import type { Prisma } from "@/generated/prisma/client";

const prefix = {
  ITEM: "ITEM",
  VARIANT: "VAR",
  UNIT: "UNIT",
  PURCHASE: "PUR",
  SALES_SKU: "SKU",
} as const;

export async function nextWorkspaceCode(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  kind: keyof typeof prefix,
): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ value: bigint }>>`
    INSERT INTO workspace_sequence (workspace_id, kind, next_value)
    VALUES (${workspaceId}::uuid, ${kind.toLowerCase()}::sequence_kind, 2)
    ON CONFLICT (workspace_id, kind)
    DO UPDATE SET next_value = workspace_sequence.next_value + 1
    RETURNING next_value - 1 AS value
  `;
  const value = rows[0]?.value;
  if (value === undefined) throw new Error("管理コードを採番できませんでした。");
  return `${prefix[kind]}-${value.toString().padStart(6, "0")}`;
}
