#!/usr/bin/env node
/**
 * One-off script: Look up Redo resend orders by order_number,
 * extract the real original order number, and print UPDATE SQL.
 *
 * Usage (on Railway or locally with .env):
 *   node scripts/lookup-redo-orders.js
 *
 * Requires: SHOPIFY_STORE_URL, SHOPIFY_ACCESS_TOKEN in env
 */

const axios = require('axios');

const PHANTOM_ORDER_NUMBERS = [
  7129, 7188, 7190, 7226, 7230, 7253, 7254, 7350, 7358, 7421, 7454, 7473
];

async function main() {
  const storeUrl = process.env.SHOPIFY_STORE_URL;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!storeUrl || !token) {
    console.error('ERROR: Set SHOPIFY_STORE_URL and SHOPIFY_ACCESS_TOKEN in environment');
    process.exit(1);
  }

  const base = storeUrl.replace(/\/$/, '');
  const updates = [];

  for (const orderNum of PHANTOM_ORDER_NUMBERS) {
    try {
      // Fetch order by order_number (Shopify name is "#7129" etc)
      const orderName = `#${orderNum}`;
      const res = await axios.get(
        `${base}/admin/api/2024-01/orders.json?name=${encodeURIComponent(orderName)}&status=any&limit=5`,
        { headers: { 'X-Shopify-Access-Token': token } }
      );

      const order = (res.data.orders || []).find(o => o.name === orderName);
      if (!order) {
        console.error(`-- #${orderNum}: NOT FOUND in Shopify`);
        continue;
      }

      // Extract original order number
      let origOrderNumber = null;

      // 1. Try note_attributes
      const redoAttr = (order.note_attributes || []).find(a => a.name === '_redo_original_order');
      if (redoAttr && redoAttr.value) {
        origOrderNumber = String(redoAttr.value).replace(/^#/, '');
      }

      // 2. Fall back to note text
      if (!origOrderNumber) {
        const note = order.note || '';
        const match = note.match(/for order #(\d+)/);
        if (match) origOrderNumber = match[1];
      }

      if (!origOrderNumber) {
        console.error(`-- #${orderNum}: Redo order found but could not extract original order number`);
        console.error(`--   note: ${(order.note || '').substring(0, 100)}`);
        console.error(`--   note_attributes: ${JSON.stringify(order.note_attributes || [])}`);
        continue;
      }

      console.log(`-- #${orderNum} → original order #${origOrderNumber}`);
      updates.push(
        `UPDATE shopify_refunds SET order_number = '${origOrderNumber}' WHERE order_number = '${orderNum}';`
      );

      // Avoid rate limiting (2 calls/sec is safe)
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error(`-- #${orderNum}: API error: ${err.message}`);
    }
  }

  console.log('\n-- ============================================================');
  console.log('-- SQL to fix Redo refund order numbers in shopify_refunds');
  console.log('-- Run in: Supabase Dashboard → SQL Editor → New query');
  console.log('-- ============================================================\n');
  for (const sql of updates) {
    console.log(sql);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
