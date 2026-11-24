import { z } from "zod";

const context = z.object({
  businessUnitId: z.uuid(),
  operatorId: z.uuid(),
  year: z.number().int(),
});
export const listingReturnDraftInputSchema = z.object({
  listingId: z.uuid(),
  caseId: z.uuid(),
  mode: z.enum(["HANDLE", "CLOSE"]),
  date: z.string().max(20),
  reason: z.string().max(1000),
  quantities: z.record(z.string().max(90), z.string().max(12)),
  closeAction: z.enum(["END", "RESUME"]),
  goodsInHand: z.boolean(),
});
export type ListingReturnDraftInput = z.infer<typeof listingReturnDraftInputSchema>;
export const listingReturnSnapshotSchema = z.object({
  type: z.literal("LISTING_RETURN"),
  listingId: z.uuid(),
  caseId: z.uuid(),
  revision: z.number().int().nonnegative(),
  context,
  reportingEntityId: z.uuid(),
  contextLabel: z.string(),
  ownershipLabel: z.string(),
  status: z.string(),
  returnPending: z.boolean(),
  inventoryRevision: z.string(),
  yearStatus: z.string(),
  yearVersion: z.string(),
  members: z.array(
    z.object({
      id: z.uuid(),
      label: z.string(),
      quantity: z.number().int(),
      good: z.number().int(),
      removed: z.number().int(),
      pending: z.number().int(),
      location: z.string(),
      cost: z.string().nullable(),
    }),
  ),
});
export type ListingReturnSnapshot = z.infer<typeof listingReturnSnapshotSchema>;
export const listingReturnDraftFields = {
  draftId: z.uuid().optional(),
  draftRevision: z.number().int().nonnegative().optional(),
  baseSnapshot: listingReturnSnapshotSchema.nullable().optional(),
  draftInput: listingReturnDraftInputSchema.optional(),
};
export const listingReturnRebaseSchema = z.object({
  idempotencyKey: z.uuid(),
  context,
  listingId: z.uuid(),
  draftId: z.uuid(),
  draftRevision: z.number().int().nonnegative(),
  currentFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  choice: z.enum(["LOCAL", "NEW"]),
  input: listingReturnDraftInputSchema,
  baseSnapshot: listingReturnSnapshotSchema.nullable(),
});
export function blankListingReturnInput(
  listingId: string,
  caseId: string,
): ListingReturnDraftInput {
  return {
    listingId,
    caseId,
    mode: "HANDLE",
    date: "",
    reason: "",
    quantities: {},
    closeAction: "END",
    goodsInHand: false,
  };
}
export function listingReturnSnapshotValues(
  snapshot: ListingReturnSnapshot | null,
): Record<string, string> {
  if (!snapshot) return {};
  return {
    status: `${snapshot.returnPending ? "返送確認待ち" : "案件終了・再開済み"}／${snapshot.status === "ENDED" ? "出品終了" : snapshot.status === "COMPLETED" ? "完了記録済み" : snapshot.status === "ACTIVE" ? "完了未記録" : "一時停止など"}`,
    quantity: snapshot.members
      .map(
        (m) =>
          `${m.label}：元 ${m.quantity}・良品 ${m.good}・非良品 ${m.removed}・未処理 ${m.pending}個`,
      )
      .join("\n"),
    cost: snapshot.members
      .map(
        (m) =>
          `${m.label}／${m.location}／管理原価 ${m.cost === null ? "未確認" : `¥${BigInt(m.cost).toLocaleString("ja-JP")}`}`,
      )
      .join("\n"),
    context: `${snapshot.contextLabel}／${snapshot.ownershipLabel}／${snapshot.yearStatus === "LOCKED" ? "年度ロック中" : snapshot.yearStatus === "CLOSING" ? "決算処理中" : "年度未ロック"}`,
  };
}
export function listingReturnPlannedValues(
  input: ListingReturnDraftInput,
  snapshot: ListingReturnSnapshot,
): Record<string, string> {
  const names: Record<string, string> = {
    RESTOCK: "良品",
    DEFECTIVE: "不良",
    DISPOSED: "廃棄",
    LOST: "返送不要・紛失",
  };
  return {
    status:
      input.mode === "HANDLE"
        ? "今回の現物確認"
        : input.closeAction === "END"
          ? "案件終了・良品確保解除を予定"
          : "元構成全量の良品再開を予定",
    quantity: snapshot.members
      .map(
        (m) =>
          `${m.label}：${Object.entries(names)
            .map(([key, name]) => `${name} ${input.quantities[`${m.id}:${key}`] || "未入力"}`)
            .join("／")}`,
      )
      .join("\n"),
    cost: "入力内容と最新の在庫・原価で再確認します。確認しただけでは確定しません。",
    context: `日付 ${input.date || "未入力"}／理由 ${input.reason || "未入力"}／現物確認 ${input.goodsInHand ? "あり" : "未確認"}`,
  };
}
