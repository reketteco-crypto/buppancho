export type WorkflowErrorCode =
  | "VALIDATION"
  | "CONFLICT"
  | "YEAR_LOCKED"
  | "CONTEXT_CHANGED"
  | "OWNERSHIP_CHANGED"
  | "VALUATION_REQUIRED"
  | "HISTORY_INCOMPLETE"
  | "STOCK_SHORTAGE"
  | "CANCELLED"
  | "KEY_REUSED"
  | "DUPLICATE";
export class WorkflowError extends Error {
  constructor(
    public code: WorkflowErrorCode,
    message: string,
    public detail?: unknown,
  ) {
    super(message);
  }
}

export function workflowRecoveryMessage(code: string | null): string {
  const messages: Record<WorkflowErrorCode, string> = {
    DUPLICATE:
      "二重登録を防ぎました。出品ID・個体コードなどが既存記録と重複していないか確認してください。",
    VALIDATION:
      "保存は成立していません。入力項目と対象の記録を確認し、修正して再実行してください。",
    CONFLICT:
      "別の操作で内容が更新されました。入力を保持して最新の記録との差分を確認してください。",
    YEAR_LOCKED:
      "対象年度がロックされているため保存できません。入力は保持されています。年度設定を確認してください。",
    CONTEXT_CHANGED: "入力先が変わりました。元の入力者・部門・年度へ戻して再確認してください。",
    OWNERSHIP_CHANGED: "申告主体の帰属を確認できません。在庫移管または旧記録の移行確認が必要です。",
    VALUATION_REQUIRED:
      "原価の確認条件が変わりました。入力を保持したまま影響を再計算し、確認してください。",
    HISTORY_INCOMPLETE:
      "入庫・販売・返品履歴と残高を照合できません。対象履歴を確認してください。現在原価で代用せず、入力を保持しています。",
    STOCK_SHORTAGE: "確保在庫が不足しています。関連する出品・在庫操作を確認してください。",
    CANCELLED: "この要求は取消済みです。必要なら入力を再確認して新しい要求で保存してください。",
    KEY_REUSED:
      "同じ操作キーでは内容を変更できません。元の要求の結果または取消を確認してください。",
  };
  return messages[code as WorkflowErrorCode] ?? messages.VALIDATION;
}
