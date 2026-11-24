BEGIN;
-- AlterTable
ALTER TABLE "purchase_charge" ADD COLUMN     "recorded_date" DATE;
CREATE FUNCTION guard_money_source() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE valid boolean:=false; BEGIN
 CASE NEW.kind
 WHEN 'PURCHASE_PAYMENT' THEN SELECT EXISTS(SELECT 1 FROM purchase_document p WHERE p.id=NEW.source_id AND p.workspace_id=NEW.workspace_id AND p.business_unit_id=NEW.business_unit_id AND p.reporting_entity_id=NEW.reporting_entity_id) INTO valid;
 WHEN 'DELIVERY_PAYMENT' THEN SELECT EXISTS(SELECT 1 FROM inbound_delivery d WHERE d.id=NEW.source_id AND d.workspace_id=NEW.workspace_id AND d.business_unit_id=NEW.business_unit_id AND d.reporting_entity_id=NEW.reporting_entity_id) INTO valid;
 WHEN 'PURCHASE_REFUND' THEN SELECT EXISTS(SELECT 1 FROM purchase_charge c LEFT JOIN purchase_document p ON p.id=c.document_id LEFT JOIN inbound_delivery d ON d.id=c.delivery_id WHERE c.id=NEW.source_id AND c.refund AND coalesce(p.workspace_id,d.workspace_id)=NEW.workspace_id AND coalesce(p.business_unit_id,d.business_unit_id)=NEW.business_unit_id AND coalesce(p.reporting_entity_id,d.reporting_entity_id)=NEW.reporting_entity_id) INTO valid;
 WHEN 'SUPPLIER_RETURN_REFUND' THEN SELECT EXISTS(SELECT 1 FROM supplier_return s JOIN purchase_receipt_line l ON l.id=s.receipt_line_id JOIN purchase_receipt r ON r.id=l.receipt_id WHERE s.id=NEW.source_id AND r.workspace_id=NEW.workspace_id AND r.business_unit_id=NEW.business_unit_id AND r.reporting_entity_id=NEW.reporting_entity_id) INTO valid;
 WHEN 'SALE_RECEIPT' THEN SELECT EXISTS(SELECT 1 FROM sales_order o WHERE o.id=NEW.source_id AND o.workspace_id=NEW.workspace_id AND o.business_unit_id=NEW.business_unit_id AND o.reporting_entity_id=NEW.reporting_entity_id) INTO valid;
 WHEN 'SALE_REFUND' THEN SELECT EXISTS(SELECT 1 FROM sales_return r JOIN sales_order o ON o.id=r.sales_order_id WHERE r.id=NEW.source_id AND o.workspace_id=NEW.workspace_id AND o.business_unit_id=NEW.business_unit_id AND o.reporting_entity_id=NEW.reporting_entity_id) INTO valid;
 ELSE valid:=true;
 END CASE;
 IF NOT valid THEN RAISE EXCEPTION 'settlement source scope mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER money_source_scope BEFORE INSERT ON money_transaction FOR EACH ROW EXECUTE FUNCTION guard_money_source();
CREATE FUNCTION check_supplier_return_movement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (SELECT coalesce(sum(quantity),0) FROM stock_movement WHERE operation_id=NEW.operation_id AND movement_type='purchase_return')<>-NEW.quantity OR EXISTS(SELECT 1 FROM stock_movement m JOIN purchase_receipt_line l ON l.id=NEW.receipt_line_id WHERE m.operation_id=NEW.operation_id AND (m.inventory_lot_id<>l.inventory_lot_id OR m.movement_type<>'purchase_return')) THEN RAISE EXCEPTION 'supplier return movement mismatch'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER supplier_return_movements AFTER INSERT ON supplier_return DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_supplier_return_movement();

COMMIT;
