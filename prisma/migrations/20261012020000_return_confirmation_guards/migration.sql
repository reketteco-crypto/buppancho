-- Validate only newly draft-owned returns; historical NULL-owned records are not rewritten.
CREATE FUNCTION check_draft_owned_return_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_id uuid; parent sales_return; draft workflow_draft; source sales_order;
  line sales_return_line; sold sales_order_line; rows_count integer; component record; processed integer;
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
    OR draft.kind IS DISTINCT FROM draft.payload->>'kind'
    OR source.completion_listing_id IS NULL
 THEN RAISE EXCEPTION 'return draft context mismatch'; END IF;
 SELECT count(*) INTO rows_count FROM sales_return_line WHERE sales_return_id=parent.id;
 IF draft.kind='REFUND' THEN
  IF rows_count<>0 OR coalesce(length(trim(parent.memo)),0)=0
    OR (parent.sales_refund_jpy=0 AND parent.fee_refund_jpy=0 AND parent.shipping_refund_jpy=0)
  THEN RAISE EXCEPTION 'refund-only record must have reason and positive amount without stock'; END IF;
 ELSE
  IF rows_count<>1 THEN RAISE EXCEPTION 'physical return requires one sale-unit line'; END IF;
  SELECT * INTO line FROM sales_return_line WHERE sales_return_id=parent.id;
  SELECT * INTO sold FROM sales_order_line WHERE id=line.sales_order_line_id;
  IF EXISTS (SELECT 1 FROM return_component_disposition WHERE sales_return_line_id=line.id AND consumption_id IS NULL)
  THEN RAISE EXCEPTION 'physical return requires original consumption'; END IF;
  FOR component IN SELECT coalesce(unique_stock_unit_id,item_variant_id) AS key,sum(quantity) AS quantity
    FROM order_component_consumption WHERE sales_order_line_id=sold.id GROUP BY coalesce(unique_stock_unit_id,item_variant_id)
  LOOP
   SELECT coalesce(sum(quantity),0) INTO processed FROM return_component_disposition
     WHERE sales_return_line_id=line.id AND coalesce(unique_stock_unit_id,item_variant_id)=component.key;
   IF component.quantity % sold.quantity<>0 OR processed<>(component.quantity / sold.quantity)*line.quantity
   THEN RAISE EXCEPTION 'return must process the full fixed composition'; END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM order_component_consumption WHERE sales_order_line_id=sold.id)
  THEN RAISE EXCEPTION 'return consumption missing'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER draft_return_complete AFTER INSERT ON sales_return DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION check_draft_owned_return_complete();
CREATE CONSTRAINT TRIGGER draft_return_line_complete AFTER INSERT ON sales_return_line DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION check_draft_owned_return_complete();
CREATE CONSTRAINT TRIGGER draft_return_component_complete AFTER INSERT ON return_component_disposition DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION check_draft_owned_return_complete();
