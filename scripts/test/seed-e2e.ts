import { getDb } from "../../lib/db/client";
import { hashPassword } from "../../lib/auth/password";
import { normalizeLoginName } from "../../lib/auth/token";
import { E2E_PASSWORD, E2E_READY_LOGIN, E2E_SETUP_LOGIN } from "./e2e-config";

const db = getDb();

async function createAccount(workspaceId: string, loginName: string, passwordHash: string) {
  return db.userAccount.create({
    data: {
      workspaceId,
      loginName,
      normalizedName: normalizeLoginName(loginName),
      passwordHash,
    },
  });
}

async function main() {
  if (await db.workspace.count()) {
    throw new Error("E2E用DBが空ではありません。テスト用Composeをdown -vして作り直してください。");
  }
  const passwordHash = await hashPassword(E2E_PASSWORD);

  const readyWorkspace = await db.workspace.create({
    data: { name: "物販帳E2E", setupCompletedAt: new Date() },
  });
  await createAccount(readyWorkspace.id, E2E_READY_LOGIN, passwordHash);
  const operator = await db.operator.create({
    data: { workspaceId: readyWorkspace.id, displayName: "E2E入力者" },
  });
  const entity = await db.reportingEntity.create({
    data: { workspaceId: readyWorkspace.id, displayName: "E2E申告主体" },
  });
  const fiscal = await db.fiscalYearProfile.create({
    data: {
      reportingEntityId: entity.id,
      year: 2026,
      filingMethod: "BLUE",
      consumptionTaxStatus: "EXEMPT",
      blueDeductionTarget: "DEDUCTION_650K",
      inventoryValuationMethod: "SPECIFIC",
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      endDate: new Date("2026-12-31T00:00:00.000Z"),
    },
  });
  const businessUnit = await db.businessUnit.create({
    data: { workspaceId: readyWorkspace.id, code: "E2E", name: "E2E販売部門", color: "#176b52" },
  });
  await db.businessUnitAssignment.create({
    data: {
      businessUnitId: businessUnit.id,
      fiscalYearProfileId: fiscal.id,
      defaultOperatorId: operator.id,
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      effectiveTo: new Date("2026-12-31T00:00:00.000Z"),
    },
  });
  await db.storageLocation.create({
    data: {
      workspaceId: readyWorkspace.id,
      businessUnitId: businessUnit.id,
      code: "MAIN",
      name: "主保管場所",
    },
  });
  await db.storageLocation.create({
    data: {
      workspaceId: readyWorkspace.id,
      businessUnitId: businessUnit.id,
      code: "SUB",
      name: "副保管場所",
    },
  });
  await db.counterparty.create({
    data: { workspaceId: readyWorkspace.id, name: "E2E仕入先", type: "SUPPLIER" },
  });

  // 50件固定ページングの境界を、毎回同じ空DBから検証するためのデータ。
  for (let index = 1; index <= 51; index += 1) {
    const serial = String(index).padStart(3, "0");
    await db.inventoryItem.create({
      data: {
        workspaceId: readyWorkspace.id,
        businessUnitId: businessUnit.id,
        itemCode: `PAGE-${serial}`,
        name: `ページング商品-${serial}`,
        managementType: "QUANTITY",
        managementCostMethod: "MOVING_AVERAGE",
        variants: {
          create: {
            workspaceId: readyWorkspace.id,
            variantCode: `PAGE-VAR-${serial}`,
            attributesJson: { テスト分類: "ページング" },
          },
        },
      },
    });
  }

  for (const project of ["desktop", "mobile"]) {
    const setupWorkspace = await db.workspace.create({ data: { name: `初期設定E2E-${project}` } });
    await createAccount(setupWorkspace.id, `${E2E_SETUP_LOGIN}_${project}`, passwordHash);
  }
}

main()
  .finally(() => db.$disconnect())
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
