const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const Anthropic = require('@anthropic-ai/sdk');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── GET /api/fulfillment/invoices ─────────────────────────────────────────────
router.get('/invoices', async (req, res) => {
  const { data, error } = await supabase
    .from('fulfillment_invoices')
    .select('*')
    .order('invoice_date', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /api/fulfillment/invoices/:id/line-items ──────────────────────────────
router.get('/invoices/:id/line-items', async (req, res) => {
  const { data, error } = await supabase
    .from('fulfillment_line_items')
    .select('*')
    .eq('invoice_id', req.params.id)
    .order('category');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /api/fulfillment/summary ──────────────────────────────────────────────
router.get('/summary', async (req, res) => {
  const { start_date, end_date } = req.query;

  let query = supabase
    .from('fulfillment_invoices')
    .select('id, invoice_date, invoice_ref, period_description, total_ex_gst, total_inc_gst, units_shipped');
  if (start_date) query = query.gte('invoice_date', start_date);
  if (end_date)   query = query.lte('invoice_date', end_date);

  const { data: invoices, error: invError } = await query;
  if (invError) return res.status(500).json({ error: invError.message });

  if (!invoices || invoices.length === 0) {
    return res.json({
      invoices: [],
      totals: { inbound: 0, outbound: 0, other: 0, total: 0, fixed: 0, variable: 0, units_shipped: 0, cost_per_unit: 0 },
    });
  }

  const invoiceIds = invoices.map(i => i.id);
  const { data: lineItems, error: liError } = await supabase
    .from('fulfillment_line_items')
    .select('invoice_id, category, cost_type, amount_ex_gst')
    .in('invoice_id', invoiceIds);
  if (liError) return res.status(500).json({ error: liError.message });

  const totals = { inbound: 0, outbound: 0, other: 0, total: 0, fixed: 0, variable: 0, units_shipped: 0 };

  for (const li of (lineItems || [])) {
    const amt = parseFloat(li.amount_ex_gst) || 0;
    totals.total += amt;
    if (li.category === 'inbound')       totals.inbound  += amt;
    else if (li.category === 'outbound') totals.outbound += amt;
    else                                  totals.other    += amt;
    if (li.cost_type === 'fixed')        totals.fixed    += amt;
    else                                  totals.variable += amt;
  }

  for (const inv of invoices) totals.units_shipped += parseInt(inv.units_shipped) || 0;

  totals.cost_per_unit = totals.units_shipped > 0
    ? Math.round((totals.variable / totals.units_shipped) * 100) / 100
    : 0;

  for (const k of ['inbound', 'outbound', 'other', 'total', 'fixed', 'variable'])
    totals[k] = Math.round(totals[k] * 100) / 100;

  res.json({ invoices, totals });
});

// ── GET /api/fulfillment/order-cost-sheet ─────────────────────────────────────
router.get('/order-cost-sheet', async (req, res) => {
  const { start_date, end_date, location } = req.query;
  if (!start_date || !end_date)
    return res.status(400).json({ error: 'start_date and end_date required' });

  // 1. Get 3PL invoice costs for period
  let variableCostTotal = 0;
  let fixedCostTotal    = 0;
  let fixedLineItems    = [];
  let totalUnitsShipped = 0;

  const { data: invoices, error: invErr } = await supabase
    .from('fulfillment_invoices')
    .select('id, units_shipped')
    .gte('invoice_date', start_date)
    .lte('invoice_date', end_date);
  if (invErr) return res.status(500).json({ error: invErr.message });

  if (invoices && invoices.length > 0) {
    const ids = invoices.map(i => i.id);
    const { data: lineItems, error: liErr } = await supabase
      .from('fulfillment_line_items')
      .select('description, category, cost_type, amount_ex_gst')
      .in('invoice_id', ids);
    if (liErr) return res.status(500).json({ error: liErr.message });

    for (const li of (lineItems || [])) {
      const amt = parseFloat(li.amount_ex_gst) || 0;
      if (li.cost_type === 'fixed') {
        fixedCostTotal += amt;
        fixedLineItems.push({ description: li.description, category: li.category, amount: amt });
      } else {
        variableCostTotal += amt;
      }
    }
    for (const inv of invoices) totalUnitsShipped += parseInt(inv.units_shipped) || 0;
  }

  const variableCostPerUnit = totalUnitsShipped > 0 ? variableCostTotal / totalUnitsShipped : 0;

  // 2. Fetch all sales in period (including fulfillment_location)
  const { data: allSales, error: salesErr } = await supabase
    .from('shopify_sales')
    .select('shopify_order_id, sku, product_name, quantity_sold, sale_price, order_date, fulfillment_location')
    .gte('order_date', start_date)
    .lte('order_date', end_date)
    .eq('store', 'au')
    .order('order_date', { ascending: false });
  if (salesErr) return res.status(500).json({ error: salesErr.message });

  // 3. Build unique location list for frontend filter dropdown
  const locationSet = new Set();
  for (const s of (allSales || [])) {
    if (s.fulfillment_location) locationSet.add(s.fulfillment_location);
  }
  const availableLocations = Array.from(locationSet).sort();

  // 4. Apply location filter — 'all' or empty = show everything
  const filteredSales = (location && location !== 'all')
    ? (allSales || []).filter(s => s.fulfillment_location === location)
    : (allSales || []);

  // 5. Group filtered sales by order
  const orderMap = {};
  for (const s of filteredSales) {
    if (!orderMap[s.shopify_order_id]) {
      orderMap[s.shopify_order_id] = {
        shopify_order_id:     s.shopify_order_id,
        order_date:           s.order_date,
        fulfillment_location: s.fulfillment_location || 'Unknown',
        line_items:           [],
        total_units:          0,
        total_revenue:        0,
      };
    }
    const o = orderMap[s.shopify_order_id];
    o.line_items.push({ sku: s.sku, product_name: s.product_name, quantity: s.quantity_sold });
    o.total_units   += s.quantity_sold;
    o.total_revenue += s.quantity_sold * parseFloat(s.sale_price || 0);
  }

  const orders = Object.values(orderMap).map(o => ({
    ...o,
    total_revenue:     Math.round(o.total_revenue * 100) / 100,
    // Only allocate variable cost if this is a 3PL-fulfilled order (or showing all)
    variable_3pl_cost: Math.round(o.total_units * variableCostPerUnit * 100) / 100,
  }));

  orders.sort((a, b) => b.order_date.localeCompare(a.order_date));

  res.json({
    period:             { start_date, end_date },
    available_locations: availableLocations,
    selected_location:  location || 'all',
    fixed_costs: {
      total:      Math.round(fixedCostTotal * 100) / 100,
      line_items: fixedLineItems,
    },
    variable_costs: {
      total:         Math.round(variableCostTotal * 100) / 100,
      units_shipped: totalUnitsShipped,
      cost_per_unit: Math.round(variableCostPerUnit * 100) / 100,
    },
    orders,
    grand_total_3pl: Math.round((fixedCostTotal + variableCostTotal) * 100) / 100,
  });
});

// ── POST /api/fulfillment/parse-pdf ───────────────────────────────────────────
router.post('/parse-pdf', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });

  const base64 = req.file.buffer.toString('base64');

  const prompt = `You are parsing a 3PL (third-party logistics) warehouse invoice for The Watch Box Co., an Australian e-commerce brand.

Extract all charge line items and return ONLY valid JSON (no markdown, no commentary).

For each line item assign THREE classifications:

1. "category":
   - "inbound"  -> receiving stock, put away, pallet storage, admin order processing receiving, inbound freight, packaging materials for receiving
   - "outbound" -> pick/pack, dispatch, admin order processing despatch, outbound freight, delivery charges, pick pack ship per unit
   - "other"    -> general labour, miscellaneous

2. "cost_type":
   - "variable" -> scales with number of orders/units. Examples: pick & pack per unit, pack label dispatch per unit, admin order processing despatch per order, pick pack ship per unit
   - "fixed"    -> same regardless of order volume. Examples: pallet storage, receiving/put away, inbound freight, delivery/freight charges, general labour, pallet wrapping, packaging materials

3. "variable_type" (only set this for variable cost_type items, otherwise null):
   - "per_order" -> flat fee charged once per order/dispatch regardless of how many units. Examples: "Admin Order Processing Despatch - 63 @ $4.50", "Pack, label and dispatch - 63 @ $1.50". The quantity matches the number of orders dispatched.
   - "per_unit"  -> fee charged per individual unit picked/shipped. Examples: "PICK, PACK, SHIP - Per unit - 73 @ $1.00". The description says "per unit" or the quantity matches units shipped (higher than order count).

To distinguish per_order vs per_unit: if the quantity on the line matches the number of dispatch/order processing lines (typically lower number like 63), it's per_order. If it matches the units shipped count (typically higher, like 73), it's per_unit. "Per unit" in the description is a strong signal.

Return this exact JSON structure:
{
  "invoice_ref": "string or null",
  "invoice_date": "YYYY-MM-DD or null",
  "period_description": "string e.g. Warehouse charges WE 20260301",
  "units_shipped": number or null,
  "line_items": [
    {
      "description": "exact description from invoice",
      "category": "inbound|outbound|other",
      "cost_type": "variable|fixed",
      "variable_type": "per_order|per_unit|null",
      "quantity": number or null,
      "unit_rate": number or null,
      "amount_ex_gst": number,
      "gst": number
    }
  ]
}

For units_shipped: use the quantity from PICK PACK SHIP Per unit line, or Pack label and dispatch line — whichever has the higher quantity (that's the unit count not order count).
For amounts: use the ex-GST amount.
Extract ALL line items.`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: prompt },
        ],
      }],
    });

    const raw   = message.content[0].text.trim();
    const clean = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    res.json(JSON.parse(clean));
  } catch (err) {
    console.error('PDF parse error:', err.message);
    res.status(500).json({ error: 'Failed to parse PDF: ' + err.message });
  }
});

