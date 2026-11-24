import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  blankReturnInput,
  validateReturnInput,
  returnInputSchema,
  returnPlannedValues,
  returnSnapshotValues,
  type ReturnSnapshot,
} from "@/lib/sales/return-types";
const orderId = randomUUID(),
  lineId = randomUUID(),
  component = randomUUID();
const snapshot: ReturnSnapshot = {
  type: "RETURN",
  orderId,
  revision: 0,
  context: { businessUnitId: randomUUID(), operatorId: randomUUID(), year: 2026 },
  reportingEntityId: randomUUID(),
  completedDate: "2026-10-01",
  status: "COMPLETED",
  inventoryRevision: "0",
  yearStatus: "OPEN",
  yearVersion: "",
  netSales: "1000",
  fee: null,
  shipping: null,
  packing: "0",
  other: "0",
  cogs: "100",
  finalCost: true,
  salesRefund: "0",
  feeRefund: "0",
  shippingRefund: "0",
  restockedCost: "0",
  lines: [
    {
      id: lineId,
      label: "青い服のセット",
      quantity: 1,
      returned: 0,
      components: [
        {
          key: component,
          label: "青い服",
          quantity: 3,
          processed: 0,
          cost: "100",
          processedCost: "0",
          location: "自宅",
        },
      ],
    },
  ],
};
describe("return workflow input", () => {
  it("keeps incomplete drafts and rejects unknown money without coercing it to zero", () => {
    const input = { ...blankReturnInput("RETURN", orderId), lineId, date: "2026-10-12" };
    expect(returnInputSchema.safeParse(input).success).toBe(true);
    expect(validateReturnInput(input).fields.salesRefund).toBeDefined();
    const confirmed = {
      ...input,
      salesRefund: { state: "NONE" as const, amount: "" },
      feeRefund: { state: "NONE" as const, amount: "" },
      shippingRefund: { state: "AMOUNT" as const, amount: "0" },
    };
    expect(validateReturnInput(confirmed).fields).toEqual({});
    expect(validateReturnInput(confirmed).amounts).toEqual({
      salesRefund: 0n,
      feeRefund: 0n,
      shippingRefund: 0n,
    });
  });
  it("validates date, integer quantities, refund reasons and at least one positive refund", () => {
    const input = {
      ...blankReturnInput("REFUND", orderId),
      date: "2026-02-30",
      memo: "確認",
      salesRefund: { state: "AMOUNT" as const, amount: "1.5" },
    };
    expect(validateReturnInput(input).fields.date).toBeDefined();
    expect(validateReturnInput(input).fields.salesRefund).toBeDefined();
    const zero = {
      ...input,
      date: "2026-10-12",
      salesRefund: { state: "NONE" as const, amount: "" },
      feeRefund: { state: "NONE" as const, amount: "" },
      shippingRefund: { state: "NONE" as const, amount: "" },
    };
    expect(validateReturnInput(zero).fields.salesRefund).toContain("1つ以上");
  });
  it("shows Japanese facts and planned input without UUIDs or internal keys", () => {
    const input = {
      ...blankReturnInput("RETURN", orderId),
      lineId,
      dispositions: { [component]: "RESTOCK" as const },
    };
    const values = JSON.stringify(returnPlannedValues(input, snapshot));
    expect(values).toContain("青い服");
    expect(values).toContain("未確認");
    expect(values).not.toContain(component);
    expect(values).not.toContain(lineId);
    expect(returnSnapshotValues(snapshot).quantity).toContain("構成品の残り3個");
  });
});
