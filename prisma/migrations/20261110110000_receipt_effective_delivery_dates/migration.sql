BEGIN;
CREATE OR REPLACE FUNCTION guard_receipt_delivery_link() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE r purchase_receipt_line; d inbound_delivery_line; BEGIN
 SELECT * INTO r FROM purchase_receipt_line WHERE id=NEW.receipt_line_id FOR UPDATE;
 SELECT * INTO d FROM inbound_delivery_line WHERE id=NEW.delivery_line_id FOR UPDATE;
 IF r.line_id<>d.purchase_line_id OR r.delivery_line_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM purchase_receipt pr JOIN inbound_delivery dd ON dd.id=d.delivery_id WHERE pr.id=r.receipt_id AND pr.workspace_id=dd.workspace_id AND pr.business_unit_id=dd.business_unit_id AND pr.reporting_entity_id=dd.reporting_entity_id AND coalesce((SELECT c.effective_date FROM event_date_correction c WHERE c.operation_id=pr.operation_id ORDER BY c.created_at DESC,c.id DESC LIMIT 1),pr.received_date)>=dd.shipped_date) THEN RAISE EXCEPTION 'receipt attribution scope mismatch'; END IF;
 IF NEW.quantity+(SELECT coalesce(sum(quantity),0) FROM receipt_delivery_link WHERE receipt_line_id=r.id)>r.quantity OR NEW.quantity+(SELECT coalesce(sum(quantity),0) FROM receipt_delivery_link WHERE delivery_line_id=d.id)+(SELECT coalesce(sum(quantity),0) FROM purchase_receipt_line WHERE delivery_line_id=d.id)>d.quantity THEN RAISE EXCEPTION 'receipt attribution exceeds quantity'; END IF;
 RETURN NEW;
END $$;

COMMIT;
