const express = require('express');
const router = express.Router();
const axios = require('axios');
const supabase = require('../db/supabase');

const BASE_URL = process.env.REDO_API_BASE_URL || 'https://api.getredo.com/v2.2';
const TOKEN = process.env.REDO_API_TOKEN;
const STORE_ID = process.env.REDO_STORE_ID;
const TZ = process.env.SHOPIFY_STORE_TIMEZONE || 'Australia/Sydney';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function shopifyGet(url, accessToken, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await axios.get(url, {
        headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      if (err.response?.status === 429 && attempt < retries) {
        const retryAfter = parseFloat(err.response.headers['retry-after']) || 1;
        console.log(`[redo] Rate limited (429), waiting ${retryAfter}s before retry ${attempt}/${retries}...`);
        await sleep(retryAfter * 1000);
        continue;
      }
      throw err;
    }
  }
}

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
  let allOrders = [];
  let searchedName = '';

  try {
    for (const suffix of suffixes) {
      searchedName = `#${orderNum}${suffix}`;
      const url = `${base}/admin/api/2024-01/orders.json?name=${encodeURIComponent(searchedName)}&status=any&fields=id,name,order_number,refunds,shipping_lines,line_items`;
      const response = await shopifyGet(url, accessToken);
      allOrders = response.data?.orders || [];
      if (allOrders.length > 0) {
        console.log(`[redo] Found ${allOrders.length} Shopify order(s) with name=${searchedName}: ${allOrders.map(o => o.name).join(', ')}`);
        break;
      }
    }
    if (allOrders.length === 0) {
      console.log(`[redo] Shopify order ${orderName} not found (tried suffixes: ${suffixes.join(', ')})`);
      return null;
    }

    // Prefer exact name match (Shopify name search can return partial matches like #6084-RESEND for #6084)
    const exactMatch = allOrders.find(o => o.name === searchedName);
    const order = exactMatch || allOrders[0];
    const refunds = order.refunds || [];

    // Sum refund amounts from all refund events
    let productRefundCents = 0;
    let shippingRefundCents = 0;
    let refundDiscrepancyCents = 0; // Redo uses order_adjustments instead of refund_line_items

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
          // Redo returns show as refund_discrepancy adjustments (negative = refund, positive = credit)
          refundDiscrepancyCents += Math.round(parseFloat(adj.amount || 0) * 100);
        }
      }
    }

    // If Shopify has refund_line_items for this SKU, use those (most accurate)
    if (productRefundCents > 0) {
      const result = { product_refund: productRefundCents / 100, shipping_refund: shippingRefundCents / 100, total_refund: (productRefundCents + shippingRefundCents) / 100 };
      console.log(`[redo] Shopify refund_line_items for ${orderName}/${sku}:`, JSON.stringify(result));
      return result;
    }

    // If Shopify has refund_discrepancy adjustments (Redo-handled returns),
    // the net negative amount (excluding shipping) is the product refund.
    // Net of adjustments: e.g. -179.01 + 199.00 + -199.00 = -179.01
    if (refundDiscrepancyCents !== 0) {
      const netProductCents = Math.abs(refundDiscrepancyCents);
      const result = { product_refund: netProductCents / 100, shipping_refund: shippingRefundCents / 100, total_refund: (netProductCents + shippingRefundCents) / 100, source: 'refund_discrepancy' };
      console.log(`[redo] Shopify refund_discrepancy for ${orderName}/${sku}: net=$${result.product_refund}, shipping=$${result.shipping_refund}`);
      return result;
    }

    // Last fallback: no Shopify refund records at all (return still open).
    // Use the original line item price as the product-only refund amount.
    const lineItem = (order.line_items || []).find(li => li.sku === sku);
    if (lineItem) {
      const originalPriceCents = Math.round(parseFloat(lineItem.price || 0) * 100) * (lineItem.quantity || 1);
      const result = { product_refund: originalPriceCents / 100, shipping_refund: 0, total_refund: originalPriceCents / 100, source: 'line_item_price' };
      console.log(`[redo] No Shopify refund for ${orderName}/${sku}, using line item price: $${result.product_refund}`);
      return result;
    }

    console.log(`[redo] Shopify order ${orderName} has no refund or line item for SKU ${sku}`);
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
    let allOrders = [];
    let matchedName = '';
    for (const suffix of suffixes) {
      const searchName = `#${orderNum}${suffix}`;
      const url = `${storeUrl}/admin/api/2024-01/orders.json?name=${encodeURIComponent(searchName)}&status=any&fields=id,name,order_number,financial_status,refunds,line_items,shipping_lines`;
      const resp = await axios.get(url, {
        headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' },
      });
      allOrders = resp.data?.orders || [];
      if (allOrders.length > 0) { matchedName = searchName; break; }
    }

    if (allOrders.length === 0) {
      return res.json({ found: false, searched_names: suffixes.map(s => `#${orderNum}${s}`), message: 'No orders found' });
    }

    // Prefer exact name match (Shopify name search can return partial matches like #6084-RESEND for #6084)
    const exactMatch = allOrders.find(o => o.name === matchedName);
    const order = exactMatch || allOrders[0];
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

    // Also get original line items for the SKU to show sale price
    const lineItems = (order.line_items || []).map(li => ({
      sku: li.sku,
      title: li.title,
      price: li.price,
      quantity: li.quantity,
      discount_allocations: li.discount_allocations,
    }));
    const shippingLines = (order.shipping_lines || []).map(sl => ({
      title: sl.title,
      price: sl.price,
      discounted_price: sl.discounted_price,
    }));

    // Also run fetchShopifyRefund to show what the sync would compute
    const computed = await fetchShopifyRefund(matchedName || `#${orderNum}`, sku);

    res.json({
      found: true,
      order_name: order.name,
      order_id: order.id,
      financial_status: order.financial_status,
      all_matched_orders: allOrders.map(o => ({ name: o.name, id: o.id, financial_status: o.financial_status })),
      refunds_count: refunds.length,
      refund_details: refundDetails,
      line_items: lineItems,
      shipping_lines: shippingLines,
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
      // Use updatedAt as return_date to match when Shopify processes the refund,
      // not when Redo initiated the return. Fall back to createdAt if updatedAt missing.
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

    // Batched Shopify cross-check for complete returns not in shopify_sales
    // Corrects refund_amount to product-only (excludes shipping) using Shopify API
    const { data: salesOrders } = await supabase
      .from('shopify_sales')
      .select('order_number')
      .eq('store', store);
    const salesOrderSet = new Set((salesOrders || []).map(r => r.order_number));

    const toCheck = filteredRecords.filter(r => {
      if (r.status !== 'complete') return false;
      const orderNum = (r.shopify_order_name || '').replace(/^#/, '');
      return !salesOrderSet.has(orderNum);
    });

    let crossCheckUpdated = 0;
    for (let i = 0; i < toCheck.length; i++) {
      if (i > 0) await sleep(500);
      const rec = toCheck[i];
      const shopifyRefund = await fetchShopifyRefund(rec.shopify_order_name, rec.sku);
      if (shopifyRefund && shopifyRefund.product_refund !== rec.refund_amount) {
        console.log(`[redo] Correcting ${rec.shopify_order_name}/${rec.sku}: $${rec.refund_amount} -> $${shopifyRefund.product_refund}`);
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
      shopify_cross_checked: toCheck.length,
      shopify_cross_check_updated: crossCheckUpdated,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    console.error('Redo sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
