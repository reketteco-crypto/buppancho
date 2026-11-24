-- Prisma exposes upper-case names; PostgreSQL stores this enum in lower-case.
-- Keep the already applied migration intact and normalize only the comparison.
DO $$
DECLARE definition text; corrected text;
BEGIN
 SELECT pg_get_functiondef('check_draft_owned_return_complete()'::regprocedure) INTO definition;
 corrected := replace(definition, 'disposition::text AS disposition', 'upper(disposition::text) AS disposition');
 IF corrected = definition THEN RAISE EXCEPTION 'component return guard definition not recognized'; END IF;
 EXECUTE corrected;
END $$;
