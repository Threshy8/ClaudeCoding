const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const supabase = require('../db/supabase');
const { recomputeAllCogs, runFifoEngine } = require('../utils/fifo');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── GET /api/purchases/orders ─────────────────────────────────────────────────
// List all POs with their lines and consumption status
router.get('/orders', async (req, res) => {
  const { status, supplier } = req.query;

  let query = supabase
    .from('purchase_orders')
    .select(`
      id, po_number, supplier, order_date, notes, status, total_value, invoice_url, created_at, destination, original_currency, exchange_rate,
      purchase_order_lines (
        id, sku, product_name, quantity_ordered, quantity_remaining, unit_cost, total_cost, order_date
      )
    `)
    .order('order_date', { ascending: false });

  if (status) query = query.eq('status', status);
  if (supplier) query = query.eq('supplier', supplier);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Enrich with consumption info
  const enriched = (data || []).map(po => {
    const lines = po.purchase_order_lines || [];
    const totalOrdered = lines.reduce((s, l) => s + l.quantity_ordered, 0);
    const totalRemaining = lines.reduce((s, l) => s + l.quantity_remaining, 0);
    const totalConsumed = totalOrdered - totalRemaining;
    return {
      ...po,
      total_units_ordered: totalOrdered,
      total_units_remaining: totalRemaining,
      total_units_consumed: totalConsumed,
      consumption_pct: totalOrdered > 0 ? Math.round((totalConsumed / totalOrdered) * 100) : 0,
    };
  });

  res.json(enriched);
});

// ── GET /api/purchases/orders/:id/consumption ─────────────────────────────────
// For a specific PO, show which orders consumed units from each line
router.get('/orders/:id/consumption', async (req, res) => {
  const { id } = req.params;

  // Get PO + lines
  const { data: po, error: poErr } = await supabase
    .from('purchase_orders')
    .select(`
      id, po_number, supplier, order_date, status,
      purchase_order_lines ( id, sku, product_name, quantity_ordered, quantity_remaining, unit_cost )
    `)
    .eq('id', id)
    .single();

  if (poErr) return res.status(404).json({ error: 'PO not found' });

  // Get cogs_entries that reference lines from this PO
  const lineIds = (po.purchase_order_lines || []).map(l => l.id);
  if (lineIds.length === 0) return res.json({ ...po, consumption: [] });

  const { data: entries } = await supabase
    .from('cogs_entries')
    .select('shopify_order_id, order_number, order_date, sku, quantity_sold, po_line_id, sale_price, gross_profit')
    .in('po_line_id', lineIds)
    .order('order_date', { ascending: true });

  // Group consumption by SKU
  const consumptionBySku = {};
  for (const e of (entries || [])) {
    if (!consumptionBySku[e.sku]) consumptionBySku[e.sku] = [];
    consumptionBySku[e.sku].push({
      shopify_order_id: e.shopify_order_id,
      order_number:     e.order_number,
      order_date:       e.order_date,
      quantity_sold:    e.quantity_sold,
      sale_price:       e.sale_price,
      gross_profit:     e.gross_profit,
    });
  }

  const lines = (po.purchase_order_lines || []).map(line => ({
    ...line,
    quantity_consumed: line.quantity_ordered - line.quantity_remaining,
    orders: consumptionBySku[line.sku] || [],
  }));

  res.json({ ...po, purchase_order_lines: lines });
});

// ── POST /api/purchases/orders ────────────────────────────────────────────────
// Create a PO manually (with line items)
router.post('/orders', async (req, res) => {
  const { supplier, order_date, notes, lines, destination, original_currency, exchange_rate } = req.body;

  if (!supplier || !order_date || !lines || lines.length === 0) {
    return res.status(400).json({ error: 'supplier, order_date, and lines are required' });
  }

  // Auto-generate PO number
  const { data: poNumData, error: poNumErr } = await supabase.rpc('next_po_number');
  if (poNumErr) return res.status(500).json({ error: 'Failed to generate PO number: ' + poNumErr.message });
  const po_number = poNumData;

  // Calculate total value
  const total_value = lines.reduce((s, l) => s + (l.quantity * parseFloat(l.unit_cost || 0)), 0);

  // Insert PO header
  const insertData = { po_number, supplier, order_date, notes, total_value, status: 'open' };
  if (destination) insertData.destination = destination;
  if (original_currency) insertData.original_currency = original_currency;
  if (exchange_rate != null) insertData.exchange_rate = exchange_rate;

  const { data: po, error: poErr } = await supabase
    .from('purchase_orders')
    .insert(insertData)
    .select()
    .single();

  if (poErr) return res.status(500).json({ error: poErr.message });

  // Insert PO lines
  const lineRows = lines.map(l => ({
    po_id:              po.id,
    po_number:          po.po_number,
    sku:                l.sku,
    product_name:       l.product_name,
    quantity_ordered:   l.quantity,
    quantity_remaining: l.quantity,
    unit_cost:          parseFloat(l.unit_cost),
    supplier:           supplier,
    order_date:         order_date,
  }));

  const { error: linesErr } = await supabase
    .from('purchase_order_lines')
    .insert(lineRows);

  if (linesErr) {
    // Rollback PO header
    await supabase.from('purchase_orders').delete().eq('id', po.id);
    return res.status(500).json({ error: linesErr.message });
  }

  res.json({ success: true, po_number: po.po_number, po_id: po.id });
});

