ALTER TABLE workflow_request ADD COLUMN error_fields jsonb;
ALTER TABLE workflow_request ADD CONSTRAINT workflow_request_error_fields
  CHECK (error_fields IS NULL OR (status = 'REJECTED' AND jsonb_typeof(error_fields) = 'object'));

CREATE OR REPLACE FUNCTION protect_workflow_request() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'workflow requests are retained'; END IF;
 IF (to_jsonb(NEW)-ARRAY['status','target_id','error_code','error_message','error_fields','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','target_id','error_code','error_message','error_fields','updated_at']) THEN RAISE EXCEPTION 'request identity is immutable'; END IF;
 IF OLD.status<>'PREPARED' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'request result is terminal'; END IF;
 RETURN NEW;
END $$;
