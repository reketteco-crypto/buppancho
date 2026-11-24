-- Additive only: no legacy valuation is recalculated by this migration.
CREATE SEQUENCE inventory_valuation_order_seq;
ALTER TABLE inventory_operation ADD COLUMN valuation_order numeric(60,30);
WITH ranked AS (SELECT id,row_number() OVER (ORDER BY occurred_at,created_at,id) AS n FROM inventory_operation)
UPDATE inventory_operation o SET valuation_order=r.n FROM ranked r WHERE r.id=o.id;
SELECT setval('inventory_valuation_order_seq',greatest(coalesce((SELECT max(valuation_order)::bigint FROM inventory_operation),0)+1,1),false);
ALTER TABLE inventory_operation ALTER COLUMN valuation_order SET NOT NULL, ALTER COLUMN valuation_order SET DEFAULT nextval('inventory_valuation_order_seq');
ALTER TABLE listing ADD COLUMN origin_reporting_entity_id uuid REFERENCES reporting_entity(id) ON DELETE RESTRICT,
  ADD COLUMN origin_assignment_id uuid REFERENCES business_unit_assignment(id) ON DELETE RESTRICT,
  ADD COLUMN origin_year integer;
ALTER TABLE listing ADD CONSTRAINT listing_origin_complete CHECK ((origin_reporting_entity_id IS NULL AND origin_assignment_id IS NULL AND origin_year IS NULL) OR (origin_reporting_entity_id IS NOT NULL AND origin_assignment_id IS NOT NULL AND origin_year BETWEEN 2000 AND 2200));
CREATE FUNCTION protect_listing_origin() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.origin_reporting_entity_id IS NOT NULL AND (NEW.origin_reporting_entity_id IS DISTINCT FROM OLD.origin_reporting_entity_id OR NEW.origin_assignment_id IS DISTINCT FROM OLD.origin_assignment_id OR NEW.origin_year IS DISTINCT FROM OLD.origin_year) THEN RAISE EXCEPTION 'listing origin is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER listing_origin_immutable BEFORE UPDATE ON listing FOR EACH ROW EXECUTE FUNCTION protect_listing_origin();

CREATE TABLE workflow_request (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspace(id), business_unit_id uuid NOT NULL REFERENCES business_unit(id),
 operator_id uuid NOT NULL REFERENCES operator(id), user_account_id uuid NOT NULL REFERENCES user_account(id), year integer NOT NULL,
 kind text NOT NULL, fingerprint text NOT NULL, payload jsonb NOT NULL, status text NOT NULL DEFAULT 'PREPARED', target_id uuid, error_code text,
 created_at timestamptz(3) NOT NULL DEFAULT now(),updated_at timestamptz(3) NOT NULL DEFAULT now(),
 CONSTRAINT workflow_request_status CHECK (status IN ('PREPARED','APPLIED','REJECTED','CANCELLED'))
);
CREATE INDEX workflow_request_scope_idx ON workflow_request(workspace_id,business_unit_id,operator_id,status);
CREATE TABLE draft_save_receipt (id uuid PRIMARY KEY,draft_id uuid NOT NULL REFERENCES workflow_draft(id) ON DELETE RESTRICT,fingerprint text NOT NULL,revision integer NOT NULL CHECK (revision>0),created_at timestamptz(3) NOT NULL DEFAULT now());
CREATE INDEX draft_save_receipt_draft_idx ON draft_save_receipt(draft_id);
CREATE TABLE valuation_run (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sequence bigserial NOT NULL UNIQUE,
 workspace_id uuid NOT NULL REFERENCES workspace(id),business_unit_id uuid NOT NULL REFERENCES business_unit(id),operator_id uuid NOT NULL REFERENCES operator(id),
 request_id uuid NOT NULL UNIQUE,source_order_id uuid NOT NULL REFERENCES sales_order(id),summary jsonb NOT NULL,created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX valuation_run_scope_idx ON valuation_run(workspace_id,business_unit_id,created_at);
CREATE TABLE valuation_adjustment (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),run_id uuid NOT NULL REFERENCES valuation_run(id) ON DELETE RESTRICT,
 target_type text NOT NULL CHECK(target_type IN ('MOVEMENT','CONSUMPTION','DISPOSITION')),target_id uuid NOT NULL,
 before_jpy bigint NOT NULL,after_jpy bigint NOT NULL,delta_jpy bigint NOT NULL,
 CONSTRAINT valuation_delta_check CHECK(delta_jpy=after_jpy-before_jpy),
 UNIQUE(run_id,target_type,target_id)
);
CREATE INDEX valuation_adjustment_target_idx ON valuation_adjustment(target_type,target_id);
CREATE FUNCTION prevent_valuation_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'valuation history is append-only'; END $$;
CREATE TRIGGER valuation_run_immutable BEFORE UPDATE OR DELETE ON valuation_run FOR EACH ROW EXECUTE FUNCTION prevent_valuation_mutation();
CREATE TRIGGER valuation_adjustment_immutable BEFORE UPDATE OR DELETE ON valuation_adjustment FOR EACH ROW EXECUTE FUNCTION prevent_valuation_mutation();
CREATE TRIGGER draft_save_receipt_immutable BEFORE UPDATE OR DELETE ON draft_save_receipt FOR EACH ROW EXECUTE FUNCTION prevent_valuation_mutation();
CREATE TABLE inventory_revision (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_unit_id uuid NOT NULL UNIQUE REFERENCES business_unit(id),revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0));
-- A department-level guard serializes old and new inventory writers, including direct SQL.
CREATE FUNCTION touch_inventory_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE unit_id uuid;
BEGIN
 IF TG_TABLE_NAME IN ('inventory_operation','stock_movement','inventory_cost_balance','sales_order') THEN unit_id=NEW.business_unit_id;
 ELSIF TG_TABLE_NAME='inventory_item' THEN unit_id=NEW.business_unit_id;
 ELSE SELECT i.business_unit_id INTO unit_id FROM item_variant v JOIN inventory_item i ON i.id=v.inventory_item_id WHERE v.id=NEW.item_variant_id;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('inventory-domain:'||unit_id::text,0));
 INSERT INTO inventory_revision(business_unit_id,revision) VALUES(unit_id,1) ON CONFLICT(business_unit_id) DO UPDATE SET revision=inventory_revision.revision+1;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_operation_revision BEFORE INSERT OR UPDATE ON inventory_operation FOR EACH ROW EXECUTE FUNCTION touch_inventory_revision();
CREATE TRIGGER stock_movement_revision BEFORE INSERT OR UPDATE ON stock_movement FOR EACH ROW EXECUTE FUNCTION touch_inventory_revision();
CREATE TRIGGER inventory_cost_balance_revision BEFORE INSERT OR UPDATE ON inventory_cost_balance FOR EACH ROW EXECUTE FUNCTION touch_inventory_revision();
CREATE TRIGGER inventory_lot_revision BEFORE INSERT OR UPDATE ON inventory_lot FOR EACH ROW EXECUTE FUNCTION touch_inventory_revision();
CREATE TRIGGER unique_stock_revision BEFORE INSERT OR UPDATE ON unique_stock_unit FOR EACH ROW EXECUTE FUNCTION touch_inventory_revision();
CREATE TRIGGER inventory_reservation_revision BEFORE INSERT OR UPDATE ON inventory_reservation FOR EACH ROW EXECUTE FUNCTION touch_inventory_revision();
CREATE TRIGGER sales_order_revision BEFORE INSERT OR UPDATE ON sales_order FOR EACH ROW EXECUTE FUNCTION touch_inventory_revision();
