import { describe, it, expect } from "vitest";
import {
  historicalPreviewAllowed,
  plannedMovementCost,
  plannedOutCost,
  plannedOperationOrder,
  valuationSession,
} from "@/lib/inventory/valuation-session";
import { dateCorrectionSchema } from "@/lib/inventory/date-correction";
import { randomUUID } from "node:crypto";
describe("transaction-local valuation session", () => {
  it("uses request-normalized planned costs without leaking into another operation", () => {
    const key = randomUUID();
    expect(historicalPreviewAllowed()).toBe(false);
    valuationSession.run(
      {
        evaluating: true,
        requestKey: key,
        order: "3.5",
        costs: new Map([
          ["pending:0", -153n],
          ["pending:1", 100n],
        ]),
      },
      () => {
        expect(historicalPreviewAllowed()).toBe(true);
        expect(plannedMovementCost(`${key}:0`, -100n)).toBe(-153n);
        expect(plannedMovementCost(`${randomUUID()}:0`, -100n)).toBe(-100n);
        expect(plannedOutCost(100n)).toBe(153n);
        expect(plannedOperationOrder()).toBe("3.5");
      },
    );
    expect(plannedOutCost(100n)).toBe(100n);
    expect(historicalPreviewAllowed()).toBe(false);
  });
  it("requires a real calendar date and a reason for date corrections", () => {
    const input = {
      context: { businessUnitId: randomUUID(), operatorId: randomUUID(), year: 2026 },
      idempotencyKey: randomUUID(),
      operationId: randomUUID(),
      previousDate: "2026-01-01",
      date: "2026-02-30",
      reason: "到着日の訂正",
    };
    expect(dateCorrectionSchema.safeParse(input).success).toBe(false);
    expect(
      dateCorrectionSchema.safeParse({ ...input, date: "2026-02-28", reason: "" }).success,
    ).toBe(false);
    expect(dateCorrectionSchema.safeParse({ ...input, date: "2026-02-28" }).success).toBe(true);
  });
});
