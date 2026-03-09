const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');

// GET /api/purchases — list all purchases, newest first
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('purchases')
    .select('*')
    .order('purchase_date', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/purchases — add a new purchase
router.post('/', async (req, res) => {
  const { sku, product_name, quantity, unit_cost, purchase_date, supplier_notes } = req.body;

  if (!sku || !product_name || !quantity || !unit_cost || !purchase_date) {
    return res.status(400).json({ error: 'Missing required fields: sku, product_name, quantity, unit_cost, purchase_date' });
  }

  const { data, error } = await supabase
    .from('purchases')
    .insert([{ sku, product_name, quantity: parseInt(quantity), unit_cost: parseFloat(unit_cost), purchase_date, supplier_notes: supplier_notes || null }])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Also upsert into products table to keep current_unit_cost up to date
  await supabase.from('products').upsert(
    { sku, product_name, current_unit_cost: parseFloat(unit_cost), updated_at: new Date().toISOString() },
    { onConflict: 'sku' }
  );

  res.status(201).json(data);
});

// DELETE /api/purchases/:id — delete a purchase
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  const { error } = await supabase
    .from('purchases')
    .delete()
    .eq('id', id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
