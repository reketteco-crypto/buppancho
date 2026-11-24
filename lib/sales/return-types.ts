import { z } from "zod";

const text = z.string().max(1000);
export const returnKindSchema = z.enum(["RETURN", "REFUND"]);
export type ReturnKind = z.infer<typeof returnKindSchema>;
const context = z.object({
  businessUnitId: z.uuid(),
  operatorId: z.uuid(),
  year: z.number().int(),
});
export const returnMoneySchema = z.object({
  state: z.enum(["UNKNOWN", "NONE", "AMOUNT"]),
  amount: text,
});
export const returnInputSchema = z.object({
  kind: returnKindSchema,
  orderId: z.uuid(),
  date: text,
  lineId: text,
  quantity: text,
  scope: z.enum(["SALE_UNIT", "COMPONENTS"]).optional(),
  components: z
    .array(
      z.object({
        key: z.uuid(),
        disposition: z.enum(["RESTOCK", "DEFECTIVE", "DISPOSED"]),
        quantity: text,
      }),
    )
    .max(300)
    .optional(),
  dispositions: z.record(z.string(), z.enum(["", "RESTOCK", "DEFECTIVE", "DISPOSED"])),
  salesRefund: returnMoneySchema,
  feeRefund: returnMoneySchema,
  shippingRefund: returnMoneySchema,
  memo: text,
});
export type ReturnInput = z.infer<typeof returnInputSchema>;
export const returnSnapshotSchema = z.object({
  type: z.literal("RETURN"),
  orderId: z.uuid(),
  revision: z.number().int().nonnegative(),
  context,
  reportingEntityId: z.uuid(),
  contextLabel: z.string().optional(),
  ownershipLabel: z.string().optional(),
  completedDate: z.string(),
  status: z.string(),
  inventoryRevision: z.string(),
  yearStatus: z.string(),
  yearVersion: z.string(),
  netSales: z.string(),
  fee: z.string().nullable(),
  shipping: z.string().nullable(),
  packing: z.string().nullable(),
  other: z.string().nullable(),
  cogs: z.string().nullable(),
  finalCost: z.boolean(),
  salesRefund: z.string(),
  feeRefund: z.string(),
  shippingRefund: z.string(),
  restockedCost: z.string(),
  lines: z.array(
    z.object({
      id: z.uuid(),
      label: z.string(),
      quantity: z.number().int(),
      returned: z.number().int(),
      componentOnly: z.boolean().optional(),
      components: z.array(
        z.object({
          key: z.string(),
          label: z.string(),
          quantity: z.number().int(),
          processed: z.number().int(),
          cost: z.string(),
          processedCost: z.string(),
          location: z.string(),
        }),
      ),
    }),
  ),
});
export type ReturnSnapshot = z.infer<typeof returnSnapshotSchema>;
export const returnReviewSchema = z.object({
  context,
  kind: returnKindSchema,
  orderId: z.uuid(),
  draftId: z.uuid().optional(),
});
export const returnPreviewSchema = returnReviewSchema.extend({
  input: returnInputSchema,
  baseSnapshot: returnSnapshotSchema.nullable().optional(),
  valuationPosition: z.union([z.literal("LAST"), z.uuid()]).optional(),
});
export const returnRecordSchema = returnPreviewSchema
  .extend({
    valuationFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    valuationPosition: z.union([z.literal("LAST"), z.uuid()]).optional(),
    idempotencyKey: z.uuid(),
    draftId: z.uuid(),
    draftRevision: z.number().int().nonnegative(),
    orderRevision: z.number().int().nonnegative(),
    confirmationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    baseSnapshot: returnSnapshotSchema.nullable(),
  })
  .superRefine((v, c) => {
    for (const [key, message] of Object.entries(validateReturnInput(v.input).fields))
      c.addIssue({ code: "custom", path: ["input", key], message });
    if (v.input.orderId !== v.orderId || v.input.kind !== v.kind)
      c.addIssue({ code: "custom", path: ["input"], message: "対象実績・操作が一致しません。" });
  });
