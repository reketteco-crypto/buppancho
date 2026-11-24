import type { Prisma } from "@/generated/prisma/client";
export async function lockInventoryTarget(
  tx: Prisma.TransactionClient,
  variantId: string,
  businessUnitId: string,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${variantId}:${businessUnitId}`}, 0))`;
}
export async function lockInventoryDomain(tx: Prisma.TransactionClient, businessUnitId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`inventory-domain:${businessUnitId}`},0))`;
}
