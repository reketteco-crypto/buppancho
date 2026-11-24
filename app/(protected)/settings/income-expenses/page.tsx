import { randomUUID } from "node:crypto";
import { commerceContext, todayTokyo } from "@/lib/commerce/view";
import { CategoryEditor } from "@/components/commerce/category-form";
export default async function CategoriesPage() {
  const c = await commerceContext(),
    rows = await c.db.moneyCategory.findMany({
      where: { workspaceId: c.workspaceId },
      orderBy: [{ kind: "asc" }, { name: "asc" }],
    }),
    base = { context: c.context, date: todayTokyo() };
  return (
    <div className="commerce">
      <header className="commerce-heading">
        <h1>収支の項目</h1>
      </header>
      <div className="commerce-editor">
        {rows.map((r) => (
          <details className="commerce-disclosure" key={`${r.id}:${r.revision}`}>
            <summary>
              {r.name}
              <span>
                {r.kind === "EXPENSE" ? "費用" : "収入"}
                {r.active ? "" : " · 無効"}
              </span>
            </summary>
            <CategoryEditor
              initial={{
                ...base,
                idempotencyKey: randomUUID(),
                id: r.id,
                revision: r.revision,
                name: r.name,
                kind: r.kind as "EXPENSE" | "INCOME",
                active: r.active,
              }}
            />
          </details>
        ))}
        <details className="commerce-disclosure">
          <summary>項目を追加</summary>
          <CategoryEditor
            initial={{
              ...base,
              idempotencyKey: randomUUID(),
              id: "",
              revision: 0,
              name: "",
              kind: "EXPENSE",
              active: true,
            }}
          />
        </details>
      </div>
    </div>
  );
}
