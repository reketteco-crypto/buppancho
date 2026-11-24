BEGIN;

CREATE FUNCTION guard_owner_allocation_active() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM money_transaction WHERE id=NEW.source_transaction_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM money_transaction
    WHERE reverses_id IN (NEW.source_transaction_id, NEW.settlement_id)
  ) THEN
    RAISE EXCEPTION 'reversed owner entries cannot be allocated';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER owner_allocation_active_guard
  BEFORE INSERT ON owner_settlement_allocation
  FOR EACH ROW EXECUTE FUNCTION guard_owner_allocation_active();

CREATE OR REPLACE FUNCTION guard_owner_reversal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind='REVERSAL' THEN
    PERFORM id FROM money_transaction WHERE id=NEW.reverses_id FOR UPDATE;
    IF EXISTS (
      SELECT 1 FROM owner_settlement_allocation a
      JOIN money_transaction t ON t.id=a.settlement_id
      WHERE a.source_transaction_id=NEW.reverses_id
        AND NOT EXISTS (SELECT 1 FROM money_transaction r WHERE r.reverses_id=t.id)
    ) THEN
      RAISE EXCEPTION 'reverse owner settlements first';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

COMMIT;
