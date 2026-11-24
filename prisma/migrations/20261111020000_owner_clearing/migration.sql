BEGIN;
ALTER TABLE money_account DROP CONSTRAINT money_account_kind;
ALTER TABLE money_account ADD CONSTRAINT money_account_kind CHECK(account_kind IN ('STANDARD','CREDIT_CARD','OWNER_CLEARING'));
CREATE UNIQUE INDEX owner_clearing_scope ON money_account(workspace_id,business_unit_id,reporting_entity_id) WHERE account_kind='OWNER_CLEARING';
CREATE OR REPLACE FUNCTION guard_money_account() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM business_unit u JOIN reporting_entity e ON e.id=NEW.reporting_entity_id WHERE u.id=NEW.business_unit_id AND u.workspace_id=NEW.workspace_id AND e.workspace_id=NEW.workspace_id) THEN RAISE EXCEPTION 'account scope mismatch'; END IF;
 IF TG_OP='UPDATE' AND (NEW.workspace_id<>OLD.workspace_id OR NEW.business_unit_id<>OLD.business_unit_id OR NEW.reporting_entity_id<>OLD.reporting_entity_id OR NEW.opening_date<>OLD.opening_date OR NEW.opening_balance_jpy<>OLD.opening_balance_jpy) THEN RAISE EXCEPTION 'account opening is immutable'; END IF;
 IF NEW.account_kind='OWNER_CLEARING' AND NEW.opening_balance_jpy<>0 THEN RAISE EXCEPTION 'owner opening must be zero'; END IF;
 IF TG_OP='UPDATE' AND NEW.account_kind IS DISTINCT FROM OLD.account_kind AND (NEW.account_kind='OWNER_CLEARING' OR OLD.account_kind='OWNER_CLEARING') THEN RAISE EXCEPTION 'owner kind is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION guard_money_entry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM money_account a JOIN money_transaction t ON t.id=NEW.transaction_id WHERE a.id=NEW.account_id AND a.workspace_id=t.workspace_id AND a.business_unit_id=t.business_unit_id AND a.reporting_entity_id=t.reporting_entity_id AND (a.account_kind='OWNER_CLEARING' OR a.opening_date<=t.date)) THEN RAISE EXCEPTION 'money entry scope or date mismatch'; END IF;
 UPDATE money_account SET revision=revision+1 WHERE id=NEW.account_id;
 RETURN NEW;
END $$;
ALTER TABLE money_transaction DROP CONSTRAINT money_transaction_kind;
ALTER TABLE money_transaction ADD CONSTRAINT money_transaction_kind CHECK(kind IN ('PURCHASE_PAYMENT','DELIVERY_PAYMENT','PURCHASE_REFUND','SUPPLIER_RETURN_REFUND','SALE_RECEIPT','SALE_REFUND','TRANSFER','REVERSAL','FEE_PAYMENT','SHIPPING_PAYMENT','SALE_FEE_REFUND','SALE_SHIPPING_REFUND','OTHER_PAYMENT','OTHER_RECEIPT','PURCHASE_CREDIT_REFUND','DELIVERY_CREDIT_REFUND','SALE_CREDIT_REFUND','SALE_SETTLEMENT_PAYMENT','OWNER_CONTRIBUTION','OWNER_DRAWING','OWNER_REIMBURSEMENT','OWNER_REPAYMENT'));
CREATE OR REPLACE FUNCTION check_money_transaction() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE target uuid; t money_transaction; n integer; total bigint; BEGIN
 IF TG_TABLE_NAME='money_transaction' THEN target:=NEW.id; ELSE target:=NEW.transaction_id; END IF;
 SELECT * INTO t FROM money_transaction WHERE id=target;
 SELECT count(*),coalesce(sum(amount_jpy),0) INTO n,total FROM money_entry WHERE transaction_id=target;
 IF t.kind IN ('TRANSFER','OWNER_REIMBURSEMENT','OWNER_REPAYMENT') THEN
  IF t.kind='TRANSFER' AND EXISTS(SELECT 1 FROM money_entry e JOIN money_account a ON a.id=e.account_id WHERE e.transaction_id=target AND a.account_kind='OWNER_CLEARING') THEN RAISE EXCEPTION 'owner clearing requires owner settlement'; END IF;
  IF t.kind IN ('OWNER_REIMBURSEMENT','OWNER_REPAYMENT') AND (NOT EXISTS(SELECT 1 FROM money_entry e JOIN money_account a ON a.id=e.account_id WHERE e.transaction_id=target AND a.account_kind='OWNER_CLEARING' AND e.purpose='PRINCIPAL' AND e.amount_jpy=CASE WHEN t.kind='OWNER_REIMBURSEMENT' THEN t.amount_jpy ELSE -t.amount_jpy END) OR NOT EXISTS(SELECT 1 FROM money_entry e JOIN money_account a ON a.id=e.account_id WHERE e.transaction_id=target AND a.account_kind='STANDARD' AND e.purpose='PRINCIPAL' AND e.amount_jpy=CASE WHEN t.kind='OWNER_REIMBURSEMENT' THEN -t.amount_jpy ELSE t.amount_jpy END) OR (t.kind='OWNER_REPAYMENT' AND t.fee_jpy<>0)) THEN RAISE EXCEPTION 'owner settlement accounts mismatch'; END IF;
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
 ELSE valid:=NEW.kind IN ('TRANSFER','REVERSAL','OWNER_CONTRIBUTION','OWNER_DRAWING','OWNER_REIMBURSEMENT','OWNER_REPAYMENT'); END IF;
 IF NOT valid THEN RAISE EXCEPTION 'settlement source scope mismatch'; END IF;
 RETURN NEW;
