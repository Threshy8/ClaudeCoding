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

async function buildCogsData(period, through) {
  const [year, month] = period.split('-').map(Number);
  const periodStart = `${year}-${String(month).padStart(2, '0')}-01`;
  let periodEnd = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;

  // Cap end date: explicit ?through=YYYY-MM-DD, or "month to date" for current month
  if (through && /^\d{4}-\d{2}-\d{2}$/.test(through)) {
    const throughDate = new Date(through + 'T12:00:00Z');
    const nextDay = new Date(throughDate);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    periodEnd = nextDay.toISOString().slice(0, 10);
  } else {
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

  // 1. Get all purchases (all time) to compute average costs and total stock purchased
  const { data: allPurchases, error: purchaseError } = await supabase
    .from('purchases')
    .select('sku, product_name, quantity, unit_cost');

  if (purchaseError) throw new Error(purchaseError.message);

  // 2. Get all sales (all time) to compute units sold per SKU (for inventory on-hand)
  const { data: allSales, error: allSalesError } = await supabase
    .from('shopify_sales')
    .select('sku, quantity_sold');

  if (allSalesError) throw new Error(allSalesError.message);

  // 3. Get sales for the requested period only (for revenue and period COGS)
  const { data: periodSales, error: periodSalesError } = await supabase
    .from('shopify_sales')
    .select('sku, product_name, quantity_sold, sale_price, order_date')
    .gte('order_date', periodStart)
    .lt('order_date', periodEnd);

  if (periodSalesError) throw new Error(periodSalesError.message);

  // --- Build average cost map per SKU ---
  const skuCostMap = {}; // { sku: { totalQty, totalCost, productName } }
  for (const p of allPurchases) {
    if (!skuCostMap[p.sku]) {
      skuCostMap[p.sku] = { totalQty: 0, totalCost: 0, productName: p.product_name };
    }
    skuCostMap[p.sku].totalQty += p.quantity;
    skuCostMap[p.sku].totalCost += p.quantity * parseFloat(p.unit_cost);
  }

  const avgCostMap = {}; // { sku: avgCost }
  const totalPurchasedMap = {}; // { sku: totalQty }
  for (const [sku, d] of Object.entries(skuCostMap)) {
    avgCostMap[sku] = d.totalQty > 0 ? d.totalCost / d.totalQty : 0;
    totalPurchasedMap[sku] = d.totalQty;
  }

  // --- Build all-time units sold map per SKU ---
  const allTimeSoldMap = {}; // { sku: totalSold }
  for (const s of allSales) {
    allTimeSoldMap[s.sku] = (allTimeSoldMap[s.sku] || 0) + s.quantity_sold;
  }

  // --- Build period sales summary per SKU ---
  const periodSkuMap = {}; // { sku: { unitsSold, revenue, productName } }
  for (const s of periodSales) {
    if (!periodSkuMap[s.sku]) {
      periodSkuMap[s.sku] = {
        product_name: s.product_name,
        units_sold: 0,
        revenue: 0,
      };
    }
    periodSkuMap[s.sku].units_sold += s.quantity_sold;
    periodSkuMap[s.sku].revenue += s.quantity_sold * parseFloat(s.sale_price);
  }

  // --- Build per-SKU breakdown ---
  const skuBreakdown = [];

  for (const [sku, d] of Object.entries(periodSkuMap)) {
    const avgCost = avgCostMap[sku] || 0;
    const cogs = d.units_sold * avgCost;
    const revenue = d.revenue;
    const grossMargin = revenue > 0 ? ((revenue - cogs) / revenue) * 100 : 0;

    // Inventory on hand = total ever purchased - total ever sold
    const totalPurchased = totalPurchasedMap[sku] || 0;
    const totalSoldAllTime = allTimeSoldMap[sku] || 0;
    const unitsOnHand = Math.max(0, totalPurchased - totalSoldAllTime);
    const inventoryValue = unitsOnHand * avgCost;

    skuBreakdown.push({
      sku,
      product_name: d.product_name || skuCostMap[sku]?.productName || 'Unknown',
      units_sold: d.units_sold,
      avg_unit_cost: Math.round(avgCost * 100) / 100,
      revenue: Math.round(revenue * 100) / 100,
      cogs: Math.round(cogs * 100) / 100,
      gross_margin_pct: Math.round(grossMargin * 100) / 100,
      units_on_hand: unitsOnHand,
      inventory_value: Math.round(inventoryValue * 100) / 100,
    });
  }

  // Also include SKUs that have inventory but no period sales (for inventory value)
  for (const [sku, d] of Object.entries(skuCostMap)) {
    if (periodSkuMap[sku]) continue; // already included above
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
    period,
    total_revenue: Math.round(totalRevenue * 100) / 100,
    total_cogs: Math.round(totalCogs * 100) / 100,
    total_inventory_value: Math.round(totalInventoryValue * 100) / 100,
    gross_margin_pct: Math.round(overallMargin * 100) / 100,
    sku_breakdown: skuBreakdown,
  };
}

// GET /api/cogs/summary?period=2026-02&through=2026-03-10 (optional: cap end date)
router.get('/summary', async (req, res) => {
  const period = req.query.period;
  const through = req.query.through; // optional YYYY-MM-DD to match Shopify report range
  if (!period || !/^\d{4}-\d{2}$/.test(period)) {
    return res.status(400).json({ error: 'period query param required in format YYYY-MM (e.g. 2026-02)' });
  }

  try {
    const data = await buildCogsData(period, through);
    res.json(data);
  } catch (err) {
    console.error('COGS summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.buildCogsData = buildCogsData;
