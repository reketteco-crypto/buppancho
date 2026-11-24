-- Expand incomplete draft types without changing existing records or applied migrations.
ALTER TABLE workflow_draft DROP CONSTRAINT workflow_draft_kind_check;
ALTER TABLE workflow_draft ADD CONSTRAINT workflow_draft_kind_check
  CHECK (kind IN ('LISTING', 'PURCHASE', 'COMPLETION', 'RETURN', 'REFUND'));
