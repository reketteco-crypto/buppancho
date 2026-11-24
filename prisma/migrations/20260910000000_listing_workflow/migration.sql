-- Existing records remain version 1. Only the explicit new workflow creates version 2.
ALTER TABLE listing ADD COLUMN workflow_version integer NOT NULL DEFAULT 1,
  ADD COLUMN revision integer NOT NULL DEFAULT 0,
  ADD COLUMN components_snapshot jsonb,
  ADD COLUMN return_pending boolean NOT NULL DEFAULT false;
ALTER TABLE listing ADD CONSTRAINT listing_workflow_version_check CHECK (workflow_version IN (1,2)),
  ADD CONSTRAINT listing_new_unit_check CHECK (workflow_version = 1 OR (listed_quantity BETWEEN 0 AND 1 AND external_listing_id IS NOT NULL AND components_snapshot IS NOT NULL));
ALTER TABLE sales_order ALTER COLUMN ordered_at DROP NOT NULL;
ALTER TABLE sales_order ADD COLUMN completion_listing_id uuid REFERENCES listing(id) ON DELETE RESTRICT,
  ADD COLUMN revision integer NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX sales_order_completion_listing_id_key ON sales_order(completion_listing_id);
ALTER TABLE inventory_reservation ALTER COLUMN sales_order_line_id DROP NOT NULL;
ALTER TABLE inventory_reservation ADD COLUMN listing_id uuid REFERENCES listing(id) ON DELETE RESTRICT;
ALTER TABLE inventory_reservation ADD CONSTRAINT reservation_owner_xor CHECK (num_nonnulls(sales_order_line_id, listing_id) = 1);
CREATE INDEX inventory_reservation_listing_id_status_idx ON inventory_reservation(listing_id,status);
CREATE TABLE workflow_draft (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspace(id),
  business_unit_id uuid NOT NULL REFERENCES business_unit(id), operator_id uuid NOT NULL REFERENCES operator(id),
  year integer NOT NULL, kind text NOT NULL CHECK (kind IN ('LISTING','PURCHASE','COMPLETION')),
  payload jsonb NOT NULL, revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  archived_at timestamptz(3), created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL
);
CREATE INDEX workflow_draft_workspace_id_business_unit_id_year_archived_at_idx ON workflow_draft(workspace_id,business_unit_id,year,archived_at);
CREATE TABLE workflow_event (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspace(id),
  business_unit_id uuid NOT NULL REFERENCES business_unit(id), operator_id uuid NOT NULL REFERENCES operator(id),
  year integer NOT NULL, kind text NOT NULL, target_id uuid NOT NULL,
  occurred_at timestamptz(3) NOT NULL, detail jsonb NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX workflow_event_workspace_id_business_unit_id_target_id_idx ON workflow_event(workspace_id,business_unit_id,target_id);
CREATE FUNCTION protect_workflow_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'workflow events are immutable'; END $$;
CREATE TRIGGER workflow_event_immutable BEFORE UPDATE OR DELETE ON workflow_event FOR EACH ROW EXECUTE FUNCTION protect_workflow_event();
