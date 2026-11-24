import { describe, expect, it, vi } from "vitest";
import {
  effectiveOperationTimeline,
  effectiveOperationDates,
  effectiveLotReceiptDates,
  hasLaterInventoryEvents,
  effectiveSourceDates,
} from "@/lib/inventory/event-dates";

describe("append-only event dates and calculation order", () => {
  const operation = {
    id: "operation",
    occurredAt: new Date("2026-01-01T15:00:00Z"),
    valuationOrder: "10",
  };
  const database = (corrections: object[]) =>
    ({
      eventDateCorrection: { findMany: vi.fn().mockResolvedValue(corrections) },
    }) as unknown as Parameters<typeof effectiveOperationTimeline>[0];
  it("uses Japan date and original order when there is no correction", async () => {
    const result = await effectiveOperationTimeline(database([]), [operation]);
    expect(result.get(operation.id)).toEqual({ date: "2026-01-02", order: "10" });
  });
  it("applies latest append-only date and reviewed order without changing originals", async () => {
    const db = database([
      { operationId: operation.id, effectiveDate: new Date("2026-02-01"), valuationOrder: "4.5" },
      { operationId: operation.id, effectiveDate: new Date("2026-03-01"), valuationOrder: "6.25" },
    ]);
    expect((await effectiveOperationTimeline(db, [operation])).get(operation.id)).toEqual({
      date: "2026-03-01",
      order: "6.25",
    });
    expect((await effectiveOperationDates(db, [operation])).get(operation.id)).toBe("2026-03-01");
    expect(operation.valuationOrder).toBe("10");
  });
  it("does not invent a reviewed order for older correction records", async () => {
    expect(
      (
        await effectiveOperationTimeline(
          database([
            {
              operationId: operation.id,
              effectiveDate: new Date("2026-02-01"),
              valuationOrder: null,
            },
          ]),
          [operation],
        )
      ).get(operation.id)?.order,
    ).toBe("10");
  });
  it("resolves a lot receipt from corrected acquisition events, not the stale lot date", async () => {
    const db = {
      ...database([
        { operationId: operation.id, effectiveDate: new Date("2026-02-01"), valuationOrder: null },
      ]),
      stockMovement: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ inventoryLotId: "lot", operationId: operation.id, operation }]),
      },
    } as unknown as Parameters<typeof effectiveLotReceiptDates>[0];
    expect((await effectiveLotReceiptDates(db, ["lot"])).get("lot")).toBe("2026-02-01");
  });
  it("detects later stock events using corrected dates and scoped variants", async () => {
    const findMany = vi.fn().mockResolvedValue([operation]);
    const db = {
      ...database([
        { operationId: operation.id, effectiveDate: new Date("2026-03-01"), valuationOrder: null },
      ]),
      inventoryOperation: { findMany },
    } as unknown as Parameters<typeof hasLaterInventoryEvents>[0];
    const scope = { workspaceId: "workspace", businessUnitId: "unit" };
    expect(await hasLaterInventoryEvents(db, scope, ["variant"], "2026-02-01")).toBe(true);
    expect(await hasLaterInventoryEvents(db, scope, ["variant"], "2026-03-01")).toBe(false);
    expect(findMany).toHaveBeenCalledWith({
      where: { ...scope, movements: { some: { itemVariantId: { in: ["variant"] } } } },
    });
  });
  const fullContext = {
    workspaceId: "workspace",
    businessUnitId: "unit",
    operatorId: "operator",
    year: 2026,
    reportingEntityId: "entity",
    userAccountId: "account",
    sessionId: "session",
  };
  it("projects only workspace and department when the caller supplies a full workflow context", async () => {
    const findMany = vi.fn().mockResolvedValue([operation]);
    const db = { ...database([]), inventoryOperation: { findMany } } as unknown as Parameters<
      typeof hasLaterInventoryEvents
    >[0];
    await hasLaterInventoryEvents(db, fullContext, ["variant"], "2026-01-01");
    expect(findMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        workspaceId: "workspace",
        businessUnitId: "unit",
        movements: { some: { itemVariantId: { in: ["variant"] } } },
      },
    });
  });
  it("never forwards session, year or operator properties into source event queries", async () => {
    const findMany = vi.fn().mockResolvedValue([{ ...operation, sourceId: "order" }]);
    const db = { ...database([]), inventoryOperation: { findMany } } as unknown as Parameters<
      typeof effectiveSourceDates
    >[0];
    const dates = await effectiveSourceDates(db, fullContext, "sales_order", [
      { id: "order", date: new Date("2026-01-01") },
    ]);
    expect(dates.get("order")).toBe("2026-01-02");
    expect(findMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        workspaceId: "workspace",
        businessUnitId: "unit",
        sourceType: "sales_order",
        sourceId: { in: ["order"] },
        operationType: "SALE_COMPLETION",
      },
    });
  });
});
