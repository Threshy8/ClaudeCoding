-- ============================================================
-- Opening Stock Insert — SCC Warehouse Export
-- Run in: Supabase Dashboard → SQL Editor → New query
-- Date: 2026-02-01
-- ============================================================

INSERT INTO purchases (sku, product_name, quantity, unit_cost, purchase_date, supplier, supplier_notes, po_number, quantity_remaining)
VALUES
  ('BLK2ATS', 'Atlas Watch Winder Black',      124,  27.69, '2026-02-01', 'SCC Opening Stock', 'Opening inventory balance', 'OPEN-2026', 124),
  ('BRN2ATS', 'Atlas Watch Winder Brown',        94,  27.69, '2026-02-01', 'SCC Opening Stock', 'Opening inventory balance', 'OPEN-2026',  94),
  ('BLK1CAR', 'Carina Watch Winder Black',      263,  16.73, '2026-02-01', 'SCC Opening Stock', 'Opening inventory balance', 'OPEN-2026', 263),
  ('BRN1CAR', 'Carina Watch Winder Brown',      305,  16.73, '2026-02-01', 'SCC Opening Stock', 'Opening inventory balance', 'OPEN-2026', 305),
  ('GRN1CYC', 'Cyclops Watch Winder Green',     123,  17.00, '2026-02-01', 'SCC Opening Stock', 'Opening inventory balance', 'OPEN-2026', 123),
  ('WHT1CYC', 'Cyclops Watch Winder White',     146,  17.00, '2026-02-01', 'SCC Opening Stock', 'Opening inventory balance', 'OPEN-2026', 146),
  ('BLK1VYG', 'Voyager 1 Slot Black',           126,  14.31, '2026-02-01', 'SCC Opening Stock', 'Opening inventory balance', 'OPEN-2026', 126),
  ('BLK2VYG', 'Voyager 2 Slot Black',           205,  14.62, '2026-02-01', 'SCC Opening Stock', 'Opening inventory balance', 'OPEN-2026', 205),
  ('BLK3VYG', 'Voyager 3 Slot Black',           143,  16.77, '2026-02-01', 'SCC Opening Stock', 'Opening inventory balance', 'OPEN-2026', 143),
  ('BLK2TAU', 'Taurus Watch Winder Black',       18,  70.77, '2026-02-01', 'SCC Opening Stock', 'Opening inventory balance', 'OPEN-2026',  18),
  ('WHT2TAU', 'Taurus Watch Winder White',       13,  70.77, '2026-02-01', 'SCC Opening Stock', 'Opening inventory balance', 'OPEN-2026',  13),
  ('GRY2TAU', 'Taurus Watch Winder Grey',        13,  70.77, '2026-02-01', 'SCC Opening Stock', 'Opening inventory balance', 'OPEN-2026',  13),
  ('BLK4LEO', 'Leone Watch Winder Black',         3, 100.00, '2026-02-01', 'SCC Opening Stock', 'Opening inventory balance', 'OPEN-2026',   3),
  ('GRY4LEO', 'Leone Watch Winder Grey',         11, 100.00, '2026-02-01', 'SCC Opening Stock', 'Opening inventory balance', 'OPEN-2026',  11),
  ('WHT4LEO', 'Leone Watch Winder White',         6, 100.00, '2026-02-01', 'SCC Opening Stock', 'Opening inventory balance', 'OPEN-2026',   6),
  ('BLK6IMP', 'Imperium Watch Winder Black',      9, 177.69, '2026-02-01', 'SCC Opening Stock', 'Opening inventory balance', 'OPEN-2026',   9),
  ('WHT6IMP', 'Imperium Watch Winder White',     10, 177.69, '2026-02-01', 'SCC Opening Stock', 'Opening inventory balance', 'OPEN-2026',  10),
  ('GRY6IMP', 'Imperium Watch Winder Grey',       9, 177.69, '2026-02-01', 'SCC Opening Stock', 'Opening inventory balance', 'OPEN-2026',   9);
