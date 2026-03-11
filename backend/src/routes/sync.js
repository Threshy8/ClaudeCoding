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

// Fetch all orders from a Shopify store with pagination.
// Includes partially_refunded and refunded so all gross sales and return events are captured.
// The orders endpoint embeds full refund data — no separate /refunds.json calls needed.
async function fetchAllOrders(storeUrl, accessToken) {
  const base = storeUrl.replace(/\/$/, '');
  const orders = [];
  // paid               = fully paid, no returns
  // partially_refunded = paid, some items returned
  // refunded           = paid, all items returned — needed to capture cross-period returns
  let url = `${base}/admin/api/2024-01/orders.json?status=any&financial_status=paid,partially_refunded,refunded&limit=250`;

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

    const tz = process.env.SHOPIFY_STORE_TIMEZONE;

    function toStoreDate(isoString) {
      if (!isoString) return null;
      const d = new Date(isoString);
      return tz ? d.toLocaleDateString('en-CA', { timeZone: tz }) : isoString.split('T')[0];
    }

    // ── Pass 1: gross sales records (shopify_sales) ───────────────────────────
    // Store gross quantities ordered so refunds can be applied by refund_date later.
    // Includes paid, partially_refunded, AND refunded orders — a fully-refunded order
    // still has a gross sale on the order_date; the return is tracked separately.
    const salesRecords = [];

    for (const order of orders) {
      if (order.test) continue;
      if (order.cancelled_at) continue;
      if (!['paid', 'partially_refunded', 'refunded'].includes(order.financial_status)) continue;
      if (order.currency !== 'AUD') continue;

      const orderDate = toStoreDate(order.created_at);
      // Use total_price (gross, before any refunds) — refund amounts tracked separately
      const orderTotal = parseFloat(order.total_price || '0') || 0;

      // Fulfillment location: Shopify embeds location name in fulfillments[].location_id
      // but not the name directly. Best available signals in order payload:
      //   1. fulfillments[0].origin_address.name  (set on some plans)
      //   2. order.assigned_location.name          (on some Shopify plans)
      //   3. fulfillments[0].service               (e.g. "manual", carrier name)
      //   4. Fall back to 'Unfulfilled' / 'Unknown'
      const firstFulfillment = (order.fulfillments || [])[0];
      const assignedLocation =
        firstFulfillment?.origin_address?.name ||
        order.assigned_location?.name          ||
        order.location?.name                   ||
        (firstFulfillment ? firstFulfillment.service || `location_${firstFulfillment.location_id}` : null) ||
        (order.fulfillment_status == null || order.fulfillment_status === 'unfulfilled'
          ? 'Unfulfilled' : 'Unknown Location');

      const lineItems = order.line_items || [];
      const lines = [];
      let grossLineTotal = 0;

      for (const item of lineItems) {
        const qty = item.quantity || 0;
        if (qty <= 0) continue;
        const lineGross = parseFloat(item.price) * qty;
        grossLineTotal += lineGross;
        lines.push({
          sku: item.sku || `NO-SKU-${item.product_id}`,
          product_name: item.title || item.name || 'Unknown',
          qty,
          lineGross,
        });
      }

      if (lines.length === 0) continue;

      // Allocate total_price proportionally across line items
      const scale = grossLineTotal > 0 ? orderTotal / grossLineTotal : 1;

      const bySku = {};
      for (const { sku, product_name, qty, lineGross } of lines) {
        if (!bySku[sku]) bySku[sku] = { product_name, qty: 0, revenue: 0 };
        bySku[sku].qty += qty;
        bySku[sku].revenue += lineGross * scale;
      }

      const customerName = order.customer
        ? [order.customer.first_name, order.customer.last_name].filter(Boolean).join(' ')
        : (order.billing_address?.name || null);

      for (const [sku, d] of Object.entries(bySku)) {
        salesRecords.push({
          shopify_order_id: String(order.id),
          order_number:     order.order_number ? String(order.order_number) : null,
          customer_name:    customerName || null,
          sku,
          product_name: d.product_name,
          quantity_sold: d.qty,
          sale_price: Math.round((d.revenue / d.qty) * 100) / 100,
          order_date: orderDate,
          store,
          fulfillment_location: assignedLocation,
        });
      }
    }

    // ── Pass 2: refund records (shopify_refunds) ──────────────────────────────
    // Extract every refund line item with its refund_date so COGS queries can subtract
    // returns in the period they happened (matching Shopify's "Net items sold" method).
    const refundRecords = [];

    for (const order of orders) {
      if (order.test) continue;
      if (order.cancelled_at) continue;
      if (order.currency !== 'AUD') continue;

      const orderDate = toStoreDate(order.created_at);

      // Build line_item_id → {sku, product_name} lookup for this order
      const lineItemMap = {};
      for (const li of (order.line_items || [])) {
        lineItemMap[String(li.id)] = {
          sku: li.sku || `NO-SKU-${li.product_id}`,
          product_name: li.title || li.name || 'Unknown',
        };
      }

      for (const refund of (order.refunds || [])) {
        const refundDate = toStoreDate(refund.created_at);
        if (!refundDate) continue;

        // Aggregate refunded qty and subtotal by SKU within this refund event
        const refundBySku = {};
        for (const rli of (refund.refund_line_items || [])) {
          const li = lineItemMap[String(rli.line_item_id)];
          if (!li) continue;
          const { sku, product_name } = li;
          if (!refundBySku[sku]) refundBySku[sku] = { product_name, quantity: 0, subtotal: 0 };
          refundBySku[sku].quantity += rli.quantity || 0;
          refundBySku[sku].subtotal += parseFloat(rli.subtotal || '0') || 0;
        }

        for (const [sku, d] of Object.entries(refundBySku)) {
          if (d.quantity <= 0) continue;
          refundRecords.push({
            shopify_order_id: String(order.id),
            order_number:     order.order_number ? String(order.order_number) : null,
            shopify_refund_id: String(refund.id),
            sku,
            product_name: d.product_name,
            quantity_refunded: d.quantity,
            refund_subtotal: Math.round(d.subtotal * 100) / 100,
            order_date:   orderDate,
            refund_date:  refundDate,
            store,
          });
        }
      }
    }

    // ── Persist ───────────────────────────────────────────────────────────────
    await supabase.from('shopify_sales').delete().eq('store', store);
    await supabase.from('shopify_refunds').delete().eq('store', store);

    let inserted = 0;
    let errors = [];

    for (let i = 0; i < salesRecords.length; i += 100) {
      const batch = salesRecords.slice(i, i + 100);
      const { error } = await supabase
        .from('shopify_sales')
        .upsert(batch, { onConflict: 'shopify_order_id,sku' });
      if (error) errors.push(error.message);
      else inserted += batch.length;
    }

    let refundsInserted = 0;
    for (let i = 0; i < refundRecords.length; i += 100) {
      const batch = refundRecords.slice(i, i + 100);
      const { error } = await supabase
        .from('shopify_refunds')
        .upsert(batch, { onConflict: 'shopify_refund_id,sku' });
      if (error) errors.push(error.message);
      else refundsInserted += batch.length;
    }

    res.json({
      success: true,
      store,
      orders_fetched: orders.length,
      orders_synced: salesRecords.length > 0 ? [...new Set(salesRecords.map(r => r.shopify_order_id))].length : 0,
      line_items_synced: inserted,
      refund_line_items_synced: refundsInserted,
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
