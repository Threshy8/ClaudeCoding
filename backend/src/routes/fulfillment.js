const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const Anthropic = require('@anthropic-ai/sdk');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── GET /api/fulfillment/invoices ─────────────────────────────────────────────
// List all invoices with totals
router.get('/invoices', async (req, res) => {
  const { data, error } = await supabase
    .from('fulfillment_invoices')
    .select('*')
    .order('invoice_date', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /api/fulfillment/invoices/:id/line-items ───────────────────────────────
router.get('/invoices/:id/line-items', async (req, res) => {
  const { data, error } = await supabase
    .from('fulfillment_line_items')
    .select('*')
    .eq('invoice_id', req.params.id)
    .order('category');

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /api/fulfillment/summary ───────────────────────────────────────────────
// Monthly cost summary for dashboard
router.get('/summary', async (req, res) => {
  const { start_date, end_date } = req.query;

  let query = supabase
    .from('fulfillment_invoices')
    .select('id, invoice_date, shipment_ref, total_ex_gst, total_inc_gst, units_shipped');

  if (start_date) query = query.gte('invoice_date', start_date);
  if (end_date)   query = query.lte('invoice_date', end_date);

  const { data: invoices, error: invError } = await query;
  if (invError) return res.status(500).json({ error: invError.message });

  if (!invoices || invoices.length === 0) {
    return res.json({ invoices: [], totals: { inbound: 0, outbound: 0, other: 0, total: 0, units_shipped: 0, cost_per_unit: 0 } });
  }

  const invoiceIds = invoices.map(i => i.id);
  const { data: lineItems, error: liError } = await supabase
    .from('fulfillment_line_items')
    .select('invoice_id, category, amount_ex_gst')
    .in('invoice_id', invoiceIds);

  if (liError) return res.status(500).json({ error: liError.message });

  const totals = { inbound: 0, outbound: 0, other: 0, total: 0, units_shipped: 0 };

  for (const li of (lineItems || [])) {
    const amt = parseFloat(li.amount_ex_gst) || 0;
    totals.total += amt;
    if (li.category === 'inbound')       totals.inbound += amt;
    else if (li.category === 'outbound') totals.outbound += amt;
    else                                  totals.other += amt;
  }

  for (const inv of invoices) {
    totals.units_shipped += parseInt(inv.units_shipped) || 0;
  }

  totals.cost_per_unit = totals.units_shipped > 0
    ? Math.round((totals.outbound / totals.units_shipped) * 100) / 100
    : 0;

  // Round
  for (const k of ['inbound', 'outbound', 'other', 'total']) {
    totals[k] = Math.round(totals[k] * 100) / 100;
  }

  res.json({ invoices, totals });
});

// ── POST /api/fulfillment/parse-pdf ───────────────────────────────────────────
// Upload PDF → Claude parses it → return structured line items (not saved yet)
router.post('/parse-pdf', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });

  const base64 = req.file.buffer.toString('base64');

  const prompt = `You are parsing a 3PL (third-party logistics) warehouse invoice for The Watch Box Co., an Australian e-commerce brand.

Extract all charge line items from this invoice and return ONLY valid JSON (no markdown, no commentary).

Categorise each line item as:
- "inbound"  → receiving stock, put away, pallet storage, admin order processing receiving, inbound freight, wrapping/packaging materials for receiving
- "outbound" → pick/pack, dispatch, admin order processing despatch, outbound freight, delivery charges, pick pack ship per unit
- "other"    → anything that doesn't clearly fit inbound or outbound (e.g. general labour, miscellaneous)

Return this exact JSON structure:
{
  "invoice_ref": "string or null",
  "invoice_date": "YYYY-MM-DD or null",
  "period_description": "string describing what period this covers, e.g. 'Warehouse charges WE 20260301'",
  "units_shipped": number or null,
  "line_items": [
    {
      "description": "exact description from invoice",
      "category": "inbound" | "outbound" | "other",
      "quantity": number or null,
      "unit_rate": number or null,
      "amount_ex_gst": number,
      "gst": number
    }
  ]
}

For units_shipped: look for "Pack, label and dispatch" or "PICK, PACK, SHIP" lines — the quantity on those lines is the units shipped.
For amounts: use the ex-GST amount (before GST column).
Extract ALL line items including admin fees, storage, freight, labour, packaging.`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: base64 },
            },
            { type: 'text', text: prompt },
          ],
        },
      ],
    });

    const raw = message.content[0].text.trim();
    // Strip markdown fences if present
    const clean = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(clean);

    res.json(parsed);
  } catch (err) {
    console.error('PDF parse error:', err.message);
    res.status(500).json({ error: 'Failed to parse PDF: ' + err.message });
  }
});

// ── POST /api/fulfillment/invoices ─────────────────────────────────────────────
// Save a parsed invoice + its line items to Supabase
router.post('/invoices', async (req, res) => {
  const { invoice_ref, invoice_date, period_description, units_shipped, line_items } = req.body;

  if (!invoice_date || !line_items || line_items.length === 0) {
    return res.status(400).json({ error: 'invoice_date and line_items are required' });
  }

  const totalExGst = line_items.reduce((s, li) => s + (parseFloat(li.amount_ex_gst) || 0), 0);
  const totalGst   = line_items.reduce((s, li) => s + (parseFloat(li.gst) || 0), 0);
  const totalIncGst = totalExGst + totalGst;

  // Insert invoice
  const { data: invoice, error: invError } = await supabase
    .from('fulfillment_invoices')
    .insert({
      invoice_ref:        invoice_ref || null,
      invoice_date:       invoice_date,
      period_description: period_description || null,
      units_shipped:      units_shipped || null,
      total_ex_gst:       Math.round(totalExGst * 100) / 100,
      total_gst:          Math.round(totalGst * 100) / 100,
      total_inc_gst:      Math.round(totalIncGst * 100) / 100,
    })
    .select()
    .single();

  if (invError) return res.status(500).json({ error: invError.message });

  // Insert line items
  const rows = line_items.map(li => ({
    invoice_id:    invoice.id,
    description:   li.description,
    category:      li.category,
    quantity:      li.quantity || null,
    unit_rate:     li.unit_rate || null,
    amount_ex_gst: parseFloat(li.amount_ex_gst) || 0,
    gst:           parseFloat(li.gst) || 0,
  }));

  const { error: liError } = await supabase.from('fulfillment_line_items').insert(rows);
  if (liError) return res.status(500).json({ error: liError.message });

  res.json({ success: true, invoice });
});

// ── DELETE /api/fulfillment/invoices/:id ──────────────────────────────────────
router.delete('/invoices/:id', async (req, res) => {
  // Line items deleted via CASCADE
  const { error } = await supabase
    .from('fulfillment_invoices')
    .delete()
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
