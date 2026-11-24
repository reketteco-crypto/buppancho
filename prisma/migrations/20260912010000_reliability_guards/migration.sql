-- Request identity and terminal results cannot be rewritten or physically removed.
CREATE FUNCTION protect_workflow_request() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'workflow requests are retained'; END IF;
 IF (to_jsonb(NEW)-ARRAY['status','target_id','error_code','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','target_id','error_code','updated_at']) THEN RAISE EXCEPTION 'request identity is immutable'; END IF;
 IF OLD.status<>'PREPARED' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'request result is terminal'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER workflow_request_immutable BEFORE UPDATE OR DELETE ON workflow_request FOR EACH ROW EXECUTE FUNCTION protect_workflow_request();
ALTER TABLE workflow_request ADD CONSTRAINT workflow_request_result CHECK ((status='APPLIED' AND target_id IS NOT NULL) OR (status<>'APPLIED' AND target_id IS NULL));

CREATE FUNCTION check_listing_origin_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.origin_assignment_id IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM business_unit_assignment a JOIN fiscal_year_profile f ON f.id=a.fiscal_year_profile_id
   JOIN sales_sku s ON s.id=NEW.sales_sku_id JOIN reporting_entity e ON e.id=f.reporting_entity_id
   WHERE a.id=NEW.origin_assignment_id AND a.business_unit_id=s.business_unit_id AND f.year=NEW.origin_year
   AND f.reporting_entity_id=NEW.origin_reporting_entity_id AND e.workspace_id=s.workspace_id
 ) THEN RAISE EXCEPTION 'listing origin scope mismatch'; END IF;
 RETURN NEW;
END $$;
-- Validate the snapshot when first populated, not when an annual assignment later changes.
CREATE TRIGGER listing_origin_scope_insert BEFORE INSERT ON listing FOR EACH ROW EXECUTE FUNCTION check_listing_origin_scope();
CREATE TRIGGER listing_origin_scope_update BEFORE UPDATE ON listing FOR EACH ROW WHEN (OLD.origin_assignment_id IS NULL AND NEW.origin_assignment_id IS NOT NULL) EXECUTE FUNCTION check_listing_origin_scope();

CREATE FUNCTION check_valuation_target_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_unit uuid; run_unit uuid;
BEGIN
 SELECT business_unit_id INTO run_unit FROM valuation_run WHERE id=NEW.run_id;
 IF NEW.target_type='MOVEMENT' THEN SELECT business_unit_id INTO target_unit FROM stock_movement WHERE id=NEW.target_id;
 ELSIF NEW.target_type='CONSUMPTION' THEN SELECT o.business_unit_id INTO target_unit FROM order_component_consumption c JOIN sales_order_line l ON l.id=c.sales_order_line_id JOIN sales_order o ON o.id=l.sales_order_id WHERE c.id=NEW.target_id;
 ELSE SELECT o.business_unit_id INTO target_unit FROM return_component_disposition d JOIN sales_return_line l ON l.id=d.sales_return_line_id JOIN sales_return r ON r.id=l.sales_return_id JOIN sales_order o ON o.id=r.sales_order_id WHERE d.id=NEW.target_id;
 END IF;
 IF target_unit IS NULL OR target_unit IS DISTINCT FROM run_unit THEN RAISE EXCEPTION 'valuation target scope mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER valuation_adjustment_scope BEFORE INSERT ON valuation_adjustment FOR EACH ROW EXECUTE FUNCTION check_valuation_target_scope();
