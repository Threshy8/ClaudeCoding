const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');

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
    .select('sku, quantity_refunded');

  if (allRefundsError) throw new Error(allRefundsError.message);

  // 4. Get gross sales for the period (by order_date)
  const { data: periodSales, error: periodSalesError } = await supabase
    .from('shopify_sales')
    .select('sku, product_name, quantity_sold, sale_price, order_date')
    .gte('order_date', periodStart)
    .lt('order_date', periodEnd)
    .neq('sku', 'x-redo').neq('sku', 'shipping').neq('sku', 'tax');

  if (periodSalesError) throw new Error(periodSalesError.message);

  // 5. Get refunds processed in the period (by refund_date, not order_date)
  //    This matches Shopify's "Net items sold" methodology: returns reduce the period
  //    in which they happen, regardless of when the original order was placed.
  const { data: periodRefunds, error: periodRefundsError } = await supabase
    .from('shopify_refunds')
    .select('sku, product_name, quantity_refunded, refund_subtotal')
    .gte('refund_date', periodStart)
    .lt('refund_date', periodEnd);

  if (periodRefundsError) throw new Error(periodRefundsError.message);

  // --- Build average cost map per SKU ---
  const skuCostMap = {}; // { sku: { totalQty, totalCost, productName } }
  for (const p of allPurchases) {
    if (!skuCostMap[p.sku]) {
      skuCostMap[p.sku] = { totalQty: 0, totalCost: 0, productName: p.product_name };
    }
    skuCostMap[p.sku].totalQty += p.quantity;
    skuCostMap[p.sku].totalCost += p.quantity * parseFloat(p.unit_cost);
  }

  const avgCostMap = {};       // { sku: avgCost }
  const totalPurchasedMap = {}; // { sku: totalQty }
  for (const [sku, d] of Object.entries(skuCostMap)) {
    avgCostMap[sku] = d.totalQty > 0 ? d.totalCost / d.totalQty : 0;
    totalPurchasedMap[sku] = d.totalQty;
  }

  // --- Build all-time net units sold map per SKU (gross sales − all-time refunds) ---
  const allTimeSoldMap = {}; // { sku: netSold }
  for (const s of allSales) {
    allTimeSoldMap[s.sku] = (allTimeSoldMap[s.sku] || 0) + s.quantity_sold;
  }
  for (const r of allRefunds) {
    allTimeSoldMap[r.sku] = (allTimeSoldMap[r.sku] || 0) - r.quantity_refunded;
  }

  // --- Build period refund map (by refund_date) ---
  // { sku: { qty, subtotal, product_name } }
  const periodRefundMap = {};
  for (const r of periodRefunds) {
    if (!periodRefundMap[r.sku]) {
      periodRefundMap[r.sku] = { product_name: r.product_name, qty: 0, subtotal: 0 };
    }
    periodRefundMap[r.sku].qty += r.quantity_refunded;
    periodRefundMap[r.sku].subtotal += parseFloat(r.refund_subtotal || 0);
  }

  // --- Build period gross sales summary per SKU ---
  const periodSkuMap = {}; // { sku: { product_name, gross_units, gross_revenue } }
  for (const s of periodSales) {
    if (!periodSkuMap[s.sku]) {
      periodSkuMap[s.sku] = { product_name: s.product_name, gross_units: 0, gross_revenue: 0 };
    }
    periodSkuMap[s.sku].gross_units += s.quantity_sold;
    periodSkuMap[s.sku].gross_revenue += s.quantity_sold * parseFloat(s.sale_price);
  }

  // Merge period refunds into periodSkuMap so cross-period returns create entries too
  for (const [sku, r] of Object.entries(periodRefundMap)) {
    if (!periodSkuMap[sku]) {
      periodSkuMap[sku] = { product_name: r.product_name, gross_units: 0, gross_revenue: 0 };
    }
  }

  // --- Build per-SKU breakdown ---
  // Net units = gross orders in period − refunds processed in period (by refund_date)
  // Net revenue = gross revenue − refund subtotals processed in period
  const skuBreakdown = [];

  for (const [sku, d] of Object.entries(periodSkuMap)) {
    const refund = periodRefundMap[sku] || { qty: 0, subtotal: 0 };
    const units_sold = d.gross_units - refund.qty;
    const revenue = d.gross_revenue - refund.subtotal;

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
      avg_unit_cost: Math.round(avgCost * 100) / 100,
      revenue: Math.round(revenue * 100) / 100,
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

  function _sumVirtual(rows, sku) {
    return (rows || []).filter(r => r.sku === sku)
      .reduce((s, r) => s + (r.quantity_sold || 0) * parseFloat(r.sale_price || 0), 0);
  }
  const redoFees = _sumVirtual(virtualRows, 'x-redo');
  const redoUnits = (virtualRows || []).filter(r => r.sku === 'x-redo')
    .reduce((s, r) => s + (r.quantity_sold || 0), 0);
  const shippingTotal = _sumVirtual(virtualRows, 'shipping');
  const taxTotal = _sumVirtual(virtualRows, 'tax');

  // --- Sales breakdown ---
  // NOTE: sale_price is already net of discounts (discount_allocations subtracted during
  // Shopify sync), so gross_sales = item revenue after discounts, before refunds.
  // Discount breakdown is not stored separately in shopify_sales.
  const grossSales = Object.values(periodSkuMap).reduce((s, d) => s + d.gross_revenue, 0);
  const totalDiscounts = 0; // Already baked into sale_price during sync
  const totalReturns = Object.values(periodRefundMap).reduce((s, d) => s + d.subtotal, 0);
  const netSales = grossSales - totalReturns;
  const shippingRevenue = shippingTotal;
  const totalCollected = netSales + shippingRevenue + redoFees;

  // --- Totals ---
  const totalRevenue = skuBreakdown.reduce((s, r) => s + r.revenue, 0);
  const totalCogs = skuBreakdown.reduce((s, r) => s + r.cogs, 0);
  const totalInventoryValue = skuBreakdown.reduce((s, r) => s + r.inventory_value, 0);
  const overallMargin = totalRevenue > 0 ? ((totalRevenue - totalCogs) / totalRevenue) * 100 : 0;

  return {
    period: periodLabel,
    period_start: periodStart,
    period_end: periodEnd,
    total_revenue: Math.round((totalRevenue + redoFees + shippingTotal + taxTotal) * 100) / 100,
    total_cogs: Math.round(totalCogs * 100) / 100,
    total_inventory_value: Math.round(totalInventoryValue * 100) / 100,
    gross_margin_pct: Math.round(overallMargin * 100) / 100,
    redo_fees: Math.round(redoFees * 100) / 100,
    redo_units: redoUnits,
    shipping_total: Math.round(shippingTotal * 100) / 100,
    tax_total: Math.round(taxTotal * 100) / 100,
    // Sales breakdown (mirrors Shopify's Total Sales view)
    gross_sales: Math.round(grossSales * 100) / 100,
    total_discounts: totalDiscounts,
    total_returns: Math.round(totalReturns * 100) / 100,
    net_sales: Math.round(netSales * 100) / 100,
    shipping_revenue: Math.round(shippingRevenue * 100) / 100,
    total_collected: Math.round(totalCollected * 100) / 100,
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
      const tz = process.env.SHOPIFY_STORE_TIMEZONE;
      const now = new Date();
      const today = tz ? now.toLocaleDateString('en-CA', { timeZone: tz }) : now.toISOString().slice(0, 10);
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

// ── GET /api/cogs/orders ──────────────────────────────────────────────────────
// Returns order-level sales breakdown for the period
router.get('/orders', async (req, res) => {
  const { start_date, end_date, store = 'au' } = req.query;
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date and end_date required' });

  // Get all purchases for avg cost calculation
  const { data: purchases, error: pErr } = await supabase
    .from('purchases')
    .select('sku, quantity, unit_cost');
  if (pErr) return res.status(500).json({ error: pErr.message });

  // Build avg cost map
  const costMap = {};
  for (const p of (purchases || [])) {
    if (!costMap[p.sku]) costMap[p.sku] = { totalCost: 0, totalQty: 0 };
    costMap[p.sku].totalCost += p.unit_cost * p.quantity;
    costMap[p.sku].totalQty  += p.quantity;
  }
  const avgCost = (sku) => {
    const c = costMap[sku];
    return c && c.totalQty > 0 ? c.totalCost / c.totalQty : 0;
  };

  // Get all sales in period grouped by order
  const { data: sales, error: sErr } = await supabase
    .from('shopify_sales')
    .select('shopify_order_id, order_number, customer_name, sku, product_name, quantity_sold, sale_price, order_date, fulfillment_location')
    .gte('order_date', start_date)
    .lte('order_date', end_date)
    .eq('store', store)
    .neq('sku', 'x-redo').neq('sku', 'shipping').neq('sku', 'tax')
    .order('order_date', { ascending: false });
  if (sErr) return res.status(500).json({ error: sErr.message });

  // Group by order
  const orderMap = {};
  for (const s of (sales || [])) {
    if (!orderMap[s.shopify_order_id]) {
      orderMap[s.shopify_order_id] = {
        shopify_order_id:     s.shopify_order_id,
        order_number:         s.order_number || s.shopify_order_id,
        customer_name:        s.customer_name || '—',
        order_date:           s.order_date,
        fulfillment_location: s.fulfillment_location || 'Unknown',
        line_items: [],
        total_units:   0,
        total_revenue: 0,
        total_cogs:    0,
      };
    }
    const o = orderMap[s.shopify_order_id];
    const qty     = s.quantity_sold || 0;
    const revenue = qty * parseFloat(s.sale_price || 0);
    const cogs    = qty * avgCost(s.sku);
    o.line_items.push({ sku: s.sku, product_name: s.product_name, qty, revenue, cogs });
    o.total_units   += qty;
    o.total_revenue += revenue;
    o.total_cogs    += cogs;
  }

  const orders = Object.values(orderMap).map(o => ({
    ...o,
    total_revenue:    Math.round(o.total_revenue * 100) / 100,
    total_cogs:       Math.round(o.total_cogs    * 100) / 100,
    gross_profit:     Math.round((o.total_revenue - o.total_cogs) * 100) / 100,
    gross_margin_pct: o.total_revenue > 0 ? Math.round((o.total_revenue - o.total_cogs) / o.total_revenue * 100) : null,
  }));

  orders.sort((a, b) => b.order_date.localeCompare(a.order_date));
  res.json(orders);
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
    if (!costMap[p.sku]) costMap[p.sku] = { totalCost: 0, totalQty: 0 };
    costMap[p.sku].totalCost += p.unit_cost * p.quantity;
    costMap[p.sku].totalQty  += p.quantity;
  }
  const avgCost = (sku) => {
    const c = costMap[sku];
    return c && c.totalQty > 0 ? c.totalCost / c.totalQty : 0;
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

  // Group by order
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
        estimated_cogs:        0,
        notes:                 null,
      };
    }
    const o = orderMap[s.shopify_order_id];
    const qty = s.quantity_sold || 0;
    const cogs = qty * avgCost(s.sku);
    o.line_items.push({ sku: s.sku, product_name: s.product_name, qty });
    o.total_units    += qty;
    o.estimated_cogs += cogs;
  }

  const orders = Object.values(orderMap).map(o => ({
    ...o,
    estimated_cogs: Math.round(o.estimated_cogs * 100) / 100,
  }));

  orders.sort((a, b) => b.order_date.localeCompare(a.order_date));

  const summary = {
    total_resends:       orders.length,
    total_units_resent:  orders.reduce((s, o) => s + o.total_units, 0),
    total_estimated_cogs: Math.round(orders.reduce((s, o) => s + o.estimated_cogs, 0) * 100) / 100,
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
      .select('sku, product_name, quantity_sold, unit_purchase_cost, unit_gd_shipping, unit_scc_handling, total_unit_cogs, sale_price, gross_profit, order_date')
      .gte('order_date', start_date)
      .lte('order_date', end_date)
      .eq('store', store);
    if (eErr) return res.status(500).json({ error: eErr.message });
    if (!entries || entries.length === 0) return res.json({ sku_breakdown: [], total_revenue: 0, total_cogs: 0, gross_margin_pct: 0, total_inventory_value: 0, redo_fees: 0, shipping_total: 0, tax_total: 0, gross_sales: 0, total_discounts: 0, total_returns: 0, net_sales: 0, shipping_revenue: 0, total_collected: 0 });

    // Group by SKU
    const skuMap = {};
    for (const e of entries) {
      if (!skuMap[e.sku]) {
        skuMap[e.sku] = { sku: e.sku, product_name: e.product_name, units_sold: 0, revenue: 0, cogs: 0, purchase_cost: 0, gd_shipping: 0, scc_handling: 0 };
      }
      const qty = e.quantity_sold || 0;
      skuMap[e.sku].units_sold += qty;
      skuMap[e.sku].revenue += qty * parseFloat(e.sale_price || 0);
      skuMap[e.sku].cogs += qty * parseFloat(e.total_unit_cogs || 0);
      skuMap[e.sku].purchase_cost += qty * parseFloat(e.unit_purchase_cost || 0);
      skuMap[e.sku].gd_shipping += qty * parseFloat(e.unit_gd_shipping || 0);
      skuMap[e.sku].scc_handling += qty * parseFloat(e.unit_scc_handling || 0);
    }

    // Get inventory on-hand from WAC data (purchases − all-time net sold)
    const { data: allPurchases } = await supabase.from('purchases').select('sku, product_name, quantity, unit_cost');
    const { data: allSales } = await supabase.from('shopify_sales').select('sku, quantity_sold').neq('sku', 'x-redo').neq('sku', 'shipping').neq('sku', 'tax');
    const { data: allRefunds } = await supabase.from('shopify_refunds').select('sku, quantity_refunded');

    const purchaseMap = {};
    for (const p of (allPurchases || [])) {
      if (!purchaseMap[p.sku]) purchaseMap[p.sku] = { totalQty: 0, totalCost: 0 };
      purchaseMap[p.sku].totalQty += p.quantity;
      purchaseMap[p.sku].totalCost += p.quantity * parseFloat(p.unit_cost);
    }
    const allTimeSold = {};
    for (const s of (allSales || [])) allTimeSold[s.sku] = (allTimeSold[s.sku] || 0) + s.quantity_sold;
    for (const r of (allRefunds || [])) allTimeSold[r.sku] = (allTimeSold[r.sku] || 0) - r.quantity_refunded;

    // Get period refunds (by refund_date) to compute net units/revenue
    const { data: periodRefunds } = await supabase
      .from('shopify_refunds')
      .select('sku, quantity_refunded, refund_subtotal')
      .gte('refund_date', start_date)
      .lte('refund_date', end_date)
      .eq('store', store);

    const refundMap = {};
    for (const r of (periodRefunds || [])) {
      if (!refundMap[r.sku]) refundMap[r.sku] = { qty: 0, subtotal: 0 };
      refundMap[r.sku].qty += r.quantity_refunded;
      refundMap[r.sku].subtotal += parseFloat(r.refund_subtotal || 0);
    }

    const skuBreakdown = Object.values(skuMap).map(s => {
      const refund = refundMap[s.sku] || { qty: 0, subtotal: 0 };
      const netUnits = s.units_sold - refund.qty;
      const netRevenue = s.revenue - refund.subtotal;
      // Scale COGS proportionally for net units
      const avgUnitCogs = s.units_sold > 0 ? s.cogs / s.units_sold : 0;
      const netCogs = netUnits * avgUnitCogs;
      const margin = netRevenue > 0 ? ((netRevenue - netCogs) / netRevenue) * 100 : 0;
      const pm = purchaseMap[s.sku] || { totalQty: 0, totalCost: 0 };
      const avgCost = pm.totalQty > 0 ? pm.totalCost / pm.totalQty : 0;
      const onHand = Math.max(0, pm.totalQty - (allTimeSold[s.sku] || 0));
      return {
        sku: s.sku,
        product_name: s.product_name,
        units_sold: netUnits,
        avg_unit_cost: s.units_sold > 0 ? Math.round(s.cogs / s.units_sold * 100) / 100 : 0,
        revenue: Math.round(netRevenue * 100) / 100,
        cogs: Math.round(netCogs * 100) / 100,
        gross_margin_pct: Math.round(margin * 100) / 100,
        units_on_hand: onHand,
        inventory_value: Math.round(onHand * avgCost * 100) / 100,
        // FIFO cost breakdown
        purchase_cost: Math.round(s.purchase_cost * 100) / 100,
        gd_shipping: Math.round(s.gd_shipping * 100) / 100,
        scc_handling: Math.round(s.scc_handling * 100) / 100,
      };
    });

    // Also add SKUs with inventory but no period sales
    for (const [sku, pm] of Object.entries(purchaseMap)) {
      if (skuMap[sku]) continue;
      const avgCost = pm.totalQty > 0 ? pm.totalCost / pm.totalQty : 0;
      const onHand = Math.max(0, pm.totalQty - (allTimeSold[sku] || 0));
      if (onHand > 0) {
        skuBreakdown.push({
          sku, product_name: (allPurchases || []).find(p => p.sku === sku)?.product_name || 'Unknown',
          units_sold: 0, avg_unit_cost: Math.round(avgCost * 100) / 100, revenue: 0, cogs: 0,
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

    function _sumV(rows, sku) {
      return (rows || []).filter(r => r.sku === sku)
        .reduce((s, r) => s + (r.quantity_sold || 0) * parseFloat(r.sale_price || 0), 0);
    }
    const redoFees = _sumV(virtualRows, 'x-redo');
    const redoUnits = (virtualRows || []).filter(r => r.sku === 'x-redo')
      .reduce((s, r) => s + (r.quantity_sold || 0), 0);
    const shippingTotal = _sumV(virtualRows, 'shipping');
    const taxTotal = _sumV(virtualRows, 'tax');

    // Sales breakdown — same note: sale_price is net of discounts from sync
    const grossSales = Object.values(skuMap).reduce((s, d) => s + d.revenue, 0);
    const totalDiscounts = 0; // Already baked into sale_price during sync
    const totalReturns = Object.values(refundMap).reduce((s, d) => s + d.subtotal, 0);
    const netSales = grossSales - totalReturns;
    const shippingRevenue = shippingTotal;
    const totalCollected = netSales + shippingRevenue + redoFees;

    const totalRevenue = skuBreakdown.reduce((s, r) => s + r.revenue, 0);
    const totalCogs = skuBreakdown.reduce((s, r) => s + r.cogs, 0);
    const totalInvValue = skuBreakdown.reduce((s, r) => s + r.inventory_value, 0);

    res.json({
      period: `${start_date} – ${end_date}`,
      total_revenue: Math.round((totalRevenue + redoFees + shippingTotal + taxTotal) * 100) / 100,
      total_cogs: Math.round(totalCogs * 100) / 100,
      total_inventory_value: Math.round(totalInvValue * 100) / 100,
      gross_margin_pct: totalRevenue > 0 ? Math.round((totalRevenue - totalCogs) / totalRevenue * 10000) / 100 : 0,
      redo_fees: Math.round(redoFees * 100) / 100,
      redo_units: redoUnits,
      shipping_total: Math.round(shippingTotal * 100) / 100,
      tax_total: Math.round(taxTotal * 100) / 100,
      gross_sales: Math.round(grossSales * 100) / 100,
      total_discounts: totalDiscounts,
      total_returns: Math.round(totalReturns * 100) / 100,
      net_sales: Math.round(netSales * 100) / 100,
      shipping_revenue: Math.round(shippingRevenue * 100) / 100,
      total_collected: Math.round(totalCollected * 100) / 100,
      sku_breakdown: skuBreakdown,
    });
  } catch (err) {
    console.error('FIFO by-sku error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/cogs/entries/by-order ──────────────────────────────────────────
// Returns FIFO-based per-order breakdown from cogs_entries, same shape as /orders
router.get('/entries/by-order', async (req, res) => {
  const { start_date, end_date, store = 'au' } = req.query;
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date and end_date required' });

  try {
    const { data: entries, error: eErr } = await supabase
      .from('cogs_entries')
      .select('shopify_order_id, order_number, order_date, sku, product_name, quantity_sold, unit_purchase_cost, unit_gd_shipping, unit_scc_handling, total_unit_cogs, sale_price, gross_profit, fulfillment_location')
      .gte('order_date', start_date)
      .lte('order_date', end_date)
      .eq('store', store)
      .order('order_date', { ascending: false });
    if (eErr) return res.status(500).json({ error: eErr.message });
    if (!entries || entries.length === 0) return res.json([]);

    // Get customer names from shopify_sales
    const orderIds = [...new Set(entries.map(e => e.shopify_order_id))];
    const { data: salesInfo } = await supabase
      .from('shopify_sales')
      .select('shopify_order_id, customer_name')
      .in('shopify_order_id', orderIds);
    const customerMap = {};
    for (const s of (salesInfo || [])) {
      if (s.customer_name) customerMap[s.shopify_order_id] = s.customer_name;
    }

    // Group by order
    const orderMap = {};
    for (const e of entries) {
      const skuLower = (e.sku || '').toLowerCase();
      if (skuLower === 'x-redo' || skuLower === 'shipping' || skuLower === 'tax') continue;
      if (!orderMap[e.shopify_order_id]) {
        orderMap[e.shopify_order_id] = {
          shopify_order_id: e.shopify_order_id,
          order_number: e.order_number || e.shopify_order_id,
          customer_name: customerMap[e.shopify_order_id] || '—',
          order_date: e.order_date,
          fulfillment_location: e.fulfillment_location || 'Unknown',
          line_items: [],
          total_units: 0,
          total_revenue: 0,
          total_cogs: 0,
        };
      }
      const o = orderMap[e.shopify_order_id];
      const qty = e.quantity_sold || 0;
      const revenue = qty * parseFloat(e.sale_price || 0);
      const cogs = qty * parseFloat(e.total_unit_cogs || 0);
      o.line_items.push({
        sku: e.sku,
        product_name: e.product_name,
        qty,
        revenue: Math.round(revenue * 100) / 100,
        cogs: Math.round(cogs * 100) / 100,
        unit_purchase_cost: parseFloat(e.unit_purchase_cost || 0),
        unit_gd_shipping: parseFloat(e.unit_gd_shipping || 0),
        unit_scc_handling: parseFloat(e.unit_scc_handling || 0),
      });
      o.total_units += qty;
      o.total_revenue += revenue;
      o.total_cogs += cogs;
    }

    const orders = Object.values(orderMap).map(o => ({
      ...o,
      total_revenue: Math.round(o.total_revenue * 100) / 100,
      total_cogs: Math.round(o.total_cogs * 100) / 100,
      gross_profit: Math.round((o.total_revenue - o.total_cogs) * 100) / 100,
      gross_margin_pct: o.total_revenue > 0 ? Math.round((o.total_revenue - o.total_cogs) / o.total_revenue * 100) : null,
    }));

    orders.sort((a, b) => b.order_date.localeCompare(a.order_date));
    res.json(orders);
  } catch (err) {
    console.error('FIFO by-order error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/inventory/summary ───────────────────────────────────────────────
// Returns current stock levels per SKU with values and sales velocity
router.get('/inventory/summary', async (req, res) => {
  const store = req.query.store || 'au';

  try {
    // 1. Get all lots with remaining stock
    const { data: lots, error: lotsErr } = await supabase
      .from('purchase_order_lines')
      .select('sku, product_name, unit_cost, quantity_remaining, po_number')
      .gt('quantity_remaining', 0);
    if (lotsErr) return res.status(500).json({ error: lotsErr.message });
    if (!lots || lots.length === 0) return res.json({ skus: [], total_inventory_value: 0, total_retail_value: 0, total_skus: 0, total_units: 0 });

    // Group by SKU
    const skuMap = {};
    for (const lot of lots) {
      if (!skuMap[lot.sku]) {
        skuMap[lot.sku] = { sku: lot.sku, product_name: lot.product_name, quantity_remaining: 0, total_cost: 0, po_numbers: new Set() };
      }
      skuMap[lot.sku].quantity_remaining += lot.quantity_remaining;
      skuMap[lot.sku].total_cost += lot.quantity_remaining * parseFloat(lot.unit_cost);
      if (lot.po_number) skuMap[lot.sku].po_numbers.add(lot.po_number);
    }

    // 2. Get sales this calendar month
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

    // 3. Get avg sale price per SKU (last 30 days)
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data: recentSales } = await supabase
      .from('shopify_sales')
      .select('sku, quantity_sold, sale_price')
      .gte('order_date', thirtyDaysAgo)
      .eq('store', store)
      .neq('sku', 'x-redo').neq('sku', 'shipping').neq('sku', 'tax');

    const salePriceMap = {}; // { sku: { totalRev, totalQty } }
    for (const s of (recentSales || [])) {
      if (!salePriceMap[s.sku]) salePriceMap[s.sku] = { totalRev: 0, totalQty: 0 };
      const qty = s.quantity_sold || 0;
      salePriceMap[s.sku].totalRev += qty * parseFloat(s.sale_price || 0);
      salePriceMap[s.sku].totalQty += qty;
    }

    // 4. Build response
    const skus = Object.values(skuMap).map(s => {
      const avgUnitCost = s.quantity_remaining > 0 ? s.total_cost / s.quantity_remaining : 0;
      const sp = salePriceMap[s.sku];
      const avgSalePrice = sp && sp.totalQty > 0 ? sp.totalRev / sp.totalQty : 0;
      return {
        sku: s.sku,
        product_name: s.product_name,
        quantity_remaining: s.quantity_remaining,
        unit_cost: Math.round(avgUnitCost * 100) / 100,
        inventory_value: Math.round(s.total_cost * 100) / 100,
        avg_sale_price: Math.round(avgSalePrice * 100) / 100,
        retail_value: Math.round(s.quantity_remaining * avgSalePrice * 100) / 100,
        units_sold_this_month: monthSoldMap[s.sku] || 0,
        po_numbers: [...s.po_numbers],
        low_stock: s.quantity_remaining < 10,
      };
    });

    skus.sort((a, b) => (a.product_name || '').localeCompare(b.product_name || ''));

    res.json({
      skus,
      total_inventory_value: Math.round(skus.reduce((s, r) => s + r.inventory_value, 0) * 100) / 100,
      total_retail_value: Math.round(skus.reduce((s, r) => s + r.retail_value, 0) * 100) / 100,
      total_skus: skus.length,
      total_units: skus.reduce((s, r) => s + r.quantity_remaining, 0),
    });
  } catch (err) {
    console.error('Inventory summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/forecast/revenue ────────────────────────────────────────────────
// Daily revenue for last 90 days + 30-day forward projection
router.get('/forecast/revenue', async (req, res) => {
  const store = req.query.store || 'au';

  try {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const ninetyAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const { data: sales, error: sErr } = await supabase
      .from('shopify_sales')
      .select('order_date, quantity_sold, sale_price')
      .gte('order_date', ninetyAgo)
      .lte('order_date', today)
      .eq('store', store)
      .neq('sku', 'x-redo').neq('sku', 'shipping').neq('sku', 'tax');
    if (sErr) return res.status(500).json({ error: sErr.message });

    // Build daily revenue map
    const dailyMap = {};
    for (const s of (sales || [])) {
      const d = s.order_date;
      dailyMap[d] = (dailyMap[d] || 0) + (s.quantity_sold || 0) * parseFloat(s.sale_price || 0);
    }

    // Fill all 90 days (including zero-revenue days)
    const historical = [];
    for (let i = 89; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      historical.push({ date: d, revenue: Math.round((dailyMap[d] || 0) * 100) / 100 });
    }

    // 7-day rolling average
    for (let i = 0; i < historical.length; i++) {
      const windowStart = Math.max(0, i - 6);
      const window = historical.slice(windowStart, i + 1);
      historical[i].rolling_7d = Math.round(window.reduce((s, r) => s + r.revenue, 0) / window.length * 100) / 100;
    }

    // Projection: average of last 30 days
    const last30 = historical.slice(-30);
    const avgDaily = last30.reduce((s, r) => s + r.revenue, 0) / 30;

    const forecast = [];
    for (let i = 1; i <= 30; i++) {
      const d = new Date(now.getTime() + i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      forecast.push({
        date: d,
        projected: Math.round(avgDaily * 100) / 100,
        low: Math.round(avgDaily * 0.7 * 100) / 100,
        high: Math.round(avgDaily * 1.3 * 100) / 100,
      });
    }

    // Days remaining in current month
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dayOfMonth = now.getDate();
    const daysRemaining = daysInMonth - dayOfMonth;

    // Revenue so far this month
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const thisMonthRev = historical.filter(h => h.date >= monthStart).reduce((s, r) => s + r.revenue, 0);

    // Next month projection
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const daysInNextMonth = new Date(nextMonth.getFullYear(), nextMonth.getMonth() + 1, 0).getDate();

    res.json({
      historical,
      forecast,
      summary: {
        avg_daily: Math.round(avgDaily * 100) / 100,
        projected_this_month: Math.round((thisMonthRev + daysRemaining * avgDaily) * 100) / 100,
        projected_next_month: Math.round(avgDaily * daysInNextMonth * 100) / 100,
      },
    });
  } catch (err) {
    console.error('Forecast revenue error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/forecast/stockout ──────────────────────────────────────────────
// Stockout risk per SKU based on sales velocity
router.get('/forecast/stockout', async (req, res) => {
  const store = req.query.store || 'au';

  try {
    // Get current stock from purchase_order_lines
    const { data: lots, error: lotsErr } = await supabase
      .from('purchase_order_lines')
      .select('sku, product_name, quantity_remaining, po_number')
      .gt('quantity_remaining', 0);
    if (lotsErr) return res.status(500).json({ error: lotsErr.message });

    // Group by SKU
    const skuStock = {};
    for (const lot of (lots || [])) {
      if (!skuStock[lot.sku]) {
        skuStock[lot.sku] = { sku: lot.sku, product_name: lot.product_name, quantity_remaining: 0, po_numbers: new Set() };
      }
      skuStock[lot.sku].quantity_remaining += lot.quantity_remaining;
      if (lot.po_number) skuStock[lot.sku].po_numbers.add(lot.po_number);
    }

    // Get sales last 30 days for velocity
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const thirtyAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const { data: recentSales, error: rsErr } = await supabase
      .from('shopify_sales')
      .select('sku, quantity_sold')
      .gte('order_date', thirtyAgo)
      .lte('order_date', today)
      .eq('store', store)
      .neq('sku', 'x-redo').neq('sku', 'shipping').neq('sku', 'tax');
    if (rsErr) return res.status(500).json({ error: rsErr.message });

    const soldMap = {};
    for (const s of (recentSales || [])) {
      soldMap[s.sku] = (soldMap[s.sku] || 0) + (s.quantity_sold || 0);
    }

    const LEAD_TIME_DAYS = 60;
    const results = [];

    for (const [sku, stock] of Object.entries(skuStock)) {
      const unitsSold30d = soldMap[sku] || 0;
      const dailyVelocity = unitsSold30d / 30;
      let daysUntilStockout = null;
      let reorderByDate = null;
      let status = 'no_movement';

      if (dailyVelocity > 0) {
        daysUntilStockout = Math.round(stock.quantity_remaining / dailyVelocity);
        const reorderDate = new Date(now.getTime() + Math.max(0, daysUntilStockout - LEAD_TIME_DAYS) * 24 * 60 * 60 * 1000);
        reorderByDate = reorderDate.toISOString().slice(0, 10);

        if (daysUntilStockout < 30) status = 'danger';
        else if (daysUntilStockout < 90) status = 'order_now';
        else if (daysUntilStockout < 120) status = 'warning';
        else status = 'ok';
      }

      results.push({
        sku,
        product_name: stock.product_name,
        quantity_remaining: stock.quantity_remaining,
        units_sold_30d: unitsSold30d,
        daily_velocity: Math.round(dailyVelocity * 100) / 100,
        days_until_stockout: daysUntilStockout,
        reorder_by_date: reorderByDate,
        status,
        po_numbers: [...stock.po_numbers],
      });
    }

    // Sort: danger first, then by days_until_stockout ascending (nulls last)
    results.sort((a, b) => {
      if (a.days_until_stockout === null && b.days_until_stockout === null) return 0;
      if (a.days_until_stockout === null) return 1;
      if (b.days_until_stockout === null) return -1;
      return a.days_until_stockout - b.days_until_stockout;
    });

    res.json(results);
  } catch (err) {
    console.error('Forecast stockout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/forecast/peak-period ───────────────────────────────────────────
// Analyse a past peak period and compare with current stock
router.get('/forecast/peak-period', async (req, res) => {
  const { store = 'au', period_start, period_end } = req.query;
  if (!period_start || !period_end) return res.status(400).json({ error: 'period_start and period_end required (YYYY-MM-DD)' });

  try {
    // Get sales during the peak period
    const { data: sales, error: sErr } = await supabase
      .from('shopify_sales')
      .select('sku, product_name, quantity_sold, sale_price, order_date')
      .gte('order_date', period_start)
      .lte('order_date', period_end)
      .eq('store', store)
      .neq('sku', 'x-redo').neq('sku', 'shipping').neq('sku', 'tax');
    if (sErr) return res.status(500).json({ error: sErr.message });

    // Daily breakdown
    const dailyMap = {};
    const skuMap = {};
    let totalRevenue = 0;
    let totalUnits = 0;

    for (const s of (sales || [])) {
      const qty = s.quantity_sold || 0;
      const rev = qty * parseFloat(s.sale_price || 0);
      totalRevenue += rev;
      totalUnits += qty;

      dailyMap[s.order_date] = (dailyMap[s.order_date] || 0) + rev;

      if (!skuMap[s.sku]) {
        skuMap[s.sku] = { sku: s.sku, product_name: s.product_name, units_sold: 0, revenue: 0 };
      }
      skuMap[s.sku].units_sold += qty;
      skuMap[s.sku].revenue += rev;
    }

    // Get current stock
    const { data: lots } = await supabase
      .from('purchase_order_lines')
      .select('sku, quantity_remaining')
      .gt('quantity_remaining', 0);

    const stockMap = {};
    for (const lot of (lots || [])) {
      stockMap[lot.sku] = (stockMap[lot.sku] || 0) + lot.quantity_remaining;
    }

    // Build daily breakdown sorted
    const daily = Object.entries(dailyMap)
      .map(([date, revenue]) => ({ date, revenue: Math.round(revenue * 100) / 100 }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Gap analysis
    const gapAnalysis = Object.values(skuMap).map(s => {
      const currentStock = stockMap[s.sku] || 0;
      const gap = currentStock - s.units_sold;
      let status = 'sufficient';
      if (gap < 0) status = 'insufficient';
      else if (gap < s.units_sold * 0.25) status = 'at_risk';

      return {
        sku: s.sku,
        product_name: s.product_name,
        peak_units_sold: s.units_sold,
        peak_revenue: Math.round(s.revenue * 100) / 100,
        current_stock: currentStock,
        stock_gap: gap,
        status,
      };
    }).sort((a, b) => a.stock_gap - b.stock_gap);

    // How many equivalent events can current stock support?
    const equivalentEvents = totalUnits > 0
      ? Math.round(Object.values(stockMap).reduce((s, v) => s + v, 0) / totalUnits * 10) / 10
      : null;

    res.json({
      period: { start: period_start, end: period_end },
      total_revenue: Math.round(totalRevenue * 100) / 100,
      total_units: totalUnits,
      daily,
      sku_breakdown: Object.values(skuMap).map(s => ({
        ...s,
        revenue: Math.round(s.revenue * 100) / 100,
      })),
      gap_analysis: gapAnalysis,
      equivalent_events: equivalentEvents,
    });
  } catch (err) {
    console.error('Peak period error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.buildCogsData = buildCogsData;
