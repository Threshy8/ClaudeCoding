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
    .select('sku, quantity_sold');

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
    .lt('order_date', periodEnd);

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

  // --- Totals ---
  const totalRevenue = skuBreakdown.reduce((s, r) => s + r.revenue, 0);
  const totalCogs = skuBreakdown.reduce((s, r) => s + r.cogs, 0);
  const totalInventoryValue = skuBreakdown.reduce((s, r) => s + r.inventory_value, 0);
  const overallMargin = totalRevenue > 0 ? ((totalRevenue - totalCogs) / totalRevenue) * 100 : 0;

  return {
    period: periodLabel,
    period_start: periodStart,
    period_end: periodEnd,
    total_revenue: Math.round(totalRevenue * 100) / 100,
    total_cogs: Math.round(totalCogs * 100) / 100,
    total_inventory_value: Math.round(totalInventoryValue * 100) / 100,
    gross_margin_pct: Math.round(overallMargin * 100) / 100,
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
    .select('shopify_order_id, order_number, sku, product_name, quantity_sold, sale_price, order_date, fulfillment_location')
    .gte('order_date', start_date)
    .lte('order_date', end_date)
    .eq('store', store)
    .order('order_date', { ascending: false });
  if (sErr) return res.status(500).json({ error: sErr.message });

  // Group by order
  const orderMap = {};
  for (const s of (sales || [])) {
    if ((s.sku || '').toLowerCase().includes('x-redo')) continue; // exclude non-physical
    if (!orderMap[s.shopify_order_id]) {
      orderMap[s.shopify_order_id] = {
        shopify_order_id:     s.shopify_order_id,
        order_number:         s.order_number || s.shopify_order_id,
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

module.exports = router;
module.exports.buildCogsData = buildCogsData;
