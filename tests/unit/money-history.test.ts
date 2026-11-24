import { describe, it, expect } from "vitest";
import {
  transactionHistoryRow,
  otherSettlementStatus,
  type HistoryTransaction,
  type HistoryEntry,
} from "@/lib/commerce/money-history-view";
import { moneyReturnHref } from "@/lib/commerce/money-navigation";
const entry = (
  accountId: string,
  amountJpy: bigint,
  accountKind = "STANDARD",
  purpose = "PRINCIPAL",
): HistoryEntry => ({
  id: `${accountId}-${purpose}`,
  accountId,
  amountJpy,
  account: { name: accountId, accountKind },
  purpose,
});
const transaction = (
  entries: HistoryEntry[],
  kind = "TRANSFER",
  amountJpy = 9800n,
  feeJpy = 200n,
): HistoryTransaction => ({
  id: "transaction",
  kind,
  amountJpy,
  feeJpy,
  date: new Date("2026-11-12"),
  memo: null,
  entries,
  reversedBy: null,
  reversesId: null,
  reverses: null,
});
const source = { title: "内容", reference: "番号", href: "/money" };
describe("入出金履歴の金額と操作", () => {
  it("手数料付き振替の全体と振替元・先の実際の増減を表示する", () => {
    const t = transaction([
      entry("メルカリ残高", -9800n),
      entry("メルカリ残高", -200n, "STANDARD", "FEE"),
      entry("銀行", 9800n),
    ]);
    expect(transactionHistoryRow(t, source)).toMatchObject({
      amount: "¥9,800",
      amountLabel: "振替",
      feeLabel: "手数料 ¥200",
      flow: "メルカリ残高 → 銀行",
    });
    expect(transactionHistoryRow(t, source, "メルカリ残高").amount).toBe("−¥10,000");
    expect(transactionHistoryRow(t, source, "銀行").amount).toBe("＋¥9,800");
  });
  it.each([
    [-25n, "−¥25"],
    [5000n, "＋¥5,000"],
  ] as const)("通常口座の符号を明示する", (amount, display) =>
    expect(
      transactionHistoryRow(
        transaction([entry("銀行", amount)], "OTHER_PAYMENT", amount < 0n ? -amount : amount, 0n),
        source,
      ).amount,
    ).toBe(display),
  );
  it("カードの利用・返金・引落と返金取消を表示する", () => {
    expect(
      transactionHistoryRow(
        transaction([entry("カード", -10000n, "CREDIT_CARD")], "PURCHASE_PAYMENT", 10000n, 0n),
        source,
      ),
    ).toMatchObject({ amountLabel: "利用", amount: "¥10,000" });
    const refund = transaction(
      [entry("カード", 1000n, "CREDIT_CARD")],
      "PURCHASE_REFUND",
      1000n,
      0n,
    );
    expect(transactionHistoryRow(refund, source).amountLabel).toBe("返金");
    expect(
      transactionHistoryRow(
        {
          ...refund,
          kind: "REVERSAL",
          reversesId: "refund",
          reverses: { kind: "PURCHASE_REFUND" },
          entries: [entry("カード", -1000n, "CREDIT_CARD")],
        },
        source,
      ).amountLabel,
    ).toBe("返金の取消");
    const debit = transaction(
      [entry("銀行", -10000n), entry("カード", 10000n, "CREDIT_CARD")],
      "TRANSFER",
      10000n,
      0n,
    );
    expect(transactionHistoryRow(debit, source, "カード").amountLabel).toBe("引落");
    expect(transactionHistoryRow(debit, source).amountLabel).toBe("引落");
  });
  it("本人立替と受取、精算の事業口座出金を区別する", () => {
    expect(
      transactionHistoryRow(
        transaction([entry("本人", -10000n, "OWNER_CLEARING")], "PURCHASE_PAYMENT", 10000n, 0n),
        source,
      ).amountLabel,
    ).toBe("本人立替");
    expect(
      transactionHistoryRow(
        transaction([entry("本人", 1000n, "OWNER_CLEARING")], "PURCHASE_REFUND", 1000n, 0n),
        source,
      ).amountLabel,
    ).toBe("本人受取");
    const settlement = transaction(
      [
        entry("銀行", -4000n),
        entry("本人", 4000n, "OWNER_CLEARING"),
        entry("銀行", -100n, "STANDARD", "FEE"),
      ],
      "OWNER_REIMBURSEMENT",
      4000n,
      100n,
    );
    expect(transactionHistoryRow(settlement, source).amount).toBe("−¥4,100");
  });
  it("振替取消の方向を反転し、元記録に取消済みを表示する", () => {
    const t = transaction([
      entry("元", 9800n),
      entry("元", 200n, "STANDARD", "FEE"),
      entry("先", -9800n),
    ]);
    expect(
      transactionHistoryRow(
        { ...t, kind: "REVERSAL", reversesId: "old", reverses: { kind: "TRANSFER" } },
        source,
        "元",
      ),
    ).toMatchObject({ amount: "＋¥10,000", status: "取消", flow: "先 → 元" });
    expect(transactionHistoryRow({ ...t, reversedBy: { id: "reverse" } }, source).canCancel).toBe(
      false,
    );
  });
  it("現在の決済状態を判定する", () => {
    expect(otherSettlementStatus(100n, 0n, false)).toBe("未決済");
    expect(otherSettlementStatus(100n, 40n, false)).toBe("一部決済");
    expect(otherSettlementStatus(100n, 100n, false)).toBe("決済済み");
    expect(otherSettlementStatus(100n, 101n, false)).toBe("差額確認");
    expect(otherSettlementStatus(0n, 0n, false)).toBe("決済不要");
    expect(otherSettlementStatus(0n, 100n, true)).toBe("取消済み");
  });
  it.each([
    "https://example.com/money",
    "//example.com/money",
    "/money/records/a",
    "/money-other",
    "/money#anchor",
  ])("一覧以外への復帰を拒否する", (href) => expect(moneyReturnHref(href)).toBeUndefined());
  it("一覧の条件と展開IDを引き継ぎ、未知の引数を除外する", () =>
    expect(moneyReturnHref("/money?tab=records&page=2&open=id&unknown=removed")).toBe(
      "/money?tab=records&page=2&open=id",
    ));
});
