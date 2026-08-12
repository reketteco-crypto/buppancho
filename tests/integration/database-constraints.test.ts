import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;
let client: Client;

describeDb("phase 0 PostgreSQL constraints", () => {
  beforeAll(async () => {
    client = new Client({ connectionString });
    await client.connect();
  });
  afterAll(async () => {
    await client?.end();
  });

  it("contains only phase 0 domain tables", async () => {
    const result = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
    );
    const names = result.rows.map((row) => row.table_name);
    expect(names).toContain("workspace");
    expect(names).toContain("business_unit_assignment");
    expect(names).not.toContain("inventory_item");
    expect(names).not.toContain("sales_order");
    expect(names).not.toContain("journal_entry");
  });

  it("rejects overlapping reporting-entity assignments for one business unit", async () => {
    await client.query("BEGIN");
    try {
      const workspace = (
        await client.query<{ id: string }>(
          "INSERT INTO workspace(name) VALUES('test') RETURNING id",
        )
      ).rows[0]!;
      const entity = (
        await client.query<{ id: string }>(
          "INSERT INTO reporting_entity(workspace_id,display_name) VALUES($1,'事業主') RETURNING id",
          [workspace.id],
        )
      ).rows[0]!;
      const fiscal = (
        await client.query<{ id: string }>(
          "INSERT INTO fiscal_year_profile(reporting_entity_id,year,filing_method,consumption_tax_status,blue_deduction_target,inventory_valuation_method,start_date,end_date) VALUES($1,2026,'blue','exempt','650k','specific','2026-01-01','2026-12-31') RETURNING id",
          [entity.id],
        )
      ).rows[0]!;
      const unit = (
        await client.query<{ id: string }>(
          "INSERT INTO business_unit(workspace_id,code,name,color) VALUES($1,'TEST','テスト','#176b52') RETURNING id",
          [workspace.id],
        )
      ).rows[0]!;
      await client.query(
        "INSERT INTO business_unit_assignment(business_unit_id,fiscal_year_profile_id,effective_from,effective_to) VALUES($1,$2,'2026-01-01','2026-12-31')",
        [unit.id, fiscal.id],
      );
      await expect(
        client.query(
          "INSERT INTO business_unit_assignment(business_unit_id,fiscal_year_profile_id,effective_from,effective_to) VALUES($1,$2,'2026-06-01','2026-06-30')",
          [unit.id, fiscal.id],
        ),
      ).rejects.toThrow();
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("stores the default operator on the annual assignment", async () => {
    const columns = await client.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name='business_unit_assignment'",
    );
    expect(columns.rows.map((row) => row.column_name)).toContain("default_operator_id");
    const oldColumns = await client.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name='business_unit'",
    );
    expect(oldColumns.rows.map((row) => row.column_name)).not.toContain("default_operator_id");
  });
});
