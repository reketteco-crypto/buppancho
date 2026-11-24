import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { z } from "zod";
import { runWorkflow } from "@/lib/sales/workflow-runner";
import { historicalPreviewAllowed, plannedOperationOrder } from "@/lib/inventory/valuation-session";
import { checkWorkflowContext, type WorkflowContext } from "@/lib/sales/workflow-context";
import { WorkflowError } from "@/lib/sales/workflow-errors";
import { hasLaterInventoryEvents, effectiveLotReceiptDates } from "@/lib/inventory/event-dates";
import { purchaseBaselineSchema } from "@/lib/inventory/purchase-comparison";
import { nextWorkspaceCode } from "@/lib/inventory/codes";
import { lockInventoryTarget } from "@/lib/inventory/context";
import { averageUnitCost, parseYen } from "@/lib/inventory/money";
import { writeAudit } from "@/lib/audit/write";
import type { purchaseRecordSchema, purchaseEventSchema } from "@/lib/validation/workflow";
const jsonRecord = (value: unknown) => value as Prisma.InputJsonValue;
const dateOnly = (value: string) => new Date(`${value}T00:00:00Z`);

export async function recordPurchase(
  db: PrismaClient,
  c: WorkflowContext,
  payload: z.output<typeof purchaseRecordSchema>,
) {
  return runWorkflow(db, c, payload, "PURCHASE_SAVE", payload.purchasedDate, async (tx) => {
    const date = dateOnly(payload.purchasedDate);
    const [location, supplier, draft] = await Promise.all([
      tx.storageLocation.findFirst({
        where: {
          id: payload.storageLocationId,
          workspaceId: c.workspaceId,
          active: true,
          OR: [{ businessUnitId: null }, { businessUnitId: c.businessUnitId }],
        },
      }),
      tx.counterparty.findFirst({
        where: {
          id: payload.supplierId,
          workspaceId: c.workspaceId,
          type: "SUPPLIER",
          active: true,
        },
      }),
      tx.workflowDraft.findUnique({ where: { id: payload.draftId } }),
    ]);
    if (!location || !supplier)
      throw new WorkflowError("VALIDATION", "仕入先・保管場所を確認してください。");
    if (
      draft &&
      (draft.workspaceId !== c.workspaceId ||
        draft.businessUnitId !== c.businessUnitId ||
        draft.operatorId !== c.operatorId ||
        draft.year !== c.year ||
        draft.kind !== "PURCHASE" ||
        draft.archivedAt)
    )
      throw new WorkflowError(
        "CONFLICT",
        "この途中保存は記録済みか、入力先が異なります。元の記録を確認してください。",
      );
    if ((draft?.revision ?? 0) !== payload.draftRevision)
      throw new WorkflowError(
        "CONFLICT",
        "途中保存が別操作で更新されました。内容を再確認してください。",
      );
    const original = purchaseBaselineSchema.safeParse(draft?.baseSnapshot ?? payload.baseSnapshot);
    if (
      original.success &&
      original.data.reportingEntityId &&
      original.data.reportingEntityId !== c.reportingEntityId
    )
      throw new WorkflowError(
        "OWNERSHIP_CHANGED",
        "入力開始後に申告主体が変更されています。帰属を確認してください。",
      );
    const existingVariantIds = [
      ...new Set(
        payload.lines.flatMap((line) =>
          line.variant.source === "EXISTING" ? [line.variant.variantId] : [],
        ),
      ),
    ];
    const existingVariantCount = await tx.itemVariant.count({
      where: {
        id: { in: existingVariantIds },
        workspaceId: c.workspaceId,
        active: true,
        inventoryItem: { businessUnitId: c.businessUnitId, status: "ACTIVE" },
      },
    });
    if (existingVariantCount !== existingVariantIds.length)
      throw new WorkflowError("VALIDATION", "選択した商品を現在の部門で使用できません。");
    const total = payload.lines.reduce((sum, line) => sum + parseYen(line.amountJpy), 0n);
    if (total !== parseYen(payload.purchaseTotalJpy))
      throw new WorkflowError("VALIDATION", "仕入総額と明細原価の合計が一致しません。");
    const individualCodes = payload.lines.flatMap((line) =>
      line.trackingMode === "UNIQUE" && line.individualCode ? [line.individualCode] : [],
    );
    if (new Set(individualCodes).size !== individualCodes.length)
      throw new WorkflowError("VALIDATION", "個体コードが仕入内で重複しています。");
    if (
      individualCodes.length &&
      (await tx.uniqueStockUnit.count({
        where: { workspaceId: c.workspaceId, individualCode: { in: individualCodes } },
      }))
    )
      throw new WorkflowError("VALIDATION", "すでに使用されている個体コードがあります。");
    const editing = payload.purchaseId
      ? await tx.purchase.findFirst({
          where: {
            id: payload.purchaseId,
            workspaceId: c.workspaceId,
            businessUnitId: c.businessUnitId,
            status: "DRAFT",
          },
        })
      : null;
    if (payload.purchaseId && !editing)
      throw new WorkflowError("VALIDATION", "編集できる仕入下書きが見つかりません。");
    if ((editing?.revision ?? 0) !== payload.revision)
      throw new WorkflowError(
        "CONFLICT",
        "仕入れが別端末で更新されました。最新の保存内容を確認してください。",
      );
    if (editing && editing.reportingEntityId !== c.reportingEntityId)
      throw new WorkflowError("OWNERSHIP_CHANGED", "仕入れの申告主体が変更されています。");

    const variantMap = new Map<string, string>();
    for (const product of payload.newProducts) {
      const itemCode = product.itemCode || (await nextWorkspaceCode(tx, c.workspaceId, "ITEM"));
      const item = await tx.inventoryItem.create({
        data: {
          workspaceId: c.workspaceId,
          businessUnitId: c.businessUnitId,
          itemCode,
          name: product.name,
          category: product.category || null,
          defaultConditionCategory: product.defaultConditionCategory,
          managementType: product.defaultTrackingMode,
          managementCostMethod:
            product.defaultTrackingMode === "QUANTITY" ? "MOVING_AVERAGE" : "SPECIFIC",
          defaultStorageLocationId: payload.storageLocationId,
          memo: product.memo || null,
        },
      });
      for (const variant of product.variants) {
        const variantCode =
          variant.variantCode || (await nextWorkspaceCode(tx, c.workspaceId, "VARIANT"));
        const created = await tx.itemVariant.create({
          data: {
            workspaceId: c.workspaceId,
            inventoryItemId: item.id,
            variantCode,
            attributesJson: jsonRecord(variant.attributes),
          },
        });
        variantMap.set(`${product.clientRef}:${variant.clientRef}`, created.id);
      }
      await writeAudit(tx, {
        requestId: payload.idempotencyKey,
        workspaceId: c.workspaceId,
        userAccountId: c.userAccountId,
        operatorId: c.operatorId,
        action: "inventory_item.create_from_purchase",
        entityType: "inventory_item",
        entityId: item.id,
        after: { itemCode, name: product.name, variantCount: product.variants.length },
      });
    }

    const purchaseCode =
      editing?.purchaseCode ?? (await nextWorkspaceCode(tx, c.workspaceId, "PURCHASE"));
    const uniqueLineCount = payload.lines.filter((line) => line.trackingMode === "UNIQUE").length;
    const data = {
      reportingEntityId: c.reportingEntityId,
      supplierId: payload.supplierId,
      storageLocationId: payload.storageLocationId,
      orderNumber: payload.orderNumber || null,
      purchasedDate: date,
      purchaseTotalJpy: parseYen(payload.purchaseTotalJpy),
      expectedItemCount: uniqueLineCount > 0 ? uniqueLineCount : null,
      memo: payload.memo || null,
      requestKey: payload.idempotencyKey,
    };
    const purchase = editing
      ? await tx.purchase.update({ where: { id: editing.id }, data })
      : await tx.purchase.create({
          data: {
            workspaceId: c.workspaceId,
            businessUnitId: c.businessUnitId,
            purchaseType: "DOMESTIC",
            purchaseCode,
            ...data,
          },
        });
    if (editing) await tx.purchaseLine.deleteMany({ where: { purchaseId: editing.id } });

    for (const line of payload.lines) {
      const itemVariantId =
        line.variant.source === "EXISTING"
          ? line.variant.variantId
          : variantMap.get(`${line.variant.productRef}:${line.variant.variantRef}`);
      if (!itemVariantId)
        throw new WorkflowError("VALIDATION", "新規商品のバリアントを解決できませんでした。");
      if (line.trackingMode === "QUANTITY" && Object.keys(line.commonMeasurements).length) {
        const current = await tx.itemVariant.findUniqueOrThrow({ where: { id: itemVariantId } });
        await tx.itemVariant.update({
          where: { id: itemVariantId },
          data: {
            attributesJson: jsonRecord({
              ...(current.attributesJson as Record<string, string>),
              ...line.commonMeasurements,
            }),
          },
        });
      }
      await tx.purchaseLine.create({
        data: {
          purchaseId: purchase.id,
          itemVariantId,
          trackingMode: line.trackingMode,
          conditionCategory: line.conditionCategory,
          sourceName: line.sourceName,
          sourceUrl: line.sourceUrl || null,
          orderedQuantity: line.quantity,
          productAmountJpy: parseYen(line.amountJpy),
          finalLandedCostJpy: parseYen(line.amountJpy),
          draftIndividualCode: line.trackingMode === "UNIQUE" ? line.individualCode || null : null,
          draftCondition: line.conditionDescription || null,
          draftMeasurementsJson: jsonRecord(
            line.trackingMode === "UNIQUE" ? line.measurements : line.commonMeasurements,
          ),
          draftMemo: line.trackingMode === "UNIQUE" ? line.memo || null : null,
        },
      });
    }
    await writeAudit(tx, {
      requestId: payload.idempotencyKey,
      workspaceId: c.workspaceId,
      userAccountId: c.userAccountId,
      operatorId: c.operatorId,
      action: editing ? "purchase.draft.update" : "purchase.draft.create",
      entityType: "purchase",
      entityId: purchase.id,
      before: editing ? { purchaseTotalJpy: editing.purchaseTotalJpy.toString() } : undefined,
      after: {
        purchaseCode,
        purchaseType: "DOMESTIC",
        purchasedDate: payload.purchasedDate,
        purchaseTotalJpy: payload.purchaseTotalJpy,
        lineCount: payload.lines.length,
      },
    });

    if (draft) {
      await tx.workflowDraft.update({ where: { id: draft.id }, data: { archivedAt: new Date() } });
    } else {
      // A fast confirmation can precede the first autosave. Insert a scoped tombstone
      // so a delayed autosave cannot recreate an already-confirmed draft.
      await tx.workflowDraft.create({
        data: {
          id: payload.draftId,
          workspaceId: c.workspaceId,
          businessUnitId: c.businessUnitId,
          operatorId: c.operatorId,
          year: c.year,
          kind: "PURCHASE",
          baseSnapshot: payload.baseSnapshot ? jsonRecord(payload.baseSnapshot) : undefined,
          payload: { purchaseId: purchase.id },
          archivedAt: new Date(),
        },
      });
    }
    return {
      id: purchase.id,
      detail: {
        purchaseCode: purchase.purchaseCode,
        revision: purchase.revision,
        lineCount: payload.lines.length,
      },
    };
  });
}