// ── POST /api/fulfillment/invoices ────────────────────────────────────────────
router.post('/invoices', async (req, res) => {
  const { invoice_ref, invoice_date, period_description, units_shipped, line_items } = req.body;

  if (!invoice_date || !line_items || line_items.length === 0)
    return res.status(400).json({ error: 'invoice_date and line_items are required' });

  const totalExGst  = line_items.reduce((s, li) => s + (parseFloat(li.amount_ex_gst) || 0), 0);
  const totalGst    = line_items.reduce((s, li) => s + (parseFloat(li.gst) || 0), 0);
  const totalIncGst = totalExGst + totalGst;

  const { data: invoice, error: invError } = await supabase
    .from('fulfillment_invoices')
    .insert({
      invoice_ref:        invoice_ref || null,
      invoice_date,
      period_description: period_description || null,
      units_shipped:      units_shipped || null,
      total_ex_gst:       Math.round(totalExGst  * 100) / 100,
      total_gst:          Math.round(totalGst    * 100) / 100,
      total_inc_gst:      Math.round(totalIncGst * 100) / 100,
    })
    .select()
    .single();

  if (invError) return res.status(500).json({ error: invError.message });

  const rows = line_items.map(li => ({
    invoice_id:     invoice.id,
    description:    li.description,
    category:       li.category,
    cost_type:      li.cost_type || 'fixed',
    variable_type:  li.variable_type || null,
    quantity:       li.quantity  || null,
    unit_rate:      li.unit_rate || null,
    amount_ex_gst:  parseFloat(li.amount_ex_gst) || 0,
    gst:            parseFloat(li.gst) || 0,
  }));

  const { error: liError } = await supabase.from('fulfillment_line_items').insert(rows);
  if (liError) return res.status(500).json({ error: liError.message });

  res.json({ success: true, invoice });
});

