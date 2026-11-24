BEGIN;

ALTER TABLE purchase_document_line ADD COLUMN source_name TEXT;
CREATE INDEX purchase_document_line_item_variant_id_idx ON purchase_document_line(item_variant_id);

COMMIT;
