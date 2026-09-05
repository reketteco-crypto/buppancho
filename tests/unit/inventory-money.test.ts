import { describe, expect, it } from "vitest";
import { averageUnitCost, movingAverageOutCost, parseYen } from "@/lib/inventory/money";

describe("inventory money", () => {
  it("parses only non-negative integer yen", () => {
    expect(parseYen("20000")).toBe(20_000n);
    expect(() => parseYen("1.5")).toThrow("整数円");
    expect(() => parseYen("-1")).toThrow("整数円");
  });

  it("calculates a six-decimal unit cost", () => {
    expect(averageUnitCost(24_000n, 20)).toBe("1200.000000");
    expect(averageUnitCost(10_000n, 3)).toBe("3333.333333");
  });

  it("uses moving average and clears all residual cost on full issue", () => {
    expect(movingAverageOutCost(24_000n, 20, 12)).toBe(14_400n);
    expect(movingAverageOutCost(10_000n, 3, 1)).toBe(3_333n);
    expect(movingAverageOutCost(10_000n, 3, 3)).toBe(10_000n);
  });
});
