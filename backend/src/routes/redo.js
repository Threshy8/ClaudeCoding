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
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    console.error('Redo sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
