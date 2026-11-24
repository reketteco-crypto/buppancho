import { describe, expect, it } from "vitest";
import { sameDraftValue } from "@/lib/validation/draft-comparison";

describe("draft three-way comparison", () => {
  it("ignores object key order including nested JSONB values", () => {
    expect(
      sameDraftValue(
        { show: false, product: { name: "商品", memo: "" }, axes: [{ id: "a", name: "色" }] },
        { axes: [{ name: "色", id: "a" }], product: { memo: "", name: "商品" }, show: false },
      ),
    ).toBe(true);
  });
  it("does not hide changes in money, quantity, date, or array order", () => {
    for (const [a, b] of [
      ["0", ""],
      [1, 2],
      ["2026-01-01", "2026-01-02"],
      [
        [1, 2],
        [2, 1],
      ],
    ])
      expect(sameDraftValue(a, b)).toBe(false);
  });
  it("keeps missing, unknown, and zero distinct", () => {
    expect(sameDraftValue(undefined, null)).toBe(false);
    expect(sameDraftValue(null, 0)).toBe(false);
    expect(sameDraftValue({ fee: null }, {})).toBe(false);
  });
});
