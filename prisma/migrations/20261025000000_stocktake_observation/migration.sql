ALTER TYPE inventory_operation_type ADD VALUE IF NOT EXISTS 'stocktake';
CREATE TABLE stocktake_observation (
 id uuid PRIMARY KEY, operation_id uuid NOT NULL UNIQUE REFERENCES inventory_operation(id),
 request_id uuid NOT NULL UNIQUE, workspace_id uuid NOT NULL REFERENCES workspace(id),
 business_unit_id uuid NOT NULL REFERENCES business_unit(id),
 reporting_entity_id uuid NOT NULL REFERENCES reporting_entity(id),
 item_variant_id uuid NOT NULL REFERENCES item_variant(id),
 storage_location_id uuid NOT NULL REFERENCES storage_location(id),
 book_quantity integer NOT NULL CHECK(book_quantity>=0),
 counted_quantity integer NOT NULL CHECK(counted_quantity>=0 AND counted_quantity<=1000000),
 difference integer NOT NULL CHECK(difference=counted_quantity-book_quantity),
 created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX stocktake_observation_scope ON stocktake_observation(workspace_id,business_unit_id,item_variant_id);
CREATE FUNCTION check_stocktake_observation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS (
 SELECT 1 FROM inventory_operation o
 JOIN item_variant v ON v.id=NEW.item_variant_id
 JOIN inventory_item i ON i.id=v.inventory_item_id
 JOIN storage_location l ON l.id=NEW.storage_location_id
 JOIN reporting_entity e ON e.id=NEW.reporting_entity_id
 WHERE o.id=NEW.operation_id AND o.workspace_id=NEW.workspace_id AND o.business_unit_id=NEW.business_unit_id
 AND o.operation_type::text='stocktake' AND o.idempotency_key=NEW.request_id
 AND v.workspace_id=NEW.workspace_id AND i.business_unit_id=NEW.business_unit_id
 AND l.workspace_id=NEW.workspace_id AND (l.business_unit_id IS NULL OR l.business_unit_id=NEW.business_unit_id)
 AND e.workspace_id=NEW.workspace_id
 ) THEN RAISE EXCEPTION 'stocktake scope mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER stocktake_observation_scope BEFORE INSERT ON stocktake_observation FOR EACH ROW EXECUTE FUNCTION check_stocktake_observation();
CREATE TRIGGER stocktake_observation_immutable BEFORE UPDATE OR DELETE ON stocktake_observation FOR EACH ROW EXECUTE FUNCTION prevent_valuation_mutation();

-- Deferred: the operation and movements are written before the observation in one transaction.
CREATE FUNCTION check_stocktake_movements() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; s stocktake_observation%ROWTYPE; kind text; total bigint;
BEGIN
 IF TG_TABLE_NAME='inventory_operation' THEN target := NEW.id;
 ELSE target := NEW.operation_id; END IF;
 SELECT operation_type::text INTO kind FROM inventory_operation WHERE id=target;
 IF kind IS DISTINCT FROM 'stocktake' THEN RETURN NEW; END IF;
 SELECT * INTO s FROM stocktake_observation WHERE operation_id=target;
 IF NOT FOUND THEN RAISE EXCEPTION 'stocktake observation missing'; END IF;
 SELECT coalesce(sum(quantity),0) INTO total FROM stock_movement WHERE operation_id=target;
 IF total<>s.difference OR EXISTS (
 SELECT 1 FROM stock_movement m WHERE m.operation_id=target AND (
 m.item_variant_id<>s.item_variant_id OR m.business_unit_id<>s.business_unit_id OR m.unique_stock_unit_id IS NOT NULL OR
 (s.difference=0) OR
 (s.difference>0 AND (m.movement_type::text<>'adjustment_in' OR m.quantity<=0 OR m.storage_location_to_id IS DISTINCT FROM s.storage_location_id OR m.storage_location_from_id IS NOT NULL)) OR
 (s.difference<0 AND (m.movement_type::text<>'adjustment_out' OR m.quantity>=0 OR m.storage_location_from_id IS DISTINCT FROM s.storage_location_id OR m.storage_location_to_id IS NOT NULL))
 )) THEN RAISE EXCEPTION 'stocktake movement mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER stocktake_operation_complete AFTER INSERT ON inventory_operation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_stocktake_movements();
CREATE CONSTRAINT TRIGGER stocktake_movement_complete AFTER INSERT ON stock_movement DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_stocktake_movements();
CREATE CONSTRAINT TRIGGER stocktake_observation_complete AFTER INSERT ON stocktake_observation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_stocktake_movements();
