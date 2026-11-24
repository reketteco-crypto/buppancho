-- A trigger record has only its source table's columns. Keep the record access
-- inside separate branches so PostgreSQL never resolves a missing field.
CREATE OR REPLACE FUNCTION check_charge_allocation_sum() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; charge purchase_charge; allocated_sum bigint;
BEGIN
 IF TG_TABLE_NAME='purchase_charge' THEN target:=NEW.id;
 ELSE target:=NEW.charge_id;
 END IF;
 SELECT * INTO charge FROM purchase_charge WHERE id=target;
 SELECT COALESCE(sum(amount_jpy),0) INTO allocated_sum FROM purchase_charge_allocation WHERE charge_id=target;
 IF charge.allocated AND (charge.amount_jpy IS NULL OR charge.amount_jpy<>allocated_sum) THEN RAISE EXCEPTION 'allocation sum mismatch'; END IF;
 RETURN NULL;
END $$;
