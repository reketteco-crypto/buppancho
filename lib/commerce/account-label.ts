export function accountBalanceView(kind: string, balance: bigint) {
  return kind === "CREDIT_CARD"
    ? {
        label: balance > 0n ? "カード返金・預け残高" : "未払額",
        amount: balance < 0n ? -balance : balance,
      }
    : { label: "口座残高", amount: balance };
}
