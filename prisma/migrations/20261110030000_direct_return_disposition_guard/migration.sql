-- Preserve normalized enum comparison when extending the complete-return guard.
DO $$
DECLARE definition text; corrected text;
BEGIN
 SELECT pg_get_functiondef('check_draft_owned_return_complete()'::regprocedure) INTO definition;
 corrected := replace(definition, 'disposition::text AS disposition', 'upper(disposition::text) AS disposition');
 IF corrected = definition THEN RAISE EXCEPTION 'component return guard definition not recognized'; END IF;
 EXECUTE corrected;
END $$;
