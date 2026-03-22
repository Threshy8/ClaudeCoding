-- ============================================================
-- Migration: Add line_revenue_cents to cogs_entries
-- Stores the actual Shopify line total in integer cents to avoid
-- rounding errors from sale_price * quantity reconstruction.
-- Run this in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

alter table cogs_entries
  add column if not exists line_revenue_cents integer;

comment on column cogs_entries.line_revenue_cents is
  'Actual Shopify line total in integer cents (from shopify_sales.line_revenue). '
  'Avoids rounding errors when sale_price * qty != line total due to discount allocation.';

-- Backfill from shopify_sales for existing rows
update cogs_entries ce
set line_revenue_cents = round(ss.line_revenue * 100)::integer
from shopify_sales ss
where ce.shopify_order_id = ss.shopify_order_id
  and ce.sku = ss.sku
  and ss.line_revenue is not null
  and ce.line_revenue_cents is null;
