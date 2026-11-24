-- A cancelled draft was never received. Do not invent a finalized_at timestamp.
ALTER TABLE purchase DROP CONSTRAINT purchase_status_time_check;
ALTER TABLE purchase ADD CONSTRAINT purchase_status_time_check CHECK (
  (status = 'finalized' AND finalized_at IS NOT NULL AND cancelled_at IS NULL) OR
  (status = 'cancelled' AND cancelled_at IS NOT NULL) OR
  (status NOT IN ('finalized', 'cancelled') AND finalized_at IS NULL AND cancelled_at IS NULL)
);
