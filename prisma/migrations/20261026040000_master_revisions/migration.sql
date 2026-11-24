-- Revision increases on every path, including setup/copy and non-UI updates.
CREATE FUNCTION advance_master_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.revision := OLD.revision+1; RETURN NEW; END $$;
DO $$
DECLARE target text;
BEGIN
 FOREACH target IN ARRAY ARRAY['workspace','operator','reporting_entity','business_unit','fiscal_year_profile','business_unit_assignment','storage_location','counterparty','inventory_item','sales_channel']
 LOOP
  EXECUTE format('ALTER TABLE %I ADD COLUMN revision integer NOT NULL DEFAULT 0 CHECK(revision>=0)', target);
  EXECUTE format('CREATE TRIGGER master_revision BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION advance_master_revision()', target);
 END LOOP;
END $$;
