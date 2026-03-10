const express = require('express');
const router = express.Router();
const axios = require('axios');
const supabase = require('../db/supabase');

// Exchange client credentials for an OAuth access token (24hr expiry, must refresh)
// Shopify requires application/x-www-form-urlencoded, not JSON
async function getOAuthToken(storeUrl, clientId, clientSecret) {
  const base = storeUrl.replace(/\/$/, '');
  const tokenUrl = `${base}/admin/oauth/access_token`;
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
  });

  const response = await axios.post(tokenUrl, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    maxRedirects: 0, // Don't follow redirects — API shouldn't redirect; catches wrong URLs
    validateStatus: (status) => status >= 200 && status < 300,
  });

  const data = response.data;
  if (typeof data === 'string' && data.trim().toLowerCase().startsWith('<!')) {
    throw new Error(
      'Shopify returned HTML instead of JSON. Check: 1) Store URL is correct (e.g. https://your-store.myshopify.com). ' +
        '2) App is installed on the store. 3) Store is active (not suspended/expired).'
    );
  }
  if (!data || !data.access_token) {
    throw new Error(data?.errors || 'No access_token in Shopify response');
  }
  return data.access_token;
}

// Resolve access token for a store: prefer direct token, fall back to OAuth
async function getAccessToken(store, storeUrl, accessToken, clientId, clientSecret) {
  if (accessToken) {
    return accessToken;
  }
  if (clientId && clientSecret) {
    return getOAuthToken(storeUrl, clientId, clientSecret);
  }
  throw new Error(
    `Shopify auth not configured for ${store}. Set either SHOPIFY_ACCESS_TOKEN or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET in .env`
  );
}

// Build a map of { line_item_id -> total_refunded_qty } from the refunds already
// embedded in the order object (Shopify includes full refund data in the orders endpoint,
// so no extra /refunds.json API call per order is needed).
function buildRefundMap(order) {
  const refundedQty = {};
  for (const refund of (order.refunds || [])) {
    for (const rli of (refund.refund_line_items || [])) {
      const id = String(rli.line_item_id);
      refundedQty[id] = (refundedQty[id] || 0) + (rli.quantity || 0);
    }
  }
  return refundedQty;
}

// Fetch all orders from a Shopify store with pagination.
// Includes partially_refunded so we capture paid orders that have had returns processed.
// The orders endpoint embeds full refund data — no separate /refunds.json calls needed.
async function fetchAllOrders(storeUrl, accessToken) {
  const base = storeUrl.replace(/\/$/, '');
  const orders = [];
  // paid          = fully paid, no refunds (or non-financial exchanges only)
  // partially_refunded = paid in full then some items returned/refunded
  let url = `${base}/admin/api/2024-01/orders.json?status=any&financial_status=paid,partially_refunded&limit=250`;

  while (url) {
    const response = await axios.get(url, {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
    });

    orders.push(...response.data.orders);

    const linkHeader = response.headers['link'];
    if (linkHeader && linkHeader.includes('rel="next"')) {
      const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      url = match ? match[1] : null;
    } else {
      url = null;
    }
  }

  return orders;
}

// GET /api/sync/shopify/test — diagnostic: test OAuth token request, return status and response type
router.get('/shopify/test', async (req, res) => {
  const storeUrl = process.env.SHOPIFY_STORE_URL;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!storeUrl || !clientId || !clientSecret) {
    return res.json({
      ok: false,
      error: 'Missing SHOPIFY_STORE_URL, SHOPIFY_CLIENT_ID, or SHOPIFY_CLIENT_SECRET',
    });
  }

  const tokenUrl = `${storeUrl.replace(/\/$/, '')}/admin/oauth/access_token`;
  try {
    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    });
    const response = await axios.post(tokenUrl, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      maxRedirects: 0,
      validateStatus: () => true, // accept any status so we can inspect
    });

    const data = response.data;
    const contentType = response.headers['content-type'] || '';
    const isHtml = typeof data === 'string' && data.trim().toLowerCase().startsWith('<!');

    res.json({
      status: response.status,
      contentType,
      isHtml,
      bodyPreview: typeof data === 'string'
        ? data.slice(0, 120) + (data.length > 120 ? '...' : '')
        : JSON.stringify(data).slice(0, 200),
      hint: isHtml
        ? 'HTML response = app likely not installed on store. Install app in Dev Dashboard, or use Custom app (Settings → Apps → Develop apps) to get SHOPIFY_ACCESS_TOKEN.'
        : response.status === 200 && data?.access_token
          ? 'Token obtained successfully.'
          : `Unexpected response (status ${response.status}). Check credentials.`,
    });
  } catch (err) {
    res.json({
      ok: false,
      error: err.message,
      status: err.response?.status,
      hint: err.code === 'ENOTFOUND' ? 'Store URL may be wrong — check SHOPIFY_STORE_URL.' : '',
    });
  }
});

