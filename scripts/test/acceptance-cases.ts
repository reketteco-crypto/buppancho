import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { PrismaClient } from "@/generated/prisma/client";
import { averageUnitCost } from "@/lib/inventory/money";
import { lockInventoryDomain } from "@/lib/inventory/domain-lock";
import { recordListing, recordCompletion, recordListingEvent } from "@/lib/sales/workflow";
import {
  listingRecordSchema,
  completionRecordSchema,
  listingEventSchema,
} from "@/lib/validation/workflow";

/** Fictional fixtures only. Caller has already guarded the fresh acceptance DB. */
export async function prepareAcceptanceCases(db: PrismaClient) {
  const target = new URL(process.env.DATABASE_URL ?? "");
  if (
    target.hostname !== "127.0.0.1" ||
    target.port !== "55432" ||
    target.pathname !== "/buppancho_phase2_acceptance_20261028_01_test"
  )
    throw new Error("実機受入専用DB以外には確認データを追加できません。");
  const a = await db.businessUnitAssignment.findFirstOrThrow({
    where: { businessUnit: { code: "MOBILE_TEST" } },
    include: { businessUnit: true, fiscalYearProfile: true },
  });
  const user = await db.userAccount.findFirstOrThrow({
    where: { workspaceId: a.businessUnit.workspaceId },
  });
  const c = {
    workspaceId: a.businessUnit.workspaceId,
    businessUnitId: a.businessUnitId,
    operatorId: a.defaultOperatorId!,
    reportingEntityId: a.fiscalYearProfile.reportingEntityId,
    year: 2026,
    userAccountId: user.id,
  };
  const location = await db.storageLocation.findFirstOrThrow({
    where: { businessUnitId: c.businessUnitId },
  });
  async function item(name: string) {
    const saved = await db.inventoryItem.findFirst({
      where: { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId, name },
      include: { variants: true },
    });
    if (saved) return saved.variants[0]!.id;
    const token = randomUUID().toUpperCase();
    const value = await db.inventoryItem.create({
      data: {
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        itemCode: `ACC-${token}`,
        name,
        managementType: "QUANTITY",
        managementCostMethod: "MOVING_AVERAGE",
        defaultStorageLocationId: location.id,
        variants: { create: { workspaceId: c.workspaceId, variantCode: `ACV-${token}` } },
      },
      include: { variants: true },
    });
    return value.variants[0]!.id;
  }
  async function receive(variantId: string, date: string, quantity: number, cost: bigint) {
    await db.$transaction(async (tx) => {
      await lockInventoryDomain(tx, c.businessUnitId);
      const recorded = await tx.inventoryLot.findFirst({
        where: { itemVariantId: variantId, receivedDate: new Date(date) },
      });
      if (recorded) {
        if (recorded.receivedQuantity !== quantity || recorded.landedCostTotalJpy !== cost)
          throw new Error("受入用入庫の既存内容が一致しません。");
        return;
      }
      const previous = await tx.inventoryCostBalance.findFirst({
        where: { itemVariantId: variantId, businessUnitId: c.businessUnitId },
      });
      const lot = await tx.inventoryLot.create({
        data: {
          itemVariantId: variantId,
          trackingMode: "QUANTITY",
          receivedDate: new Date(date),
          receivedQuantity: quantity,
          remainingQuantity: quantity,
          landedCostTotalJpy: cost,
          unitCostJpy: averageUnitCost(cost, quantity),
          storageLocationId: location.id,
        },
      });
      const op = await tx.inventoryOperation.create({
        data: {
          workspaceId: c.workspaceId,
          businessUnitId: c.businessUnitId,
          operatorId: c.operatorId,
          operationType: "ADJUSTMENT_IN",
          sourceType: "acceptance_fixture",
          sourceId: lot.id,
          idempotencyKey: randomUUID(),
          occurredAt: new Date(`${date}T00:00:00+09:00`),
        },
      });
      await tx.stockMovement.create({
        data: {
          operationId: op.id,
          itemVariantId: variantId,
          inventoryLotId: lot.id,
          movementType: "ADJUSTMENT_IN",
          quantity,
          costTotalJpy: cost,
          movementAt: op.occurredAt,
          businessUnitId: c.businessUnitId,
          storageLocationToId: location.id,
          sourceType: "acceptance_fixture",
          sourceId: lot.id,
          idempotencyKey: randomUUID(),
          operatorId: c.operatorId,
          note: "実機受入用の架空在庫",
        },
      });
      const total = (previous?.carryingCostTotalJpy ?? 0n) + cost,
        count = (previous?.quantity ?? 0) + quantity;
      if (previous)
        await tx.inventoryCostBalance.update({
          where: { id: previous.id },
          data: {
            quantity: count,
            carryingCostTotalJpy: total,
            averageUnitCostJpy: averageUnitCost(total, count),
          },
        });
      else
        await tx.inventoryCostBalance.create({
          data: {
            itemVariantId: variantId,
            businessUnitId: c.businessUnitId,
            trackingMode: "QUANTITY",
            quantity: count,
            carryingCostTotalJpy: total,
            averageUnitCostJpy: averageUnitCost(total, count),
          },
        });
    });
  }
  let reference = 900000100000n;
  async function listing(name: string, variantId: string, quantity = 1, date = "2026-10-01") {
    const externalReference = `m${++reference}`;
    const existing = await db.listing.findFirst({
      where: {
        salesSku: { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
        externalListingId: externalReference,
      },
    });
    if (existing) {
      if (existing.displayName !== name)
        throw new Error("受入データの出品IDが別の内容で使われています。");
      return existing.id;
    }
    return recordListing(
      db,
      c,
      listingRecordSchema.parse({
        context: c,
        idempotencyKey: randomUUID(),
        name,
        components: [
          { itemVariantId: variantId, uniqueStockUnitId: null, requiredQuantity: quantity },
        ],
        externalReference,
        price: "980",
        listedDate: date,
        expectedShipping: "200",
        expectedFeeSource: "RATE",
        expectedPacking: "0",
        expectedOther: "0",
      }),
    );
  }
  async function complete(listingId: string, date: string) {
    const saved = await db.salesOrder.findUnique({ where: { completionListingId: listingId } });
    if (saved) return saved.id;
    return recordCompletion(
      db,
      c,
      completionRecordSchema.parse({
        context: c,
        idempotencyKey: randomUUID(),
        listingId,
        revision: 0,
        completedDate: date,
        actualPrice: "980",
        fee: "98",
        shipping: "200",
        packing: "0",
        other: "0",
        purchasedDate: "",
        shippedDate: "",
        shippingMethod: "",
        trackingNumber: "",
        externalOrderId: "",
        memo: "実機受入用の架空取引",
      }),
    );
  }
  async function pending(name: string, quantity: number) {
    const variant = await item(name);
    await receive(variant, "2026-01-01", quantity, 100n * BigInt(quantity));
    const id = await listing(name, variant, quantity);
    const current = await db.listing.findUniqueOrThrow({ where: { id } });
    if (current.returnPending) return `/sales/listings/${id}/return`;
    await recordListingEvent(
      db,
      c,
      listingEventSchema.parse({
        context: c,
        idempotencyKey: randomUUID(),
        listingId: id,
        revision: 0,
        date: "2026-10-02",
        event: "RETURN_PENDING",
        goodsInHand: false,
        reason: "実機受入用：発送後キャンセル・返送待ち",
      }),
    );
    return `/sales/listings/${id}/return`;
  }
  const normal = await db.itemVariant.findFirstOrThrow({
    where: { inventoryItem: { itemCode: "MOBILE-ITEM-001" } },
  });
  const standard = await listing("01 通常完了・キーボード確認", normal.id);
  const partial = await pending("02 部分返送（3個）", 3);
  const resume = await pending("03 全量良品で再開（1個）", 1);
  const split = await item("04 分割返品（3個・原価100円）");
  await receive(split, "2026-01-01", 3, 100n);
  const order = await complete(
    await listing("04 分割返品（3個・原価100円）", split, 3),
    "2026-10-02",
  );
  const back = await item("05 原価影響確認");
  await receive(back, "2026-01-10", 10, 1000n);
  const early = await listing("05 原価影響確認・2月分を後日入力", back, 1, "2026-01-20");
  const later = await listing("05 原価影響確認・後続販売", back, 1, "2026-01-20");
  await receive(back, "2026-03-01", 10, 2000n);
  await complete(later, "2026-03-02");
  // Separate entity keeps the locked previous year from affecting the other cases.
  const entity =
    (await db.reportingEntity.findFirst({
      where: { workspaceId: c.workspaceId, displayName: "年度切替用（仮設定）" },
    })) ??
    (await db.reportingEntity.create({
      data: { workspaceId: c.workspaceId, displayName: "年度切替用（仮設定）" },
    }));
  const unit =
    (await db.businessUnit.findFirst({
      where: { workspaceId: c.workspaceId, code: "ACCEPT_YEAR" },
    })) ??
    (await db.businessUnit.create({
      data: {
        workspaceId: c.workspaceId,
        code: "ACCEPT_YEAR",
        name: "年度切替確認部門",
        color: "#176b52",
      },
    }));
  const yearLocation =
    (await db.storageLocation.findFirst({
      where: { workspaceId: c.workspaceId, code: "YEAR_MAIN" },
    })) ??
    (await db.storageLocation.create({
      data: {
        workspaceId: c.workspaceId,
        businessUnitId: unit.id,
        code: "YEAR_MAIN",
        name: "年度切替の保管場所",
      },
    }));
  for (const year of [2026, 2027]) {
    const profile =
      (await db.fiscalYearProfile.findFirst({ where: { reportingEntityId: entity.id, year } })) ??
      (await db.fiscalYearProfile.create({
        data: {
          reportingEntityId: entity.id,
          year,
          filingMethod: "BLUE",
          consumptionTaxStatus: "EXEMPT",
          blueDeductionTarget: "DEDUCTION_650K",
          inventoryValuationMethod: "SPECIFIC",
          startDate: new Date(`${year}-01-01`),
          endDate: new Date(`${year}-12-31`),
        },
      }));
    const assignment = await db.businessUnitAssignment.findFirst({
      where: { businessUnitId: unit.id, fiscalYearProfileId: profile.id },
    });
    if (!assignment)
      await db.businessUnitAssignment.create({
        data: {
          businessUnitId: unit.id,
          fiscalYearProfileId: profile.id,
          defaultOperatorId: c.operatorId,
          effectiveFrom: profile.startDate,
          effectiveTo: profile.endDate,
        },
      });
  }
  // Reuse the guarded fixture helpers with an explicitly selected separate context.
  c.businessUnitId = unit.id;
  c.reportingEntityId = entity.id;
  location.id = yearLocation.id;
  const yearVariant = await item("06 前年出品・翌年完了");
  await receive(yearVariant, "2026-12-01", 1, 100n);
  const yearListing = await listing("06 前年出品・翌年完了", yearVariant, 1, "2026-12-10");
  await db.fiscalYearProfile.updateMany({
    where: { reportingEntityId: entity.id, year: 2026 },
    data: { status: "LOCKED", lockedAt: new Date() },
  });
  const manifest = {
    workspace: "フェーズ2実機受入（テスト専用）",
    login: "phase2_acceptance",
    cases: {
      normal: `/sales/listings/${standard}/complete`,
      partial,
      resume,
      split: `/sales/orders/${order}/return`,
      backdated: `/sales/listings/${early}/complete`,
      yearSwitch: `/sales/listings/${yearListing}/complete`,
    },
  };
  await mkdir(".tmp/phase2-acceptance", { recursive: true });
  await writeFile(".tmp/phase2-acceptance/cases.json", JSON.stringify(manifest, null, 2));
  console.log("実機受入の架空データ6ケースを準備しました。既存DBは変更していません。");
}
