import { z } from "zod";

const referenceKey = z.string().trim().min(1).max(80);
const displayName = z.string().trim().min(1, "表示名を入力してください。").max(50);
const taxStatus = z.enum(["EXEMPT", "TAXABLE", "INVOICE_REGISTERED"]);
const valuationMethod = z.enum(["SPECIFIC", "LAST_PURCHASE_COST", "GROSS_AVERAGE", "OTHER"]);
const blueDeductionTarget = z.enum(["NONE", "DEDUCTION_100K", "DEDUCTION_550K", "DEDUCTION_650K"]);

export const initialSetupSchema = z
  .object({
    workspaceName: z.string().trim().min(1, "ワークスペース名を入力してください。").max(100),
    year: z.number().int().min(2000).max(2200),
    operators: z
      .array(z.object({ key: referenceKey, displayName }))
      .min(1, "入力者を1件以上登録してください。"),
    reportingEntities: z
      .array(z.object({ key: referenceKey, displayName }))
      .min(1, "申告主体を1件以上登録してください。"),
    fiscalYearProfiles: z.array(
      z.object({
        reportingEntityKey: referenceKey,
        filingMethod: z.enum(["BLUE", "WHITE"]),
        consumptionTaxStatus: taxStatus,
        blueDeductionTarget,
        inventoryValuationMethod: valuationMethod,
        inventoryValuationMethodNote: z.string().trim().max(200).optional(),
      }),
    ),
    businessUnits: z
      .array(
        z.object({
          code: z
            .string()
            .trim()
            .min(1, "部門コードを入力してください。")
            .max(40)
            .regex(/^[A-Z0-9_]+$/, "部門コードは大文字英数字とアンダースコアで入力してください。"),
          name: z.string().trim().min(1, "販売部門名を入力してください。").max(80),
          color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "表示色を確認してください。"),
          defaultOperatorKey: referenceKey,
          reportingEntityKey: referenceKey,
        }),
      )
      .min(1, "販売部門を1件以上登録してください。"),
  })
  .superRefine((data, ctx) => {
    const checkUnique = (values: string[], path: string, message: string) => {
      const seen = new Set<string>();
      values.forEach((value, index) => {
        const normalized = value.trim();
        if (seen.has(normalized)) {
          ctx.addIssue({ code: "custom", path: [path, index], message });
        }
        seen.add(normalized);
      });
    };

    checkUnique(
      data.operators.map((item) => item.key),
      "operators",
      "入力者の内部参照が重複しています。",
    );
    checkUnique(
      data.operators.map((item) => item.displayName),
      "operators",
      "入力者の表示名が重複しています。",
    );
    checkUnique(
      data.reportingEntities.map((item) => item.key),
      "reportingEntities",
      "申告主体の内部参照が重複しています。",
    );
    checkUnique(
      data.reportingEntities.map((item) => item.displayName),
      "reportingEntities",
      "申告主体の表示名が重複しています。",
    );
    checkUnique(
      data.businessUnits.map((item) => item.code),
      "businessUnits",
      "販売部門コードが重複しています。",
    );
    checkUnique(
      data.businessUnits.map((item) => item.name),
      "businessUnits",
      "販売部門名が重複しています。",
    );
    checkUnique(
      data.fiscalYearProfiles.map((item) => item.reportingEntityKey),
      "fiscalYearProfiles",
      "同じ申告主体の年度設定が重複しています。",
    );

    const operatorKeys = new Set(data.operators.map((item) => item.key));
    const entityKeys = new Set(data.reportingEntities.map((item) => item.key));
    const profileKeys = new Set(data.fiscalYearProfiles.map((item) => item.reportingEntityKey));

    data.reportingEntities.forEach((item, index) => {
      if (!profileKeys.has(item.key)) {
        ctx.addIssue({
          code: "custom",
          path: ["reportingEntities", index],
          message: "申告主体の年度設定がありません。",
        });
      }
    });
    data.fiscalYearProfiles.forEach((item, index) => {
      if (!entityKeys.has(item.reportingEntityKey)) {
        ctx.addIssue({
          code: "custom",
          path: ["fiscalYearProfiles", index],
          message: "年度設定の申告主体が見つかりません。",
        });
      }
      if (item.filingMethod === "WHITE" && item.blueDeductionTarget !== "NONE") {
        ctx.addIssue({
          code: "custom",
          path: ["fiscalYearProfiles", index, "blueDeductionTarget"],
          message: "白色申告の青色控除目標は「なし」にしてください。",
        });
      }
      if (item.inventoryValuationMethod === "OTHER" && !item.inventoryValuationMethodNote) {
        ctx.addIssue({
          code: "custom",
          path: ["fiscalYearProfiles", index, "inventoryValuationMethodNote"],
          message: "その他の棚卸評価方法を入力してください。",
        });
      }
    });
    data.businessUnits.forEach((item, index) => {
      if (!operatorKeys.has(item.defaultOperatorKey)) {
        ctx.addIssue({
          code: "custom",
          path: ["businessUnits", index, "defaultOperatorKey"],
          message: "販売部門の主な入力者が見つかりません。",
        });
      }
      if (!entityKeys.has(item.reportingEntityKey)) {
        ctx.addIssue({
          code: "custom",
          path: ["businessUnits", index, "reportingEntityKey"],
          message: "販売部門の申告主体が見つかりません。",
        });
      }
    });
  });

export type InitialSetupInput = z.infer<typeof initialSetupSchema>;

export function formDataToSetupInput(formData: FormData): InitialSetupInput {
  const raw = formData.get("setupPayload");
  if (typeof raw !== "string") throw new Error("初期設定の入力を確認してください。");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("初期設定の入力形式が正しくありません。");
  }
  return initialSetupSchema.parse(value);
}
