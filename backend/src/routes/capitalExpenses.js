const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// GET /api/capital-expenses — list all, ordered by purchase_date desc
router.get('/', async (req, res) => {
  const { start_date, end_date } = req.query;

  let query = supabase
    .from('capital_expenses')
    .select('*')
    .order('purchase_date', { ascending: false });

  if (start_date) query = query.gte('purchase_date', start_date);
  if (end_date) query = query.lte('purchase_date', end_date);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/capital-expenses — create new entry
router.post('/', async (req, res) => {
  const { name, category, amount, purchase_date, notes } = req.body;

  if (!name || !category || amount == null || !purchase_date) {
    return res.status(400).json({ error: 'name, category, amount, and purchase_date are required' });
  }

  const { data, error } = await supabase
    .from('capital_expenses')
    .insert({ name, category, amount: parseFloat(amount), purchase_date, notes: notes || null })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/capital-expenses/:id — delete entry
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('capital_expenses').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

const PARSE_PROMPT = `You are a receipt parser for an Australian small business. Extract the capital expense details from this receipt/invoice.

Return JSON in this exact format (no markdown, no explanation):
{
  "name": "short asset/item name in English",
  "category": "one of: Machinery, Equipment, Furniture, Vehicle, Technology, Other",
  "amount": 0.00,
  "purchase_date": "YYYY-MM-DD",
  "notes": "supplier name, order number, original currency and amount"
}

CRITICAL RULES:

1. ASSET NAME — Always translate to English:
   - If the product name is in Chinese, Japanese, or any non-English language, translate it to a clear English description.
   - Include the brand name (keep in original if it's a brand) + English product description + key specs (model, wattage, size).
   - Example: "RTRUST激光雕刻机小型便携式金属打标迷你台式木头皮革切割镭雕机" → "RTRUST Laser Engraving Machine (Desktop, Portable)"
   - Example: "数码相机4K高清" → "Digital Camera 4K HD"
   - Keep it concise but descriptive.

2. CURRENCY CONVERSION — Always return amount in AUD:
   - Detect the currency from symbols and text on the receipt.
   - If CNY (Chinese Yuan, ¥): multiply by 0.21 to convert to AUD. Example: ¥1221 CNY × 0.21 = $256.41 AUD.
   - If USD ($, US Dollar): multiply by 1.55 to convert to AUD. Example: $100 USD × 1.55 = $155.00 AUD.
   - If EUR (€): multiply by 1.70 to convert to AUD.
   - If GBP (£): multiply by 2.00 to convert to AUD.
   - If already AUD or Australian: use the amount as-is.
   - The "amount" field MUST always be in AUD after conversion.
   - Use the final total amount paid (inc shipping, GST/tax if shown), not subtotals.

3. NOTES — Include all of these if available:
   - Original currency and amount (e.g. "Original: ¥1221 CNY")
   - Order number / invoice number / reference
   - Supplier or store name (e.g. "1688", "Taobao", "Amazon AU")
   - Payment method if visible

4. CATEGORY — Must be exactly one of: Machinery, Equipment, Furniture, Vehicle, Technology, Other

5. PURCHASE DATE — The transaction/purchase date in YYYY-MM-DD format. If not found, use null.`;

// POST /api/capital-expenses/parse-receipt — AI extraction from text or image
router.post('/parse-receipt', async (req, res) => {
  const { text, image_base64, media_type } = req.body;

  if (!text && !image_base64) {
    return res.status(400).json({ error: 'Receipt text or image is required' });
  }

  try {
    let content;
    if (image_base64) {
      content = [
        { type: 'image', source: { type: 'base64', media_type: media_type || 'image/jpeg', data: image_base64 } },
        { type: 'text', text: PARSE_PROMPT },
      ];
    } else {
      content = `${PARSE_PROMPT}\n\nReceipt text:\n${text}`;
    }

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1000,
      messages: [{ role: 'user', content }],
    });

    const rawText = message.content[0]?.text || '';
    let parsed;
    try {
      parsed = JSON.parse(rawText.replace(/```json|```/g, '').trim());
    } catch {
      return res.status(422).json({ error: 'Could not parse Claude response', raw: rawText });
    }

    res.json({ success: true, parsed });
  } catch (err) {
    console.error('Receipt parse error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
