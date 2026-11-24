import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { returnProgress } from "@/lib/sales/listing-return-domain";
import { listingReturnSchema, listingReturnCloseSchema } from "@/lib/validation/workflow";
describe("listing-owned partial return", () => {
  it("keeps good and unresolved quantities reserved", () => {
    expect(
      returnProgress(3, [
        { disposition: "RESTOCK", quantity: 1 },
        { disposition: "DEFECTIVE", quantity: 1 },
      ]),
    ).toEqual({ processed: 2, pending: 1, good: 1, removed: 1, allGood: false });
  });
  it("allows resume only when original quantities are all confirmed good", () => {
    expect(
      returnProgress(3, [
        { disposition: "RESTOCK", quantity: 1 },
        { disposition: "RESTOCK", quantity: 2 },
      ]).allGood,
    ).toBe(true);
    expect(
      returnProgress(3, [
        { disposition: "RESTOCK", quantity: 2 },
        { disposition: "LOST", quantity: 1 },
      ]).allGood,
    ).toBe(false);
  });
  it.each([0, -1, 1.5, 4])("rejects invalid quantity %s", (quantity) => {
    expect(() => returnProgress(3, [{ disposition: "RESTOCK", quantity }])).toThrow();
  });
  it("rejects duplicate handling fields and requires explicit closure confirmation", () => {
    const row = { memberId: randomUUID(), disposition: "RESTOCK", quantity: 1 };
    const base = {
      idempotencyKey: randomUUID(),
      context: { businessUnitId: randomUUID(), operatorId: randomUUID(), year: 2026 },
      listingId: randomUUID(),
      revision: 0,
      date: "2026-10-25",
      reason: "現物確認",
    };
    expect(listingReturnSchema.safeParse({ ...base, rows: [row, row] }).success).toBe(false);
    expect(listingReturnSchema.safeParse({ ...base, rows: [row] }).success).toBe(true);
    expect(
      listingReturnCloseSchema.safeParse({ ...base, action: "RESUME", goodsInHand: false }).success,
    ).toBe(false);
  });
});
