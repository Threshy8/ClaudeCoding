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

    // De-duplicate: skip returns already captured in shopify_refunds
    const { data: existingRefunds } = await supabase
      .from('shopify_refunds')
      .select('order_number, sku')
      .eq('store', store);

    const coveredSet = new Set(
      (existingRefunds || []).map(r => `${r.order_number}|${r.sku}`)
    );

    const filteredRecords = records.filter(r => {
      const orderNum = (r.shopify_order_name || '').replace(/^#/, '');
      return !coveredSet.has(`${orderNum}|${r.sku}`);
    });

    // Clear old Redo returns and insert fresh
    await supabase.from('redo_returns').delete().eq('store', store);

    for (let i = 0; i < filteredRecords.length; i += 100) {
      const batch = filteredRecords.slice(i, i + 100);
      const { error: upsertErr } = await supabase
        .from('redo_returns')
        .upsert(batch, { onConflict: 'redo_return_id,sku' });
      if (upsertErr) console.error('Redo upsert error:', upsertErr.message);
    }

    res.json({
      success: true,
      returns_fetched: allReturns.length,
      records_total: records.length,
      records_deduped: records.length - filteredRecords.length,
      records_synced: filteredRecords.length,
    });
  } catch (err) {
    console.error('Redo sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
