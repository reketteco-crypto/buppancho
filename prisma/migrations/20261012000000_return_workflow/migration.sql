ALTER TABLE sales_return ADD COLUMN source_draft_id uuid REFERENCES workflow_draft(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX sales_return_source_draft_id_key ON sales_return(source_draft_id);
CREATE INDEX sales_return_line_sales_order_line_id_idx ON sales_return_line(sales_order_line_id);
CREATE INDEX return_component_disposition_consumption_id_idx ON return_component_disposition(consumption_id);

CREATE FUNCTION check_return_record_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o sales_order; d workflow_draft; amount bigint;
BEGIN
 SELECT * INTO o FROM sales_order WHERE id=NEW.sales_order_id;
 PERFORM pg_advisory_xact_lock(hashtextextended('inventory-domain:'||o.business_unit_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('order:'||o.id::text,0));
 IF NEW.source_draft_id IS NOT NULL THEN
  SELECT * INTO d FROM workflow_draft WHERE id=NEW.source_draft_id;
  IF d.workspace_id IS DISTINCT FROM o.workspace_id OR d.business_unit_id IS DISTINCT FROM o.business_unit_id
    OR d.kind NOT IN ('RETURN','REFUND') OR d.payload->>'orderId' IS DISTINCT FROM o.id::text
  THEN RAISE EXCEPTION 'return draft scope mismatch'; END IF;
 END IF;
 SELECT coalesce(sum(sales_refund_jpy),0) INTO amount FROM sales_return WHERE sales_order_id=o.id;
 IF amount+NEW.sales_refund_jpy > o.gross_sales_jpy-o.discount_jpy THEN RAISE EXCEPTION 'refund total exceeds sales'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sales_return_scope BEFORE INSERT ON sales_return FOR EACH ROW EXECUTE FUNCTION check_return_record_scope();

CREATE FUNCTION check_return_line_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source sales_order_line; parent uuid; used integer; unit_id uuid;
BEGIN
 SELECT * INTO source FROM sales_order_line WHERE id=NEW.sales_order_line_id;
 SELECT sales_order_id INTO parent FROM sales_return WHERE id=NEW.sales_return_id;
 IF source.sales_order_id IS DISTINCT FROM parent THEN RAISE EXCEPTION 'return line scope mismatch'; END IF;
 SELECT business_unit_id INTO unit_id FROM sales_order WHERE id=parent;
 PERFORM pg_advisory_xact_lock(hashtextextended('inventory-domain:'||unit_id::text,0));
 SELECT coalesce(sum(quantity),0) INTO used FROM sales_return_line WHERE sales_order_line_id=source.id;
 IF used+NEW.quantity>source.quantity THEN RAISE EXCEPTION 'return quantity exceeds sold quantity'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sales_return_line_scope BEFORE INSERT ON sales_return_line FOR EACH ROW EXECUTE FUNCTION check_return_line_scope();

CREATE FUNCTION check_return_disposition_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source order_component_consumption; line_id uuid; used integer;
BEGIN
 IF NEW.consumption_id IS NOT NULL THEN
  SELECT * INTO source FROM order_component_consumption WHERE id=NEW.consumption_id;
  SELECT sales_order_line_id INTO line_id FROM sales_return_line WHERE id=NEW.sales_return_line_id;
  IF source.sales_order_line_id IS DISTINCT FROM line_id OR source.item_variant_id IS DISTINCT FROM NEW.item_variant_id
    OR source.unique_stock_unit_id IS DISTINCT FROM NEW.unique_stock_unit_id OR source.inventory_lot_id IS DISTINCT FROM NEW.inventory_lot_id
    OR source.storage_location_id IS DISTINCT FROM NEW.storage_location_id
  THEN RAISE EXCEPTION 'return disposition scope mismatch'; END IF;
  SELECT coalesce(sum(quantity),0) INTO used FROM return_component_disposition WHERE consumption_id=source.id;
  IF used+NEW.quantity>source.quantity THEN RAISE EXCEPTION 'component return exceeds consumption'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER return_disposition_scope BEFORE INSERT ON return_component_disposition FOR EACH ROW EXECUTE FUNCTION check_return_disposition_scope();

CREATE FUNCTION check_return_quantity_cache() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line_id uuid; expected integer; actual integer;
BEGIN
 IF TG_TABLE_NAME='sales_order_line' THEN line_id=NEW.id; ELSE line_id=NEW.sales_order_line_id; END IF;
 SELECT returned_quantity INTO actual FROM sales_order_line WHERE id=line_id;
 SELECT coalesce(sum(quantity),0) INTO expected FROM sales_return_line WHERE sales_order_line_id=line_id;
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'return quantity cache mismatch'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER return_line_cache AFTER INSERT ON sales_return_line DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_return_quantity_cache();
CREATE CONSTRAINT TRIGGER return_order_line_cache AFTER UPDATE ON sales_order_line DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_return_quantity_cache();
CREATE TRIGGER sales_return_immutable BEFORE UPDATE OR DELETE ON sales_return FOR EACH ROW EXECUTE FUNCTION prevent_valuation_mutation();
CREATE TRIGGER sales_return_line_immutable BEFORE UPDATE OR DELETE ON sales_return_line FOR EACH ROW EXECUTE FUNCTION prevent_valuation_mutation();
CREATE TRIGGER return_disposition_immutable BEFORE UPDATE OR DELETE ON return_component_disposition FOR EACH ROW EXECUTE FUNCTION prevent_valuation_mutation();
