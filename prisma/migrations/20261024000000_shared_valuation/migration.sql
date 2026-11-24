ALTER TABLE valuation_run ALTER COLUMN source_order_id DROP NOT NULL;
ALTER TABLE valuation_run ADD COLUMN source_type text, ADD COLUMN source_id uuid;
CREATE TABLE event_date_correction (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspace(id),
 business_unit_id uuid NOT NULL REFERENCES business_unit(id), operation_id uuid NOT NULL REFERENCES inventory_operation(id),
 request_id uuid NOT NULL UNIQUE, previous_date date NOT NULL, effective_date date NOT NULL,
 reason text NOT NULL CHECK(length(trim(reason))>0), operator_id uuid NOT NULL REFERENCES operator(id),
 created_at timestamptz(3) NOT NULL DEFAULT now(),
 CHECK(extract(year FROM previous_date)=extract(year FROM effective_date))
);
CREATE INDEX event_date_correction_scope ON event_date_correction(workspace_id,business_unit_id,operation_id,created_at);
CREATE FUNCTION check_event_date_correction() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM inventory_operation o JOIN operator p ON p.id=NEW.operator_id
 WHERE o.id=NEW.operation_id AND o.workspace_id=NEW.workspace_id AND o.business_unit_id=NEW.business_unit_id
 AND p.workspace_id=NEW.workspace_id) THEN RAISE EXCEPTION 'date correction scope mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER event_date_correction_scope BEFORE INSERT ON event_date_correction FOR EACH ROW EXECUTE FUNCTION check_event_date_correction();
CREATE TRIGGER event_date_correction_immutable BEFORE UPDATE OR DELETE ON event_date_correction FOR EACH ROW EXECUTE FUNCTION prevent_valuation_mutation();
