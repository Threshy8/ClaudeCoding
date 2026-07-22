const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');

// ── Shared helpers ──────────────────────────────────────────────────────────

/** Convert a dollar value to integer cents for accumulation without float drift */
const toCents = (v) => Math.round(parseFloat(v || 0) * 100);

/** SKUs that represent fees/adjustments, not physical products */
const VIRTUAL_REFUND_SKUS = ['shipping', 'x-redo', 'tax'];

/** Sum virtual SKU revenue in integer cents */
function sumVirtualCents(rows, sku) {
  return (rows || []).filter(r => r.sku === sku)
    .reduce((s, r) => s + toCents(r.sale_price) * (r.quantity_sold || 0), 0);
}

/**
 * Fetch net stock adjustment deltas per SKU from the stock_adjustments table.
 * Returns { sku: totalDelta } map. These deltas are added to FIFO-derived
 * quantity_remaining to get the true on-hand count.
 */
async function getStockAdjustmentDeltas() {
  const { data, error } = await supabase
    .from('stock_adjustments')
    .select('sku, delta');
  if (error) {
    console.error('stock_adjustments query error:', error.message);
    return {};
  }
  const map = {};
  for (const row of (data || [])) {
    map[row.sku] = (map[row.sku] || 0) + row.delta;
  }
  return map;
}

/**
 * Average cost method:
 * For each SKU, calculate the weighted average unit cost from all purchases.
 * COGS = units_sold × average_unit_cost
 * Inventory Asset Value = units_on_hand × average_unit_cost
 * units_on_hand = total_purchased - total_sold (all time)
 */

