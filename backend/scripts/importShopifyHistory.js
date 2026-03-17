#!/usr/bin/env node
/**
 * Import historical Shopify orders from a CSV export into shopify_sales.
 *
 * Usage:
 *   node scripts/importShopifyHistory.js [path-to-csv]
 *
 * Defaults to ~/Downloads/orders_export_1 2.csv if no path given.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

const VALID_STATUSES = new Set(['paid', 'partially_refunded', 'refunded']);
const BATCH_SIZE = 100;
const LOG_EVERY = 500;

// ── CSV parser (handles quoted fields with commas/newlines) ─────────────────
function parseCSV(text) {
  const rows = [];
  let i = 0;
  const len = text.length;

  function readField() {
    if (i >= len) return '';
    if (text[i] === '"') {
      // Quoted field
      i++; // skip opening quote
      let val = '';
      while (i < len) {
        if (text[i] === '"') {
          if (i + 1 < len && text[i + 1] === '"') {
            val += '"';
            i += 2;
          } else {
            i++; // skip closing quote
            break;
          }
        } else {
          val += text[i];
          i++;
        }
      }
      return val;
    } else {
      // Unquoted field
      let val = '';
      while (i < len && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
        val += text[i];
        i++;
      }
      return val;
    }
  }

  while (i < len) {
    const row = [];
    while (true) {
      row.push(readField());
      if (i >= len) { rows.push(row); break; }
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '\r') i++;
      if (i < len && text[i] === '\n') i++;
      rows.push(row);
      break;
    }
  }

  return rows;
}

// ── Parse "2025-12-31 20:45:07 +1100" → "2025-12-31" ───────────────────────
function parseOrderDate(raw) {
  if (!raw) return null;
  // Extract YYYY-MM-DD from the beginning
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const csvPath = process.argv[2]
    || path.join(require('os').homedir(), 'Downloads', 'orders_export_1 2.csv');

  if (!fs.existsSync(csvPath)) {
    console.error(`CSV file not found: ${csvPath}`);
    process.exit(1);
  }

  console.log(`Reading ${csvPath} …`);
  const raw = fs.readFileSync(csvPath, 'utf-8');
  const allRows = parseCSV(raw);

  if (allRows.length < 2) {
    console.error('CSV has no data rows');
    process.exit(1);
  }

  const headers = allRows[0];
  const col = (name) => headers.indexOf(name);

  // Map column indices
  const iName            = col('Name');
  const iFinancialStatus = col('Financial Status');
  const iCreatedAt       = col('Created at');
  const iQty             = col('Lineitem quantity');
  const iLineitemName    = col('Lineitem name');
  const iLineitemPrice   = col('Lineitem price');
  const iLineitemSku     = col('Lineitem sku');
  const iLineitemDiscount = col('Lineitem discount');
  const iBillingName     = col('Billing Name');
  const iId              = col('Id');
  const iShipping        = col('Shipping');
  const iTaxes           = col('Taxes');

  // Validate required columns
  const required = { Name: iName, 'Financial Status': iFinancialStatus, 'Created at': iCreatedAt,
    'Lineitem quantity': iQty, 'Lineitem name': iLineitemName, 'Lineitem price': iLineitemPrice,
    'Lineitem sku': iLineitemSku, Id: iId };
  for (const [name, idx] of Object.entries(required)) {
    if (idx === -1) { console.error(`Missing required column: ${name}`); process.exit(1); }
  }

  console.log(`Found ${allRows.length - 1} data rows, ${headers.length} columns`);

  // Order-level columns that Shopify only populates on the first line item row.
  // Continuation rows for the same order leave these blank — carry them forward.
  const ORDER_LEVEL_COLS = [iName, iFinancialStatus, iCreatedAt, iBillingName, iId, iShipping, iTaxes].filter(i => i !== -1);

  const records = [];
  let skippedStatus = 0;
  let skippedNoSku = 0;
  let skippedNoQty = 0;
  let prevOrderFields = {};
  const seenOrderShipping = new Set(); // track which orders already have shipping/tax rows

  for (let r = 1; r < allRows.length; r++) {
    const row = allRows[r];
    if (row.length < 2) continue; // skip empty lines

    // Shopify CSV: continuation rows for multi-line-item orders repeat Name and
    // Created at, but leave Financial Status and Id blank. Carry those forward.
    if ((row[iId] || '').trim()) {
      // New order — snapshot order-level fields
      for (const idx of ORDER_LEVEL_COLS) {
        prevOrderFields[idx] = row[idx];
      }
    } else {
      // Continuation row — fill in blanks from previous order
      for (const idx of ORDER_LEVEL_COLS) {
        if (!(row[idx] || '').trim()) {
          row[idx] = prevOrderFields[idx] || '';
        }
      }
    }

    const status = (row[iFinancialStatus] || '').toLowerCase().trim();
    if (!VALID_STATUSES.has(status)) { skippedStatus++; continue; }

    const sku = (row[iLineitemSku] || '').trim();
    if (!sku) { skippedNoSku++; continue; }

    const qty = parseInt(row[iQty], 10) || 0;
    if (qty <= 0) { skippedNoQty++; continue; }

    const orderName = (row[iName] || '').trim();
    const orderNumber = orderName.replace(/^#/, '');
    const shopifyOrderId = (row[iId] || '').trim();
    if (!shopifyOrderId) continue;

    const lineitemPrice = parseFloat(row[iLineitemPrice]) || 0;
    const lineitemDiscount = iLineitemDiscount !== -1 ? (parseFloat(row[iLineitemDiscount]) || 0) : 0;
    // sale_price is per-unit after discount
    const totalLineDiscount = lineitemDiscount; // CSV discount is total for the line
    const perUnitDiscount = qty > 0 ? totalLineDiscount / qty : 0;
    const salePrice = Math.round((lineitemPrice - perUnitDiscount) * 100) / 100;

    const orderDate = parseOrderDate(row[iCreatedAt]);
    if (!orderDate) continue;

    const customerName = iBillingName !== -1 ? (row[iBillingName] || '').trim() : null;

    records.push({
      shopify_order_id: shopifyOrderId,
      order_number: orderNumber,
      order_name: orderName,
      sku,
      product_name: (row[iLineitemName] || '').trim() || 'Unknown',
      quantity_sold: qty,
      sale_price: salePrice,
      order_date: orderDate,
      store: 'au',
      fulfillment_location: 'SCC',
      customer_name: customerName || null,
    });

    // Add shipping/tax rows once per order (on first line item seen)
    if (!seenOrderShipping.has(shopifyOrderId)) {
      seenOrderShipping.add(shopifyOrderId);

      const shippingAmount = iShipping !== -1 ? (parseFloat(row[iShipping]) || 0) : 0;
      if (shippingAmount > 0) {
        records.push({
          shopify_order_id: shopifyOrderId,
          order_number: orderNumber,
          order_name: orderName,
          sku: 'shipping',
          product_name: 'Shipping Charge',
          quantity_sold: 1,
          sale_price: Math.round(shippingAmount * 100) / 100,
          order_date: orderDate,
          store: 'au',
          fulfillment_location: 'SCC',
          customer_name: customerName || null,
        });
      }

    }

    if (records.length % LOG_EVERY === 0) {
      console.log(`  Parsed ${records.length} records so far (row ${r}/${allRows.length - 1}) …`);
    }
  }

  console.log(`\nParsed ${records.length} valid records`);
  console.log(`Skipped: ${skippedStatus} (status), ${skippedNoSku} (no SKU), ${skippedNoQty} (zero qty)`);

  // Deduplicate by shopify_order_id + sku (keep last occurrence, matching upsert behavior)
  const deduped = new Map();
  for (const rec of records) {
    deduped.set(`${rec.shopify_order_id}__${rec.sku}`, rec);
  }
  const finalRecords = [...deduped.values()];
  console.log(`After dedup: ${finalRecords.length} unique (order_id, sku) pairs\n`);

  // Upsert in batches
  let inserted = 0;
  let errors = 0;

  for (let i = 0; i < finalRecords.length; i += BATCH_SIZE) {
    const batch = finalRecords.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('shopify_sales')
      .upsert(batch, { onConflict: 'shopify_order_id,sku' });

    if (error) {
      console.error(`  Batch ${Math.floor(i / BATCH_SIZE) + 1} error:`, error.message);
      errors += batch.length;
    } else {
      inserted += batch.length;
    }

    if ((i + BATCH_SIZE) % LOG_EVERY < BATCH_SIZE) {
      console.log(`  Upserted ${Math.min(i + BATCH_SIZE, finalRecords.length)}/${finalRecords.length} …`);
    }
  }

  console.log(`\n=== Done ===`);
  console.log(`  Inserted/updated: ${inserted}`);
  console.log(`  Errors: ${errors}`);
  console.log(`  Total unique records: ${finalRecords.length}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
