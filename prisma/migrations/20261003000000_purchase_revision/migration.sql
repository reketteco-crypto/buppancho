ALTER TABLE purchase ADD COLUMN revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0);
CREATE FUNCTION increment_purchase_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.revision := OLD.revision + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_revision BEFORE UPDATE ON purchase
FOR EACH ROW EXECUTE FUNCTION increment_purchase_revision();
