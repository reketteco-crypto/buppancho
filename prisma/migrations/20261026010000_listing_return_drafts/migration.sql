ALTER TABLE workflow_draft DROP CONSTRAINT workflow_draft_kind_check;
ALTER TABLE workflow_draft ADD CONSTRAINT workflow_draft_kind_check CHECK(kind IN('LISTING','PURCHASE','COMPLETION','RETURN','REFUND','LISTING_RETURN'));
CREATE TABLE listing_return_submission (
 id uuid PRIMARY KEY, draft_id uuid UNIQUE REFERENCES workflow_draft(id),
 case_id uuid NOT NULL REFERENCES listing_return_case(id),
 kind text NOT NULL CHECK(kind IN('LISTING_RETURN','LISTING_RETURN_CLOSE')),
 occurred_date date NOT NULL, reason text NOT NULL CHECK(length(trim(reason))>0),
 created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX listing_return_submission_case ON listing_return_submission(case_id);
CREATE FUNCTION guard_listing_return_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.draft_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM workflow_draft draft JOIN listing_return_case return_case ON return_case.id=NEW.case_id
  WHERE draft.id=NEW.draft_id AND draft.kind='LISTING_RETURN' AND draft.workspace_id=return_case.workspace_id
  AND draft.business_unit_id=return_case.business_unit_id
  AND draft.year=extract(year FROM NEW.occurred_date)
  AND draft.payload->>'listingId'=return_case.listing_id::text AND draft.payload->>'caseId'=return_case.id::text
 ) THEN RAISE EXCEPTION 'listing return submission draft scope mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER listing_return_submission_scope BEFORE INSERT ON listing_return_submission FOR EACH ROW EXECUTE FUNCTION guard_listing_return_submission();
CREATE TRIGGER listing_return_submission_immutable BEFORE UPDATE OR DELETE ON listing_return_submission FOR EACH ROW EXECUTE FUNCTION prevent_valuation_mutation();
