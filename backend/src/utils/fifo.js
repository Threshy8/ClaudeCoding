/**
 * FIFO Engine — WBC COGS System
 * 
 * Processes sales and writes locked-in cogs_entries rows.
 * Called after every Shopify sync.
 * 
 * Logic:
 *   1. Find all shopify_sales rows that don't yet have a cogs_entry
 *   2. For each sale, consume purchase_order_lines in FIFO order (oldest first)
 *   3. Look up GermanDrop shipping cost if order is GD-fulfilled
 *   4. Write cogs_entries row with all cost components locked in
 */

const supabase = require('../db/supabase');

/**
 * Run FIFO engine for a given store.
 * Returns summary of what was processed.
 */
async function runFifoEngine(store = 'au', startDate = '2026-03-12') {
  const results = {
    processed: 0,
    skipped_no_lot: [],
    errors: [],
  };

  // 1. Get all sales that don't yet have a cogs_entry
  const { data: sales, error: salesErr } = await supabase
    .from('shopify_sales')
    .select('shopify_order_id, order_number, order_date, sku, product_name, quantity_sold, sale_price, fulfillment_location, store')
    .eq('store', store);

  if (salesErr) throw new Error('Failed to fetch sales: ' + salesErr.message);
  if (!sales || sales.length === 0) return results;

  // 2. Get existing cogs_entries to avoid duplicates (shopify_order_id + sku is unique)
  const { data: existingEntries } = await supabase
    .from('cogs_entries')
    .select('shopify_order_id, sku');

  const existingSet = new Set(
    (existingEntries || []).map(e => `${e.shopify_order_id}__${e.sku}`)
  );

  // 3. Get all GermanDrop order costs (for shipping component)
  const { data: gdCosts } = await supabase
    .from('germandrop_order_costs')
    .select('shopify_order_id, shipping_cost');

  const gdCostMap = {};
  for (const g of (gdCosts || [])) {
    gdCostMap[g.shopify_order_id] = parseFloat(g.shipping_cost || 0);
  }

  // 4. Get all SCC per-unit handling fees from fulfillment_line_items
  // These are allocated per unit in the fulfillment system
  const { data: sccItems } = await supabase
    .from('fulfillment_line_items')
    .select('shopify_order_id, sku, per_unit_cost');

  const sccMap = {};
  for (const s of (sccItems || [])) {
    if (s.shopify_order_id && s.sku) {
      sccMap[`${s.shopify_order_id}__${s.sku}`] = parseFloat(s.per_unit_cost || 0);
    }
  }

  // 5. Get all available FIFO lots (quantity_remaining > 0), ordered oldest first
  const { data: allLots, error: lotsErr } = await supabase
    .from('purchase_order_lines')
    .select('id, po_number, sku, unit_cost, quantity_remaining, order_date, supplier')
    .gt('quantity_remaining', 0)
    .order('order_date', { ascending: true })
    .order('created_at', { ascending: true });

  if (lotsErr) throw new Error('Failed to fetch lots: ' + lotsErr.message);

  // Build mutable FIFO queue per SKU (in memory for this run)
  const fifoQueues = {}; // { sku: [ { id, po_number, unit_cost, quantity_remaining, ... } ] }
  for (const lot of (allLots || [])) {
    if (!fifoQueues[lot.sku]) fifoQueues[lot.sku] = [];
    fifoQueues[lot.sku].push({ ...lot, quantity_remaining: lot.quantity_remaining });
  }

  // Track lot quantity changes to batch-update at the end
  const lotUpdates = {}; // { lot_id: new_quantity_remaining }

  // 6. Group sales by order to calculate per-order unit counts (for GD shipping allocation)
  const orderUnitCounts = {};
  for (const s of sales) {
    if (s.order_date < startDate) continue;
    const skuLower = (s.sku || '').toLowerCase();
    if (skuLower === 'x-redo' || skuLower === 'shipping' || skuLower === 'tax') continue;
    orderUnitCounts[s.shopify_order_id] = (orderUnitCounts[s.shopify_order_id] || 0) + s.quantity_sold;
  }

  // 7. Process each sale
  const entriesToInsert = [];

  for (const sale of sales) {
    // Skip sales before the opening stock date
    if (sale.order_date < startDate) continue;

    // Skip virtual SKU lines (redo fees, shipping, tax)
    const skuLower2 = (sale.sku || '').toLowerCase();
    if (skuLower2 === 'x-redo' || skuLower2 === 'shipping' || skuLower2 === 'tax') continue;

    const key = `${sale.shopify_order_id}__${sale.sku}`;

    // Skip if already has a cogs_entry
    if (existingSet.has(key)) continue;

    const qty = sale.quantity_sold || 0;
    if (qty <= 0) continue;

    // --- FIFO cost resolution ---
    const queue = fifoQueues[sale.sku] || [];
    let remainingQty = qty;
    let totalPurchaseCost = 0;
    let primaryLotId = null;
    let primaryPoNumber = null;
    let hasLot = false;

    for (const lot of queue) {
      if (remainingQty <= 0) break;
      if (lot.quantity_remaining <= 0) continue;

      hasLot = true;
      if (!primaryLotId) {
        primaryLotId = lot.id;
        primaryPoNumber = lot.po_number;
      }

      const consume = Math.min(remainingQty, lot.quantity_remaining);
      totalPurchaseCost += consume * parseFloat(lot.unit_cost);
      lot.quantity_remaining -= consume;
      remainingQty -= consume;

      // Track for DB update
      lotUpdates[lot.id] = lot.quantity_remaining;
    }

    // If we couldn't fill from lots, use 0 cost but flag it
    if (!hasLot) {
      results.skipped_no_lot.push({ sku: sale.sku, order: sale.order_number });
    }

    // If partially filled (more sold than in stock), cost what we have
    const unitPurchaseCost = qty > 0 ? totalPurchaseCost / qty : 0;

    // --- GermanDrop shipping allocation ---
    const isGermanDrop = (sale.fulfillment_location || '').toLowerCase().includes('germandrop') ||
                         (sale.fulfillment_location || '').toLowerCase().includes('gd-fulfillment');
    const gdTotalShipping = gdCostMap[sale.shopify_order_id] || 0;
    const orderTotalUnits = orderUnitCounts[sale.shopify_order_id] || qty;
    const unitGdShipping = isGermanDrop && gdTotalShipping > 0
      ? (gdTotalShipping / orderTotalUnits)
      : 0;

    // --- SCC handling fee ---
    const unitSccHandling = sccMap[key] || 0;

    // --- Total COGS per unit ---
    const totalUnitCogs = unitPurchaseCost + unitGdShipping + unitSccHandling;
    const salePrice = parseFloat(sale.sale_price || 0);
    const grossProfit = (salePrice - totalUnitCogs) * qty;

    entriesToInsert.push({
      shopify_order_id:    sale.shopify_order_id,
      order_number:        sale.order_number,
      order_date:          sale.order_date,
      sku:                 sale.sku,
      product_name:        sale.product_name,
      quantity_sold:       qty,
      po_line_id:          primaryLotId,
      po_number:           primaryPoNumber,
      unit_purchase_cost:  Math.round(unitPurchaseCost * 10000) / 10000,
      unit_gd_shipping:    Math.round(unitGdShipping * 10000) / 10000,
      unit_scc_handling:   Math.round(unitSccHandling * 10000) / 10000,
      total_unit_cogs:     Math.round(totalUnitCogs * 10000) / 10000,
      sale_price:          salePrice,
      gross_profit:        Math.round(grossProfit * 10000) / 10000,
      store:               sale.store || store,
      fulfillment_location: sale.fulfillment_location,
      locked_at:           new Date().toISOString(),
    });
  }

  // 8. Insert cogs_entries in batches
  for (let i = 0; i < entriesToInsert.length; i += 100) {
    const batch = entriesToInsert.slice(i, i + 100);
    const { error } = await supabase
      .from('cogs_entries')
      .upsert(batch, { onConflict: 'shopify_order_id,sku' });
    if (error) results.errors.push(error.message);
    else results.processed += batch.length;
  }

  // 9. Update lot quantity_remaining in DB
  const lotUpdateEntries = Object.entries(lotUpdates);
  for (const [lotId, newQty] of lotUpdateEntries) {
    const { error } = await supabase
      .from('purchase_order_lines')
      .update({ quantity_remaining: newQty })
      .eq('id', lotId);
    if (error) results.errors.push(`Lot update failed ${lotId}: ${error.message}`);
  }

  // 10. Update PO statuses (open / partial / closed)
  await updatePoStatuses();

  return results;
}

