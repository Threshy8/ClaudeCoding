const express = require('express');
const router = express.Router();
const axios = require('axios');
const supabase = require('../db/supabase');

// Fetch all orders from a Shopify store with pagination
async function fetchAllOrders(storeUrl, accessToken) {
  const orders = [];
  let url = `${storeUrl}/admin/api/2024-01/orders.json?status=any&limit=250`;

  while (url) {
    const response = await axios.get(url, {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
    });

    orders.push(...response.data.orders);

    // Handle pagination via Link header
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

// POST /api/sync/shopify — trigger a Shopify sync
router.post('/shopify', async (req, res) => {
  const store = req.body.store || 'au'; // 'au' or 'us'

  let storeUrl, accessToken;

  if (store === 'au') {
    storeUrl = process.env.SHOPIFY_STORE_URL;
    accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
  } else if (store === 'us') {
    storeUrl = process.env.SHOPIFY_US_STORE_URL;
    accessToken = process.env.SHOPIFY_US_ACCESS_TOKEN;
  } else {
    return res.status(400).json({ error: 'Invalid store. Use "au" or "us".' });
  }

  if (!storeUrl || !accessToken) {
    return res.status(500).json({ error: `Shopify credentials not configured for store: ${store}` });
  }

  try {
    const orders = await fetchAllOrders(storeUrl, accessToken);

    const salesRecords = [];

    for (const order of orders) {
      const orderDate = order.created_at ? order.created_at.split('T')[0] : null;

      for (const item of order.line_items || []) {
        const sku = item.sku || `NO-SKU-${item.product_id}`;
        salesRecords.push({
          shopify_order_id: String(order.id),
          sku,
          product_name: item.title || item.name || 'Unknown',
          quantity_sold: item.quantity,
          sale_price: parseFloat(item.price),
          order_date: orderDate,
          store,
        });
      }
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
      line_items_synced: inserted,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    console.error('Shopify sync error:', err.response?.data || err.message);
    res.status(500).json({
      error: 'Shopify sync failed',
      details: err.response?.data?.errors || err.message,
    });
  }
});

module.exports = router;
