const express = require('express');
const router = express.Router();
const axios = require('axios');
const supabase = require('../db/supabase');
const { sleep, shopifyGet, getShopifyAccessToken } = require('../utils/shopify');
const { toStoreDate } = require('../utils/date');

const BASE_URL = process.env.REDO_API_BASE_URL || 'https://api.getredo.com/v2.2';
const TOKEN = process.env.REDO_API_TOKEN;
const STORE_ID = process.env.REDO_STORE_ID;

// ── Shopify refund lookup ────────────────────────────────────────────────────

/**
 * Fetch refund details for a specific order from Shopify Orders API.
 * Returns { product_refund, shipping_refund, total_refund } in dollars,
 * or null if the order has no refunds or can't be fetched.
 */
async function fetchShopifyRefund(orderName, sku) {
  const storeUrl = process.env.SHOPIFY_STORE_URL;
  if (!storeUrl) return null;

  let accessToken;
  try {
    accessToken = await getShopifyAccessToken();
  } catch (e) {
    console.error('[redo] Failed to get Shopify access token:', e.message);
    return null;
  }
  if (!accessToken) return null;

  const base = storeUrl.replace(/\/$/, '');
  const orderNum = orderName.replace(/^#/, '');
  const suffixes = ['AUS', ''];
  let allOrders = [];
  let searchedName = '';

  try {
    for (const suffix of suffixes) {
      searchedName = `#${orderNum}${suffix}`;
      const url = `${base}/admin/api/2024-01/orders.json?name=${encodeURIComponent(searchedName)}&status=any&fields=id,name,order_number,refunds,shipping_lines,line_items`;
      const response = await shopifyGet(url, accessToken);
      allOrders = response.data?.orders || [];
      if (allOrders.length > 0) break;
    }
    if (allOrders.length === 0) return null;

    // Prefer exact name match (avoid partial matches like #6084-RESEND for #6084)
    const exactMatch = allOrders.find(o => o.name === searchedName);
    const order = exactMatch || allOrders[0];
    const refunds = order.refunds || [];

    let productRefundCents = 0;
    let shippingRefundCents = 0;
    let refundDiscrepancyCents = 0;

    for (const refund of refunds) {
      for (const rli of (refund.refund_line_items || [])) {
        const itemSku = rli.line_item?.sku || '';
        if (itemSku === sku) {
          productRefundCents += Math.round(parseFloat(rli.subtotal || 0) * 100);
        }
      }
      for (const adj of (refund.order_adjustments || [])) {
        if (adj.kind === 'shipping_refund') {
          shippingRefundCents += Math.abs(Math.round(parseFloat(adj.amount || 0) * 100));
        } else if (adj.kind === 'refund_discrepancy') {
          refundDiscrepancyCents += Math.round(parseFloat(adj.amount || 0) * 100);
        }
      }
    }

    if (productRefundCents > 0) {
      return { product_refund: productRefundCents / 100, shipping_refund: shippingRefundCents / 100, total_refund: (productRefundCents + shippingRefundCents) / 100 };
    }

    if (refundDiscrepancyCents !== 0) {
      const netProductCents = Math.abs(refundDiscrepancyCents);
      return { product_refund: netProductCents / 100, shipping_refund: shippingRefundCents / 100, total_refund: (netProductCents + shippingRefundCents) / 100, source: 'refund_discrepancy' };
    }

    // Fallback: use original line item price
    const lineItem = (order.line_items || []).find(li => li.sku === sku);
    if (lineItem) {
      const originalPriceCents = Math.round(parseFloat(lineItem.price || 0) * 100) * (lineItem.quantity || 1);
      return { product_refund: originalPriceCents / 100, shipping_refund: 0, total_refund: originalPriceCents / 100, source: 'line_item_price' };
    }

    return null;
  } catch (err) {
    console.error(`[redo] Failed to fetch Shopify order ${orderName}:`, err.response?.status, err.message);
    return null;
  }
}

// ── Redo API helpers ─────────────────────────────────────────────────────────

async function fetchAllRedoReturns(updatedAtMin) {
  const returns = [];
  let pageContinue = null;

  do {
    const params = {};
    if (updatedAtMin) params.updated_at_min = updatedAtMin;

    const headers = {
      'Authorization': `Bearer ${TOKEN}`,
      'X-Page-Size': '100',
    };
    if (pageContinue) headers['X-Page-Continue'] = pageContinue;

    const response = await axios.get(`${BASE_URL}/stores/${STORE_ID}/returns`, { headers, params });
    const data = response.data;
    returns.push(...(data.returns || data || []));

    pageContinue = response.headers['x-page-next'] || response.headers['X-Page-Next'] || null;
  } while (pageContinue);

  return returns;
}

// GET /api/sync/redo/test — connectivity check
router.get('/test', async (req, res) => {
  if (!TOKEN || !STORE_ID) {
    return res.json({ ok: false, error: 'REDO_API_TOKEN or REDO_STORE_ID not configured' });
  }
  try {
    const response = await axios.get(`${BASE_URL}/stores/${STORE_ID}/returns`, {
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'X-Page-Size': '1' },
    });
    res.json({ ok: true, sample_count: (response.data.returns || response.data || []).length });
  } catch (err) {
    res.json({ ok: false, error: err.response?.data || err.message });
  }
});