/**
 * Recalculate and update status for all purchase_orders
 * open = all quantity_remaining == quantity_ordered
 * partial = some consumed
 * closed = all quantity_remaining == 0
 */
async function updatePoStatuses() {
  const { data: pos } = await supabase
    .from('purchase_orders')
    .select('id');
  if (!pos) return;

  for (const po of pos) {
    const { data: lines } = await supabase
      .from('purchase_order_lines')
      .select('quantity_ordered, quantity_remaining')
      .eq('po_id', po.id);

    if (!lines || lines.length === 0) continue;

    const totalOrdered = lines.reduce((s, l) => s + l.quantity_ordered, 0);
    const totalRemaining = lines.reduce((s, l) => s + l.quantity_remaining, 0);

    let status = 'open';
    if (totalRemaining === 0) status = 'closed';
    else if (totalRemaining < totalOrdered) status = 'partial';

    await supabase
      .from('purchase_orders')
      .update({ status })
      .eq('id', po.id);
  }
}

/**
 * Recalculate ALL cogs_entries from scratch (full recompute).
 * Use this when purchase lots are edited/deleted.
 * WARNING: Deletes all existing cogs_entries and re-runs FIFO.
 */
async function recomputeAllCogs(store = 'au', startDate = '2026-03-12') {
  // Reset all lot quantities to original ordered quantities
  const { data: lines } = await supabase
    .from('purchase_order_lines')
    .select('id, quantity_ordered');

  for (const line of (lines || [])) {
    await supabase
      .from('purchase_order_lines')
      .update({ quantity_remaining: line.quantity_ordered })
      .eq('id', line.id);
  }

  // Delete all cogs_entries for this store
  await supabase
    .from('cogs_entries')
    .delete()
    .eq('store', store);

  // Re-run FIFO
  return runFifoEngine(store, startDate);
}

module.exports = { runFifoEngine, recomputeAllCogs };
