const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');

// GET /api/products — list all products with current costs
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .order('updated_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
