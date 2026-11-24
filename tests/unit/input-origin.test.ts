import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertInputOrigin } from "@/lib/sales/input-origin";
import { assertSubmittedOrigin, type WorkflowContext } from "@/lib/sales/workflow-context";
describe("frozen input attribution", () => {
  const c: WorkflowContext = {
    workspaceId: randomUUID(),
    businessUnitId: randomUUID(),
    operatorId: randomUUID(),
    reportingEntityId: randomUUID(),
    year: 2026,
    userAccountId: randomUUID(),
  };
  it("rejects a new entity even when department, operator and year are unchanged", () => {
    const baseline = { type: "INPUT_ORIGIN", ...c };
    expect(() => assertInputOrigin(baseline, c)).not.toThrow();
    expect(() => assertInputOrigin(baseline, { ...c, reportingEntityId: randomUUID() })).toThrow(
      /申告主体/,
    );
    expect(() => assertInputOrigin(baseline, { ...c, businessUnitId: randomUUID() })).toThrow(
      /入力先/,
    );
  });
  it("validates the submitted attribution without inventing an old missing baseline", () => {
    expect(() =>
      assertSubmittedOrigin({ context: { reportingEntityId: randomUUID() } }, c),
    ).toThrow(/申告主体/);
    expect(() => assertInputOrigin(null, c)).not.toThrow();
  });
});
