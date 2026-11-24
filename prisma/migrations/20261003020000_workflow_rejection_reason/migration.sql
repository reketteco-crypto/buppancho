-- Store only explicitly classified, user-facing errors. Database/runtime errors
-- must not be copied into this field. Existing terminal records remain unchanged.
ALTER TABLE workflow_request ADD COLUMN error_message text;
ALTER TABLE workflow_request ADD CONSTRAINT workflow_request_error_message
  CHECK (error_message IS NULL OR (status = 'REJECTED' AND length(error_message) BETWEEN 1 AND 2000));

CREATE OR REPLACE FUNCTION protect_workflow_request() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'workflow requests are retained'; END IF;
 IF (to_jsonb(NEW)-ARRAY['status','target_id','error_code','error_message','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','target_id','error_code','error_message','updated_at']) THEN RAISE EXCEPTION 'request identity is immutable'; END IF;
 IF OLD.status<>'PREPARED' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'request result is terminal'; END IF;
 RETURN NEW;
END $$;
