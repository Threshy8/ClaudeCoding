-- Fix existing Redo resend refund record to reference the original order number
-- instead of the resend order number.
-- Run this in: Supabase Dashboard → SQL Editor → New query

UPDATE shopify_refunds
SET order_number = '6084'
WHERE sku = 'BLK2ATS'
  AND refund_date = '2026-03-18'
  AND order_number = '7117';