export async function recordPurchaseEvent(
  db: PrismaClient,
  c: WorkflowContext,
  input: z.output<typeof purchaseEventSchema>,
  kind: "PURCHASE_RECEIVE" | "PURCHASE_CANCEL",
) {
  return runWorkflow(db, c, input, kind, input.date, async (tx) => {
    const parsed = { ...input, id: input.purchaseId };
    const purchase = await tx.purchase.findFirst({
      where: { id: input.purchaseId, workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
      include: {
        lines: {
          include: {
            itemVariant: { include: { inventoryItem: true } },
            inventoryLot: { include: { uniqueStockUnits: true, stockMovements: true } },
          },
        },
      },
    });
    if (!purchase) throw new WorkflowError("VALIDATION", "仕入れが見つかりません。");
    if (purchase.revision !== input.revision)
      throw new WorkflowError("CONFLICT", "仕入れが更新されました。最新の内容を確認してください。");
    if (purchase.reportingEntityId !== c.reportingEntityId)
      throw new WorkflowError("OWNERSHIP_CHANGED", "仕入れの申告主体が異なります。");
    const receivedDate = dateOnly(input.date);
    if (receivedDate < purchase.purchasedDate)
      throw new WorkflowError("VALIDATION", "処理日は仕入日以降を指定してください。");
    const ids = [...new Set(purchase.lines.map((l) => l.itemVariantId))].sort();
    for (const id of ids) await lockInventoryTarget(tx, id, c.businessUnitId);
    if (kind === "PURCHASE_RECEIVE") {
      if (purchase.status !== "DRAFT")
        throw new WorkflowError("CONFLICT", "この仕入れは入庫済み、または取消済みです。");
      if (!purchase.lines.length)
        throw new WorkflowError("VALIDATION", "入庫する明細がありません。");
      const validLocations = await tx.storageLocation.count({
        where: {
          id: purchase.storageLocationId,
          workspaceId: c.workspaceId,
          active: true,
          OR: [{ businessUnitId: null }, { businessUnitId: c.businessUnitId }],
        },
      });
      if (
        !validLocations ||
        purchase.lines.some(
          (l) =>
            l.itemVariant.inventoryItem.businessUnitId !== c.businessUnitId ||
            l.itemVariant.inventoryItem.workspaceId !== c.workspaceId,
        )
      )
        throw new WorkflowError("CONTEXT_CHANGED", "商品の部門・保管場所を確認してください。");
      const later = await hasLaterInventoryEvents(tx, c, ids, input.date);
      if (later && !historicalPreviewAllowed())
        throw new WorkflowError(
          "VALUATION_REQUIRED",
          "入庫日より後の在庫履歴があります。後日入庫は原価影響確認の実装待ちです。",
        );
      const sum = purchase.lines.reduce((total, line) => total + line.finalLandedCostJpy, 0n);
      if (sum !== purchase.purchaseTotalJpy)
        throw new WorkflowError("VALIDATION", "仕入総額と明細原価の合計が一致しません。");
      if (purchase.purchaseType === "USED_BUNDLE") {
        if (purchase.expectedItemCount !== purchase.lines.length)
          throw new WorkflowError("VALIDATION", "予定点数と個体件数が一致しません。");
        if (
          purchase.lines.some(
            (line) =>
              line.orderedQuantity !== 1 || !line.draftIndividualCode || !line.draftCondition,
          )
        ) {
          throw new WorkflowError(
            "VALIDATION",
            "すべての個体についてコードと状態を入力してください。",
          );
        }
      }
      if (
        purchase.lines.some(
          (line) =>
            line.trackingMode === "UNIQUE" && (line.orderedQuantity !== 1 || !line.draftCondition),
        )
      )
        throw new WorkflowError("VALIDATION", "個体管理の明細は1点固定で、状態の入力が必要です。");
      const operation = await tx.inventoryOperation.create({
        data: {
          workspaceId: c.workspaceId,
          businessUnitId: c.businessUnitId,
          operatorId: c.operatorId,
          operationType: "PURCHASE_RECEIPT",
          valuationOrder: plannedOperationOrder(),
          sourceType: "purchase",
          sourceId: purchase.id,
          idempotencyKey: parsed.idempotencyKey,
          occurredAt: new Date(`${receivedDate.toISOString().slice(0, 10)}T00:00:00+09:00`),
        },
      });
      for (const [index, line] of purchase.lines.entries()) {
        await lockInventoryTarget(tx, line.itemVariantId, c.businessUnitId);
        const lot = await tx.inventoryLot.create({
          data: {
            itemVariantId: line.itemVariantId,
            trackingMode: line.trackingMode,
            purchaseLineId: line.id,
            receivedDate,
            receivedQuantity: line.orderedQuantity,
            remainingQuantity: line.orderedQuantity,
            landedCostTotalJpy: line.finalLandedCostJpy,
            unitCostJpy: averageUnitCost(line.finalLandedCostJpy, line.orderedQuantity),
            costStatus: "FINAL",
            storageLocationId: purchase.storageLocationId,
          },
        });
        let uniqueId: string | null = null;
        if (line.trackingMode === "UNIQUE") {
          const individualCode =
            line.draftIndividualCode || (await nextWorkspaceCode(tx, c.workspaceId, "UNIT"));
          const unit = await tx.uniqueStockUnit.create({
            data: {
              workspaceId: c.workspaceId,
              itemVariantId: line.itemVariantId,
              inventoryLotId: lot.id,
              individualCode,
              condition: line.draftCondition!,
              measurementsJson: line.draftMeasurementsJson ?? {},
              acquisitionCostJpy: line.finalLandedCostJpy,
              storageLocationId: purchase.storageLocationId,
              memo: line.draftMemo,
            },
          });
          uniqueId = unit.id;
        }
        await tx.stockMovement.create({
          data: {
            operationId: operation.id,
            itemVariantId: line.itemVariantId,
            inventoryLotId: lot.id,
            uniqueStockUnitId: uniqueId,
            movementType: "RECEIPT",
            quantity: line.orderedQuantity,
            costTotalJpy: line.finalLandedCostJpy,
            movementAt: operation.occurredAt,
            businessUnitId: c.businessUnitId,
            storageLocationToId: purchase.storageLocationId,
            sourceType: "purchase_line",
            sourceId: line.id,
            idempotencyKey: `${parsed.idempotencyKey}:${index}`,
            operatorId: c.operatorId,
          },
        });
        const balance = await tx.inventoryCostBalance.findUnique({
          where: {
            itemVariantId_businessUnitId_trackingMode: {
              itemVariantId: line.itemVariantId,
              businessUnitId: c.businessUnitId,
              trackingMode: line.trackingMode,
            },
          },
        });
        const quantity = (balance?.quantity ?? 0) + line.orderedQuantity;
        const total = (balance?.carryingCostTotalJpy ?? 0n) + line.finalLandedCostJpy;
        await tx.inventoryCostBalance.upsert({
          where: {
            itemVariantId_businessUnitId_trackingMode: {
              itemVariantId: line.itemVariantId,
              businessUnitId: c.businessUnitId,
              trackingMode: line.trackingMode,
            },
          },
          create: {
            itemVariantId: line.itemVariantId,
            businessUnitId: c.businessUnitId,
            trackingMode: line.trackingMode,
            quantity,
            carryingCostTotalJpy: total,
            averageUnitCostJpy: averageUnitCost(total, quantity),
          },
          update: {
            quantity,
            carryingCostTotalJpy: total,
            averageUnitCostJpy: averageUnitCost(total, quantity),
          },
        });
      }
      await tx.purchase.update({
        where: { id: purchase.id },
        data: { status: "FINALIZED", finalizedAt: new Date() },
      });
    } else {
      if (!input.reason) throw new WorkflowError("VALIDATION", "取消理由を入力してください。");
      await checkWorkflowContext(tx, c, purchase.purchasedDate.toISOString().slice(0, 10));
      if (purchase.status === "CANCELLED")
        throw new WorkflowError("CONFLICT", "この仕入れは取消済みです。");
      if (purchase.status === "DRAFT") {
        await tx.purchase.update({
          where: { id: purchase.id },
          data: { status: "CANCELLED", cancelledAt: new Date() },
        });
      } else {
        const later = await hasLaterInventoryEvents(tx, c, ids, input.date);
        if (later && !historicalPreviewAllowed())
          throw new WorkflowError(
            "VALUATION_REQUIRED",
            "取消日より後の在庫履歴があります。原価影響を確認するまで確定できません。",
          );
        const receiptDates = await effectiveLotReceiptDates(
          tx,
          purchase.lines.flatMap((line) => (line.inventoryLot ? [line.inventoryLot.id] : [])),
        );
        for (const line of purchase.lines) {
          const lot = line.inventoryLot;
          if (
            !lot ||
            lot.remainingQuantity !== lot.receivedQuantity ||
            lot.stockMovements.length !== 1
          ) {
            throw new WorkflowError(
              "VALIDATION",
              "入庫後の移動があるため取消できません。対象商品の在庫履歴を確認してください。",
            );
          }
          if (lot.uniqueStockUnits.some((unit) => unit.status !== "IN_STOCK")) {
            throw new WorkflowError("VALIDATION", "状態が変更された個体を含むため取消できません。");
          }
          if (!receiptDates.has(lot.id) || receiptDates.get(lot.id)! > input.date)
            throw new WorkflowError("VALIDATION", "取消日は入庫日以降を指定してください。");
        }
        const operation = await tx.inventoryOperation.create({
          data: {
            workspaceId: c.workspaceId,
            businessUnitId: c.businessUnitId,
            operatorId: c.operatorId,
            operationType: "PURCHASE_REVERSAL",
            valuationOrder: plannedOperationOrder(),
            sourceType: "purchase",
            sourceId: purchase.id,
            idempotencyKey: parsed.idempotencyKey,
            occurredAt: new Date(`${input.date}T00:00:00+09:00`),
            note: parsed.reason,
          },
        });
        for (const [index, line] of purchase.lines.entries()) {
          const lot = line.inventoryLot!;
          await lockInventoryTarget(tx, line.itemVariantId, c.businessUnitId);
          if (
            await tx.inventoryReservation.count({
              where: {
                status: "RESERVED",
                OR: [{ inventoryLotId: lot.id }, { uniqueStockUnit: { inventoryLotId: lot.id } }],
              },
            })
          )
            throw new WorkflowError(
              "VALIDATION",
              "出品・注文に確保済みの在庫があります。関連出品の終了・返送確認を先に行ってください。",
            );
          const balance = await tx.inventoryCostBalance.findUniqueOrThrow({
            where: {
              itemVariantId_businessUnitId_trackingMode: {
                itemVariantId: line.itemVariantId,
                businessUnitId: c.businessUnitId,
                trackingMode: line.trackingMode,
              },
            },
          });
          if (
            balance.quantity < line.orderedQuantity ||
            balance.carryingCostTotalJpy < line.finalLandedCostJpy
          )
            throw new WorkflowError("VALIDATION", "原価残高が不足するため取消できません。");
          const quantity = balance.quantity - line.orderedQuantity;
          const total = balance.carryingCostTotalJpy - line.finalLandedCostJpy;
          await tx.inventoryCostBalance.update({
            where: { id: balance.id },
            data: {
              quantity,
              carryingCostTotalJpy: total,
              averageUnitCostJpy: quantity === 0 ? 0 : averageUnitCost(total, quantity),
            },
          });
          await tx.inventoryLot.update({ where: { id: lot.id }, data: { remainingQuantity: 0 } });
          if (lot.uniqueStockUnits.length) {
            await tx.uniqueStockUnit.updateMany({
              where: { inventoryLotId: lot.id },
              data: { status: "PURCHASE_CANCELLED" },
            });
          }
          await tx.stockMovement.create({
            data: {
              operationId: operation.id,
              itemVariantId: line.itemVariantId,
              inventoryLotId: lot.id,
              uniqueStockUnitId: lot.uniqueStockUnits[0]?.id,
              movementType: "RECEIPT_REVERSAL",
              quantity: -line.orderedQuantity,
              costTotalJpy: -line.finalLandedCostJpy,
              movementAt: operation.occurredAt,
              businessUnitId: c.businessUnitId,
              storageLocationFromId: purchase.storageLocationId,
              sourceType: "purchase_line",
              sourceId: line.id,
              idempotencyKey: `${parsed.idempotencyKey}:${index}`,
              operatorId: c.operatorId,
              note: parsed.reason,
            },
          });
        }
        await tx.purchase.update({
          where: { id: purchase.id },
          data: { status: "CANCELLED", cancelledAt: new Date() },
        });
      }
    }
    return {
      id: purchase.id,
      detail: { kind, beforeStatus: purchase.status, reason: input.reason, date: input.date },
    };
  });
}
