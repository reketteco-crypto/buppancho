import { describe, expect, it } from "vitest";
import { initialSetupSchema, type InitialSetupInput } from "@/lib/validation/setup";

const valid = {
  workspaceName: "物販帳",
  year: 2026,
  operators: [
    { key: "owner", displayName: "事業主" },
    { key: "apparel", displayName: "アパレル担当" },
  ],
  reportingEntities: [{ key: "owner_entity", displayName: "事業主" }],
  fiscalYearProfiles: [
    {
      reportingEntityKey: "owner_entity",
      filingMethod: "BLUE",
      consumptionTaxStatus: "EXEMPT",
      blueDeductionTarget: "DEDUCTION_650K",
      inventoryValuationMethod: "LAST_PURCHASE_COST",
      inventoryValuationMethodNote: "",
    },
  ],
  businessUnits: [
    {
      code: "CHINA_IMPORT",
      name: "中国輸入",
      color: "#2563eb",
      defaultOperatorKey: "owner",
      reportingEntityKey: "owner_entity",
    },
    {
      code: "APPAREL",
      name: "アパレル",
      color: "#db2777",
      defaultOperatorKey: "apparel",
      reportingEntityKey: "owner_entity",
    },
  ],
} as const;

const copy = () => structuredClone(valid) as unknown as InitialSetupInput;

describe("initial setup validation", () => {
  it("accepts multiple departments sharing one annual tax profile", () => {
    expect(initialSetupSchema.safeParse(valid).success).toBe(true);
  });

  it("requires at least one operator, reporting entity, and business unit", () => {
    expect(initialSetupSchema.safeParse({ ...valid, operators: [] }).success).toBe(false);
    expect(initialSetupSchema.safeParse({ ...valid, reportingEntities: [] }).success).toBe(false);
    expect(initialSetupSchema.safeParse({ ...valid, businessUnits: [] }).success).toBe(false);
  });

  it("rejects duplicate names and department codes", () => {
    const input = copy();
    input.operators[1]!.displayName = "事業主";
    input.businessUnits[1]!.code = "CHINA_IMPORT";
    expect(initialSetupSchema.safeParse(input).success).toBe(false);
  });

  it("rejects references to missing operators and reporting entities", () => {
    const input = copy();
    input.businessUnits[0]!.defaultOperatorKey = "missing";
    input.businessUnits[1]!.reportingEntityKey = "missing";
    expect(initialSetupSchema.safeParse(input).success).toBe(false);
  });

  it("rejects a blue deduction target for a white return", () => {
    const input = copy();
    input.fiscalYearProfiles[0]!.filingMethod = "WHITE";
    expect(initialSetupSchema.safeParse(input).success).toBe(false);
  });

  it("requires a note for an unlisted inventory valuation method", () => {
    const input = copy();
    input.fiscalYearProfiles[0]!.inventoryValuationMethod = "OTHER";
    expect(initialSetupSchema.safeParse(input).success).toBe(false);
    input.fiscalYearProfiles[0]!.inventoryValuationMethodNote = "届出済みの評価方法";
    expect(initialSetupSchema.safeParse(input).success).toBe(true);
  });
});
