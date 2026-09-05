import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;
let client: Client;

describeDb("PostgreSQL constraints", () => {
  beforeAll(async () => {
    client = new Client({ connectionString });
    await client.connect();
  });
  afterAll(async () => {
    await client?.end();
  });

  it("contains phase 0 and phase 1 domain tables but no later-phase tables", async () => {
    const result = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
    );
    const names = result.rows.map((row) => row.table_name);
    expect(names).toContain("workspace");
    expect(names).toContain("business_unit_assignment");
    expect(names).toContain("inventory_item");
    expect(names).toContain("stock_movement");
    expect(names).toContain("purchase");
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
      await client.query("SAVEPOINT invalid_method");
      await expect(
        client.query(
          "INSERT INTO business_unit_assignment(business_unit_id,fiscal_year_profile_id,effective_from,effective_to) VALUES($1,$2,'2026-06-01','2026-06-30')",
          [unit.id, fiscal.id],
        ),
      ).rejects.toThrow();
      await client.query("ROLLBACK TO SAVEPOINT invalid_method");
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

  it("enforces phase 1 inventory management and code constraints", async () => {
    await client.query("BEGIN");
    try {
      const workspace = (
        await client.query<{ id: string }>(
          "INSERT INTO workspace(name) VALUES('phase1') RETURNING id",
        )
      ).rows[0]!;
      const unit = (
        await client.query<{ id: string }>(
          "INSERT INTO business_unit(workspace_id,code,name,color) VALUES($1,'P1','フェーズ1','#176b52') RETURNING id",
          [workspace.id],
        )
      ).rows[0]!;
      await client.query("SAVEPOINT duplicate_code");
      await expect(
        client.query(
          "INSERT INTO inventory_item(workspace_id,business_unit_id,item_code,name,management_type,management_cost_method) VALUES($1,$2,'ITEM-000001','不正','unique','moving_average')",
          [workspace.id, unit.id],
        ),
      ).rejects.toThrow();
      await client.query("ROLLBACK TO SAVEPOINT duplicate_code");
      await client.query(
        "INSERT INTO inventory_item(workspace_id,business_unit_id,item_code,name,management_type,management_cost_method) VALUES($1,$2,'ITEM-000001','正常','quantity','moving_average')",
        [workspace.id, unit.id],
      );
      await expect(
        client.query(
          "INSERT INTO inventory_item(workspace_id,business_unit_id,item_code,name,management_type,management_cost_method) VALUES($1,$2,'ITEM-000001','重複','quantity','moving_average')",
          [workspace.id, unit.id],
        ),
      ).rejects.toThrow();
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("separates condition and tracking mode and makes variant codes workspace-unique", async () => {
    const columns = await client.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE (table_name = 'inventory_item' AND column_name = 'default_condition_category')
          OR (table_name = 'purchase_line' AND column_name IN ('condition_category','tracking_mode'))
          OR (table_name = 'inventory_lot' AND column_name = 'tracking_mode')
          OR (table_name = 'inventory_cost_balance' AND column_name = 'tracking_mode')`,
    );
    expect(columns.rows).toHaveLength(5);

    await client.query("BEGIN");
    try {
      const workspace = (
        await client.query<{ id: string }>(
          "INSERT INTO workspace(name) VALUES('unified') RETURNING id",
        )
      ).rows[0]!;
      const unit = (
        await client.query<{ id: string }>(
          "INSERT INTO business_unit(workspace_id,code,name,color) VALUES($1,'U1','統合','#176b52') RETURNING id",
          [workspace.id],
        )
      ).rows[0]!;
      const first = (
        await client.query<{ id: string }>(
          "INSERT INTO inventory_item(workspace_id,business_unit_id,item_code,name,management_type,management_cost_method) VALUES($1,$2,'ITEM-U1','商品1','quantity','moving_average') RETURNING id",
          [workspace.id, unit.id],
        )
      ).rows[0]!;
      const second = (
        await client.query<{ id: string }>(
          "INSERT INTO inventory_item(workspace_id,business_unit_id,item_code,name,management_type,management_cost_method) VALUES($1,$2,'ITEM-U2','商品2','unique','specific') RETURNING id",
          [workspace.id, unit.id],
        )
      ).rows[0]!;
      await client.query(
        "INSERT INTO item_variant(workspace_id,inventory_item_id,variant_code) VALUES($1,$2,'VAR-SAME')",
        [workspace.id, first.id],
      );
      await client.query("SAVEPOINT duplicate_variant");
      await expect(
        client.query(
          "INSERT INTO item_variant(workspace_id,inventory_item_id,variant_code) VALUES($1,$2,'VAR-SAME')",
          [workspace.id, second.id],
        ),
      ).rejects.toThrow();
      await client.query("ROLLBACK TO SAVEPOINT duplicate_variant");
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("allows a quantity-only unified purchase to omit the individual item count", async () => {
    const constraint = await client.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conname = 'purchase_count_check'`,
    );
    expect(constraint.rows[0]?.definition).toContain("expected_item_count IS NULL");
    expect(constraint.rows[0]?.definition).toContain("expected_item_count > 0");
  });

  it("allows only moving average for quantity items and keeps FIFO reserved", async () => {
    const constraint = await client.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint WHERE conname = 'inventory_item_cost_method_check'`,
    );
    expect(constraint.rows[0]?.definition).toContain("management_cost_method = 'moving_average'");
    expect(constraint.rows[0]?.definition).not.toContain("management_cost_method = ANY");

    const enumValues = await client.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum
       JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
       WHERE pg_type.typname = 'management_cost_method'`,
    );
    expect(enumValues.rows.map((row) => row.enumlabel)).toContain("fifo");
  });

  it("has trigram indexes for item, variant and attribute searches", async () => {
    const indexes = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND indexname IN (
         'inventory_item_code_trgm_idx',
         'item_variant_code_trgm_idx',
         'item_variant_attributes_text_trgm_idx'
       )`,
    );
    expect(indexes.rows.map((row) => row.indexname).sort()).toEqual([
      "inventory_item_code_trgm_idx",
      "item_variant_attributes_text_trgm_idx",
      "item_variant_code_trgm_idx",
    ]);
  });
});
