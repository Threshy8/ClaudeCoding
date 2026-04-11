const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');

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

module.exports = router;
