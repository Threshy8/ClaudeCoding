-- ============================================================
-- Stock Adjustments — Physical Inventory Counts
-- Run this in: Supabase Dashboard → SQL Editor → New query
--
-- This table stores the delta between physical warehouse counts
-- and FIFO-derived quantities. The inventory endpoint computes:
--   on_hand = SUM(purchase_order_lines.quantity_remaining) + SUM(stock_adjustments.delta)
--
-- This survives FIFO recomputes — the adjustments layer sits on
-- top of the FIFO data, not inside it.
-- ============================================================

create table if not exists stock_adjustments (
  id               uuid primary key default gen_random_uuid(),
  sku              text not null,
  adjustment_date  date not null,
  physical_count   integer not null,
  system_count     integer not null,
  delta            integer not null,  -- physical_count - system_count
  location         text not null default 'SCC',
  notes            text,
  created_at       timestamptz default now()
);

create index if not exists stock_adj_sku_idx on stock_adjustments(sku);
create index if not exists stock_adj_date_idx on stock_adjustments(adjustment_date);

-- RLS
alter table stock_adjustments enable row level security;
create policy "Allow all for anon" on stock_adjustments for all using (true) with check (true);

-- ============================================================
-- Clean up old stock-count PO approach
-- This removes the fake SCC-STOCKCOUNT-2026-03 PO and its lines.
-- After running this, run POST /api/cogs/recompute to restore
-- correct FIFO quantity_remaining values.
-- ============================================================
DELETE FROM purchase_order_lines
WHERE po_number = 'SCC-STOCKCOUNT-2026-03';

DELETE FROM purchase_orders
WHERE po_number = 'SCC-STOCKCOUNT-2026-03';

-- Restore any zeroed-out quantity_remaining values:
-- The old script set quantity_remaining = 0 on real PO lines.
-- Running POST /api/cogs/recompute will reset all lines to
-- quantity_ordered and re-run FIFO, which fixes this automatically.
-- You MUST run recompute after this migration.

-- ============================================================
-- Insert initial physical counts as stock adjustments.
-- system_count will be populated by the API when real counts
-- are submitted; for this seed data we set system_count = 0
-- and delta = physical_count (full override).
-- After FIFO recompute runs, new adjustments should use the
-- POST /api/inventory/adjustment endpoint which computes the
-- real system_count and delta.
-- ============================================================
INSERT INTO stock_adjustments (sku, adjustment_date, physical_count, system_count, delta, location, notes)
VALUES
  ('BLK1CAR', '2026-03-22', 285, 0, 285, 'SCC', 'March 2026 SCC physical count — initial import'),
  ('BLK1VYG', '2026-03-22', 139, 0, 139, 'SCC', 'March 2026 SCC physical count — initial import'),
  ('BLK2ATS', '2026-03-22', 147, 0, 147, 'SCC', 'March 2026 SCC physical count — initial import'),
  ('BLK2TAU', '2026-03-22', 23,  0, 23,  'SCC', 'March 2026 SCC physical count — initial import'),
  ('BLK2VYG', '2026-03-22', 212, 0, 212, 'SCC', 'March 2026 SCC physical count — initial import'),
  ('BLK3VYG', '2026-03-22', 149, 0, 149, 'SCC', 'March 2026 SCC physical count — initial import'),
  ('BLK4LEO', '2026-03-22', 8,   0, 8,   'SCC', 'March 2026 SCC physical count — initial import'),
  ('BLK6IMP', '2026-03-22', 10,  0, 10,  'SCC', 'March 2026 SCC physical count — initial import'),
  ('BRN1CAR', '2026-03-22', 323, 0, 323, 'SCC', 'March 2026 SCC physical count — initial import'),
  ('BRN2ATS', '2026-03-22', 106, 0, 106, 'SCC', 'March 2026 SCC physical count — initial import'),
  ('GRN1CYC', '2026-03-22', 135, 0, 135, 'SCC', 'March 2026 SCC physical count — initial import'),
  ('GRY2TAU', '2026-03-22', 13,  0, 13,  'SCC', 'March 2026 SCC physical count — initial import'),
  ('GRY4LEO', '2026-03-22', 11,  0, 11,  'SCC', 'March 2026 SCC physical count — initial import'),
  ('GRY6IMP', '2026-03-22', 10,  0, 10,  'SCC', 'March 2026 SCC physical count — initial import'),
  ('WHT1CYC', '2026-03-22', 149, 0, 149, 'SCC', 'March 2026 SCC physical count — initial import'),
  ('WHT2TAU', '2026-03-22', 14,  0, 14,  'SCC', 'March 2026 SCC physical count — initial import'),
  ('WHT4LEO', '2026-03-22', 6,   0, 6,   'SCC', 'March 2026 SCC physical count — initial import'),
  ('WHT6IMP', '2026-03-22', 10,  0, 10,  'SCC', 'March 2026 SCC physical count — initial import')
ON CONFLICT DO NOTHING;

-- Verify
SELECT sku, physical_count, system_count, delta, location, notes
FROM stock_adjustments
ORDER BY sku;
