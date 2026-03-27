const express = require('express');
const router = express.Router();
const axios = require('axios');
const supabase = require('../db/supabase');

const BASE_URL = process.env.REDO_API_BASE_URL || 'https://api.getredo.com/v2.2';
const TOKEN = process.env.REDO_API_TOKEN;
const STORE_ID = process.env.REDO_STORE_ID;
const TZ = process.env.SHOPIFY_STORE_TIMEZONE || 'Australia/Sydney';

function toStoreDate(isoString) {
  if (!isoString) return null;
  const d = new Date(isoString);
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

// ── Shopify helpers ──────────────────────────────────────────────────────────

async function getShopifyAccessToken() {
  const storeUrl = process.env.SHOPIFY_STORE_URL;
  if (process.env.SHOPIFY_ACCESS_TOKEN) return process.env.SHOPIFY_ACCESS_TOKEN;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!storeUrl || !clientId || !clientSecret) return null;

  const base = storeUrl.replace(/\/$/, '');
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
  });
  const response = await axios.post(`${base}/admin/oauth/access_token`, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    maxRedirects: 0,
    validateStatus: (status) => status >= 200 && status < 300,
  });
  return response.data?.access_token || null;
}

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

  // Shopify order names may have a store suffix (e.g. #4758AUS)
  // Try with suffix first, then without
  const suffixes = ['AUS', ''];
  let orders = [];

  try {
    for (const suffix of suffixes) {
      const searchName = `#${orderNum}${suffix}`;
      const url = `${base}/admin/api/2024-01/orders.json?name=${encodeURIComponent(searchName)}&status=any&fields=id,name,order_number,refunds,shipping_lines`;
      const response = await axios.get(url, {
        headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' },
      });
      orders = response.data?.orders || [];
      if (orders.length > 0) {
        console.log(`[redo] Found Shopify order with name=${searchName}`);
        break;
      }
    }
    if (orders.length === 0) {
      console.log(`[redo] Shopify order ${orderName} not found (tried suffixes: ${suffixes.join(', ')})`);
      return null;
    }

    const order = orders[0];
    const refunds = order.refunds || [];
    if (refunds.length === 0) {
      console.log(`[redo] Shopify order ${orderName} has no refunds`);
      return null;
    }

    // Sum product refunds for the matching SKU across all refund events
    let productRefundCents = 0;
    let shippingRefundCents = 0;

    for (const refund of refunds) {
      // Product refund line items
      for (const rli of (refund.refund_line_items || [])) {
        const itemSku = rli.line_item?.sku || '';
        if (itemSku === sku) {
          productRefundCents += Math.round(parseFloat(rli.subtotal || 0) * 100);
        }
      }
      // Shipping refund (order_adjustments with kind = 'shipping_refund')
      for (const adj of (refund.order_adjustments || [])) {
        if (adj.kind === 'shipping_refund') {
          // amount is negative in Shopify, so negate it
          shippingRefundCents += Math.abs(Math.round(parseFloat(adj.amount || 0) * 100));
        }
      }
    }

    const totalCents = productRefundCents + shippingRefundCents;
    if (totalCents === 0) {
      console.log(`[redo] Shopify order ${orderName} has refunds but none for SKU ${sku}`);
      return null;
    }

    const result = {
      product_refund: productRefundCents / 100,
      shipping_refund: shippingRefundCents / 100,
      total_refund: totalCents / 100,
    };
    console.log(`[redo] Shopify refund for ${orderName}/${sku}:`, JSON.stringify(result));
    return result;
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
// GET /api/sync/redo/shopify-refund?order=4758&sku=BLK2ATS — debug Shopify refund lookup
router.get('/shopify-refund', async (req, res) => {
  const orderName = req.query.order || '';
  const sku = req.query.sku || '';
  if (!orderName) return res.status(400).json({ error: 'order query param required' });

  try {
    const storeUrl = (process.env.SHOPIFY_STORE_URL || '').replace(/\/$/, '');
    let accessToken;
    try { accessToken = await getShopifyAccessToken(); } catch (e) {
      return res.json({ error: `Auth failed: ${e.message}` });
    }
    if (!accessToken) return res.json({ error: 'No Shopify access token available' });

    // Try with AUS suffix first, then without
    const orderNum = orderName.replace(/^#/, '');
    const suffixes = ['AUS', ''];
    let orders = [];
    let matchedName = '';
    for (const suffix of suffixes) {
      const searchName = `#${orderNum}${suffix}`;
      const url = `${storeUrl}/admin/api/2024-01/orders.json?name=${encodeURIComponent(searchName)}&status=any`;
      const resp = await axios.get(url, {
        headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' },
      });
      orders = resp.data?.orders || [];
      if (orders.length > 0) { matchedName = searchName; break; }
    }

    if (orders.length === 0) {
      return res.json({ found: false, searched_names: suffixes.map(s => `#${orderNum}${s}`), message: 'No orders found' });
    }

    const order = orders[0];
    const refunds = order.refunds || [];

    // Raw refund data for debugging
    const refundDetails = refunds.map(r => ({
      id: r.id,
      created_at: r.created_at,
      line_items: (r.refund_line_items || []).map(rli => ({
        sku: rli.line_item?.sku,
        title: rli.line_item?.title,
        subtotal: rli.subtotal,
        total_tax: rli.total_tax,
        quantity: rli.quantity,
      })),
      adjustments: (r.order_adjustments || []).map(a => ({
        kind: a.kind,
        amount: a.amount,
        reason: a.reason,
      })),
    }));

    // Also run fetchShopifyRefund to show what the sync would compute
    const computed = await fetchShopifyRefund(matchedName || `#${orderNum}`, sku);

    res.json({
      found: true,
      order_name: order.name,
      order_id: order.id,
      refunds_count: refunds.length,
      refund_details: refundDetails,
      computed_for_sku: sku || '(none)',
      computed_result: computed,
    });
  } catch (err) {
    res.json({ error: err.response?.status + ' ' + (err.response?.data?.errors || err.message) });
  }
});

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

// GET /api/sync/redo/debug — inspect raw API response headers + first/last records
router.get('/debug', async (req, res) => {
  if (!TOKEN || !STORE_ID) {
    return res.json({ ok: false, error: 'REDO_API_TOKEN or REDO_STORE_ID not configured' });
  }
  try {
    const pageSize = req.query.page_size || '5';
    const params = {};
    if (req.query.updated_at_min) params.updated_at_min = req.query.updated_at_min;
    if (req.query.updated_at_max) params.updated_at_max = req.query.updated_at_max;

    const headers = {
      'Authorization': `Bearer ${TOKEN}`,
      'X-Page-Size': pageSize,
    };
    if (req.query.page_continue) headers['X-Page-Continue'] = req.query.page_continue;

    const response = await axios.get(`${BASE_URL}/stores/${STORE_ID}/returns`, { headers, params });
    const returns = response.data.returns || response.data || [];

    res.json({
      response_headers: response.headers,
      returns_count: returns.length,
      first_return: returns[0] ? {
        id: returns[0].id || returns[0]._id,
        status: returns[0].status,
        type: returns[0].type,
        createdAt: returns[0].createdAt,
        updatedAt: returns[0].updatedAt,
        order_name: returns[0].order?.name,
        items_count: (returns[0].items || []).length,
        items: (returns[0].items || []).map(i => ({ sku: i.sku, quantity: i.quantity, refund: i.refund })),
      } : null,
      last_return: returns.length > 1 ? {
        id: returns[returns.length - 1].id || returns[returns.length - 1]._id,
        status: returns[returns.length - 1].status,
        type: returns[returns.length - 1].type,
        createdAt: returns[returns.length - 1].createdAt,
        updatedAt: returns[returns.length - 1].updatedAt,
        order_name: returns[returns.length - 1].order?.name,
        items_count: (returns[returns.length - 1].items || []).length,
      } : null,
      data_keys: returns[0] ? Object.keys(returns[0]) : [],
    });
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
      const returnDate = toStoreDate(ret.createdAt);
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
    // (old orders where Redo may underreport refund amounts)
    const { data: salesOrders } = await supabase
      .from('shopify_sales')
      .select('order_number')
      .eq('store', store);
    const salesOrderSet = new Set((salesOrders || []).map(r => r.order_number));

    let crossCheckCount = 0;
    let crossCheckUpdated = 0;
    for (const rec of filteredRecords) {
      const orderNum = (rec.shopify_order_name || '').replace(/^#/, '');
      if (salesOrderSet.has(orderNum)) continue; // Recent order, Redo amount is fine

      crossCheckCount++;
      const shopifyRefund = await fetchShopifyRefund(rec.shopify_order_name, rec.sku);
      if (shopifyRefund && shopifyRefund.total_refund > rec.refund_amount) {
        console.log(`[redo] Upgrading refund for ${rec.shopify_order_name}/${rec.sku}: $${rec.refund_amount} -> $${shopifyRefund.total_refund} (product=$${shopifyRefund.product_refund} + shipping=$${shopifyRefund.shipping_refund})`);
        rec.refund_amount = shopifyRefund.total_refund;
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
        errors.push({ batch_index: i, batch_size: batch.length, error: upsertErr.message, sample: batch[0] });
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