END $$;



CREATE TABLE owner_settlement_allocation(id uuid PRIMARY KEY,settlement_id uuid NOT NULL REFERENCES money_transaction(id),source_transaction_id uuid NOT NULL REFERENCES money_transaction(id),amount_jpy bigint NOT NULL CHECK(amount_jpy>0),UNIQUE(settlement_id,source_transaction_id));
CREATE INDEX owner_settlement_allocation_source_transaction_id_idx ON owner_settlement_allocation(source_transaction_id);
CREATE FUNCTION guard_owner_allocation() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE src money_transaction; dst money_transaction; src_amount bigint; dst_amount bigint; src_account uuid; dst_account uuid; used bigint; BEGIN
 SELECT * INTO src FROM money_transaction WHERE id=NEW.source_transaction_id FOR UPDATE;
 SELECT * INTO dst FROM money_transaction WHERE id=NEW.settlement_id;
 SELECT e.amount_jpy,e.account_id INTO src_amount,src_account FROM money_entry e JOIN money_account a ON a.id=e.account_id WHERE e.transaction_id=src.id AND a.account_kind='OWNER_CLEARING' AND e.purpose='PRINCIPAL';
 SELECT e.amount_jpy,e.account_id INTO dst_amount,dst_account FROM money_entry e JOIN money_account a ON a.id=e.account_id WHERE e.transaction_id=dst.id AND a.account_kind='OWNER_CLEARING' AND e.purpose='PRINCIPAL';
 IF src.id=dst.id OR src.reverses_id IS NOT NULL OR dst.reverses_id IS NOT NULL OR src.workspace_id<>dst.workspace_id OR src.business_unit_id<>dst.business_unit_id OR src.reporting_entity_id<>dst.reporting_entity_id OR src.date>dst.date OR src_account IS NULL OR src_account IS DISTINCT FROM dst_account OR (src_amount<0)=(dst_amount<0) THEN RAISE EXCEPTION 'owner allocation scope mismatch'; END IF;
 SELECT coalesce(sum(a.amount_jpy),0) INTO used FROM owner_settlement_allocation a JOIN money_transaction t ON t.id=a.settlement_id WHERE (a.source_transaction_id=src.id OR a.settlement_id=src.id) AND NOT EXISTS(SELECT 1 FROM money_transaction r WHERE r.reverses_id=t.id);
 IF used+NEW.amount_jpy>abs(src_amount) THEN RAISE EXCEPTION 'owner source over allocation'; END IF;
 SELECT coalesce(sum(a.amount_jpy),0) INTO used FROM owner_settlement_allocation a JOIN money_transaction t ON t.id=a.settlement_id WHERE (a.source_transaction_id=dst.id OR a.settlement_id=dst.id) AND NOT EXISTS(SELECT 1 FROM money_transaction r WHERE r.reverses_id=t.id);
 IF used+NEW.amount_jpy>abs(dst_amount) THEN RAISE EXCEPTION 'owner settlement over allocation'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER owner_allocation_guard BEFORE INSERT ON owner_settlement_allocation FOR EACH ROW EXECUTE FUNCTION guard_owner_allocation();
CREATE TRIGGER owner_allocation_immutable BEFORE UPDATE OR DELETE ON owner_settlement_allocation FOR EACH ROW EXECUTE FUNCTION prevent_valuation_mutation();
CREATE FUNCTION guard_owner_reversal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.kind='REVERSAL' AND EXISTS(SELECT 1 FROM owner_settlement_allocation a JOIN money_transaction t ON t.id=a.settlement_id WHERE a.source_transaction_id=NEW.reverses_id AND NOT EXISTS(SELECT 1 FROM money_transaction r WHERE r.reverses_id=t.id)) THEN RAISE EXCEPTION 'reverse owner settlements first'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER owner_reversal_guard BEFORE INSERT ON money_transaction FOR EACH ROW EXECUTE FUNCTION guard_owner_reversal();

COMMIT;