// POST /api/sync/redo — full sync
router.post('/', async (req, res) => {
  const store = req.body.store || 'au';
  const updatedAtMin = req.body.updated_at_min || null;

  if (!TOKEN || !STORE_ID) {
    return res.status(400).json({ error: 'REDO_API_TOKEN or REDO_STORE_ID not configured' });
  }

  try {
    const allReturns = await fetchAllRedoReturns(updatedAtMin);

    // Build records — one row per (return, sku)
    const records = [];
    for (const ret of allReturns) {
      const orderName = ret.order?.name || '';
      const returnDate = toStoreDate(ret.updatedAt) || toStoreDate(ret.createdAt);
      if (!returnDate) continue;

      for (const item of (ret.items || [])) {
        const refundAmount = parseFloat(item.refund?.amount?.amount || item.refund?.amount || 0);
        const qty = item.quantity || 1;
        const sku = item.sku || item.variantId || 'UNKNOWN';

        records.push({
          redo_return_id: ret.id || ret._id,
          shopify_order_name: orderName,
          sku,
          product_name: item.product?.title || item.productTitle || 'Unknown',
          quantity_returned: qty,
          refund_amount: Math.round(refundAmount * 100) / 100,
          return_type: ret.type,
          status: ret.status,
          return_date: returnDate,
          updated_at: ret.updatedAt,
          store,
        });
      }
    }

    // Aggregate items with the same (redo_return_id, sku) to avoid upsert conflicts
    const aggMap = {};
    for (const r of records) {
      const key = `${r.redo_return_id}|${r.sku}`;
      if (!aggMap[key]) {
        aggMap[key] = { ...r };
      } else {
        aggMap[key].quantity_returned += r.quantity_returned;
        aggMap[key].refund_amount = Math.round((aggMap[key].refund_amount + r.refund_amount) * 100) / 100;
      }
    }
    const aggregatedRecords = Object.values(aggMap);

    // De-duplicate: skip returns already captured in shopify_refunds
    const { data: existingRefunds } = await supabase
      .from('shopify_refunds')
      .select('order_number, sku')
      .eq('store', store);

    const coveredSet = new Set(
      (existingRefunds || []).map(r => `${r.order_number}|${r.sku}`)
    );

    const filteredRecords = aggregatedRecords.filter(r => {
      const orderNum = (r.shopify_order_name || '').replace(/^#/, '');
      return !coveredSet.has(`${orderNum}|${r.sku}`);
    });

    // Cross-check against Shopify API for orders not in shopify_sales
    const { data: salesOrders } = await supabase
      .from('shopify_sales')
      .select('order_number')
      .eq('store', store);
    const salesOrderSet = new Set((salesOrders || []).map(r => r.order_number));

    let crossCheckCount = 0;
    let crossCheckUpdated = 0;
    for (const rec of filteredRecords) {
      const orderNum = (rec.shopify_order_name || '').replace(/^#/, '');
      if (salesOrderSet.has(orderNum)) continue;

      if (crossCheckCount > 0) await sleep(600);
      crossCheckCount++;
      const shopifyRefund = await fetchShopifyRefund(rec.shopify_order_name, rec.sku);
      if (shopifyRefund && shopifyRefund.product_refund !== rec.refund_amount) {
        console.log(`[redo] Correcting refund for ${rec.shopify_order_name}/${rec.sku}: $${rec.refund_amount} -> $${shopifyRefund.product_refund}`);
        rec.refund_amount = shopifyRefund.product_refund;
        crossCheckUpdated++;
      }
    }

    // Clear old Redo returns and insert fresh
    await supabase.from('redo_returns').delete().eq('store', store);

    let insertedCount = 0;
    const errors = [];
    for (let i = 0; i < filteredRecords.length; i += 100) {
      const batch = filteredRecords.slice(i, i + 100);
      const { data: inserted, error: upsertErr } = await supabase
        .from('redo_returns')
        .upsert(batch, { onConflict: 'redo_return_id,sku' })
        .select('id');
      if (upsertErr) {
        console.error('Redo upsert error:', upsertErr.message, 'batch index:', i);
        errors.push({ batch_index: i, batch_size: batch.length, error: upsertErr.message });
      } else {
        insertedCount += (inserted || []).length;
      }
    }

    res.json({
      success: true,
      returns_fetched: allReturns.length,
      records_total: records.length,
      records_aggregated: aggregatedRecords.length,
      records_deduped: aggregatedRecords.length - filteredRecords.length,
      records_attempted: filteredRecords.length,
      records_inserted: insertedCount,
      shopify_cross_checked: crossCheckCount,
      shopify_cross_check_updated: crossCheckUpdated,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    console.error('Redo sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
