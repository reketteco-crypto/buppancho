import { randomUUID } from "node:crypto";
import { commerceContext, todayTokyo } from "@/lib/commerce/view";
import { CounterpartyEditor } from "@/components/commerce/supplier-form";
import type { AllocationMethod } from "@/lib/commerce/allocation";
export default async function CounterpartiesPage() {
  const c = await commerceContext(),
    rows = await c.db.counterparty.findMany({
      where: { workspaceId: c.workspaceId, type: "SUPPLIER" },
      orderBy: [{ active: "desc" }, { name: "asc" }],
    }),
    base = { context: c.context, date: todayTokyo() };
  return (
    <div className="commerce">
      <header className="commerce-heading">
        <h1>取引先</h1>
      </header>
      <div className="commerce-editor">
        {rows.map((r) => (
          <details className="commerce-disclosure" key={`${r.id}:${r.revision}`}>
            <summary>
              {r.name}
              {r.active ? "" : " · 無効"}
            </summary>
            <CounterpartyEditor
              initial={{
                ...base,
                idempotencyKey: randomUUID(),
                id: r.id,
                revision: r.revision,
                name: r.name,
                currency: r.defaultCurrency,
                allocationMethod: r.defaultAllocationMethod as AllocationMethod,
                memo: r.memo || "",
                active: r.active,
              }}
            />
          </details>
        ))}
        <details className="commerce-disclosure">
          <summary>取引先を追加</summary>
          <CounterpartyEditor
            initial={{
              ...base,
              idempotencyKey: randomUUID(),
              id: "",
              revision: 0,
              name: "",
              currency: "JPY",
              allocationMethod: "VALUE",
              memo: "",
              active: true,
            }}
          />
        </details>
      </div>
    </div>
  );
}
