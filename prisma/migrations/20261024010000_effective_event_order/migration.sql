-- Previously recorded corrections keep their original operation order.
-- New corrections retain the order explicitly reviewed by the operator.
ALTER TABLE event_date_correction ADD COLUMN valuation_order numeric(60,30);
