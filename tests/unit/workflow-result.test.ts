import { describe, expect, it } from "vitest";
import { workflowResult } from "@/lib/sales/workflow-result";

describe("durable workflow result", () => {
  it("requires a saved target before reporting success", () => {
    expect(workflowResult({ status: "APPLIED", id: "saved-record" })).toMatchObject({
      status: "APPLIED",
      saved: true,
      id: "saved-record",
    });
    expect(workflowResult({ status: "APPLIED" })).toMatchObject({
      status: "UNKNOWN",
      saved: false,
    });
    expect(workflowResult({ saved: true })).toMatchObject({ status: "UNKNOWN", saved: false });
  });
  it("does not turn a request-level payload error into a terminal rejection", () => {
    expect(workflowResult({ status: "PREPARED", code: "KEY_REUSED" })).toMatchObject({
      status: "PREPARED",
      code: "KEY_REUSED",
      saved: false,
    });
    expect(workflowResult({ status: "PROCESSING", saved: true })).toMatchObject({
      status: "PROCESSING",
      saved: false,
    });
  });
  it("keeps rejection reasons and supplies safe recovery text for old requests", () => {
    expect(
      workflowResult({ status: "REJECTED", code: "CONFLICT", error: "元の拒否理由" }),
    ).toMatchObject({ status: "REJECTED", saved: false, error: "元の拒否理由" });
    expect(workflowResult({ status: "REJECTED", code: "YEAR_LOCKED" }).error).toContain("ロック");
    expect(workflowResult({ status: "CANCELLED" })).toMatchObject({
      status: "CANCELLED",
      saved: false,
    });
  });
});
