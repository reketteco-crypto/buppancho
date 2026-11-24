import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { buySchema } from "@/lib/commerce/input";
import { calculatePurchase } from "@/lib/commerce/purchase-calculation";
import { receiptCostPlan } from "@/lib/commerce/receipt-cost";
import { tabularCandidate, invoiceCandidate } from "@/lib/commerce/imports/tabular";
import { rakumartCandidate } from "@/lib/commerce/imports/rakumart";
const base = () => ({
  idempotencyKey: randomUUID(),
  draftId: randomUUID(),
  context: { businessUnitId: randomUUID(), operatorId: randomUUID(), year: 2026 },
  date: "2026-11-10",
  locationId: randomUUID(),
  received: false,
  supplierName: "取引先",
  lines: [
    { clientId: randomUUID(), name: "商品", trackingMode: "QUANTITY", quantity: 3, amount: "1.25" },
  ],
});
describe("汎用購入の計算と取込候補", () => {
  it.each(["", "0", "125"])("配送書類の国際運賃を取り込み、代行手数料（%s）を除外する", (fee) => {
    const result = rakumartCandidate([
      {
        name: "配送依頼書詳細",
        rows: [
          ["P001", "1", "ORDER001", "", "", "商品A", "", "", "2", "100"],
          ["", "", "", "", "", "", "", "", "", "国際運賃（円）", "1,002"],
          ["", "", "", "", "", "", "", "", "", "代行手数料（円）", fee],
        ],
      },
    ]);
    expect(result?.kind).toBe("DELIVERY");
    expect(result?.lines[0]).toMatchObject({
      name: "商品A",
      quantity: 2,
      sourceReference: "ORDER001",
    });
    expect(result?.charges).toEqual([{ name: "国際運賃", amount: "1002", currency: "JPY" }]);
  });
  it("注文書類の手数料は購入費用として取り込む", () => {
    const result = rakumartCandidate([
      {
        name: "注文書",
        rows: [
          ["", "", "", "", "注文番号：ORDER001"],
          ["1", "", "", "商品A", "2", "", "", "", "100"],
          [...Array<string>(15).fill(""), "代行手数料", "12.5"],
        ],
      },
    ]);
    expect(result?.kind).toBe("PURCHASE");
    expect(result?.charges).toEqual([{ name: "代行手数料", amount: "12.5", currency: "CNY" }]);
  });
  it("外貨換算と実支払額で調整し、費用の二重加算をしない", () => {
    const input = buySchema.parse({
      ...base(),
      currency: "USD",
      exchangeRate: "150",
      actualOrderJpy: "1000",
      charges: [{ name: "送料", amount: "2", currency: "USD" }],
    });
    const result = calculatePurchase(input);
    expect(result.total).toBe(1000n);
    expect(result.amounts).toEqual([700n]);
    expect(result.landed).toEqual([1000n]);
    const derived = calculatePurchase({ ...input, exchangeRate: "" });
    expect(derived.total).toBe(1000n);
    expect(derived.rateBasis).toBe("ACTUAL");
  });
  it("不明な金額と0円、税込と税抜を区別する", () => {
    const input = buySchema.parse({
      ...base(),
      currency: "JPY",
      lines: [{ ...base().lines[0], amount: "100" }],
      charges: [{ name: "送料", amount: "" }],
      taxMode: "INCLUDED",
      taxAmount: "30",
    });
    expect(calculatePurchase(input)).toMatchObject({ total: 300n, final: false });
    expect(
      calculatePurchase({ ...input, charges: [{ ...input.charges[0]!, amount: "0" }] }),
    ).toMatchObject({ total: 300n, final: true });
    expect(calculatePurchase({ ...input, charges: [], taxMode: "EXCLUDED" })).toMatchObject({
      total: 330n,
      final: true,
    });
    expect(() => calculatePurchase({ ...input, actualOrderJpy: "300" })).toThrow();
  });
  it("同梱・分割受取の送料は対応する受取だけへ配分する", () => {
    const receipts = [
      { id: "first", quantity: 2, deliveryLineId: "shipment" },
      { id: "second", quantity: 4, deliveryLineId: "shipment" },
      { id: "other", quantity: 4 },
    ];
    expect([
      ...receiptCostPlan(10, 1000n, receipts, [
        { id: "shipment", quantity: 6, cost: 61n },
      ]).values(),
    ]).toEqual([220n, 441n, 400n]);
    const late = [
      { id: "all", quantity: 10, links: [{ deliveryLineId: "shipment", quantity: 6 }] },
    ];
    expect(
      receiptCostPlan(10, 1000n, late, [{ id: "shipment", quantity: 6, cost: 61n }]).get("all"),
    ).toBe(1061n);
  });
  it("取込は入力候補と不足項目だけを返し、少数額を文字列で保つ", () => {
    const result = tabularCandidate([
      {
        name: "購入",
        rows: [
          ["商品名", "数量", "単価", "通貨"],
          ["商品A", "3", "1.25", "USD"],
          ["商品B", "", "", "USD"],
        ],
      },
    ]);
    expect(result.lines[0]).toEqual({ name: "商品A", quantity: 3, amount: "1.25" });
    expect(result.lines[1]!.amount).toBeUndefined();
    expect(result.unresolved.length).toBeGreaterThan(0);
    const invoice = invoiceCandidate([
      "関税 ¥1,002",
      "消費税 2,003円",
      "地方消費税 103円",
      "立替手数料 100円",
    ]);
    expect(invoice.charges.map((c) => c.amount)).toEqual(["1002", "2003", "103", "100"]);
    expect(() => invoiceCandidate(["画像だけ"])).toThrow();
  });
});
