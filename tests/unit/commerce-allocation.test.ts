import { describe, expect, it } from "vitest";
import { allocateCharge, allocateYen, convertMoney } from "@/lib/commerce/allocation";

describe("共通の費用配分", () => {
  it("最大剰余と固定明細順で端数を配り、返金も合計が一致する", () => {
    expect(allocateYen(10n, [1, 1, 1])).toEqual([4n, 3n, 3n]);
    expect(allocateYen(-10n, [1, 1, 1])).toEqual([-4n, -3n, -3n]);
    expect(allocateYen(9007199254740993n, [1, 2])).toEqual([3002399751580331n, 6004799503160662n]);
  });
  it("配送名と独立して金額・数量・重量・容積を使い分ける", () => {
    const lines = [
      { id: "a", amount: "100", quantity: 2, weight: "10", volume: "400" },
      { id: "b", amount: "300", quantity: 2, weight: "30", volume: "100" },
    ];
    expect(allocateCharge(100n, "VALUE", lines).allocations?.map((a) => a.amount)).toEqual([
      25n,
      75n,
    ]);
    expect(allocateCharge(100n, "QUANTITY", lines).allocations?.map((a) => a.amount)).toEqual([
      50n,
      50n,
    ]);
    expect(allocateCharge(100n, "WEIGHT", lines).allocations?.map((a) => a.amount)).toEqual([
      25n,
      75n,
    ]);
    expect(allocateCharge(100n, "VOLUME", lines).allocations?.map((a) => a.amount)).toEqual([
      80n,
      20n,
    ]);
  });
  it("不明額・不足した重量を0円として確定しない", () => {
    const rows = [{ id: "a", amount: "100", quantity: 1, weight: "" }];
    expect(allocateCharge(null, "VALUE", rows).allocations).toBeNull();
    expect(allocateCharge(100n, "WEIGHT", rows).allocations).toBeNull();
    expect(allocateCharge(0n, "WEIGHT", rows).allocations?.[0]?.amount).toBe(0n);
  });
  it("円換算はDecimalで行い、実支払額を保持する", () => {
    expect(convertMoney("0.1", "CNY", "24.27")).toBe(2n);
    expect(convertMoney("3518", "CNY", "24.27", "85382")).toBe(85382n);
    expect(() => convertMoney("10.5", "JPY", "1")).toThrow();
    expect(() => convertMoney("10", "USD", "")).toThrow();
    expect(() => convertMoney("10", "USD", "150", "-1")).toThrow();
    expect(
      allocateCharge(100n, "MANUAL", [
        { id: "a", amount: "100", quantity: 1, manual: "0" },
        { id: "b", amount: "100", quantity: 1, manual: "100" },
      ]).allocations?.map((a) => a.amount),
    ).toEqual([0n, 100n]);
    expect(
      allocateCharge(100n, "MANUAL", [{ id: "a", amount: "100", quantity: 1, manual: "1" }])
        .allocations,
    ).toBeNull();
    expect(
      allocateCharge(-100n, "MANUAL", [{ id: "a", amount: "100", quantity: 1, manual: "100" }])
        .allocations?.[0]?.amount,
    ).toBe(-100n);
  });
});