// POST /api/sync/shopify — trigger a Shopify sync
router.post('/shopify', async (req, res) => {
  const store = req.body.store || 'au'; // 'au' or 'us'

  let storeUrl, accessToken, clientId, clientSecret;

  if (store === 'au') {
    storeUrl = process.env.SHOPIFY_STORE_URL;
    accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
    clientId = process.env.SHOPIFY_CLIENT_ID;
    clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  } else if (store === 'us') {
    storeUrl = process.env.SHOPIFY_US_STORE_URL;
    accessToken = process.env.SHOPIFY_US_ACCESS_TOKEN;
    clientId = process.env.SHOPIFY_US_CLIENT_ID;
    clientSecret = process.env.SHOPIFY_US_CLIENT_SECRET;
  } else {
    return res.status(400).json({ error: 'Invalid store. Use "au" or "us".' });
  }

  const storeUrlVar = store === 'us' ? 'SHOPIFY_US_STORE_URL' : 'SHOPIFY_STORE_URL';
  if (!storeUrl) {
    return res.status(500).json({
      error: `${storeUrlVar} not set. Add your store URL (e.g. https://your-store.myshopify.com) to .env`
    });
  }

  try {
    const token = await getAccessToken(store, storeUrl, accessToken, clientId, clientSecret);
    const orders = await fetchAllOrders(storeUrl, token);

    const salesRecords = [];

    for (const order of orders) {
      // Skip test orders and anything that slipped through that isn't paid
      if (order.test) continue;
      if (order.cancelled_at) continue;
      if (order.financial_status !== 'paid' && order.financial_status !== 'partially_refunded') continue;
      // AUD only — skip foreign-currency orders so revenue is always in AUD
      if (order.currency !== 'AUD') continue;

      // Use store timezone for order date so period filtering matches Shopify Analytics
      const tz = process.env.SHOPIFY_STORE_TIMEZONE;
      let orderDate = null;
      if (order.created_at) {
        const d = new Date(order.created_at);
        orderDate = tz
          ? d.toLocaleDateString('en-CA', { timeZone: tz })
          : order.created_at.split('T')[0];
      }

      // current_total_price = order total after any partial refunds (AUD, incl. shipping + taxes)
      // For fully-paid orders (no refunds) this equals total_price.
      // For partially_refunded orders this correctly reflects the net amount received.
      const orderTotal = parseFloat(order.current_total_price || '0') || 0;

      // Build refund map from embedded order.refunds so we can subtract returned units
      const refundMap = buildRefundMap(order);

      // Build per-line-item net quantities (gross qty − refunded qty)
      const lineItems = order.line_items || [];
      const lines = [];
      let grossLineTotal = 0;

      for (const item of lineItems) {
        const grossQty = item.quantity || 0;
        const refundedQty = refundMap[String(item.id)] || 0;
        const netQty = Math.max(0, grossQty - refundedQty);

        if (netQty <= 0) continue; // fully returned or zero — exclude from sold count
        const lineGross = parseFloat(item.price) * netQty;
        grossLineTotal += lineGross;
        lines.push({
          sku: item.sku || `NO-SKU-${item.product_id}`,
          product_name: item.title || item.name || 'Unknown',
          qty: netQty,
          lineGross,
        });
      }

      // Skip orders where all line items were returned (nothing left to record)
      if (lines.length === 0) continue;

      // Allocate current_total_price proportionally so per-SKU revenue sums to net order total
      const scale = grossLineTotal > 0 ? orderTotal / grossLineTotal : 1;

      // Aggregate by SKU (handles duplicate SKUs in one order)
      const bySku = {};
      for (const { sku, product_name, qty, lineGross } of lines) {
        if (!bySku[sku]) bySku[sku] = { product_name, qty: 0, revenue: 0 };
        bySku[sku].qty += qty;
        bySku[sku].revenue += lineGross * scale;
      }

      for (const [sku, d] of Object.entries(bySku)) {
        salesRecords.push({
          shopify_order_id: String(order.id),
          sku,
          product_name: d.product_name,
          quantity_sold: d.qty,
          sale_price: Math.round((d.revenue / d.qty) * 100) / 100,
          order_date: orderDate,
          store,
        });
      }
    }

    // Wipe existing records for this store so stale cancelled/refunded rows don't persist
    await supabase.from('shopify_sales').delete().eq('store', store);

    // Upsert all records — idempotent on (shopify_order_id, sku)
    let inserted = 0;
    let errors = [];

    // Process in batches of 100 to avoid Supabase payload limits
    for (let i = 0; i < salesRecords.length; i += 100) {
      const batch = salesRecords.slice(i, i + 100);
      const { error } = await supabase
        .from('shopify_sales')
        .upsert(batch, { onConflict: 'shopify_order_id,sku' });

      if (error) {
        errors.push(error.message);
      } else {
        inserted += batch.length;
      }
    }

    res.json({
      success: true,
      store,
      orders_fetched: orders.length,
      orders_synced: salesRecords.length > 0 ? [...new Set(salesRecords.map(r => r.shopify_order_id))].length : 0,
      line_items_synced: inserted,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    const redirect = status >= 300 && status < 400;
    const isHtml = typeof data === 'string' && data.trim().toLowerCase().startsWith('<!');
    let details;
    if (redirect) {
      details = `Request redirected (${status}). Check SHOPIFY_STORE_URL — use exact myshopify.com URL.`;
    } else if (isHtml) {
      details = 'Shopify returned HTML instead of JSON. Verify: 1) Store URL (e.g. https://your-store.myshopify.com) 2) App is installed on the store 3) Store is active';
    } else {
      details = data?.errors || (typeof data === 'string' ? data.slice(0, 200) : err.message);
    }
    console.error('Shopify sync error:', status, details);
    const msg = typeof details === 'object' ? JSON.stringify(details) : String(details);
    res.status(500).json({
      error: msg || 'Shopify sync failed',
      details: details,
    });
  }
});

module.exports = router;
