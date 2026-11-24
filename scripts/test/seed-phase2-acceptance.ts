import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { prepareAcceptanceCases } from "./acceptance-cases";
import { getDb } from "../../lib/db/client";
import { hashPassword } from "../../lib/auth/password";
import { E2E_PASSWORD } from "./e2e-config";

// Never seed the ordinary application database or overwrite an existing workspace.
const url = new URL(process.env.DATABASE_URL ?? "");
if (
  url.hostname !== "127.0.0.1" ||
  url.port !== "55432" ||
  url.pathname !== "/buppancho_phase2_acceptance_20261028_01_test"
)
  throw new Error("スマホ確認専用のローカルテストDBだけを使用してください。");
const db = getDb();
async function main() {
  if (process.argv.includes("--resume-cases")) {
    if (existsSync(".tmp/phase2-acceptance/cases.json"))
      throw new Error("受入ケースの準備は完了しています。再投入しません。");
    const [workspaces, sessions, drafts] = await Promise.all([
      db.workspace.count({ where: { name: "フェーズ2実機受入（テスト専用）" } }),
      db.authSession.count(),
      db.workflowDraft.count(),
    ]);
    if (workspaces !== 1 || sessions !== 0 || drafts !== 0)
      throw new Error("未着手の受入ケースだけ再開できます。既存データは変更しません。");
    await prepareAcceptanceCases(db);
    return;
  }
  if (await db.workspace.count())
    throw new Error("確認用データは既にあります。初期化・上書きしません。");
  const passwordHash = await hashPassword(E2E_PASSWORD);
  await db.$transaction(async (tx) => {
    const workspace = await tx.workspace.create({
      data: { name: "フェーズ2実機受入（テスト専用）", setupCompletedAt: new Date() },
    });
    await tx.userAccount.create({
      data: {
        workspaceId: workspace.id,
        loginName: "phase2_acceptance",
        normalizedName: "phase2_acceptance",
        passwordHash,
      },
    });
    const operator = await tx.operator.create({
      data: { workspaceId: workspace.id, displayName: "テスト入力者" },
    });
    const entity = await tx.reportingEntity.create({
      data: { workspaceId: workspace.id, displayName: "テスト申告主体（仮設定）" },
    });
    const unit = await tx.businessUnit.create({
      data: {
        workspaceId: workspace.id,
        code: "MOBILE_TEST",
        name: "スマホ確認部門",
        color: "#176b52",
      },
    });
    const fiscal = await tx.fiscalYearProfile.create({
      data: {
        reportingEntityId: entity.id,
        year: 2026,
        filingMethod: "BLUE",
        consumptionTaxStatus: "EXEMPT",
        blueDeductionTarget: "DEDUCTION_650K",
        inventoryValuationMethod: "SPECIFIC",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
      },
    });
    await tx.businessUnitAssignment.create({
      data: {
        businessUnitId: unit.id,
        fiscalYearProfileId: fiscal.id,
        defaultOperatorId: operator.id,
        effectiveFrom: fiscal.startDate,
        effectiveTo: fiscal.endDate,
      },
    });
    const location = await tx.storageLocation.create({
      data: {
        workspaceId: workspace.id,
        businessUnitId: unit.id,
        code: "MAIN",
        name: "テスト保管場所",
      },
    });
    await tx.counterparty.create({
      data: { workspaceId: workspace.id, name: "テスト仕入先", type: "SUPPLIER" },
    });
    // Fictional test settings, not a claim about the actual marketplace fee or tax status.
    await tx.salesChannel.createMany({
      data: [
        {
          workspaceId: workspace.id,
          name: "メルカリ",
          type: "MERCARI",
          defaultFeeRate: "0.100000",
        },
        { workspaceId: workspace.id, name: "ラクマ", type: "RAKUMA" },
        { workspaceId: workspace.id, name: "Yahoo!フリマ", type: "YAHOO_FLEAMARKET" },
        { workspaceId: workspace.id, name: "メルカリShops", type: "MERCARI_SHOPS" },
        { workspaceId: workspace.id, name: "その他", type: "OTHER" },
      ],
    });
    const item = await tx.inventoryItem.create({
      data: {
        workspaceId: workspace.id,
        businessUnitId: unit.id,
        itemCode: "MOBILE-ITEM-001",
        name: "スマホ確認用商品",
        managementType: "QUANTITY",
        managementCostMethod: "MOVING_AVERAGE",
        defaultStorageLocationId: location.id,
        variants: { create: { workspaceId: workspace.id, variantCode: "MOBILE-VAR-001" } },
      },
      include: { variants: true },
    });
    const variant = item.variants[0]!;
    const lot = await tx.inventoryLot.create({
      data: {
        itemVariantId: variant.id,
        trackingMode: "QUANTITY",
        receivedDate: new Date("2026-01-01"),
        receivedQuantity: 50,
        remainingQuantity: 50,
        landedCostTotalJpy: 5000n,
        unitCostJpy: "100",
        storageLocationId: location.id,
      },
    });
    const operation = await tx.inventoryOperation.create({
      data: {
        workspaceId: workspace.id,
        businessUnitId: unit.id,
        operatorId: operator.id,
        operationType: "ADJUSTMENT_IN",
        sourceType: "mobile_test_seed",
        sourceId: lot.id,
        idempotencyKey: randomUUID(),
        occurredAt: new Date("2026-01-01T00:00:00+09:00"),
      },
    });
    await tx.stockMovement.create({
      data: {
        operationId: operation.id,
        itemVariantId: variant.id,
        inventoryLotId: lot.id,
        movementType: "ADJUSTMENT_IN",
        quantity: 50,
        costTotalJpy: 5000n,
        movementAt: operation.occurredAt,
        businessUnitId: unit.id,
        storageLocationToId: location.id,
        sourceType: "mobile_test_seed",
        sourceId: lot.id,
        idempotencyKey: randomUUID(),
        operatorId: operator.id,
        note: "スマートフォン確認用の架空在庫",
      },
    });
    await tx.inventoryCostBalance.create({
      data: {
        itemVariantId: variant.id,
        businessUnitId: unit.id,
        trackingMode: "QUANTITY",
        quantity: 50,
        carryingCostTotalJpy: 5000n,
        averageUnitCostJpy: "100",
      },
    });
  });
  await prepareAcceptanceCases(db);
}
main()
  .finally(() => db.$disconnect())
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "テスト準備に失敗しました。");
    process.exitCode = 1;
  });