// periodStart / periodEnd are YYYY-MM-DD strings; periodEnd is exclusive
async function buildCogsData(periodStart, periodEnd, periodLabel) {
  // 1. Get all purchases (all time) to compute average costs and total stock purchased
  const { data: allPurchases, error: purchaseError } = await supabase
    .from('purchases')
    .select('sku, product_name, quantity, unit_cost');

  if (purchaseError) throw new Error(purchaseError.message);

  // 2. Get gross sales (all time) — used with all-time refunds for inventory on-hand
  const { data: allSales, error: allSalesError } = await supabase
    .from('shopify_sales')
    .select('sku, quantity_sold')
    .neq('sku', 'x-redo').neq('sku', 'shipping').neq('sku', 'tax');

  if (allSalesError) throw new Error(allSalesError.message);

  // 3. Get all refunds (all time) — subtract from gross to get net sold for inventory on-hand
  const { data: allRefunds, error: allRefundsError } = await supabase
    .from('shopify_refunds')
    .select('sku, quantity_refunded, order_number');

  if (allRefundsError) throw new Error(allRefundsError.message);

  // 3b. Get all Redo returns (all time) for inventory on-hand — only completed
  const { data: allRedoReturns } = await supabase
    .from('redo_returns')
    .select('sku, quantity_returned, shopify_order_name')
    .eq('status', 'complete');

  // 4. Get gross sales for the period (by order_date)
  const { data: periodSales, error: periodSalesError } = await supabase
    .from('shopify_sales')
    .select('sku, product_name, quantity_sold, sale_price, line_revenue, gross_price, discount_amount, order_date')
    .gte('order_date', periodStart)
    .lt('order_date', periodEnd)
    .neq('sku', 'x-redo').neq('sku', 'shipping').neq('sku', 'tax');

  if (periodSalesError) throw new Error(periodSalesError.message);

  // 5. Get refunds processed in the period (by refund_date, not order_date)
  //    This matches Shopify's "Net items sold" methodology: returns reduce the period
  //    in which they happen, regardless of when the original order was placed.
  const { data: periodRefunds, error: periodRefundsError } = await supabase
    .from('shopify_refunds')
    .select('sku, product_name, quantity_refunded, refund_subtotal, order_number, refund_date')
    .gte('refund_date', periodStart)
    .lt('refund_date', periodEnd);

  if (periodRefundsError) throw new Error(periodRefundsError.message);

  // 5b. Get Redo returns processed in the period (by return_date) — only completed
  const { data: periodRedoReturns } = await supabase
    .from('redo_returns')
    .select('sku, product_name, quantity_returned, refund_amount, shopify_order_name, return_date')
    .gte('return_date', periodStart)
    .lt('return_date', periodEnd)
    .eq('status', 'complete');

  // --- Build average cost map per SKU ---
  // totalCostCents accumulates in integer cents to avoid float drift
  const skuCostMap = {}; // { sku: { totalQty, totalCostCents, productName } }
  for (const p of allPurchases) {
    if (!skuCostMap[p.sku]) {
      skuCostMap[p.sku] = { totalQty: 0, totalCostCents: 0, productName: p.product_name };
    }
    skuCostMap[p.sku].totalQty += p.quantity;
    skuCostMap[p.sku].totalCostCents += toCents(p.unit_cost) * p.quantity;
  }

  const avgCostMap = {};       // { sku: avgCost in dollars }
  const totalPurchasedMap = {}; // { sku: totalQty }
  for (const [sku, d] of Object.entries(skuCostMap)) {
    avgCostMap[sku] = d.totalQty > 0 ? d.totalCostCents / d.totalQty / 100 : 0;
    totalPurchasedMap[sku] = d.totalQty;
  }

  // --- Build sets from shopify_refunds for Redo return validation ---
  // order+sku set: avoid double-counting if shopify_refunds already has exact match
  // order set: only count Redo returns where Shopify has actually processed a refund
  const refundOrderSkuSet = new Set();
  const refundOrderSet = new Set();
  for (const r of allRefunds) {
    if (r.order_number) {
      refundOrderSkuSet.add(`${r.order_number}|${r.sku}`);
      refundOrderSet.add(r.order_number);
    }
  }

  // --- Build all-time net units sold map per SKU (gross sales − all-time refunds) ---
  const allTimeSoldMap = {}; // { sku: netSold }
  for (const s of allSales) {
    allTimeSoldMap[s.sku] = (allTimeSoldMap[s.sku] || 0) + s.quantity_sold;
  }
  for (const r of allRefunds) {
    allTimeSoldMap[r.sku] = (allTimeSoldMap[r.sku] || 0) - r.quantity_refunded;
  }
  for (const r of (allRedoReturns || [])) {
    const orderNum = (r.shopify_order_name || '').replace(/^#/, '');
    // Only count if Shopify has processed a refund for this order
    if (!refundOrderSet.has(orderNum)) continue;
    // Skip if exact order+sku already in shopify_refunds (avoid double-counting)
    if (refundOrderSkuSet.has(`${orderNum}|${r.sku}`)) continue;
    allTimeSoldMap[r.sku] = (allTimeSoldMap[r.sku] || 0) - r.quantity_returned;
  }

  // --- Build period refund map (by refund_date) ---
  // subtotalCents accumulates in integer cents
  const periodRefundMap = {};
  for (const r of periodRefunds) {
    if (!periodRefundMap[r.sku]) {
      periodRefundMap[r.sku] = { product_name: r.product_name, qty: 0, subtotalCents: 0, details: [] };
    }
    periodRefundMap[r.sku].qty += r.quantity_refunded;
    periodRefundMap[r.sku].subtotalCents += toCents(r.refund_subtotal);
    periodRefundMap[r.sku].details.push({
      order_number: r.order_number,
      refund_date: r.refund_date,
      quantity: r.quantity_refunded,
      refund_amount: parseFloat(r.refund_subtotal || 0),
    });
  }
  // Build sets from period refunds for Redo validation
  const periodRefundOrderSkuSet = new Set();
  const periodRefundOrderSet = new Set();
  for (const r of periodRefunds) {
    if (r.order_number) {
      periodRefundOrderSkuSet.add(`${r.order_number}|${r.sku}`);
      periodRefundOrderSet.add(r.order_number);
    }
  }
  // Merge Redo returns — only if Shopify has processed a refund for this order
  for (const r of (periodRedoReturns || [])) {
    const orderNum = (r.shopify_order_name || '').replace(/^#/, '');
    if (!periodRefundOrderSet.has(orderNum)) continue;
    if (periodRefundOrderSkuSet.has(`${orderNum}|${r.sku}`)) continue;
    const sku = r.sku;
    if (!periodRefundMap[sku]) {
      periodRefundMap[sku] = { product_name: r.product_name, qty: 0, subtotalCents: 0, details: [] };
    }
    periodRefundMap[sku].qty += r.quantity_returned;
    periodRefundMap[sku].subtotalCents += toCents(r.refund_amount);
    periodRefundMap[sku].details.push({
      order_number: orderNum,
      refund_date: r.return_date,
      quantity: r.quantity_returned,
      refund_amount: parseFloat(r.refund_amount || 0),
      source: 'redo',
    });
  }

  // --- Build period gross sales summary per SKU ---
  // grossRevenueCents accumulates in integer cents
  const periodSkuMap = {}; // { sku: { product_name, gross_units, grossRevenueCents, grossPriceCents, discountCents } }
  for (const s of periodSales) {
    if (!periodSkuMap[s.sku]) {
      periodSkuMap[s.sku] = { product_name: s.product_name, gross_units: 0, grossRevenueCents: 0, grossPriceCents: 0, discountCents: 0 };
    }
    periodSkuMap[s.sku].gross_units += s.quantity_sold;
    const lineRevCents = s.line_revenue != null
      ? toCents(s.line_revenue)
      : toCents(s.sale_price) * s.quantity_sold;
    periodSkuMap[s.sku].grossRevenueCents += lineRevCents;
    // Accumulate pre-discount gross price and discount amount
    periodSkuMap[s.sku].grossPriceCents += s.gross_price != null
      ? toCents(s.gross_price)
      : lineRevCents; // fallback: if gross_price not yet populated, use line_revenue
    periodSkuMap[s.sku].discountCents += toCents(s.discount_amount);
  }

  // Merge period refunds into periodSkuMap so cross-period returns create entries too
  // (skip virtual SKUs — shipping/redo/tax refunds are handled separately in the breakdown)
  for (const [sku, r] of Object.entries(periodRefundMap)) {
    if (['shipping', 'x-redo', 'tax'].includes(sku)) continue;
    if (!periodSkuMap[sku]) {
      periodSkuMap[sku] = { product_name: r.product_name, gross_units: 0, grossRevenueCents: 0 };
    }
  }

  // --- Build per-SKU breakdown ---
  // Net units = gross orders in period − refunds processed in period (by refund_date)
  // Net revenue = gross revenue − refund subtotals processed in period
  const skuBreakdown = [];

  for (const [sku, d] of Object.entries(periodSkuMap)) {
    const refund = periodRefundMap[sku] || { qty: 0, subtotalCents: 0 };
    const units_sold = d.gross_units - refund.qty;
    const revenueCents = d.grossRevenueCents - refund.subtotalCents;
    const revenue = revenueCents / 100;

    const avgCost = avgCostMap[sku] || 0;
    const cogs = units_sold * avgCost;
    const grossMargin = revenue > 0 ? ((revenue - cogs) / revenue) * 100 : 0;

    const totalPurchased = totalPurchasedMap[sku] || 0;
    const totalSoldAllTime = allTimeSoldMap[sku] || 0;
    const unitsOnHand = Math.max(0, totalPurchased - totalSoldAllTime);

    skuBreakdown.push({
      sku,
      product_name: d.product_name || skuCostMap[sku]?.productName || 'Unknown',
      units_sold,
      units_gross: d.gross_units,
      units_returned: refund.qty,
      refund_details: refund.details || [],
      avg_unit_cost: Math.round(avgCost * 100) / 100,
      revenue,
      cogs: Math.round(cogs * 100) / 100,
      gross_margin_pct: Math.round(grossMargin * 100) / 100,
      units_on_hand: unitsOnHand,
      inventory_value: Math.round(unitsOnHand * avgCost * 100) / 100,
    });
  }

  // Also include SKUs that have inventory but no period sales (for inventory value)
  for (const [sku, d] of Object.entries(skuCostMap)) {
    if (periodSkuMap[sku]) continue;
    const avgCost = avgCostMap[sku] || 0;
    const totalPurchased = totalPurchasedMap[sku] || 0;
    const totalSoldAllTime = allTimeSoldMap[sku] || 0;
    const unitsOnHand = Math.max(0, totalPurchased - totalSoldAllTime);
    if (unitsOnHand > 0) {
      skuBreakdown.push({
        sku,
        product_name: d.productName,
        units_sold: 0,
        units_gross: 0,
        units_returned: 0,
        avg_unit_cost: Math.round(avgCost * 100) / 100,
        revenue: 0,
        cogs: 0,
        gross_margin_pct: null,
        units_on_hand: unitsOnHand,
        inventory_value: Math.round(unitsOnHand * avgCost * 100) / 100,
      });
    }
  }

  // --- Virtual SKU totals (Redo fees, Shipping, Tax) ---
  const { data: virtualRows } = await supabase
    .from('shopify_sales')
    .select('sku, quantity_sold, sale_price')
    .gte('order_date', periodStart)
    .lt('order_date', periodEnd)
    .in('sku', ['x-redo', 'shipping', 'tax']);

  const redoFeesCents = sumVirtualCents(virtualRows, 'x-redo');
  const redoUnits = (virtualRows || []).filter(r => r.sku === 'x-redo')
    .reduce((s, r) => s + (r.quantity_sold || 0), 0);
  const shippingTotalCents = sumVirtualCents(virtualRows, 'shipping');
  const taxTotalCents = sumVirtualCents(virtualRows, 'tax');

  // --- Sales breakdown (all in integer cents) ---
  // gross_sales = pre-discount price × qty (matches Shopify's "Gross sales")
  // total_discounts = sum of discount_allocations (matches Shopify's "Discounts")
  // grossRevenueCents = post-discount line revenue (gross_sales - discounts)
  const grossSalesCents = Object.values(periodSkuMap).reduce((s, d) => s + d.grossPriceCents, 0);
  const totalDiscountsCents = Object.values(periodSkuMap).reduce((s, d) => s + d.discountCents, 0);

  // Split refunds: product returns vs shipping/virtual SKU refunds
  const totalReturnsCents = Object.entries(periodRefundMap)
    .filter(([sku]) => !VIRTUAL_REFUND_SKUS.includes(sku))
    .reduce((s, [, d]) => s + d.subtotalCents, 0);
  const shippingRefundsCents = (periodRefundMap['shipping'] || { subtotalCents: 0 }).subtotalCents;

  const netSalesCents = grossSalesCents - totalDiscountsCents - totalReturnsCents;
  const shippingRevenueCents = shippingTotalCents - shippingRefundsCents;
  const totalCollectedCents = netSalesCents + redoFeesCents; // excludes shipping to match Shopify "Total sales over time"

  // --- Totals (cents-based for revenue, float for cost fields) ---
  const totalRevenueCents = skuBreakdown.reduce((s, r) => s + Math.round(r.revenue * 100), 0);
  const totalCogs = skuBreakdown.reduce((s, r) => s + r.cogs, 0);
  const totalInventoryValue = skuBreakdown.reduce((s, r) => s + r.inventory_value, 0);
  const totalRevenue = totalRevenueCents / 100;
  const overallMargin = totalRevenue > 0 ? ((totalRevenue - totalCogs) / totalRevenue) * 100 : 0;

  return {
    period: periodLabel,
    period_start: periodStart,
    period_end: periodEnd,
    total_revenue: (totalRevenueCents + redoFeesCents + shippingTotalCents) / 100,
    total_cogs: Math.round(totalCogs * 100) / 100,
    total_inventory_value: Math.round(totalInventoryValue * 100) / 100,
    gross_margin_pct: Math.round(overallMargin * 100) / 100,
    redo_fees: redoFeesCents / 100,
    redo_units: redoUnits,
    shipping_total: shippingTotalCents / 100,
    tax_total: taxTotalCents / 100,
    // Sales breakdown (mirrors Shopify's Total Sales view)
    gross_sales: grossSalesCents / 100,
    total_discounts: totalDiscountsCents / 100,
    total_returns: totalReturnsCents / 100,
    net_sales: netSalesCents / 100,
    shipping_revenue: shippingRevenueCents / 100,
    total_collected: totalCollectedCents / 100,
    sku_breakdown: skuBreakdown,
  };
}

// GET /api/cogs/summary
// New mode:    ?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD  (both inclusive)
// Legacy mode: ?period=YYYY-MM[&through=YYYY-MM-DD]         (for journal export compat)
router.get('/summary', async (req, res) => {
  const { period, through, start_date, end_date } = req.query;

  let periodStart, periodEnd, periodLabel;

  if (start_date && end_date) {
    // New date-range mode — end_date is inclusive so periodEnd = next day
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date) || !/^\d{4}-\d{2}-\d{2}$/.test(end_date)) {
      return res.status(400).json({ error: 'start_date and end_date must be YYYY-MM-DD' });
    }
    if (start_date > end_date) {
      return res.status(400).json({ error: 'start_date must be <= end_date' });
    }
    periodStart = start_date;
    const endD = new Date(end_date + 'T12:00:00Z');
    endD.setUTCDate(endD.getUTCDate() + 1);
    periodEnd = endD.toISOString().slice(0, 10);
    periodLabel = `${start_date} – ${end_date}`;

  } else if (period) {
    // Legacy period mode (YYYY-MM)
    if (!/^\d{4}-\d{2}$/.test(period)) {
      return res.status(400).json({ error: 'period must be YYYY-MM (e.g. 2026-02)' });
    }
    const [year, month] = period.split('-').map(Number);
    periodStart = `${year}-${String(month).padStart(2, '0')}-01`;
    periodEnd = month === 12
      ? `${year + 1}-01-01`
      : `${year}-${String(month + 1).padStart(2, '0')}-01`;

    if (through && /^\d{4}-\d{2}-\d{2}$/.test(through)) {
      const throughDate = new Date(through + 'T12:00:00Z');
      throughDate.setUTCDate(throughDate.getUTCDate() + 1);
      periodEnd = throughDate.toISOString().slice(0, 10);
    } else {
      // Auto-cap at today for the current month
      const tz = process.env.SHOPIFY_STORE_TIMEZONE || 'Australia/Sydney';
      const now = new Date();
      const today = now.toLocaleDateString('en-CA', { timeZone: tz });
      const isCurrentMonth = period === today.slice(0, 7);
      if (isCurrentMonth && today >= periodStart && today < periodEnd) {
        const [ty, tm, td] = today.split('-').map(Number);
        const nextDay = new Date(Date.UTC(ty, tm - 1, td + 1));
        periodEnd = nextDay.toISOString().slice(0, 10);
      }
    }
    periodLabel = period;

  } else {
    return res.status(400).json({ error: 'Provide start_date+end_date or period query param' });
  }

  try {
    const data = await buildCogsData(periodStart, periodEnd, periodLabel);
    res.json(data);
  } catch (err) {
    console.error('COGS summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cogs/debug — shows raw row counts from both sales/refunds tables
// Useful for diagnosing sync issues; safe to call anytime
router.get('/debug', async (req, res) => {
  const store = req.query.store || 'au';

  const [salesRes, refundsRes, recentRefundsRes] = await Promise.all([
    supabase.from('shopify_sales').select('sku, quantity_sold, order_date', { count: 'exact' }).eq('store', store),
    supabase.from('shopify_refunds').select('sku, quantity_refunded, refund_date', { count: 'exact' }).eq('store', store),
    supabase.from('shopify_refunds')
      .select('sku, quantity_refunded, refund_date, shopify_refund_id')
      .eq('store', store)
      .order('refund_date', { ascending: false })
      .limit(20),
  ]);

  res.json({
    store,
    shopify_sales: {
      total_rows: salesRes.count,
      error: salesRes.error?.message || null,
    },
    shopify_refunds: {
      total_rows: refundsRes.count,
      error: refundsRes.error?.message || null,
      recent_20: recentRefundsRes.data || [],
      recent_error: recentRefundsRes.error?.message || null,
    },
  });
});

// ── GET /api/cogs/refunds ─────────────────────────────────────────────────────
// Returns all refunds with order date, refund date, SKU, qty, subtotal
router.get('/refunds', async (req, res) => {
  const { start_date, end_date, store = 'au' } = req.query;

  let query = supabase
    .from('shopify_refunds')
    .select('shopify_order_id, order_number, shopify_refund_id, sku, product_name, quantity_refunded, refund_subtotal, order_date, refund_date, store')
    .eq('store', store)
    .order('refund_date', { ascending: false });

  if (start_date) query = query.gte('refund_date', start_date);
  if (end_date)   query = query.lte('refund_date', end_date);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /api/cogs/resends ────────────────────────────────────────────────────
// Returns resend orders (order_number contains '-RESEND') with estimated COGS
router.get('/resends', async (req, res) => {
  const { start_date, end_date, store = 'au' } = req.query;

  // Get all purchases for avg cost calculation
  const { data: purchases, error: pErr } = await supabase
    .from('purchases')
    .select('sku, quantity, unit_cost');
  if (pErr) return res.status(500).json({ error: pErr.message });

  const costMap = {};
  for (const p of (purchases || [])) {
    if (!costMap[p.sku]) costMap[p.sku] = { totalCostCents: 0, totalQty: 0 };
    costMap[p.sku].totalCostCents += toCents(p.unit_cost) * p.quantity;
    costMap[p.sku].totalQty  += p.quantity;
  }
  const avgCostCents = (sku) => {
    const c = costMap[sku];
    return c && c.totalQty > 0 ? c.totalCostCents / c.totalQty : 0;
  };

  // Query resend orders (order_name is Shopify's order.name e.g. "#6310-RESEND")
  let query = supabase
    .from('shopify_sales')
    .select('shopify_order_id, order_number, order_name, customer_name, sku, product_name, quantity_sold, order_date, fulfillment_location')
    .eq('store', store)
    .ilike('order_name', '%-RESEND%')
    .order('order_date', { ascending: false });

  if (start_date) query = query.gte('order_date', start_date);
  if (end_date)   query = query.lte('order_date', end_date);

  const { data: sales, error: sErr } = await query;
  if (sErr) return res.status(500).json({ error: sErr.message });

  // Group by order (accumulate in cents)
  const orderMap = {};
  for (const s of (sales || [])) {
    if (!orderMap[s.shopify_order_id]) {
      const originalOrderNumber = (s.order_name || '').replace(/-RESEND.*$/i, '').replace(/^#/, '');
      orderMap[s.shopify_order_id] = {
        shopify_order_id:      s.shopify_order_id,
        order_number:          s.order_number || s.shopify_order_id,
        order_name:            s.order_name || null,
        original_order_number: originalOrderNumber,
        customer_name:         s.customer_name || '—',
        order_date:            s.order_date,
        fulfillment_location:  s.fulfillment_location || 'Unknown',
        line_items:            [],
        total_units:           0,
        estimated_cogs_cents:  0,
        notes:                 null,
      };
    }
    const o = orderMap[s.shopify_order_id];
    const qty = s.quantity_sold || 0;
    const cogsCents = Math.round(avgCostCents(s.sku) * qty);
    o.line_items.push({ sku: s.sku, product_name: s.product_name, qty });
    o.total_units          += qty;
    o.estimated_cogs_cents += cogsCents;
  }

  const orders = Object.values(orderMap).map(o => ({
    ...o,
    estimated_cogs: o.estimated_cogs_cents / 100,
  }));

  orders.sort((a, b) => b.order_date.localeCompare(a.order_date));

  const summary = {
    total_resends:       orders.length,
    total_units_resent:  orders.reduce((s, o) => s + o.total_units, 0),
    total_estimated_cogs: orders.reduce((s, o) => s + Math.round(o.estimated_cogs * 100), 0) / 100,
  };

  res.json({ summary, orders });
});

// ── GET /api/cogs/entries/by-sku ─────────────────────────────────────────────
// Returns FIFO-based per-SKU breakdown from cogs_entries, same shape as /summary
router.get('/entries/by-sku', async (req, res) => {
  const { start_date, end_date, store = 'au' } = req.query;
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date and end_date required' });

  try {
    // Get FIFO entries for the period
    const { data: entries, error: eErr } = await supabase
      .from('cogs_entries')
      .select('sku, product_name, quantity_sold, unit_purchase_cost, unit_gd_shipping, unit_scc_handling, total_unit_cogs, sale_price, line_revenue_cents, gross_profit, order_date')
      .gte('order_date', start_date)
      .lte('order_date', end_date)
      .eq('store', store);
    if (eErr) return res.status(500).json({ error: eErr.message });
    if (!entries || entries.length === 0) return res.json({ sku_breakdown: [], total_revenue: 0, total_cogs: 0, gross_margin_pct: 0, total_inventory_value: 0, redo_fees: 0, shipping_total: 0, tax_total: 0, gross_sales: 0, total_discounts: 0, total_returns: 0, net_sales: 0, shipping_revenue: 0, total_collected: 0 });

    // Check for partial coverage: compare cogs_entries count vs shopify_sales count
    const { count: salesCount } = await supabase
      .from('shopify_sales')
      .select('*', { count: 'exact', head: true })
      .gte('order_date', start_date)
      .lte('order_date', end_date)
      .eq('store', store)
      .not('sku', 'in', '(shipping,x-redo,tax)');
    if (salesCount && entries.length < salesCount) {
      // Partial FIFO coverage — signal caller to fall back to /summary
      return res.json({ partial: true, sku_breakdown: [] });
    }

    // Group by SKU — accumulate revenue in integer cents
    // Prefer line_revenue_cents (actual Shopify line total) over sale_price * qty
    // to avoid rounding errors from discount allocation
    const skuMap = {};
    for (const e of entries) {
      if (!skuMap[e.sku]) {
        skuMap[e.sku] = { sku: e.sku, product_name: e.product_name, units_sold: 0, revenueCents: 0, cogsCents: 0, purchaseCostCents: 0, gdShippingCents: 0, sccHandlingCents: 0 };
      }
      const qty = e.quantity_sold || 0;
      skuMap[e.sku].units_sold += qty;
      skuMap[e.sku].revenueCents += e.line_revenue_cents != null
        ? e.line_revenue_cents
        : toCents(e.sale_price) * qty;
      skuMap[e.sku].cogsCents += toCents(e.total_unit_cogs) * qty;
      skuMap[e.sku].purchaseCostCents += toCents(e.unit_purchase_cost) * qty;
      skuMap[e.sku].gdShippingCents += toCents(e.unit_gd_shipping) * qty;
      skuMap[e.sku].sccHandlingCents += toCents(e.unit_scc_handling) * qty;
    }

    // Get inventory on-hand from WAC data (purchases − all-time net sold)
    const { data: allPurchases } = await supabase.from('purchases').select('sku, product_name, quantity, unit_cost');
    const { data: allSales } = await supabase.from('shopify_sales').select('sku, quantity_sold').neq('sku', 'x-redo').neq('sku', 'shipping').neq('sku', 'tax');
    const { data: allRefunds } = await supabase.from('shopify_refunds').select('sku, quantity_refunded, order_number');
    const { data: allRedoReturns } = await supabase.from('redo_returns').select('sku, quantity_returned, shopify_order_name').eq('status', 'complete');

    // Build sets from shopify_refunds for Redo return validation
    const refundOrderSkuSet = new Set();
    const refundOrderSet = new Set();
    for (const r of (allRefunds || [])) {
      if (r.order_number) {
        refundOrderSkuSet.add(`${r.order_number}|${r.sku}`);
        refundOrderSet.add(r.order_number);
      }
    }

    const purchaseMap = {};
    for (const p of (allPurchases || [])) {
      if (!purchaseMap[p.sku]) purchaseMap[p.sku] = { totalQty: 0, totalCostCents: 0 };
      purchaseMap[p.sku].totalQty += p.quantity;
      purchaseMap[p.sku].totalCostCents += toCents(p.unit_cost) * p.quantity;
    }
    const allTimeSold = {};
    for (const s of (allSales || [])) allTimeSold[s.sku] = (allTimeSold[s.sku] || 0) + s.quantity_sold;
    for (const r of (allRefunds || [])) allTimeSold[r.sku] = (allTimeSold[r.sku] || 0) - r.quantity_refunded;
    for (const r of (allRedoReturns || [])) {
      const orderNum = (r.shopify_order_name || '').replace(/^#/, '');
      if (!refundOrderSet.has(orderNum)) continue;
      if (refundOrderSkuSet.has(`${orderNum}|${r.sku}`)) continue;
      allTimeSold[r.sku] = (allTimeSold[r.sku] || 0) - r.quantity_returned;
    }

    // Get period refunds (by refund_date) to compute net units/revenue
    const { data: periodRefunds } = await supabase
      .from('shopify_refunds')
      .select('sku, quantity_refunded, refund_subtotal, order_number, refund_date')
      .gte('refund_date', start_date)
      .lte('refund_date', end_date)
      .eq('store', store);

    const refundMap = {};
    for (const r of (periodRefunds || [])) {
      if (!refundMap[r.sku]) refundMap[r.sku] = { qty: 0, subtotalCents: 0, details: [] };
      refundMap[r.sku].qty += r.quantity_refunded;
      refundMap[r.sku].subtotalCents += toCents(r.refund_subtotal);
      refundMap[r.sku].details.push({
        order_number: r.order_number,
        refund_date: r.refund_date,
        quantity: r.quantity_refunded,
        refund_amount: parseFloat(r.refund_subtotal || 0),
      });
    }

    // Merge Redo returns into refund map — skip if already in shopify_refunds
    const { data: periodRedoReturns } = await supabase
      .from('redo_returns')
      .select('sku, quantity_returned, refund_amount, shopify_order_name, return_date')
      .gte('return_date', start_date)
      .lte('return_date', end_date)
      .eq('store', store)
      .eq('status', 'complete');

    // Build sets from period refunds for Redo validation
    const periodRefundOrderSkuSet = new Set();
    const periodRefundOrderSet = new Set();
    for (const r of (periodRefunds || [])) {
      if (r.order_number) {
        periodRefundOrderSkuSet.add(`${r.order_number}|${r.sku}`);
        periodRefundOrderSet.add(r.order_number);
      }
    }

    for (const r of (periodRedoReturns || [])) {
      const orderNum = (r.shopify_order_name || '').replace(/^#/, '');
      if (!periodRefundOrderSet.has(orderNum)) continue;
      if (periodRefundOrderSkuSet.has(`${orderNum}|${r.sku}`)) continue;
      if (!refundMap[r.sku]) refundMap[r.sku] = { qty: 0, subtotalCents: 0, details: [] };
      refundMap[r.sku].qty += r.quantity_returned;
      refundMap[r.sku].subtotalCents += toCents(r.refund_amount);
      refundMap[r.sku].details.push({
        order_number: orderNum,
        refund_date: r.return_date,
        quantity: r.quantity_returned,
        refund_amount: parseFloat(r.refund_amount || 0),
        source: 'redo',
      });
    }

    const skuBreakdown = Object.values(skuMap).map(s => {
      const refund = refundMap[s.sku] || { qty: 0, subtotalCents: 0 };
      const netUnits = s.units_sold - refund.qty;
      const netRevenueCents = s.revenueCents - refund.subtotalCents;
      const netRevenue = netRevenueCents / 100;
      // Scale COGS proportionally for net units
      const avgUnitCogsCents = s.units_sold > 0 ? s.cogsCents / s.units_sold : 0;
      const netCogsCents = Math.round(netUnits * avgUnitCogsCents);
      const netCogs = netCogsCents / 100;
      const margin = netRevenue > 0 ? ((netRevenue - netCogs) / netRevenue) * 100 : 0;
      const pm = purchaseMap[s.sku] || { totalQty: 0, totalCostCents: 0 };
      const avgCost = pm.totalQty > 0 ? pm.totalCostCents / pm.totalQty / 100 : 0;
      const onHand = Math.max(0, pm.totalQty - (allTimeSold[s.sku] || 0));
      return {
        sku: s.sku,
        product_name: s.product_name,
        units_sold: netUnits,
        units_gross: s.units_sold,
        units_returned: refund.qty,
        refund_details: refund.details || [],
        avg_unit_cost: s.units_sold > 0 ? Math.round(s.cogsCents / s.units_sold) / 100 : 0,
        revenue: netRevenue,
        cogs: netCogs,
        gross_margin_pct: Math.round(margin * 100) / 100,
        units_on_hand: onHand,
        inventory_value: Math.round(onHand * avgCost * 100) / 100,
        // FIFO cost breakdown
        purchase_cost: s.purchaseCostCents / 100,
        gd_shipping: s.gdShippingCents / 100,
        scc_handling: s.sccHandlingCents / 100,
      };
    });

    // Also add SKUs with inventory but no period sales
    for (const [sku, pm] of Object.entries(purchaseMap)) {
      if (skuMap[sku]) continue;
      const avgCost = pm.totalQty > 0 ? pm.totalCostCents / pm.totalQty / 100 : 0;
      const onHand = Math.max(0, pm.totalQty - (allTimeSold[sku] || 0));
      if (onHand > 0) {
        skuBreakdown.push({
          sku, product_name: (allPurchases || []).find(p => p.sku === sku)?.product_name || 'Unknown',
          units_sold: 0, units_gross: 0, units_returned: 0,
          avg_unit_cost: Math.round(avgCost * 100) / 100, revenue: 0, cogs: 0,
          gross_margin_pct: null, units_on_hand: onHand,
          inventory_value: Math.round(onHand * avgCost * 100) / 100,
          purchase_cost: 0, gd_shipping: 0, scc_handling: 0,
        });
      }
    }

    // Virtual SKU totals — use the user-requested date range (not cogs_entries effective
    // range) so redo/shipping figures match the same period as the rest of the breakdown
    const { data: virtualRows } = await supabase
      .from('shopify_sales')
      .select('sku, quantity_sold, sale_price')
      .gte('order_date', start_date)
      .lte('order_date', end_date)
      .eq('store', store)
      .in('sku', ['x-redo', 'shipping', 'tax']);

    const redoFeesCents = sumVirtualCents(virtualRows, 'x-redo');
    const redoUnits = (virtualRows || []).filter(r => r.sku === 'x-redo')
      .reduce((s, r) => s + (r.quantity_sold || 0), 0);
    const shippingTotalCents = sumVirtualCents(virtualRows, 'shipping');
    const taxTotalCents = sumVirtualCents(virtualRows, 'tax');

    // Fetch gross_price and discount_amount from shopify_sales for proper Shopify metrics
    const { data: periodSalesForGross } = await supabase
      .from('shopify_sales')
      .select('gross_price, discount_amount')
      .gte('order_date', start_date)
      .lte('order_date', end_date)
      .eq('store', store)
      .not('sku', 'in', '(shipping,x-redo,tax)');

    let grossSalesCents = 0;
    let totalDiscountsCents = 0;
    for (const row of (periodSalesForGross || [])) {
      grossSalesCents += row.gross_price != null
        ? toCents(row.gross_price)
        : 0;
      totalDiscountsCents += toCents(row.discount_amount);
    }
    // Fallback: if gross_price not yet populated, use post-discount revenue
    if (grossSalesCents === 0) {
      grossSalesCents = Object.values(skuMap).reduce((s, d) => s + d.revenueCents, 0);
    }

    // Sales breakdown — all in integer cents
    const totalReturnsCents = Object.entries(refundMap)
      .filter(([sku]) => !VIRTUAL_REFUND_SKUS.includes(sku))
      .reduce((s, [, d]) => s + d.subtotalCents, 0);
    const shippingRefundsCents = (refundMap['shipping'] || { subtotalCents: 0 }).subtotalCents;
    const netSalesCents = grossSalesCents - totalDiscountsCents - totalReturnsCents;
    const shippingRevenueCents = shippingTotalCents - shippingRefundsCents;
    const totalCollectedCents = netSalesCents + redoFeesCents; // excludes shipping to match Shopify "Total sales over time"

    const totalRevenueCents = skuBreakdown.reduce((s, r) => s + Math.round(r.revenue * 100), 0);
    const totalCogsCents = skuBreakdown.reduce((s, r) => s + Math.round(r.cogs * 100), 0);
    const totalInvValue = skuBreakdown.reduce((s, r) => s + r.inventory_value, 0);
    const totalRevenue = totalRevenueCents / 100;
    const totalCogs = totalCogsCents / 100;

    res.json({
      period: `${start_date} – ${end_date}`,
      total_revenue: (totalRevenueCents + redoFeesCents + shippingRevenueCents) / 100,
      total_cogs: totalCogs,
      total_inventory_value: Math.round(totalInvValue * 100) / 100,
      gross_margin_pct: totalRevenue > 0 ? Math.round((totalRevenue - totalCogs) / totalRevenue * 10000) / 100 : 0,
      redo_fees: redoFeesCents / 100,
      redo_units: redoUnits,
      shipping_total: shippingTotalCents / 100,
      tax_total: taxTotalCents / 100,
      gross_sales: grossSalesCents / 100,
      total_discounts: totalDiscountsCents / 100,
      total_returns: totalReturnsCents / 100,
      net_sales: netSalesCents / 100,
      shipping_revenue: shippingRevenueCents / 100,
      total_collected: totalCollectedCents / 100,
      sku_breakdown: skuBreakdown,
    });
  } catch (err) {
    console.error('FIFO by-sku error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/inventory/debug ─────────────────────────────────────────────────
// Lightweight diagnostic: tests each query the summary endpoint uses
router.get('/inventory/debug', async (req, res) => {
  const store = req.query.store || 'au';
  const results = {};
  try {
    const { count: c1, error: e1 } = await supabase.from('purchase_order_lines').select('*', { count: 'exact', head: true }).gt('quantity_remaining', 0);
    results.purchase_order_lines = e1 ? `ERROR: ${e1.message}` : `ok (${c1} rows)`;
  } catch (e) { results.purchase_order_lines = `CRASH: ${e.message}`; }
  try {
    const { count: c2, error: e2 } = await supabase.from('stock_adjustments').select('*', { count: 'exact', head: true });
    results.stock_adjustments = e2 ? `ERROR: ${e2.message}` : `ok (${c2} rows)`;
  } catch (e) { results.stock_adjustments = `CRASH: ${e.message}`; }
  try {
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const { count: c3, error: e3 } = await supabase.from('shopify_sales').select('*', { count: 'exact', head: true }).gte('order_date', monthStart).eq('store', store);
    results.shopify_sales_month = e3 ? `ERROR: ${e3.message}` : `ok (${c3} rows)`;
  } catch (e) { results.shopify_sales_month = `CRASH: ${e.message}`; }
  try {
    const thirtyAgo = new Date(Date.now() - 30*24*60*60*1000).toISOString().slice(0, 10);
    const { count: c4, error: e4 } = await supabase.from('shopify_sales').select('*', { count: 'exact', head: true }).gte('order_date', thirtyAgo).eq('store', store);
    results.shopify_sales_30d = e4 ? `ERROR: ${e4.message}` : `ok (${c4} rows)`;
  } catch (e) { results.shopify_sales_30d = `CRASH: ${e.message}`; }

  // Now try the actual summary query step by step
  try {
    const { data: lots, error: lotsErr } = await supabase
      .from('purchase_order_lines')
      .select('sku, product_name, unit_cost, quantity_remaining, po_number')
      .gt('quantity_remaining', 0);
    results.lots_fetch = lotsErr ? `ERROR: ${lotsErr.message}` : `ok (${lots?.length} rows)`;
  } catch (e) { results.lots_fetch = `CRASH: ${e.message}`; }

  res.json(results);
});

// ── GET /api/inventory/summary ───────────────────────────────────────────────
// Returns current stock levels per SKU with values and sales velocity
router.get('/inventory/summary', async (req, res) => {
  const store = req.query.store || 'au';
  console.log('[inventory/summary] start, store=', store);

  try {
    // ── 1a. GD stock: purchase_order_lines from germandrop supplier ──
    console.log('[inventory/summary] querying purchase_order_lines...');
    const { data: lots, error: lotsErr } = await supabase
      .from('purchase_order_lines')
      .select('sku, product_name, unit_cost, quantity_remaining, po_number, purchase_orders(supplier)')
      .gt('quantity_remaining', 0);
    if (lotsErr) { console.error('[inventory/summary] lotsErr:', lotsErr.message); return res.status(500).json({ error: lotsErr.message }); }
    console.log('[inventory/summary] purchase_order_lines rows:', lots?.length);

    // ── 1b. SCC stock: stock_adjustments (location='SCC') with per-location deltas ──
    console.log('[inventory/summary] querying stock_adjustments...');
    const { data: adjRows, error: adjErr } = await supabase
      .from('stock_adjustments')
      .select('sku, delta, location');
    if (adjErr) console.error('[inventory/summary] adjErr:', adjErr.message);

    // Sum deltas by SKU and location
    const sccAdjDeltas = {}; // { sku: totalDelta } for location='SCC'
    const gdAdjDeltas = {};  // { sku: totalDelta } for location='GermanDrop'/'GD'
    for (const row of (adjRows || [])) {
      const loc = (row.location || 'SCC').toLowerCase();
      if (loc.includes('gd') || loc.includes('germandrop') || loc.includes('german')) {
        gdAdjDeltas[row.sku] = (gdAdjDeltas[row.sku] || 0) + row.delta;
      } else {
        sccAdjDeltas[row.sku] = (sccAdjDeltas[row.sku] || 0) + row.delta;
      }
    }
    console.log('[inventory/summary] SCC adj SKUs:', Object.keys(sccAdjDeltas).length, 'GD adj SKUs:', Object.keys(gdAdjDeltas).length);

    // ── 1c. Sales since last SCC adjustment date (to subtract from SCC stock) ──
    // Find latest SCC adjustment date
    const sccAdjDates = (adjRows || [])
      .filter(r => !(r.location || 'SCC').toLowerCase().includes('gd') && !(r.location || 'SCC').toLowerCase().includes('german'))
      .map(r => r.adjustment_date)
      .filter(Boolean);
    const latestSccAdjDate = sccAdjDates.length > 0 ? sccAdjDates.sort().pop() : null;
    console.log('[inventory/summary] latest SCC adjustment date:', latestSccAdjDate);

    // Fetch SCC-fulfilled sales since adjustment date
    let sccSalesSinceAdj = {};  // { sku: qty_sold }
    if (latestSccAdjDate) {
      const { data: sccSales } = await supabase
        .from('shopify_sales')
        .select('sku, quantity_sold, fulfillment_location')
        .gt('order_date', latestSccAdjDate)
        .eq('store', store)
        .neq('sku', 'x-redo').neq('sku', 'shipping').neq('sku', 'tax');

      for (const s of (sccSales || [])) {
        // SCC-fulfilled = southern-cross-cargo or anything NOT manual/unfulfilled (default to SCC)
        const fl = (s.fulfillment_location || '').toLowerCase();
        const isGdFulfilled = fl.includes('oatlands') || fl === 'manual';
        if (!isGdFulfilled) {
          sccSalesSinceAdj[s.sku] = (sccSalesSinceAdj[s.sku] || 0) + s.quantity_sold;
        }
      }
    }
    console.log('[inventory/summary] SCC sales since adj SKUs:', Object.keys(sccSalesSinceAdj).length);

    // ── Build unified SKU map ──
    const skuMap = {};

    const ensureSku = (sku, productName) => {
      if (!skuMap[sku]) {
        skuMap[sku] = { sku, product_name: productName || sku, quantity_remaining: 0, totalCostCents: 0, po_numbers: new Set(), scc_stock: 0, gd_stock: 0 };
      }
    };

    // GD stock from purchase_order_lines (supplier=germandrop)
    // SCC PO stock also added here for any non-GD supplier POs with remaining stock
    for (const lot of (lots || [])) {
      ensureSku(lot.sku, lot.product_name);
      const supplier = (lot.purchase_orders?.supplier || '').toLowerCase();
      const isGD = supplier.includes('germandrop') || supplier.includes('german_drop') || supplier === 'gd';
      if (isGD) {
        skuMap[lot.sku].gd_stock += lot.quantity_remaining;
      } else {
        skuMap[lot.sku].scc_stock += lot.quantity_remaining;
      }
      skuMap[lot.sku].totalCostCents += toCents(lot.unit_cost) * lot.quantity_remaining;
      if (lot.po_number) skuMap[lot.sku].po_numbers.add(lot.po_number);
    }

    // SCC stock from stock_adjustments (physical count) minus sales since count
    for (const [sku, adjDelta] of Object.entries(sccAdjDeltas)) {
      ensureSku(sku, sku);
      const salesSince = sccSalesSinceAdj[sku] || 0;
      const sccFromAdj = Math.max(0, adjDelta - salesSince);
      skuMap[sku].scc_stock += sccFromAdj;
    }

    // GD stock adjustments (if any exist)
    for (const [sku, adjDelta] of Object.entries(gdAdjDeltas)) {
      ensureSku(sku, sku);
      skuMap[sku].gd_stock = Math.max(0, skuMap[sku].gd_stock + adjDelta);
    }

    // Compute total quantity_remaining and recalc cost for adjustment-only SKUs
    for (const s of Object.values(skuMap)) {
      s.quantity_remaining = s.scc_stock + s.gd_stock;
      // For adjustment-only SKUs (no PO lines), estimate cost from avg PO cost if available
      if (s.totalCostCents === 0 && s.quantity_remaining > 0) {
        // Look up avg cost from any PO line for this SKU
        const skuLots = (lots || []).filter(l => l.sku === s.sku);
        if (skuLots.length > 0) {
          const avgCost = skuLots.reduce((sum, l) => sum + toCents(l.unit_cost), 0) / skuLots.length;
          s.totalCostCents = Math.round(avgCost * s.quantity_remaining);
        }
      }
    }

    // Remove SKUs with 0 total stock
    for (const sku of Object.keys(skuMap)) {
      if (skuMap[sku].quantity_remaining <= 0) delete skuMap[sku];
    }

    if (Object.keys(skuMap).length === 0) {
      return res.json({ skus: [], total_inventory_value: 0, total_retail_value: 0, total_skus: 0, total_units: 0 });
    }

    // Resolve product names for adjustment-only SKUs (no PO line → product_name = sku)
    const needsName = Object.values(skuMap).filter(s => s.product_name === s.sku).map(s => s.sku);
    if (needsName.length > 0) {
      // Try shopify_sales first, then purchase_order_lines
      const { data: nameRows } = await supabase
        .from('shopify_sales')
        .select('sku, product_name')
        .in('sku', needsName)
        .limit(500);
      const nameMap = {};
      for (const r of (nameRows || [])) {
        if (r.product_name && !nameMap[r.sku]) nameMap[r.sku] = r.product_name;
      }
      // Fill gaps from purchase_order_lines
      const stillMissing = needsName.filter(s => !nameMap[s]);
      if (stillMissing.length > 0) {
        const { data: poNameRows } = await supabase
          .from('purchase_order_lines')
          .select('sku, product_name')
          .in('sku', stillMissing)
          .limit(500);
        for (const r of (poNameRows || [])) {
          if (r.product_name && !nameMap[r.sku]) nameMap[r.sku] = r.product_name;
        }
      }
      for (const s of Object.values(skuMap)) {
        if (s.product_name === s.sku && nameMap[s.sku]) s.product_name = nameMap[s.sku];
      }
    }

    // 2. Get sales this calendar month
    console.log('[inventory/summary] querying shopify_sales (month)...');
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const { data: monthSales } = await supabase
      .from('shopify_sales')
      .select('sku, quantity_sold')
      .gte('order_date', monthStart)
      .eq('store', store)
      .neq('sku', 'x-redo').neq('sku', 'shipping').neq('sku', 'tax');

    const monthSoldMap = {};
    for (const s of (monthSales || [])) {
      monthSoldMap[s.sku] = (monthSoldMap[s.sku] || 0) + s.quantity_sold;
    }

    // 3. Get avg sale price per SKU (last 30 days, in cents)
    console.log('[inventory/summary] querying shopify_sales (30d prices)...');
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data: recentSales } = await supabase
      .from('shopify_sales')
      .select('sku, quantity_sold, sale_price')
      .gte('order_date', thirtyDaysAgo)
      .eq('store', store)
      .neq('sku', 'x-redo').neq('sku', 'shipping').neq('sku', 'tax');

    const salePriceMap = {}; // { sku: { totalRevCents, totalQty } }
    for (const s of (recentSales || [])) {
      if (!salePriceMap[s.sku]) salePriceMap[s.sku] = { totalRevCents: 0, totalQty: 0 };
      const qty = s.quantity_sold || 0;
      salePriceMap[s.sku].totalRevCents += toCents(s.sale_price) * qty;
      salePriceMap[s.sku].totalQty += qty;
    }

    // 4. Build response
    console.log('[inventory/summary] building response...');
    const skus = Object.values(skuMap).map(s => {
      const avgUnitCostCents = s.quantity_remaining > 0 ? s.totalCostCents / s.quantity_remaining : 0;
      const sp = salePriceMap[s.sku];
      const avgSalePriceCents = sp && sp.totalQty > 0 ? sp.totalRevCents / sp.totalQty : 0;
      const locations = [];
      if (s.scc_stock > 0) locations.push('SCC');
      if (s.gd_stock > 0) locations.push('GermanDrop');
      if (locations.length === 0) locations.push('SCC'); // default

      return {
        sku: s.sku,
        product_name: s.product_name,
        quantity_remaining: s.quantity_remaining,
        scc_stock: s.scc_stock,
        gd_stock: s.gd_stock,
        locations,
        unit_cost: Math.round(avgUnitCostCents) / 100,
        inventory_value: s.totalCostCents / 100,
        avg_sale_price: Math.round(avgSalePriceCents) / 100,
        retail_value: Math.round(s.quantity_remaining * avgSalePriceCents) / 100,
        units_sold_this_month: monthSoldMap[s.sku] || 0,
        po_numbers: [...s.po_numbers],
        low_stock: s.quantity_remaining < 10,
      };
    });

    skus.sort((a, b) => (a.product_name || '').localeCompare(b.product_name || ''));

    res.json({
      skus,
      total_inventory_value: skus.reduce((s, r) => s + Math.round(r.inventory_value * 100), 0) / 100,
      total_retail_value: skus.reduce((s, r) => s + Math.round(r.retail_value * 100), 0) / 100,
      total_skus: skus.length,
      total_units: skus.reduce((s, r) => s + r.quantity_remaining, 0),
    });
  } catch (err) {
    console.error('Inventory summary error:', err.message);
    console.error('Inventory summary stack:', err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/inventory/adjustment ───────────────────────────────────────────
// Record a physical stock count adjustment for a single SKU.
// Looks up current FIFO quantity_remaining, calculates delta, inserts row.
router.post('/inventory/adjustment', async (req, res) => {
  const { sku, physical_count, notes, location = 'SCC' } = req.body;

  if (!sku || physical_count == null) {
    return res.status(400).json({ error: 'sku and physical_count are required' });
  }

  try {
    // Get current FIFO-derived stock for this SKU
    const { data: lots, error: lotsErr } = await supabase
      .from('purchase_order_lines')
      .select('quantity_remaining')
      .eq('sku', sku)
      .gt('quantity_remaining', 0);
    if (lotsErr) return res.status(500).json({ error: lotsErr.message });

    const systemCount = (lots || []).reduce((s, l) => s + l.quantity_remaining, 0);
    const delta = physical_count - systemCount;

    const { data: adj, error: adjErr } = await supabase
      .from('stock_adjustments')
      .insert({
        sku,
        adjustment_date: new Date().toISOString().slice(0, 10),
        physical_count,
        system_count: systemCount,
        delta,
        location,
        notes: notes || null,
      })
      .select()
      .single();

    if (adjErr) return res.status(500).json({ error: adjErr.message });

    res.json({ success: true, adjustment: adj });
  } catch (err) {
    console.error('Stock adjustment error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/inventory/adjustments/bulk ─────────────────────────────────────
// Accepts an array of { sku, physical_count } and creates adjustments for each.
// Deletes previous adjustments for the same location+notes to allow re-uploads.
router.post('/inventory/adjustments/bulk', async (req, res) => {
  const { adjustments, notes, location = 'SCC' } = req.body;

  if (!adjustments || !Array.isArray(adjustments) || adjustments.length === 0) {
    return res.status(400).json({ error: 'adjustments array is required' });
  }

  try {
    // If notes match a previous bulk upload, delete those old adjustments first (idempotent re-upload)
    if (notes) {
      await supabase
        .from('stock_adjustments')
        .delete()
        .eq('notes', notes)
        .eq('location', location);
    }

    // Get all FIFO stock in one query
    const { data: allLots } = await supabase
      .from('purchase_order_lines')
      .select('sku, quantity_remaining')
      .gt('quantity_remaining', 0);

    const fifoMap = {};
    for (const lot of (allLots || [])) {
      fifoMap[lot.sku] = (fifoMap[lot.sku] || 0) + lot.quantity_remaining;
    }

    const today = new Date().toISOString().slice(0, 10);
    const rows = adjustments.map(a => {
      const systemCount = fifoMap[a.sku] || 0;
      return {
        sku: a.sku,
        adjustment_date: today,
        physical_count: a.physical_count,
        system_count: systemCount,
        delta: a.physical_count - systemCount,
        location,
        notes: notes || null,
      };
    });

    const { data, error } = await supabase
      .from('stock_adjustments')
      .insert(rows)
      .select();

    if (error) return res.status(500).json({ error: error.message });

    const totalDelta = rows.reduce((s, r) => s + r.delta, 0);
    res.json({
      success: true,
      count: data.length,
      total_delta: totalDelta,
      adjustments: data,
    });
  } catch (err) {
    console.error('Bulk adjustment error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/inventory/adjustments ───────────────────────────────────────────
// List stock adjustments, optionally filtered by SKU
router.get('/inventory/adjustments', async (req, res) => {
  const { sku } = req.query;
  try {
    let query = supabase
      .from('stock_adjustments')
      .select('*')
      .order('created_at', { ascending: false });
    if (sku) query = query.eq('sku', sku);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/inventory/valuation ─────────────────────────────────────────────
// Simple inventory valuation from purchases table (units on hand × cost)

const SHIPPING_PER_UNIT = {
  BLK2ATS: 6.45, BRN2ATS: 6.45,
  BLK1CAR: 2.30, BRN1CAR: 2.30,
  GRN1CYC: 2.05, WHT1CYC: 2.05,
  BLK1VYG: 0.37, BLK2VYG: 0.60, BLK3VYG: 0.89,
  BLK2TAU: 14.34, WHT2TAU: 14.51, GRY2TAU: 14.51,
  BLK4LEO: 18.45, GRY4LEO: 18.21, WHT4LEO: 18.41,
  BLK6IMP: 23.70, WHT6IMP: 23.70, GRY6IMP: 23.70,
};

const RETAIL_PRICE = {
  BLK2ATS: 211.00, BRN2ATS: 211.00,
  BLK1CAR: 169.00, BRN1CAR: 169.00,
  GRN1CYC: 160.00, WHT1CYC: 160.00,
  BLK1VYG: 84.00, BLK2VYG: 109.00, BLK3VYG: 135.00,
  BLK2TAU: 509.00, WHT2TAU: 509.00, GRY2TAU: 509.00,
  BLK4LEO: 764.00, GRY4LEO: 764.00, WHT4LEO: 764.00,
  BLK6IMP: 1274.00, WHT6IMP: 1274.00, GRY6IMP: 1274.00,
};

router.get('/inventory/valuation', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('purchases')
      .select('sku, product_name, quantity_remaining, unit_cost');

    if (error) return res.status(500).json({ error: error.message });

    // Group by sku + unit_cost
    const map = {};
    for (const row of (data || [])) {
      const key = `${row.sku}|${row.unit_cost}`;
      if (!map[key]) {
        map[key] = { sku: row.sku, product_name: row.product_name, units: 0, unit_cost: parseFloat(row.unit_cost) };
      }
      map[key].units += row.quantity_remaining || 0;
    }

    const items = Object.values(map)
      .filter(i => i.units > 0)
      .map(i => {
        const retail_price = RETAIL_PRICE[i.sku] || null;
        return {
          ...i,
          shipping_per_unit: SHIPPING_PER_UNIT[i.sku] || null,
          total_value: Math.round(i.units * i.unit_cost * 100) / 100,
          retail_price,
          retail_value: retail_price != null ? Math.round(i.units * retail_price * 100) / 100 : null,
        };
      })
      .sort((a, b) => a.product_name.localeCompare(b.product_name));

    const grand_total = Math.round(items.reduce((s, i) => s + i.total_value, 0) * 100) / 100;
    const grand_total_retail = Math.round(items.reduce((s, i) => s + (i.retail_value || 0), 0) * 100) / 100;

    res.json({ items, grand_total, grand_total_retail });
  } catch (err) {
    console.error('Inventory valuation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Inventory Snapshots ──────────────────────────────────────────────────────
// Point-in-time physical inventory counts. unit_cost and retail_price are
// frozen at upload time so historical value never drifts with later purchases.

/**
 * Build a { sku: unit_cost } map from the `purchases` table.
 * Weighted average by quantity_remaining when stock remains; falls back to a
 * simple average across purchase rows; 0 if the SKU isn't in purchases.
 */
async function getFrozenUnitCostMap(skus) {
  if (!skus || skus.length === 0) return {};
  const { data, error } = await supabase
    .from('purchases')
    .select('sku, unit_cost, quantity_remaining')
    .in('sku', skus);
  if (error) throw new Error(error.message);

  const grp = {};
  for (const p of (data || [])) {
    if (!grp[p.sku]) grp[p.sku] = { rows: 0, weightedCents: 0, totalRem: 0, costSumCents: 0 };
    const costCents = toCents(p.unit_cost);
    const qr = p.quantity_remaining || 0;
    grp[p.sku].rows += 1;
    grp[p.sku].weightedCents += costCents * qr;
    grp[p.sku].totalRem += qr;
    grp[p.sku].costSumCents += costCents;
  }

  const map = {};
  for (const sku of skus) {
    const g = grp[sku];
    if (!g) { map[sku] = 0; continue; }
    if (g.totalRem > 0)      map[sku] = (g.weightedCents / g.totalRem) / 100;
    else if (g.rows > 0)     map[sku] = (g.costSumCents / g.rows) / 100;
    else                     map[sku] = 0;
  }
  return map;
}

// POST /api/inventory/snapshots
// Body: { snapshot_date: 'YYYY-MM-DD', label?: string, lines: [{ sku, product_name, quantity }] }
router.post('/inventory/snapshots', async (req, res) => {
  const { snapshot_date, label, lines } = req.body || {};

  if (!snapshot_date || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot_date)) {
    return res.status(400).json({ error: 'snapshot_date (YYYY-MM-DD) is required' });
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: 'lines array is required' });
  }

  try {
    // Idempotent per date — cascade deletes the old snapshot's lines.
    await supabase.from('inventory_snapshots').delete().eq('snapshot_date', snapshot_date);

    const skus = [...new Set(lines.map(l => l.sku).filter(Boolean))];
    const unitCostMap = await getFrozenUnitCostMap(skus);

    const { data: snap, error: snapErr } = await supabase
      .from('inventory_snapshots')
      .insert({ snapshot_date, label: label || null })
      .select()
      .single();
    if (snapErr) return res.status(500).json({ error: snapErr.message });

    const lineRows = lines
      .filter(l => l.sku)
      .map(l => ({
        snapshot_id: snap.id,
        sku: l.sku,
        product_name: l.product_name || null,
        quantity: parseInt(l.quantity, 10) || 0,
        unit_cost: unitCostMap[l.sku] || 0,
        retail_price: RETAIL_PRICE[l.sku] || 0,
        location: l.location || 'SCC',
      }));

    const { data: insertedLines, error: linesErr } = await supabase
      .from('inventory_snapshot_lines')
      .insert(lineRows)
      .select();
    if (linesErr) return res.status(500).json({ error: linesErr.message });

    res.json({ snapshot: snap, lines: insertedLines });
  } catch (err) {
    console.error('Create snapshot error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/inventory/snapshots — list (newest snapshot_date first)
router.get('/inventory/snapshots', async (req, res) => {
  const { data, error } = await supabase
    .from('inventory_snapshots')
    .select('id, snapshot_date, label, created_at')
    .order('snapshot_date', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /api/inventory/snapshots/:id/export — CSV inventory valuation download
router.get('/inventory/snapshots/:id/export', async (req, res) => {
  const { id } = req.params;
  try {
    const { data: snap, error: snapErr } = await supabase
      .from('inventory_snapshots')
      .select('id, snapshot_date, label')
      .eq('id', id)
      .single();
    if (snapErr) return res.status(404).json({ error: snapErr.message });

    const { data: lines, error: linesErr } = await supabase
      .from('inventory_snapshot_lines')
      .select('sku, product_name, quantity, unit_cost')
      .eq('snapshot_id', id)
      .order('product_name', { ascending: true });
    if (linesErr) return res.status(500).json({ error: linesErr.message });

    const rows = [['SKU', 'Product Name', 'Qty on Hand', 'Unit Cost', 'Total Value']];
    for (const l of lines || []) {
      const qty = l.quantity || 0;
      const cost = parseFloat(l.unit_cost) || 0;
      const total = Math.round(qty * cost * 100) / 100;
      rows.push([l.sku, l.product_name || '', qty, cost.toFixed(2), total.toFixed(2)]);
    }

    const csv = rows
      .map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const filename = `inventory-valuation-${snap.snapshot_date}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    console.error('Inventory export error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/inventory/snapshots/:id — snapshot + lines + totals
router.get('/inventory/snapshots/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { data: snap, error: snapErr } = await supabase
      .from('inventory_snapshots')
      .select('id, snapshot_date, label, created_at')
      .eq('id', id)
      .single();
    if (snapErr) return res.status(404).json({ error: snapErr.message });

    const { data: rawLines, error: linesErr } = await supabase
      .from('inventory_snapshot_lines')
      .select('id, sku, product_name, quantity, unit_cost, retail_price, location, created_at')
      .eq('snapshot_id', id);
    if (linesErr) return res.status(500).json({ error: linesErr.message });

    let totalInvCents = 0;
    let totalRetCents = 0;
    let totalUnits = 0;
    const lines = (rawLines || []).map(l => {
      const qty = l.quantity || 0;
      const invCents = toCents(l.unit_cost) * qty;
      const retCents = toCents(l.retail_price) * qty;
      totalInvCents += invCents;
      totalRetCents += retCents;
      totalUnits += qty;
      return {
        ...l,
        unit_cost: parseFloat(l.unit_cost) || 0,
        retail_price: parseFloat(l.retail_price) || 0,
        inventory_value: invCents / 100,
        retail_value: retCents / 100,
      };
    });

    res.json({
      snapshot: snap,
      lines,
      totals: {
        total_skus: lines.length,
        total_units: totalUnits,
        total_inventory_value: totalInvCents / 100,
        total_retail_value: totalRetCents / 100,
      },
    });
  } catch (err) {
    console.error('Get snapshot error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cogs/recompute — full FIFO recompute from scratch
const { recomputeAllCogs } = require('../utils/fifo');

router.post('/recompute', async (req, res) => {
  try {
    const store = req.body?.store || 'au';
    const startDate = req.body?.start_date || '2026-03-12';
    const result = await recomputeAllCogs(store, startDate);
    res.json({
      success: true,
      entries_created: result.processed,
      skipped_no_lot: result.skipped_no_lot?.length || 0,
      errors: result.errors,
    });
  } catch (err) {
    console.error('Recompute error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.buildCogsData = buildCogsData;