export const returnRebaseSchema = returnReviewSchema.extend({
  idempotencyKey: z.uuid(),
  draftId: z.uuid(),
  draftRevision: z.number().int().nonnegative(),
  orderRevision: z.number().int().nonnegative(),
  choice: z.enum(["LOCAL", "NEW"]),
  input: returnInputSchema,
  baseSnapshot: returnSnapshotSchema.nullable(),
});
export function blankReturnInput(kind: ReturnKind, orderId: string): ReturnInput {
  return {
    kind,
    orderId,
    date: "",
    lineId: "",
    quantity: "1",
    dispositions: {},
    memo: "",
    salesRefund: { state: "UNKNOWN", amount: "" },
    feeRefund: { state: "UNKNOWN", amount: "" },
    shippingRefund: { state: "UNKNOWN", amount: "" },
  };
}
export const dispositionNames = { RESTOCK: "良品戻し", DEFECTIVE: "不良品", DISPOSED: "廃棄" };
export const returnMoneyLabels = {
  salesRefund: "売上返金",
  feeRefund: "手数料返還",
  shippingRefund: "送料返還",
};
export const returnMoneyKeys = ["salesRefund", "feeRefund", "shippingRefund"] as const;
export function validateReturnInput(input: ReturnInput) {
  const fields: Record<string, string> = {};
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(input.date) ||
    Number.isNaN(new Date(`${input.date}T00:00:00Z`).getTime()) ||
    new Date(`${input.date}T00:00:00Z`).toISOString().slice(0, 10) !== input.date
  )
    fields.date = "存在する日付を入力してください。";
  if (input.kind === "RETURN") {
    if (!z.uuid().safeParse(input.lineId).success)
      fields.lineId = "返品する商品を選択してください。";
    if (input.scope === "COMPONENTS") {
      const seen = new Set<string>();
      for (const [i, row] of (input.components ?? []).entries()) {
        const key = `${row.key}:${row.disposition}`;
        if (seen.has(key)) fields[`components.${i}`] = "同じ構成品・処理は1行にまとめてください。";
        seen.add(key);
        if (!/^(0|[1-9]\d{0,5})$/.test(row.quantity))
          fields[`components.${i}`] = "数量は0以上の整数で入力してください。";
      }
      if (!(input.components ?? []).some((row) => /^[1-9]\d{0,5}$/.test(row.quantity)))
        fields.components = "返品する構成品の数量を1つ以上入力してください。";
    } else if (!/^[1-9]\d{0,5}$/.test(input.quantity))
      fields.quantity = "返品する販売単位数を正の整数で入力してください。";
  } else if (!input.memo.trim()) fields.memo = "返金・返還の理由を入力してください。";
  const amounts = { salesRefund: 0n, feeRefund: 0n, shippingRefund: 0n };
  for (const key of returnMoneyKeys) {
    const entry = input[key];
    if (entry.state === "UNKNOWN")
      fields[key] = "金額を確認するか、返金・返還なしを選択してください。";
    else if (entry.state === "AMOUNT") {
      if (!/^(0|[1-9]\d{0,14})$/.test(entry.amount))
        fields[key] = "0以上の整数円を入力してください。";
      else amounts[key] = BigInt(entry.amount);
    }
  }
  if (
    input.kind === "REFUND" &&
    !Object.keys(fields).length &&
    returnMoneyKeys.every((k) => amounts[k] === 0n)
  )
    fields.salesRefund = "返金・返還額を1つ以上入力してください。";
  return { fields, amounts };
}
const yen = (v: string | null) => (v === null ? "未確認" : `¥${BigInt(v).toLocaleString("ja-JP")}`);
export function returnSnapshotValues(snapshot: ReturnSnapshot | null): Record<string, string> {
  if (!snapshot) return {};
  return {
    status:
      snapshot.status === "COMPLETED"
        ? "完了"
        : snapshot.status === "RETURNED"
          ? "全数返品済み"
          : "処理対象外",
    quantity: snapshot.lines
      .map(
        (l) =>
          `${l.label}：販売${l.quantity}単位・構成品の残り${l.components.reduce((s, c) => s + c.quantity - c.processed, 0)}個`,
      )
      .join("\n"),
    money: `取引金額 ${yen(snapshot.netSales)}／売上返金累計 ${yen(snapshot.salesRefund)}／返金可能 ${yen((BigInt(snapshot.netSales) - BigInt(snapshot.salesRefund)).toString())}\n手数料返還 ${yen(snapshot.feeRefund)}／送料返還 ${yen(snapshot.shippingRefund)}`,
    cost:
      `管理原価 ${yen(snapshot.cogs)}${snapshot.finalCost ? "" : "（暫定）"}\n` +
      snapshot.lines
        .flatMap((l) =>
          l.components.map(
            (c) =>
              `${c.label}：販売時 ${c.quantity}個・処理済み ${c.processed}個・原価 ${yen(c.cost)}／${c.location}`,
          ),
        )
        .join("\n"),
    expenses: `手数料 ${yen(snapshot.fee)}／送料 ${yen(snapshot.shipping)}／梱包費 ${yen(snapshot.packing)}／その他 ${yen(snapshot.other)}`,
    date: snapshot.completedDate,
    ownership: `${snapshot.ownershipLabel ?? "帰属の表示情報は未記録"}／${snapshot.contextLabel ?? `${snapshot.context.year}年度（入力者・部門の表示情報は未記録）`}`,
  };
}
export function returnPlannedValues(
  input: ReturnInput,
  snapshot: ReturnSnapshot,
): Record<string, string> {
  const line = snapshot.lines.find((l) => l.id === input.lineId);
  return {
    status: input.kind === "RETURN" ? "現物返品の予定（未確定）" : "返金のみの予定（在庫変更なし）",
    quantity:
      input.kind === "RETURN"
        ? input.scope === "COMPONENTS"
          ? `${line?.label ?? "商品未選択"}・構成品ごとの返品\n` +
            (input.components ?? [])
              .map(
                (row) =>
                  `${line?.components.find((c) => c.key === row.key)?.label ?? "対象外の商品"}：${dispositionNames[row.disposition]} ${row.quantity || "未入力"}個`,
              )
              .join("\n")
          : `${line?.label ?? "商品未選択"}・${input.quantity || "未入力"}販売単位\n` +
            (line?.components ?? [])
              .map(
                (c) =>
                  `${c.label}：${dispositionNames[input.dispositions[c.key] as keyof typeof dispositionNames] ?? "処理未選択"}`,
              )
              .join("\n")
        : "在庫変更なし",
    money: returnMoneyKeys
      .map(
        (k) =>
          `${returnMoneyLabels[k]}：${input[k].state === "UNKNOWN" ? "未確認" : input[k].state === "NONE" ? "返金・返還なし（0円）" : /^\d+$/.test(input[k].amount) ? yen(input[k].amount) : "金額未入力"}`,
      )
      .join("\n"),
    date: input.date || "未入力",
    memo: input.memo || "なし",
  };
}