// ── DELETE /api/purchases/orders/:id ─────────────────────────────────────────
// Delete a PO (cascades to lines, then triggers recompute)
router.delete('/orders/:id', async (req, res) => {
  const { id } = req.params;
  const { store = 'au' } = req.query;

  const { error } = await supabase.from('purchase_orders').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });

  // Recompute COGS since a lot was removed
  const recomputeResult = await recomputeAllCogs(store);
  res.json({ success: true, recompute: recomputeResult });
});

// ── POST /api/purchases/parse-invoice ────────────────────────────────────────
// Upload a PO invoice image/PDF → Claude AI parses it → returns structured line items
router.post('/parse-invoice', async (req, res) => {
  const { image_base64, media_type = 'image/jpeg', supplier } = req.body;

  if (!image_base64) {
    return res.status(400).json({ error: 'image_base64 is required' });
  }

  // Fetch existing SKUs from purchase_order_lines + shopify_sales for matching
  const { data: skuData } = await supabase
    .from('shopify_sales')
    .select('sku, product_name')
    .order('sku');

  const knownSkus = [...new Map((skuData || []).map(s => [s.sku, s])).values()]
    .slice(0, 100) // limit context size
    .map(s => `${s.sku} — ${s.product_name}`)
    .join('\n');

  const systemPrompt = `You are a purchase order parser for The Watch Box Co. (WBC), an Australian watch retailer.
You parse invoices from Chinese wholesale and dropship platforms. Key platforms and their formats:

1688 (Alibaba wholesale platform):
- Unit prices in CNY (¥)
- Shows strikethrough original price and discounted price
- USD amount in brackets e.g. ($344.05) is just a currency display — IGNORE it, use ¥ unit price only
- 已发货 = shipped, 待发货 = pending
- 包邮 = free shipping included
- Product specs shown as 规格: (e.g. 黑色内灰3位 = black/grey 3-slot)
- Always extract the per-unit ¥ price, not the order total

GermanDrop:
- Similar CNY pricing
- Often has separate shipping line

For ALL Chinese platform invoices:
- ¥ = CNY (Chinese Yuan), never JPY
- Extract unit_cost from individual item price
- original_currency = CNY always
- Ignore any USD/AUD bracketed totals
- Include product specs (color/size) in product_name

Also handle non-Chinese invoices (AUD, USD, EUR etc) — detect currency from symbols and text.
Always respond with valid JSON only — no markdown, no explanation.`;

  const userPrompt = `Parse this ${supplier || 'supplier'} invoice and extract all line items.

IMPORTANT — Currency:
- Return the ORIGINAL amounts as they appear on the invoice — do NOT convert currencies yourself.
- For Chinese platforms (1688, GermanDrop): always set original_currency = "CNY", use ¥ prices only.
- For other invoices: detect currency from symbols/text and set original_currency accordingly.
- IGNORE any USD/AUD amounts shown in brackets — those are just display conversions.

Known SKUs in our system (match product names to these where possible):
${knownSkus || 'No existing SKUs yet — make your best guess from the product names.'}

Return JSON in this exact format:
{
  "supplier": "1688 or germandrop or other supplier name",
  "invoice_date": "YYYY-MM-DD",
  "invoice_reference": "any PO/invoice number on the document",
  "original_currency": "CNY",
  "shipping_cost": 0,
  "notes": "any relevant notes (include product specs like color/size)",
  "lines": [
    {
      "product_name": "exact name from invoice including specs (color/size/variant)",
      "suggested_sku": "best matching SKU from known list, or null if no match",
      "sku_confidence": "high|medium|low|none",
      "quantity": 1,
      "unit_cost": 0.00,
      "total_cost": 0.00
    }
  ],
  "invoice_total": 0.00
}

Important:
- shipping_cost is the total shipping on the invoice (not per unit), in the ORIGINAL currency. If 包邮 (free shipping), set to 0.
- All amounts (unit_cost, shipping_cost, invoice_total) must be in the ORIGINAL invoice currency
- unit_cost = per-unit price, NOT order line total
- Match product names to watch brands/models where possible
- If a field is not on the invoice, use null`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: media_type,
                data: image_base64,
              },
            },
            { type: 'text', text: userPrompt },
          ],
        },
      ],
    });

    const rawText = message.content[0]?.text || '';
    let parsed;
    try {
      parsed = JSON.parse(rawText.replace(/```json|```/g, '').trim());
    } catch {
      return res.status(422).json({ error: 'Claude could not parse invoice', raw: rawText });
    }

    // Currency conversion: if not AUD, fetch live exchange rate
    const originalCurrency = (parsed.original_currency || 'AUD').toUpperCase();
    let exchangeRate = 1.0;
    let exchangeRateDate = null;

    if (originalCurrency !== 'AUD') {
      try {
        const fxRes = await fetch(`https://open.er-api.com/v6/latest/${originalCurrency}`);
        const fxData = await fxRes.json();
        if (fxData.result === 'success' && fxData.rates?.AUD) {
          exchangeRate = fxData.rates.AUD;
          exchangeRateDate = fxData.time_last_update_utc ? new Date(fxData.time_last_update_utc).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
        }
      } catch (fxErr) {
        console.error('FX rate fetch failed:', fxErr.message);
        // Continue with rate=1, frontend will show warning
      }

      // Convert all amounts to AUD, preserve originals
      parsed.original_shipping_cost = parsed.shipping_cost;
      parsed.shipping_cost = Math.round((parsed.shipping_cost || 0) * exchangeRate * 100) / 100;

      for (const line of (parsed.lines || [])) {
        line.original_unit_cost = line.unit_cost;
        line.original_total_cost = line.total_cost;
        line.unit_cost = Math.round((line.unit_cost || 0) * exchangeRate * 100) / 100;
        line.total_cost = Math.round((line.total_cost || 0) * exchangeRate * 100) / 100;
      }

      parsed.original_invoice_total = parsed.invoice_total;
      parsed.invoice_total = Math.round((parsed.invoice_total || 0) * exchangeRate * 100) / 100;
    }

    parsed.original_currency = originalCurrency;
    parsed.exchange_rate = Math.round(exchangeRate * 10000) / 10000;
    parsed.exchange_rate_date = exchangeRateDate || new Date().toISOString().split('T')[0];

    res.json({ success: true, parsed });
  } catch (err) {
    console.error('Invoice parse error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/purchases/germandrop/topups ──────────────────────────────────────
router.get('/germandrop/topups', async (req, res) => {
  const { data, error } = await supabase
    .from('germandrop_topups')
    .select('*')
    .order('topup_date', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── POST /api/purchases/germandrop/topups ─────────────────────────────────────
router.post('/germandrop/topups', async (req, res) => {
  const { topup_date, amount_aud, notes } = req.body;
  if (!topup_date || !amount_aud) {
    return res.status(400).json({ error: 'topup_date and amount_aud required' });
  }
  const { data, error } = await supabase
    .from('germandrop_topups')
    .insert({ topup_date, amount_aud, balance_remaining: amount_aud, notes })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /api/purchases/germandrop/order-costs ─────────────────────────────────
router.get('/germandrop/order-costs', async (req, res) => {
  const { start_date, end_date } = req.query;
  let query = supabase
    .from('germandrop_order_costs')
    .select('*')
    .order('created_at', { ascending: false });
  if (start_date) query = query.gte('created_at', start_date);
  if (end_date)   query = query.lte('created_at', end_date);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── POST /api/purchases/germandrop/order-costs ────────────────────────────────
router.post('/germandrop/order-costs', async (req, res) => {
  const { shopify_order_id, order_number, shipping_cost, topup_id, notes } = req.body;
  if (!shopify_order_id || shipping_cost == null) {
    return res.status(400).json({ error: 'shopify_order_id and shipping_cost required' });
  }
  const { data, error } = await supabase
    .from('germandrop_order_costs')
    .upsert({ shopify_order_id, order_number, shipping_cost, topup_id, notes }, { onConflict: 'shopify_order_id' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── POST /api/purchases/recompute-cogs ────────────────────────────────────────
// Manually trigger full COGS recompute (after editing lots)
router.post('/recompute-cogs', async (req, res) => {
  const { store = 'au', start_date } = req.body;
  try {
    const result = await recomputeAllCogs(store, start_date || undefined);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
