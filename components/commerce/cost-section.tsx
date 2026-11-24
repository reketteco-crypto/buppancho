import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import type { commerceContext } from "@/lib/commerce/view";
import { todayTokyo } from "@/lib/commerce/view";
import { allocationLabels, type AllocationMethod } from "@/lib/commerce/allocation";
import { PurchaseCostEditor } from "./cost-form";
import { SettlementSection } from "./settlement-section";
import { CostEntry } from "./cost-entry";
import { purchaseLineBases } from "@/lib/commerce/purchase-history";
import { costBasesSchema } from "@/lib/commerce/input";

type Charge = Prisma.PurchaseChargeGetPayload<{
  include: { allocations: true; supersededBy: true };
}>;
export async function PurchaseCosts({
  c,
  source,
  lines,
  charges,
  readOnly = false,
}: {
  c: Awaited<ReturnType<typeof commerceContext>>;
  source: { purchaseId?: string; deliveryId?: string; revision: number };
  lines: {
    id: string;
    name: string;
    itemVariantId: string | null;
    weight: string;
    volume: string;
  }[];
  charges: Charge[];
  readOnly?: boolean;
}) {
  const bases = readOnly ? {} : await purchaseLineBases(c.db, c, todayTokyo(), lines);
  const form = (refund: boolean, ch?: Charge) => {
    const snapshot = ch?.basisSnapshot as { bases?: unknown } | null;
    const saved = costBasesSchema.safeParse(snapshot?.bases).data ?? {};
    const original = ch
      ? Object.fromEntries(
          lines.map((l) => [l.id, { weight: l.weight, volume: l.volume, manual: "" }]),
        )
      : bases;
    return readOnly ? null : (
      <PurchaseCostEditor
        key={`${source.revision}:${ch?.id || "new"}:${refund}`}
        refund={refund}
        lines={lines}
        initial={{
          context: c.context,
          idempotencyKey: randomUUID(),
          date: todayTokyo(),
          ...source,
          reason: "",
          additionalCharges: [],
          bases: { ...original, ...saved },
          receiptLinks: [],
          refund,
          supersedesId: ch?.id,
          charge: ch
            ? {
                name: ch.name,
                amount:
                  ch.amountForeign?.toString() ??
                  (ch.amountJpy === null
                    ? ""
                    : (ch.amountJpy < 0n ? -ch.amountJpy : ch.amountJpy).toString()),
                currency: ch.currency,
                exchangeRate: ch.exchangeRate?.toString(),
                method: ch.allocationMethod as AllocationMethod,
                capitalized: ch.capitalized,
                lineIds: ch.allocations.map((a) => a.lineId),
                manual: Object.fromEntries(
                  Object.entries(saved).map(([id, basis]) => [id, basis.manual]),
                ),
              }
            : {
                name: refund ? "購入返金" : "追加費用",
                amount: "",
                currency: "JPY",
                method: "VALUE",
                capitalized: true,
                lineIds: [],
                manual: {},
              },
        }}
      />
    );
  };
  return (
    <>
      {!readOnly && <CostEntry>{form(false)}</CostEntry>}
      {charges
        .filter((ch) => !ch.supersededBy)
        .map((ch) => (
          <div key={ch.id} className="commerce-charge-editor">
            <div className="commerce-summary-line">
              <span>
                {ch.name}
                <small className="commerce-secondary">
                  {allocationLabels[ch.allocationMethod as AllocationMethod]}
                  {!ch.capitalized ? " · 経費" : ""}
                  {!ch.allocated ? " · 配分待ち" : ""}
                </small>
              </span>
              <span>
                {ch.amountJpy === null ? "未確認" : `¥${ch.amountJpy.toLocaleString("ja-JP")}`}
              </span>
            </div>
            {!readOnly && (
              <details className="commerce-disclosure">
                <summary>金額・配分を訂正</summary>
                {form(ch.refund, ch)}
              </details>
            )}
          </div>
        ))}
      {charges
        .filter((ch) => !readOnly && ch.refund && !ch.supersededBy)
        .map((ch) => (
          <SettlementSection key={ch.id} c={c} kind="PURCHASE_REFUND" id={ch.id} />
        ))}
      {!readOnly && (
        <>
          <details className="commerce-disclosure">
            <summary>購入への返金を記録</summary>
            {form(true)}
          </details>
        </>
      )}
      {charges.some((ch) => ch.reason) && (
        <details className="commerce-disclosure">
          <summary>費用の履歴</summary>
          {charges.map((ch) => (
            <div key={ch.id} className="commerce-summary-line">
              <span>
                {ch.name}
                <small className="commerce-secondary">
                  {ch.reason}
                  {ch.supersededBy ? " · 訂正前" : ""}
                </small>
              </span>
              <span>
                {ch.amountJpy === null ? "未確認" : `¥${ch.amountJpy.toLocaleString("ja-JP")}`}
              </span>
            </div>
          ))}
        </details>
      )}
    </>
  );
}
