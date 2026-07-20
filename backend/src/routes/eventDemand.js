const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');

// POST /api/events/demand-reports
// Body: { label, event_start, event_end, order_count?, lines: [{ product_name, sku?, total_qty, total_revenue, standard_qty, express_qty }] }
router.post('/demand-reports', async (req, res) => {
  const { label, event_start, event_end, order_count, lines } = req.body || {};

  if (!label || !String(label).trim()) {
    return res.status(400).json({ error: 'label is required' });
  }
  if (!event_start || !/^\d{4}-\d{2}-\d{2}$/.test(event_start)) {
    return res.status(400).json({ error: 'event_start (YYYY-MM-DD) is required' });
  }
  if (!event_end || !/^\d{4}-\d{2}-\d{2}$/.test(event_end)) {
    return res.status(400).json({ error: 'event_end (YYYY-MM-DD) is required' });
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: 'lines array is required' });
  }

  try {
    const { data: report, error: reportErr } = await supabase
      .from('event_demand_reports')
      .insert({
        label: String(label).trim(),
        event_start,
        event_end,
        order_count: order_count != null ? parseInt(order_count, 10) : null,
      })
      .select()
      .single();
    if (reportErr) return res.status(500).json({ error: reportErr.message });

    const lineRows = lines.map(l => ({
      report_id:    report.id,
      product_name: String(l.product_name || '').trim(),
      sku:          l.sku ? String(l.sku).trim() : null,
      total_qty:    parseInt(l.total_qty, 10)    || 0,
      total_revenue: parseFloat(l.total_revenue) || 0,
      standard_qty: parseInt(l.standard_qty, 10) || 0,
      express_qty:  parseInt(l.express_qty, 10)  || 0,
      location:     l.location ? String(l.location).trim() : null,
    }));

    const { data: insertedLines, error: linesErr } = await supabase
      .from('event_demand_lines')
      .insert(lineRows)
      .select();
    if (linesErr) return res.status(500).json({ error: linesErr.message });

    res.json({ report, lines: insertedLines });
  } catch (err) {
    console.error('Create demand report error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/events/demand-reports/:id — cascade deletes lines via FK
router.delete('/demand-reports/:id', async (req, res) => {
  const { error } = await supabase
    .from('event_demand_reports')
    .delete()
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ deleted: true });
});

// PATCH /api/events/demand-reports/:id — update label / dates
router.patch('/demand-reports/:id', async (req, res) => {
  const { label, event_start, event_end } = req.body || {};
  const updates = {};
  if (label       != null) updates.label       = String(label).trim();
  if (event_start != null) updates.event_start = event_start;
  if (event_end   != null) updates.event_end   = event_end;
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'Nothing to update' });
  }
  const { data, error } = await supabase
    .from('event_demand_reports')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/events/demand-reports — list, ordered by event_end desc
router.get('/demand-reports', async (req, res) => {
  const { data, error } = await supabase
    .from('event_demand_reports')
    .select('id, label, event_start, event_end, order_count, created_at')
    .order('event_end', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /api/events/demand-reports/:id — report + lines + totals
router.get('/demand-reports/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { data: report, error: reportErr } = await supabase
      .from('event_demand_reports')
      .select('id, label, event_start, event_end, order_count, created_at')
      .eq('id', id)
      .single();
    if (reportErr) return res.status(404).json({ error: reportErr.message });

    const { data: lines, error: linesErr } = await supabase
      .from('event_demand_lines')
      .select('id, product_name, sku, total_qty, total_revenue, standard_qty, express_qty, location, created_at')
      .eq('report_id', id)
      .order('total_qty', { ascending: false });
    if (linesErr) return res.status(500).json({ error: linesErr.message });

    const totals = (lines || []).reduce(
      (acc, l) => ({
        total_units:    acc.total_units    + (l.total_qty    || 0),
        total_revenue:  acc.total_revenue  + parseFloat(l.total_revenue || 0),
        total_standard: acc.total_standard + (l.standard_qty || 0),
        total_express:  acc.total_express  + (l.express_qty  || 0),
      }),
      { total_units: 0, total_revenue: 0, total_standard: 0, total_express: 0 }
    );

    res.json({ report, lines: lines || [], totals });
  } catch (err) {
    console.error('Get demand report error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
