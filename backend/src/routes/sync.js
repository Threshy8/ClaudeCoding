const express = require('express');
const router = express.Router();
const axios = require('axios');
const supabase = require('../db/supabase');
const { runFifoEngine } = require('../utils/fifo');

// Exchange client credentials for an OAuth access token (24hr expiry, must refresh)
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
    maxRedirects: 0,
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

async function getAccessToken(store, storeUrl, accessToken, clientId, clientSecret) {
  if (accessToken) return accessToken;
  if (clientId && clientSecret) return getOAuthToken(storeUrl, clientId, clientSecret);
  throw new Error(
    `Shopify auth not configured for ${store}. Set either SHOPIFY_ACCESS_TOKEN or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET in .env`
  );
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function shopifyGet(url, accessToken, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await axios.get(url, {
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
      });
    } catch (err) {
      if (err.response?.status === 429 && attempt < retries) {
        const retryAfter = parseFloat(err.response.headers['retry-after']) || 1;
        console.log(`[Shopify] Rate limited (429), waiting ${retryAfter}s before retry ${attempt}/${retries}...`);
        await sleep(retryAfter * 1000);
        continue;
      }
      throw err;
    }
  }
}

async function fetchAllOrders(storeUrl, accessToken) {
  const base = storeUrl.replace(/\/$/, '');
  const orders = [];
  let url = `${base}/admin/api/2024-01/orders.json?status=any&financial_status=any&limit=250&created_at_min=2025-01-01T00:00:00Z`;
  console.log('[Shopify Sync] Fetching orders from:', url);
  let pageCount = 0;

  while (url) {
    if (pageCount > 0) await sleep(500); // Rate limit: stay under 2 calls/sec
    const response = await shopifyGet(url, accessToken);
    pageCount++;

    orders.push(...response.data.orders);
    console.log(`[Shopify Sync] Page ${pageCount}: fetched ${response.data.orders.length} orders (total: ${orders.length})`);

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

// GET /api/sync/shopify/test
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
      validateStatus: () => true,
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
        ? 'HTML response = app likely not installed on store.'
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

// POST /api/sync/shopify — trigger a Shopify sync + FIFO engine
router.post('/shopify', async (req, res) => {
  const store = req.body.store || 'au';

  let storeUrl, accessToken, clientId, clientSecret;

  if (store === 'au') {
    storeUrl     = process.env.SHOPIFY_STORE_URL;
    accessToken  = process.env.SHOPIFY_ACCESS_TOKEN;
    clientId     = process.env.SHOPIFY_CLIENT_ID;
    clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  } else if (store === 'us') {
    storeUrl     = process.env.SHOPIFY_US_STORE_URL;
    accessToken  = process.env.SHOPIFY_US_ACCESS_TOKEN;
    clientId     = process.env.SHOPIFY_US_CLIENT_ID;
    clientSecret = process.env.SHOPIFY_US_CLIENT_SECRET;
  } else {
    return res.status(400).json({ error: 'Invalid store. Use "au" or "us".' });
  }

  const storeUrlVar = store === 'us' ? 'SHOPIFY_US_STORE_URL' : 'SHOPIFY_STORE_URL';
  if (!storeUrl) {
    return res.status(500).json({
      error: `${storeUrlVar} not set. Add your store URL to .env`
    });
  }

  try {
    const token = await getAccessToken(store, storeUrl, accessToken, clientId, clientSecret);
    const orders = await fetchAllOrders(storeUrl, token);

    // Default to Australia/Sydney for AU store if not explicitly set
    const tz = process.env.SHOPIFY_STORE_TIMEZONE || (store === 'au' ? 'Australia/Sydney' : undefined);

    function toStoreDate(isoString) {
      if (!isoString) return null;
      const d = new Date(isoString);
      return tz ? d.toLocaleDateString('en-CA', { timeZone: tz }) : isoString.split('T')[0];
    }

    // ── Pass 1: gross sales records ───────────────────────────────────────────
    const salesRecords = [];

    for (const order of orders) {
      if (order.test) continue;
      if (order.cancelled_at) continue;
      if (!['paid', 'partially_refunded', 'refunded'].includes(order.financial_status)) continue;
      if (order.currency !== 'AUD') continue;

      const orderDate = toStoreDate(order.created_at);

      const firstFulfillment = (order.fulfillments || [])[0];
      const assignedLocation =
        firstFulfillment?.origin_address?.name ||
        order.assigned_location?.name          ||
        order.location?.name                   ||
        (firstFulfillment ? firstFulfillment.service || `location_${firstFulfillment.location_id}` : null) ||
        (order.fulfillment_status == null || order.fulfillment_status === 'unfulfilled'
          ? 'Unfulfilled' : 'Unknown Location');

      const lineItems = order.line_items || [];
      const bySku = {};

      for (const item of lineItems) {
        const qty = item.quantity || 0;
        if (qty <= 0) continue;
        const sku = item.sku || `NO-SKU-${item.product_id}`;

        // Subtract discount allocations to get net line revenue
        const discountTotal = (item.discount_allocations || [])
          .reduce((sum, da) => sum + (parseFloat(da.amount) || 0), 0);
        const lineRevenue = (parseFloat(item.price) * qty) - discountTotal;

        const grossRevenue = parseFloat(item.price) * qty;

        if (!bySku[sku]) bySku[sku] = { product_name: item.title || item.name || 'Unknown', qty: 0, revenue: 0, grossRevenue: 0, discount: 0 };
        bySku[sku].qty += qty;
        bySku[sku].revenue += lineRevenue;
        bySku[sku].grossRevenue += grossRevenue;
        bySku[sku].discount += discountTotal;
      }

      if (Object.keys(bySku).length === 0) continue;

      const customerName = order.customer
        ? [order.customer.first_name, order.customer.last_name].filter(Boolean).join(' ')
        : (order.billing_address?.name || null);

      const commonFields = {
        shopify_order_id:     String(order.id),
        order_number:         order.order_number ? String(order.order_number) : null,
        order_name:           order.name || null,
        customer_name:        customerName || null,
        order_date:           orderDate,
        store,
        fulfillment_location: assignedLocation,
      };

      for (const [sku, d] of Object.entries(bySku)) {
        const lineRevenue = Math.round(d.revenue * 100) / 100;
        const grossPrice = Math.round(d.grossRevenue * 100) / 100;
        const discountAmount = Math.round(d.discount * 100) / 100;
        salesRecords.push({
          ...commonFields,
          sku,
          product_name:         d.product_name,
          quantity_sold:        d.qty,
          sale_price:           Math.round((d.revenue / d.qty) * 100) / 100,
          line_revenue:         lineRevenue,
          gross_price:          grossPrice,
          discount_amount:      discountAmount,
        });
      }

      // Shipping row
      const shippingTotal = (order.shipping_lines || [])
        .reduce((sum, sl) => sum + (parseFloat(sl.discounted_price ?? sl.price) || 0), 0);
      if (shippingTotal > 0) {
        const shippingRounded = Math.round(shippingTotal * 100) / 100;
        salesRecords.push({
          ...commonFields,
          sku:           'shipping',
          product_name:  'Shipping Charge',
          quantity_sold: 1,
          sale_price:    shippingRounded,
          line_revenue:  shippingRounded,
        });
      }

    }

    // ── Pass 2: refund records ────────────────────────────────────────────────
    const refundRecords = [];

    for (const order of orders) {
      if (order.test) continue;
      // NOTE: Do NOT skip cancelled orders here — cancelled orders can still
      // have refunds that Shopify counts in "Returns". Pass 1 correctly skips
      // cancelled orders for gross sales, so the net effect is correct.
      if (order.currency !== 'AUD') continue;

      const orderDate = toStoreDate(order.created_at);

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
            shopify_order_id:  String(order.id),
            order_number:      order.order_number ? String(order.order_number) : null,
            shopify_refund_id: String(refund.id),
            sku,
            product_name:      d.product_name,
            quantity_refunded: d.quantity,
            refund_subtotal:   Math.round(d.subtotal * 100) / 100,
            order_date:        orderDate,
            refund_date:       refundDate,
            store,
          });
        }

        // Capture shipping refunds from order_adjustments
        const shippingRefund = (refund.order_adjustments || [])
          .filter(a => a.kind === 'shipping_refund')
          .reduce((s, a) => s + Math.abs(parseFloat(a.amount || 0)), 0);
        if (shippingRefund > 0) {
          refundRecords.push({
            shopify_order_id:  String(order.id),
            order_number:      order.order_number ? String(order.order_number) : null,
            shopify_refund_id: `${refund.id}-shipping`,
            sku:               'shipping',
            product_name:      'Shipping Refund',
            quantity_refunded: 1,
            refund_subtotal:   Math.round(shippingRefund * 100) / 100,
            order_date:        orderDate,
            refund_date:       refundDate,
            store,
          });
        }
      }
    }

    // ── Persist sales + refunds ───────────────────────────────────────────────
    // Note: Redo-processed returns are handled separately via the Redo API
    // integration (/api/sync/redo) and stored in the redo_returns table.
    await supabase.from('shopify_sales').delete().eq('store', store);
    await supabase.from('shopify_refunds').delete().eq('store', store);

    // Also clear cogs_entries so FIFO engine rewrites them fresh
    await supabase.from('cogs_entries').delete().eq('store', store);

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

    // ── Run FIFO engine to lock in COGS entries ───────────────────────────────
    let fifoResult = { processed: 0, skipped_no_lot: [], errors: [] };
    try {
      fifoResult = await runFifoEngine(store);
    } catch (fifoErr) {
      console.error('FIFO engine error (non-fatal):', fifoErr.message);
      fifoResult.errors.push(fifoErr.message);
    }

    res.json({
      success: true,
      store,
      orders_fetched:           orders.length,
      orders_synced:            salesRecords.length > 0
        ? [...new Set(salesRecords.map(r => r.shopify_order_id))].length : 0,
      line_items_synced:        inserted,
      refund_line_items_synced: refundsInserted,
      cogs_entries_written:     fifoResult.processed,
      cogs_skipped_no_lot:      fifoResult.skipped_no_lot.length,
      cogs_skipped_skus:        fifoResult.skipped_no_lot,
      errors:                   errors.length > 0 ? errors : undefined,
      fifo_errors:              fifoResult.errors.length > 0 ? fifoResult.errors : undefined,
    });
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    const redirect = status >= 300 && status < 400;
    const isHtml = typeof data === 'string' && data.trim().toLowerCase().startsWith('<!');
    let details;
    if (redirect) {
      details = `Request redirected (${status}). Check SHOPIFY_STORE_URL.`;
    } else if (isHtml) {
      details = 'Shopify returned HTML. Verify store URL and app installation.';
    } else {
      details = data?.errors || (typeof data === 'string' ? data.slice(0, 200) : err.message);
    }
    console.error('Shopify sync error:', status, details);
    const msg = typeof details === 'object' ? JSON.stringify(details) : String(details);
    res.status(500).json({ error: msg || 'Shopify sync failed', details });
  }
});

module.exports = router;
