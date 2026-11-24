-- Component-only returns count original component quantities, never fractional sale units.
ALTER TABLE sales_return_line ADD COLUMN component_only boolean NOT NULL DEFAULT false;
ALTER TABLE sales_return_line DROP CONSTRAINT sales_return_line_quantity_check;
ALTER TABLE sales_return_line ADD CONSTRAINT sales_return_line_quantity_check
 CHECK ((component_only AND quantity=0) OR (NOT component_only AND quantity>0));

CREATE OR REPLACE FUNCTION check_return_line_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source sales_order_line; parent sales_return; used integer; unit_id uuid;
BEGIN
 SELECT * INTO source FROM sales_order_line WHERE id=NEW.sales_order_line_id;
 SELECT * INTO parent FROM sales_return WHERE id=NEW.sales_return_id;
 IF source.sales_order_id IS DISTINCT FROM parent.sales_order_id THEN RAISE EXCEPTION 'return line scope mismatch'; END IF;
 SELECT business_unit_id INTO unit_id FROM sales_order WHERE id=parent.sales_order_id;
 PERFORM pg_advisory_xact_lock(hashtextextended('inventory-domain:'||unit_id::text,0));
 IF NEW.component_only AND parent.source_draft_id IS NULL THEN RAISE EXCEPTION 'component return requires a source draft'; END IF;
 IF NOT NEW.component_only AND EXISTS (SELECT 1 FROM sales_return_line WHERE sales_order_line_id=source.id AND component_only)
 THEN RAISE EXCEPTION 'use component quantities after a component-only return'; END IF;
 SELECT coalesce(sum(quantity),0) INTO used FROM sales_return_line WHERE sales_order_line_id=source.id;
 IF used+NEW.quantity>source.quantity THEN RAISE EXCEPTION 'return quantity exceeds sold quantity'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION check_draft_owned_return_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_id uuid; parent sales_return; draft workflow_draft; source sales_order;
 returned_line sales_return_line; sold sales_order_line; rows_count integer; component record; processed integer;
BEGIN
 IF TG_TABLE_NAME='sales_return' THEN parent_id=NEW.id;
 ELSIF TG_TABLE_NAME='sales_return_line' THEN parent_id=NEW.sales_return_id;
 ELSE SELECT sales_return_id INTO parent_id FROM sales_return_line WHERE id=NEW.sales_return_line_id;
 END IF;
 SELECT * INTO parent FROM sales_return WHERE id=parent_id;
 IF parent.source_draft_id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO draft FROM workflow_draft WHERE id=parent.source_draft_id;
 SELECT * INTO source FROM sales_order WHERE id=parent.sales_order_id;
 IF draft.year IS DISTINCT FROM extract(year FROM source.completed_at AT TIME ZONE 'Asia/Tokyo')::integer
 OR draft.kind IS DISTINCT FROM draft.payload->>'kind' OR source.completion_listing_id IS NULL
 THEN RAISE EXCEPTION 'return draft context mismatch'; END IF;
 SELECT count(*) INTO rows_count FROM sales_return_line WHERE sales_return_id=parent.id;
 IF draft.kind='REFUND' THEN
  IF rows_count<>0 OR coalesce(length(trim(parent.memo)),0)=0
  OR (parent.sales_refund_jpy=0 AND parent.fee_refund_jpy=0 AND parent.shipping_refund_jpy=0)
  THEN RAISE EXCEPTION 'refund-only record must have reason and positive amount without stock'; END IF;
 ELSE
  IF rows_count<>1 THEN RAISE EXCEPTION 'physical return requires one original line'; END IF;
  SELECT * INTO returned_line FROM sales_return_line WHERE sales_return_id=parent.id;
  SELECT * INTO sold FROM sales_order_line WHERE id=returned_line.sales_order_line_id;
  IF EXISTS (SELECT 1 FROM return_component_disposition WHERE sales_return_line_id=returned_line.id AND consumption_id IS NULL)
  OR NOT EXISTS (SELECT 1 FROM return_component_disposition WHERE sales_return_line_id=returned_line.id)
  THEN RAISE EXCEPTION 'physical return requires original consumption'; END IF;
  IF returned_line.component_only THEN
   IF draft.payload->>'scope' IS DISTINCT FROM 'COMPONENTS' THEN RAISE EXCEPTION 'component return draft required'; END IF;
   -- Verify the aggregate plan, including disposition, against the immutable source input.
   IF EXISTS (
    WITH requested AS (
     SELECT entry->>'key' AS component_key, entry->>'disposition' AS disposition, sum((entry->>'quantity')::integer) AS quantity
     FROM jsonb_array_elements(draft.payload->'components') AS entry GROUP BY 1,2
    ), actual AS (
     SELECT coalesce(unique_stock_unit_id,item_variant_id)::text AS component_key, disposition::text AS disposition, sum(quantity) AS quantity
     FROM return_component_disposition WHERE sales_return_line_id=returned_line.id GROUP BY 1,2
    )
    SELECT 1 FROM requested FULL JOIN actual USING(component_key,disposition)
    WHERE coalesce(requested.quantity,0)<>coalesce(actual.quantity,0)
   ) THEN RAISE EXCEPTION 'component return plan mismatch'; END IF;
  ELSE
   IF coalesce(draft.payload->>'scope','SALE_UNIT')<>'SALE_UNIT' THEN RAISE EXCEPTION 'sale-unit return draft required'; END IF;
   FOR component IN SELECT coalesce(unique_stock_unit_id,item_variant_id) AS key,sum(quantity) AS quantity
    FROM order_component_consumption WHERE sales_order_line_id=sold.id GROUP BY coalesce(unique_stock_unit_id,item_variant_id)
   LOOP
    SELECT coalesce(sum(quantity),0) INTO processed FROM return_component_disposition
     WHERE sales_return_line_id=returned_line.id AND coalesce(unique_stock_unit_id,item_variant_id)=component.key;
    IF component.quantity % sold.quantity<>0 OR processed<>(component.quantity / sold.quantity)*returned_line.quantity
    THEN RAISE EXCEPTION 'return must process the full fixed composition'; END IF;
   END LOOP;
  END IF;
 END IF;
 RETURN NULL;
END $$;
