import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "@/generated/prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertMasterVersion,
  lockMasterDomain,
  MasterConflict,
} from "@/lib/settings/master-version";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
let db: PrismaClient;
suite("master version boundaries", { timeout: 30000 }, () => {
  beforeAll(() => {
    if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("専用DBが必要です。");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  it("increments revisions even outside the UI and scopes indirect annual ownership", async () => {
    const workspace = await db.workspace.create({ data: { name: `master-${randomUUID()}` } });
    const entity = await db.reportingEntity.create({
      data: { workspaceId: workspace.id, displayName: "検証主体" },
    });
    const fiscal = await db.fiscalYearProfile.create({
      data: {
        reportingEntityId: entity.id,
        year: 2026,
        filingMethod: "BLUE",
        consumptionTaxStatus: "EXEMPT",
        blueDeductionTarget: "NONE",
        inventoryValuationMethod: "SPECIFIC",
        startDate: new Date("2026-01-01Z"),
        endDate: new Date("2026-12-31Z"),
      },
    });
    const unit = await db.businessUnit.create({
      data: { workspaceId: workspace.id, code: "MAIN", name: "版確認部門", color: "#123456" },
    });
    const operator = await db.operator.create({
      data: { workspaceId: workspace.id, displayName: "版確認入力者" },
    });
    const assignment = await db.businessUnitAssignment.create({
      data: {
        businessUnitId: unit.id,
        fiscalYearProfileId: fiscal.id,
        defaultOperatorId: operator.id,
        effectiveFrom: new Date("2026-01-01Z"),
        effectiveTo: new Date("2026-12-31Z"),
      },
    });
    const location = await db.storageLocation.create({
      data: {
        workspaceId: workspace.id,
        businessUnitId: unit.id,
        code: "MAIN",
        name: "版確認場所",
      },
    });
    const supplier = await db.counterparty.create({
      data: { workspaceId: workspace.id, name: "版確認仕入先" },
    });
    const item = await db.inventoryItem.create({
      data: {
        workspaceId: workspace.id,
        businessUnitId: unit.id,
        itemCode: "MASTER-01",
        name: "版確認商品",
        managementType: "QUANTITY",
        managementCostMethod: "MOVING_AVERAGE",
      },
    });
    const channel = await db.salesChannel.create({
      data: { workspaceId: workspace.id, type: "MERCARI", name: "版確認販路" },
    });
    for (const [table, id] of [
      ["workspace", workspace.id],
      ["reporting_entity", entity.id],
      ["fiscal_year_profile", fiscal.id],
      ["operator", operator.id],
      ["business_unit", unit.id],
      ["business_unit_assignment", assignment.id],
      ["storage_location", location.id],
      ["counterparty", supplier.id],
      ["inventory_item", item.id],
      ["sales_channel", channel.id],
    ] as const) {
      await db.$transaction(async (tx) => {
        await lockMasterDomain(tx, workspace.id);
        await assertMasterVersion(tx, workspace.id, table, id, "0");
        await tx.$executeRaw(
          Prisma.sql`UPDATE ${Prisma.raw(table)} SET revision=revision WHERE id=${id}::uuid`,
        );
      });
      await expect(
        db.$transaction((tx) => assertMasterVersion(tx, workspace.id, table, id, "0")),
      ).rejects.toBeInstanceOf(MasterConflict);
      await db.$transaction((tx) => assertMasterVersion(tx, workspace.id, table, id, "1"));
      await expect(
        db.$transaction((tx) => assertMasterVersion(tx, randomUUID(), table, id, "1")),
      ).rejects.toBeInstanceOf(MasterConflict);
    }
  });
  it("allows only one of two stale editors to commit", async () => {
    const workspace = await db.workspace.create({ data: { name: `master-race-${randomUUID()}` } });
    const operator = await db.operator.create({
      data: { workspaceId: workspace.id, displayName: "開始時" },
    });
    const results = await Promise.allSettled(
      ["端末A", "端末B"].map((displayName) =>
        db.$transaction(async (tx) => {
          await lockMasterDomain(tx, workspace.id);
          await assertMasterVersion(tx, workspace.id, "operator", operator.id, "0");
          await tx.operator.update({ where: { id: operator.id }, data: { displayName } });
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await db.operator.findUniqueOrThrow({ where: { id: operator.id } })).revision).toBe(1);
  });
});
