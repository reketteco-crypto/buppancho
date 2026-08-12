import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { getServerEnv } from "@/lib/env";

const globalForDb = globalThis as unknown as { prisma?: PrismaClient };

export function getDb(): PrismaClient {
  if (!globalForDb.prisma) {
    const adapter = new PrismaPg({
      connectionString: getServerEnv().DATABASE_URL,
      connectionTimeoutMillis: 5_000,
      max: 10,
    });
    globalForDb.prisma = new PrismaClient({ adapter });
  }
  return globalForDb.prisma;
}
