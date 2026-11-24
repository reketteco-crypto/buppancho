BEGIN;
CREATE FUNCTION check_owner_allocation_total() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE target uuid; t money_transaction; BEGIN
 IF TG_TABLE_NAME='money_transaction' THEN target:=NEW.id; ELSE target:=NEW.settlement_id; END IF;
 SELECT * INTO t FROM money_transaction WHERE id=target;
 IF t.kind IN ('OWNER_REIMBURSEMENT','OWNER_REPAYMENT') AND (SELECT coalesce(sum(amount_jpy),0) FROM owner_settlement_allocation WHERE settlement_id=target)<>t.amount_jpy THEN RAISE EXCEPTION 'owner allocation total mismatch'; END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER owner_transaction_total AFTER INSERT ON money_transaction DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_owner_allocation_total();
CREATE CONSTRAINT TRIGGER owner_allocation_total AFTER INSERT ON owner_settlement_allocation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_owner_allocation_total();
COMMIT;
