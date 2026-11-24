BEGIN;
ALTER TABLE money_account ADD COLUMN account_kind text NOT NULL DEFAULT 'STANDARD';
ALTER TABLE money_account ADD CONSTRAINT money_account_kind CHECK(account_kind IN ('STANDARD','CREDIT_CARD'));
ALTER TABLE money_transaction DROP CONSTRAINT money_transaction_kind;
ALTER TABLE money_transaction ADD CONSTRAINT money_transaction_kind CHECK(kind IN ('PURCHASE_PAYMENT','DELIVERY_PAYMENT','PURCHASE_REFUND','SUPPLIER_RETURN_REFUND','SALE_RECEIPT','SALE_REFUND','TRANSFER','REVERSAL','FEE_PAYMENT','SHIPPING_PAYMENT','SALE_FEE_REFUND','SALE_SHIPPING_REFUND','OTHER_PAYMENT','OTHER_RECEIPT','PURCHASE_CREDIT_REFUND','DELIVERY_CREDIT_REFUND','SALE_CREDIT_REFUND','SALE_SETTLEMENT_PAYMENT','OWNER_CONTRIBUTION','OWNER_DRAWING'));
CREATE OR REPLACE FUNCTION check_money_transaction() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE target uuid; t money_transaction; n integer; total bigint; BEGIN
 IF TG_TABLE_NAME='money_transaction' THEN target:=NEW.id; ELSE target:=NEW.transaction_id; END IF;
 SELECT * INTO t FROM money_transaction WHERE id=target;
 SELECT count(*),coalesce(sum(amount_jpy),0) INTO n,total FROM money_entry WHERE transaction_id=target;
 IF t.kind='TRANSFER' THEN
  IF n<>(CASE WHEN t.fee_jpy>0 THEN 3 ELSE 2 END) OR total<>-t.fee_jpy OR (SELECT count(*) FROM money_entry WHERE transaction_id=target AND purpose='PRINCIPAL' AND amount_jpy=t.amount_jpy)<>1 OR (SELECT count(*) FROM money_entry WHERE transaction_id=target AND purpose='PRINCIPAL' AND amount_jpy=-t.amount_jpy)<>1 OR (t.fee_jpy>0 AND NOT EXISTS(SELECT 1 FROM money_entry f JOIN money_entry p ON p.transaction_id=f.transaction_id AND p.account_id=f.account_id WHERE f.transaction_id=target AND f.purpose='FEE' AND f.amount_jpy=-t.fee_jpy AND p.purpose='PRINCIPAL' AND p.amount_jpy=-t.amount_jpy)) THEN RAISE EXCEPTION 'transfer entries mismatch'; END IF;
 ELSIF t.kind IN ('OWNER_CONTRIBUTION','OWNER_DRAWING') THEN
  IF n<>(CASE WHEN t.fee_jpy>0 THEN 2 ELSE 1 END) OR (t.kind='OWNER_CONTRIBUTION' AND t.fee_jpy<>0) OR total<>(CASE WHEN t.kind='OWNER_CONTRIBUTION' THEN t.amount_jpy ELSE -t.amount_jpy-t.fee_jpy END) OR NOT EXISTS(SELECT 1 FROM money_entry WHERE transaction_id=target AND purpose='PRINCIPAL' AND amount_jpy=CASE WHEN t.kind='OWNER_CONTRIBUTION' THEN t.amount_jpy ELSE -t.amount_jpy END) OR (t.fee_jpy>0 AND NOT EXISTS(SELECT 1 FROM money_entry f JOIN money_entry p ON p.transaction_id=f.transaction_id AND p.account_id=f.account_id WHERE f.transaction_id=target AND f.purpose='FEE' AND f.amount_jpy=-t.fee_jpy AND p.purpose='PRINCIPAL')) THEN RAISE EXCEPTION 'owner funding entries mismatch'; END IF;
 ELSIF t.kind='REVERSAL' THEN
  IF NOT EXISTS(SELECT 1 FROM money_transaction o WHERE o.id=t.reverses_id AND o.reverses_id IS NULL AND o.workspace_id=t.workspace_id AND o.business_unit_id=t.business_unit_id AND o.reporting_entity_id=t.reporting_entity_id AND o.date<=t.date AND o.amount_jpy=t.amount_jpy AND o.fee_jpy=t.fee_jpy) OR EXISTS((SELECT account_id,purpose,amount_jpy FROM money_entry WHERE transaction_id=target) EXCEPT (SELECT account_id,purpose,-amount_jpy FROM money_entry WHERE transaction_id=t.reverses_id)) OR EXISTS((SELECT account_id,purpose,-amount_jpy FROM money_entry WHERE transaction_id=t.reverses_id) EXCEPT (SELECT account_id,purpose,amount_jpy FROM money_entry WHERE transaction_id=target)) THEN RAISE EXCEPTION 'reversal entries mismatch'; END IF;
 ELSE
  IF n<>1 OR t.fee_jpy<>0 OR total<>(CASE WHEN t.kind IN ('PURCHASE_REFUND','SUPPLIER_RETURN_REFUND','SALE_RECEIPT','SALE_FEE_REFUND','SALE_SHIPPING_REFUND','OTHER_RECEIPT','PURCHASE_CREDIT_REFUND','DELIVERY_CREDIT_REFUND') THEN t.amount_jpy ELSE -t.amount_jpy END) THEN RAISE EXCEPTION 'settlement entries mismatch'; END IF;
 END IF;
 IF t.kind IN ('PURCHASE_PAYMENT','DELIVERY_PAYMENT','PURCHASE_REFUND','SUPPLIER_RETURN_REFUND','SALE_RECEIPT','SALE_REFUND') AND t.source_id IS NULL THEN RAISE EXCEPTION 'settlement needs source'; END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION guard_money_source() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE valid boolean:=false; BEGIN
 IF NEW.kind IN ('PURCHASE_PAYMENT','PURCHASE_CREDIT_REFUND') THEN
 SELECT EXISTS(SELECT 1 FROM purchase_document p WHERE p.id=NEW.source_id AND p.workspace_id=NEW.workspace_id AND p.business_unit_id=NEW.business_unit_id AND p.reporting_entity_id=NEW.reporting_entity_id) INTO valid;
 ELSIF NEW.kind IN ('DELIVERY_PAYMENT','DELIVERY_CREDIT_REFUND') THEN
 SELECT EXISTS(SELECT 1 FROM inbound_delivery d WHERE d.id=NEW.source_id AND d.workspace_id=NEW.workspace_id AND d.business_unit_id=NEW.business_unit_id AND d.reporting_entity_id=NEW.reporting_entity_id) INTO valid;
 ELSIF NEW.kind='PURCHASE_REFUND' THEN
 SELECT EXISTS(SELECT 1 FROM purchase_charge c LEFT JOIN purchase_document p ON p.id=c.document_id LEFT JOIN inbound_delivery d ON d.id=c.delivery_id WHERE c.id=NEW.source_id AND c.refund AND coalesce(p.workspace_id,d.workspace_id)=NEW.workspace_id AND coalesce(p.business_unit_id,d.business_unit_id)=NEW.business_unit_id AND coalesce(p.reporting_entity_id,d.reporting_entity_id)=NEW.reporting_entity_id) INTO valid;
 ELSIF NEW.kind='SUPPLIER_RETURN_REFUND' THEN
 SELECT EXISTS(SELECT 1 FROM supplier_return s JOIN purchase_receipt_line l ON l.id=s.receipt_line_id JOIN purchase_receipt r ON r.id=l.receipt_id WHERE s.id=NEW.source_id AND r.workspace_id=NEW.workspace_id AND r.business_unit_id=NEW.business_unit_id AND r.reporting_entity_id=NEW.reporting_entity_id) INTO valid;
 ELSIF NEW.kind IN ('SALE_RECEIPT','SALE_SETTLEMENT_PAYMENT','SALE_CREDIT_REFUND','FEE_PAYMENT','SHIPPING_PAYMENT') THEN
 SELECT EXISTS(SELECT 1 FROM sales_order o WHERE o.id=NEW.source_id AND o.workspace_id=NEW.workspace_id AND o.business_unit_id=NEW.business_unit_id AND o.reporting_entity_id=NEW.reporting_entity_id) INTO valid;
 ELSIF NEW.kind IN ('SALE_REFUND','SALE_FEE_REFUND','SALE_SHIPPING_REFUND') THEN
 SELECT EXISTS(SELECT 1 FROM sales_return r JOIN sales_order o ON o.id=r.sales_order_id WHERE r.id=NEW.source_id AND o.workspace_id=NEW.workspace_id AND o.business_unit_id=NEW.business_unit_id AND o.reporting_entity_id=NEW.reporting_entity_id) INTO valid;
 ELSIF NEW.kind IN ('OTHER_PAYMENT','OTHER_RECEIPT') THEN
 SELECT EXISTS(SELECT 1 FROM other_record o WHERE o.id=NEW.source_id AND o.workspace_id=NEW.workspace_id AND o.business_unit_id=NEW.business_unit_id AND o.reporting_entity_id=NEW.reporting_entity_id) INTO valid;
 ELSE valid:=NEW.kind IN ('TRANSFER','REVERSAL','OWNER_CONTRIBUTION','OWNER_DRAWING'); END IF;
 IF NOT valid THEN RAISE EXCEPTION 'settlement source scope mismatch'; END IF;
 RETURN NEW;
END $$;


COMMIT;
