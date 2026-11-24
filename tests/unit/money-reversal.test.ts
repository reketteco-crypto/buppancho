import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { moneySchema } from "@/lib/commerce/input";
import { executeMoney } from "@/lib/commerce/money";

describe("入出金取消の対象指定", () => {
  const c = {
    workspaceId: randomUUID(),
    businessUnitId: randomUUID(),
    reportingEntityId: randomUUID(),
    operatorId: randomUUID(),
    userAccountId: randomUUID(),
    year: 2026,
  };
  const raw = {
    idempotencyKey: randomUUID(),
    context: c,
    date: "2026-11-15",
    kind: "REVERSAL",
    memo: "取消理由",
  };
  it("対象なしの取消を入力検証で拒否し、通常の資金移動は対象IDを要求しない", () => {
    const parsed = moneySchema.safeParse(raw);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.path).toEqual(["reversesId"]);
    expect(moneySchema.safeParse({ ...raw, reversesId: randomUUID() }).success).toBe(true);
    expect(moneySchema.safeParse({ ...raw, kind: "OWNER_CONTRIBUTION" }).success).toBe(true);
  });
  it("検証を通さず呼ばれても対象なしでDB照会や取消をしない", async () => {
    const findFirst = vi.fn();
    const tx = { moneyTransaction: { findFirst } } as unknown as Parameters<typeof executeMoney>[0];
    const input = {
      ...raw,
      kind: "REVERSAL",
      amount: "0",
      fee: "",
      accountId: "",
      accountRevision: 0,
      toAccountId: "",
      toAccountRevision: 0,
    } as Parameters<typeof executeMoney>[2];
    await expect(executeMoney(tx, c, input)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(findFirst).not.toHaveBeenCalled();
  });
});
