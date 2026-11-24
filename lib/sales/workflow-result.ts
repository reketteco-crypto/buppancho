import { workflowRecoveryMessage } from "@/lib/sales/workflow-errors";

export type WorkflowStatus =
  | "PREPARED"
  | "PROCESSING"
  | "APPLIED"
  | "REJECTED"
  | "CANCELLED"
  | "UNKNOWN";
type Details = {
  code?: string;
  kind?: string;
  id?: string;
  error?: string;
  fields?: Record<string, string>;
  revision?: number;
  payload?: unknown;
  recordId?: string;
};
// Draft saves and read-only previews do not have a durable business-request state.
export type WorkflowFeedback = Details & { status?: WorkflowStatus; saved?: boolean };
export type WorkflowResult = Details &
  (
    | { status: "APPLIED"; saved: true; id: string }
    | { status: "PREPARED"; saved: false }
    | { status: "PROCESSING"; saved: false }
    | { status: "REJECTED"; saved: false; code: string; error: string }
    | { status: "CANCELLED"; saved: false }
    | { status: "UNKNOWN"; saved: false }
  );

export function workflowResult(value: WorkflowFeedback): WorkflowResult {
  switch (value.status) {
    case "APPLIED":
      if (value.id) return { ...value, status: "APPLIED", saved: true, id: value.id };
      // An incomplete response is not proof of failure or permission to resubmit.
      return {
        ...value,
        status: "UNKNOWN",
        saved: false,
        error: "保存先をまだ確認できません。保存結果を照会してください。",
      };
    case "REJECTED":
      return {
        ...value,
        status: "REJECTED",
        saved: false,
        code: value.code ?? "VALIDATION",
        error: value.error ?? workflowRecoveryMessage(value.code ?? null),
      };
    case "CANCELLED":
      return { ...value, status: "CANCELLED", saved: false };
    case "PREPARED":
      return { ...value, status: "PREPARED", saved: false };
    case "PROCESSING":
      return { ...value, status: "PROCESSING", saved: false };
    default:
      return { ...value, status: "UNKNOWN", saved: false };
  }
}
