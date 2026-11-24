import { describe, it, expect } from "vitest";
import { ownerLedger, ownerAvailable, type OwnerData } from "@/lib/commerce/owner-ledger";
const row = (id: string, amount: bigint, date: string, reversed?: string) => ({
  transactionId: id,
  amountJpy: amount,
  transaction: {
    id,
    reversesId: null,
    date: new Date(date),
    createdAt: new Date(date),
    sourceSnapshot: { href: "/purchases/original", name: id },
    reversedBy: reversed ? { date: new Date(reversed) } : null,
  },
});
describe("本人立替の履歴と有効日", () => {
  it("精算済み購入への返金を本人からの返金待ちにし、元の充当を維持する", () => {
    const data = {
      account: null,
      entries: [
        row("purchase", -10000n, "2026-11-01"),
        row("settlement", 10000n, "2026-11-02"),
        row("refund", 1000n, "2026-11-03"),
      ],
      allocations: [
        { settlementId: "settlement", sourceTransactionId: "purchase", amountJpy: 10000n },
      ],
    } as unknown as OwnerData;
    expect(ownerLedger(data, "2026-11-01").unpaid).toBe(10000n);
    expect(ownerLedger(data, "2026-11-02").unpaid).toBe(0n);
    expect(ownerLedger(data, "2026-11-03").receivable).toBe(1000n);
    expect(ownerAvailable(data, "2026-11-03", false)).toEqual([]);
    expect(ownerAvailable(data, "2026-11-03", true)[0]!.id).toBe("refund");
  });
  it("取消前の日付では精算を有効とし、後日記録された充当を遡及入力で使い直さない", () => {
    const data = {
      account: null,
      entries: [
        row("old", -10000n, "2026-11-01"),
        row("new", -2000n, "2026-11-02"),
        row("settlement", 4000n, "2026-11-03", "2026-11-05"),
      ],
      allocations: [{ settlementId: "settlement", sourceTransactionId: "old", amountJpy: 4000n }],
    } as unknown as OwnerData;
    expect(ownerLedger(data, "2026-11-04").unpaid).toBe(8000n);
    expect(ownerLedger(data, "2026-11-05").unpaid).toBe(12000n);
    expect(ownerAvailable(data, "2026-11-02", false).map((r) => r.amount)).toEqual([6000n, 2000n]);
    expect(ownerAvailable(data, "2026-11-05", false).map((r) => r.amount)).toEqual([10000n, 2000n]);
  });
});
