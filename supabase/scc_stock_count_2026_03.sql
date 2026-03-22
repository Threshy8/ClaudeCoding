-- ============================================================
-- SCC Warehouse Stock Count — March 2026
-- Run this in: Supabase Dashboard → SQL Editor → New query
--
-- This script:
--   1. Adds a 'location' column to purchase_order_lines
--   2. Creates a stock-count PO (SCC-STOCKCOUNT-2026-03)
--   3. Zeroes out quantity_remaining on existing PO lines for these SKUs
--   4. Inserts new PO lines with the warehouse-counted quantities
--
-- NOTE: After a FIFO recompute (POST /api/cogs/recompute), you must
-- re-run this script to restore stock count quantities, because
-- recompute resets quantity_remaining = quantity_ordered on ALL lines.
-- ============================================================

-- Step 1: Add location column if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'purchase_order_lines' AND column_name = 'location'
  ) THEN
    ALTER TABLE purchase_order_lines ADD COLUMN location text;
  END IF;
END $$;

-- Step 2: Label all existing PO lines as 'SCC' (default warehouse)
UPDATE purchase_order_lines SET location = 'SCC' WHERE location IS NULL;

-- Step 3: Create the stock-count PO header (skip if already exists)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM purchase_orders WHERE po_number = 'SCC-STOCKCOUNT-2026-03') THEN
    INSERT INTO purchase_orders (po_number, supplier, order_date, notes, status, total_value)
    VALUES (
      'SCC-STOCKCOUNT-2026-03',
      'SCC Warehouse',
      '2026-03-22',
      'Physical stock count — March 2026. Replaces FIFO-derived quantities with actual warehouse counts.',
      'open',
      0
    );
  END IF;
END $$;

-- Step 4: Get product names from existing data and build the stock count lines
DO $$
DECLARE
  v_po_id uuid;
  v_sku text;
  v_count int;
  v_product_name text;
  v_unit_cost numeric(12,2);
BEGIN
  -- Get the PO id
  SELECT id INTO v_po_id FROM purchase_orders WHERE po_number = 'SCC-STOCKCOUNT-2026-03';

  IF v_po_id IS NULL THEN
    RAISE EXCEPTION 'Stock count PO not found — insert may have been skipped by ON CONFLICT';
  END IF;

  -- Delete any previous stock-count lines for this PO (idempotent re-run)
  DELETE FROM purchase_order_lines WHERE po_id = v_po_id;

  -- Zero out quantity_remaining on ALL existing PO lines for the 18 SKUs
  -- (keeps quantity_ordered intact for FIFO history)
  UPDATE purchase_order_lines
  SET quantity_remaining = 0
  WHERE sku IN (
    'BLK1CAR','BLK1VYG','BLK2ATS','BLK2TAU','BLK2VYG',
    'BLK3VYG','BLK4LEO','BLK6IMP','BRN1CAR','BRN2ATS',
    'GRN1CYC','GRY2TAU','GRY4LEO','GRY6IMP','WHT1CYC',
    'WHT2TAU','WHT4LEO','WHT6IMP'
  )
  AND po_id != v_po_id;

  -- Helper: for each SKU, look up product_name and unit_cost from existing PO lines
  -- For new SKUs with no history, we derive names from the SKU pattern
  CREATE TEMP TABLE stock_counts (sku text, qty int) ON COMMIT DROP;
  INSERT INTO stock_counts VALUES
    ('BLK1CAR', 285), ('BLK1VYG', 139), ('BLK2ATS', 147), ('BLK2TAU', 23),
    ('BLK2VYG', 212), ('BLK3VYG', 149), ('BLK4LEO', 8),   ('BLK6IMP', 10),
    ('BRN1CAR', 323), ('BRN2ATS', 106), ('GRN1CYC', 135), ('GRY2TAU', 13),
    ('GRY4LEO', 11),  ('GRY6IMP', 10),  ('WHT1CYC', 149), ('WHT2TAU', 14),
    ('WHT4LEO', 6),   ('WHT6IMP', 10);

  FOR v_sku, v_count IN SELECT sku, qty FROM stock_counts LOOP
    -- Try to get product_name and unit_cost from existing PO lines
    SELECT product_name, unit_cost
    INTO v_product_name, v_unit_cost
    FROM purchase_order_lines
    WHERE sku = v_sku AND po_id != v_po_id
    ORDER BY created_at DESC
    LIMIT 1;

    -- If no existing data, try products table
    IF v_product_name IS NULL THEN
      SELECT product_name, current_unit_cost
      INTO v_product_name, v_unit_cost
      FROM products
      WHERE sku = v_sku
      LIMIT 1;
    END IF;

    -- If still no data, derive product name from SKU pattern
    IF v_product_name IS NULL THEN
      v_unit_cost := 0;
      v_product_name := CASE
        WHEN v_sku LIKE '%CAR' THEN 'The Carina'
        WHEN v_sku LIKE '%VYG' THEN 'The Voyage'
        WHEN v_sku LIKE '%ATS' THEN 'The Atlas'
        WHEN v_sku LIKE '%TAU' THEN 'The Taurus'
        WHEN v_sku LIKE '%LEO' THEN 'The Leo'
        WHEN v_sku LIKE '%IMP' THEN 'The Imperial'
        WHEN v_sku LIKE '%CYC' THEN 'The Cyclone'
        ELSE 'Unknown'
      END;
      -- Append colour from SKU prefix
      v_product_name := v_product_name || ' - ' || CASE
        WHEN v_sku LIKE 'BLK%' THEN 'Black'
        WHEN v_sku LIKE 'BRN%' THEN 'Brown'
        WHEN v_sku LIKE 'GRN%' THEN 'Green'
        WHEN v_sku LIKE 'GRY%' THEN 'Grey'
        WHEN v_sku LIKE 'WHT%' THEN 'White'
        ELSE 'Unknown'
      END;
    END IF;

    -- Insert the stock count PO line
    INSERT INTO purchase_order_lines (
      po_id, po_number, sku, product_name,
      quantity_ordered, quantity_remaining, unit_cost,
      supplier, order_date, location
    ) VALUES (
      v_po_id, 'SCC-STOCKCOUNT-2026-03', v_sku, v_product_name,
      v_count, v_count, COALESCE(v_unit_cost, 0),
      'SCC Warehouse', '2026-03-22', 'SCC'
    );

    RAISE NOTICE 'SKU % → % units (product: %, cost: $%)', v_sku, v_count, v_product_name, COALESCE(v_unit_cost, 0);
  END LOOP;

  -- Update the PO total_value
  UPDATE purchase_orders
  SET total_value = (
    SELECT COALESCE(SUM(unit_cost * quantity_ordered), 0)
    FROM purchase_order_lines WHERE po_id = v_po_id
  )
  WHERE id = v_po_id;
END $$;

-- Verify the results
SELECT sku, product_name, quantity_remaining as stock, unit_cost, location
FROM purchase_order_lines
WHERE po_number = 'SCC-STOCKCOUNT-2026-03'
ORDER BY sku;
