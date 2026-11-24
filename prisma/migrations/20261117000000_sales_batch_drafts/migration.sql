BEGIN;

-- Preserve all existing draft types and records while extending the shared store.
ALTER TABLE workflow_draft DROP CONSTRAINT workflow_draft_kind_check;
ALTER TABLE workflow_draft ADD CONSTRAINT workflow_draft_kind_check CHECK (
  kind IN (
    'LISTING', 'PURCHASE', 'COMPLETION', 'RETURN', 'REFUND', 'LISTING_RETURN',
    'COMMERCE_PURCHASE', 'COMMERCE_SALE',
    'COMMERCE_SALE_BATCH', 'COMMERCE_SALE_REVIEW', 'COMMERCE_SALE_MAPPING'
  )
);
CREATE INDEX workflow_draft_batch_scope_idx
  ON workflow_draft(workspace_id, business_unit_id, kind, operator_id, year, archived_at);

COMMIT;