// ── GET /api/fulfillment/invoices/:id/matched-orders ─────────────────────────
// Returns Shopify orders for the invoice's period with 3PL cost allocation
router.get('/invoices/:id/matched-orders', async (req, res) => {
  // Get invoice to know its date and units_shipped
  const { data: inv, error: invErr } = await supabase
    .from('fulfillment_invoices')
    .select('id, invoice_date, units_shipped, total_ex_gst')
    .eq('id', req.params.id)
    .single();
  if (invErr) return res.status(500).json({ error: invErr.message });

  // Get variable cost breakdown — per_order rate and per_unit rate separately
  const { data: lineItems, error: liErr } = await supabase
    .from('fulfillment_line_items')
    .select('cost_type, variable_type, amount_ex_gst, quantity')
    .eq('invoice_id', req.params.id);
  if (liErr) return res.status(500).json({ error: liErr.message });

  // Calculate per-order flat fee and per-unit fee from variable line items
  let perOrderTotal = 0; // total $ for per_order variable charges
  let perUnitTotal  = 0; // total $ for per_unit variable charges
  let orderCount    = 0; // number of orders from per_order lines (e.g. 63)

  for (const li of (lineItems || [])) {
    if (li.cost_type !== 'variable') continue;
    const amt = parseFloat(li.amount_ex_gst || 0);
    if (li.variable_type === 'per_order') {
      perOrderTotal += amt;
      // Use the quantity from the first per_order line as order count
      if (!orderCount && li.quantity) orderCount = parseInt(li.quantity);
    } else if (li.variable_type === 'per_unit') {
      perUnitTotal += amt;
    } else {
      // Fallback: no variable_type set, treat as per_unit
      perUnitTotal += amt;
    }
  }

  // Rate per order = total per_order charges / number of orders dispatched
  const ratePerOrder = orderCount > 0 ? perOrderTotal / orderCount : 0;
  // Rate per unit = total per_unit charges / units shipped
  const ratePerUnit  = inv.units_shipped > 0 ? perUnitTotal / inv.units_shipped : 0;

  // Fallback to simple average if no variable_type data
  const variableTotal = perOrderTotal + perUnitTotal;
  const useFallback   = ratePerOrder === 0 && ratePerUnit === 0;
  const fallbackRate  = inv.units_shipped > 0 ? variableTotal / inv.units_shipped : 0;

  // Use invoice date as period end, go back 7 days as period start (weekly invoice)
  const periodEnd   = inv.invoice_date;
  const d = new Date(inv.invoice_date);
  d.setDate(d.getDate() - 6);
  const periodStart = d.toISOString().split('T')[0];

  // Fetch all AU sales in that window
  const { data: sales, error: salesErr } = await supabase
    .from('shopify_sales')
    .select('shopify_order_id, sku, product_name, quantity_sold, sale_price, order_date, fulfillment_location')
    .gte('order_date', periodStart)
    .lte('order_date', periodEnd)
    .eq('store', 'au')
    .order('order_date', { ascending: false });
  if (salesErr) return res.status(500).json({ error: salesErr.message });

  // Group by order
  const orderMap = {};
  for (const s of (sales || [])) {
    if (!orderMap[s.shopify_order_id]) {
      orderMap[s.shopify_order_id] = {
        shopify_order_id:     s.shopify_order_id,
        order_date:           s.order_date,
        fulfillment_location: s.fulfillment_location || 'Unknown',
        is_scc:               (s.fulfillment_location || '').toLowerCase().includes('southern cross') ||
                              (s.fulfillment_location || '').toLowerCase().includes('scc') ||
                              (s.fulfillment_location || '').toLowerCase().includes('manual'),
        line_items:           [],
        total_units:          0,
        total_revenue:        0,
      };
    }
    const o = orderMap[s.shopify_order_id];
    o.line_items.push({ sku: s.sku, product_name: s.product_name, quantity: s.quantity_sold });
    o.total_units   += s.quantity_sold;
    o.total_revenue += s.quantity_sold * parseFloat(s.sale_price || 0);
  }

  const orders = Object.values(orderMap).map(o => {
    let cost = 0;
    if (o.is_scc) {
      if (useFallback) {
        cost = o.total_units * fallbackRate;
      } else {
        // Accurate: flat per-order fee + per-unit fee × units
        cost = ratePerOrder + (o.total_units * ratePerUnit);
      }
    }
    return {
      ...o,
      total_revenue:     Math.round(o.total_revenue * 100) / 100,
      variable_3pl_cost: Math.round(cost * 100) / 100,
    };
  });

  orders.sort((a, b) => b.order_date.localeCompare(a.order_date));

  res.json({
    period: { start: periodStart, end: periodEnd },
    cost_method: useFallback ? 'average' : 'accurate',
    rate_per_order: Math.round(ratePerOrder * 100) / 100,
    rate_per_unit:  Math.round(ratePerUnit  * 100) / 100,
    orders,
  });
});


router.delete('/invoices/:id', async (req, res) => {
  const { error } = await supabase.from('fulfillment_invoices').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── POST /api/fulfillment/summarise ───────────────────────────────────────────
router.post('/summarise', async (req, res) => {
  const { invoice_date, period_description, units_shipped, total_ex_gst, line_items } = req.body;
  if (!line_items?.length) return res.status(400).json({ error: 'No line items' });

  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `Summarise this 3PL invoice for The Watch Box Co. (Southern Cross Cargo) in 2 sentences max. Plain English, business-like. Mention the key cost types and total. Flag anything unusual like one-off fees or large labour charges.

Date: ${invoice_date} | Period: ${period_description || 'N/A'} | Units shipped: ${units_shipped || 'N/A'} | Total ex GST: $${total_ex_gst}
Line items: ${line_items.map(li => `${li.description} $${li.amount_ex_gst} (${li.cost_type})`).join(' | ')}`
    }]
  });

  res.json({ summary: msg.content[0]?.text || '' });
});

module.exports = router;
