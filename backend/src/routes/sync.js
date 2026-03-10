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

// Fetch all orders from a Shopify store with pagination
async function fetchAllOrders(storeUrl, accessToken) {
  const base = storeUrl.replace(/\/$/, '');
  const orders = [];
  let url = `${base}/admin/api/2024-01/orders.json?status=any&limit=250`;

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

    // Exclude cancelled/refunded/voided so revenue matches Shopify Analytics
    const excludeFinancial = ['refunded', 'voided'];
    const salesRecords = [];
    const excludedOrderIds = [];

    for (const order of orders) {
      if (order.test) {
        excludedOrderIds.push(String(order.id));
        continue;
      }
      if (order.status === 'cancelled' || excludeFinancial.includes(order.financial_status)) {
        excludedOrderIds.push(String(order.id));
        continue;
      }
      // Use store timezone for order date so period filtering matches Shopify Analytics
      const tz = process.env.SHOPIFY_STORE_TIMEZONE;
      let orderDate = null;
      if (order.created_at) {
        const d = new Date(order.created_at);
        orderDate = tz
          ? d.toLocaleDateString('en-CA', { timeZone: tz })
          : order.created_at.split('T')[0];
      }
      // Use current_total_price (Total sales = net sales + shipping + taxes) to match Shopify "Total sales over time"
      const orderTotal = parseFloat(order.current_total_price || '0') || 0;

      const lineItems = order.line_items || [];
      const linesWithRevenue = [];
      let totalLineRevenue = 0;

      for (const item of lineItems) {
        // current_quantity = quantity minus refunds/removals (Shopify 2024-01+) — matches "Net items sold"
        const netQty = Math.max(0, item.current_quantity ?? item.quantity ?? 0);
        if (netQty <= 0) continue;

        const grossUnitPrice = parseFloat(item.price);
        const totalDiscount = parseFloat(item.total_discount || '0');
        const unitDiscount = item.quantity > 0 ? totalDiscount / item.quantity : 0;
        const netUnitPrice = Math.max(0, grossUnitPrice - unitDiscount);
        const lineRevenue = netQty * netUnitPrice;
        totalLineRevenue += lineRevenue;
        linesWithRevenue.push({
          sku: item.sku || `NO-SKU-${item.product_id}`,
          product_name: item.title || item.name || 'Unknown',
          quantity: netQty,
          lineRevenue,
          netUnitPrice,
        });
      }

      // Allocate order total across line items (includes shipping + taxes so revenue matches "Total sales over time")
      const scale = totalLineRevenue > 0 && orderTotal >= 0 ? orderTotal / totalLineRevenue : 1;

      // Aggregate by (order_id, sku) in case multiple line items share SKU
      const bySku = {};
      for (const { sku, product_name, quantity, lineRevenue, netUnitPrice } of linesWithRevenue) {
        const allocatedRevenue = lineRevenue * scale;
        const allocUnitPrice = quantity > 0 ? allocatedRevenue / quantity : 0;
        if (!bySku[sku]) {
          bySku[sku] = { product_name, qty: 0, revenue: 0 };
        }
        bySku[sku].qty += quantity;
        bySku[sku].revenue += allocatedRevenue;
      }

      for (const [sku, d] of Object.entries(bySku)) {
        if (d.qty <= 0) continue;
        const unitPrice = d.revenue / d.qty;
        salesRecords.push({
          shopify_order_id: String(order.id),
          sku,
          product_name: d.product_name,
          quantity_sold: d.qty,
          sale_price: unitPrice,
          order_date: orderDate,
          store,
        });
      }
    }

    // Remove excluded orders from DB so re-sync corrects revenue
    if (excludedOrderIds.length > 0) {
      await supabase.from('shopify_sales').delete().in('shopify_order_id', excludedOrderIds);
    }

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
      orders_processed: orders.length,
      orders_excluded: excludedOrderIds.length,
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
