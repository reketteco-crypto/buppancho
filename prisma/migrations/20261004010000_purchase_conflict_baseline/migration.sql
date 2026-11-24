ALTER TABLE workflow_draft ADD COLUMN base_snapshot jsonb;
ALTER TABLE workflow_draft ADD CONSTRAINT workflow_draft_baseline_object CHECK (base_snapshot IS NULL OR jsonb_typeof(base_snapshot) = 'object');
CREATE FUNCTION protect_workflow_draft_baseline() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.base_snapshot IS DISTINCT FROM OLD.base_snapshot THEN
   RAISE EXCEPTION 'draft comparison baseline is immutable; create a new draft';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER workflow_draft_baseline_immutable BEFORE UPDATE ON workflow_draft FOR EACH ROW EXECUTE FUNCTION protect_workflow_draft_baseline();
