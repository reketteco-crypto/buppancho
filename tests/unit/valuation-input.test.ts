import { describe, expect, it } from "vitest";
import { valuationBusinessInput } from "@/lib/inventory/valuation-input";
describe("valuation input and durable receipt boundaries", () => {
  const input = {
    idempotencyKey: "operation",
    valuationFingerprint: "review",
    draftRevision: 1,
    revision: 7,
    date: "2026-10-26",
    rows: [{ quantity: 1 }],
    context: { year: 2026 },
    draftInput: { reason: "確認" },
  };
  it("does not invalidate stock review merely because its draft save was acknowledged", () => {
    expect(valuationBusinessInput({ ...input, draftRevision: 2 })).toEqual(
      valuationBusinessInput(input),
    );
    expect(valuationBusinessInput(input)).not.toHaveProperty("draftRevision");
  });
  it("continues protecting business versions, dates, quantities, contexts and local draft contents", () => {
    const canonical = valuationBusinessInput(input);
    for (const change of [
      { revision: 8 },
      { date: "2026-10-27" },
      { rows: [{ quantity: 2 }] },
      { context: { year: 2027 } },
      { draftInput: { reason: "別入力" } },
    ])
      expect(valuationBusinessInput({ ...input, ...change })).not.toEqual(canonical);
  });
});
