const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Helper: parse CSV text into rows ─────────────────────────────────────────
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };

  // Handle quoted CSV fields
  const splitRow = (line) => {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === ',' && !inQuotes) { result.push(current.trim()); current = ''; continue; }
      current += ch;
    }
    result.push(current.trim());
    return result;
  };

  const headers = splitRow(lines[0]).map(h => h.toUpperCase().trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = splitRow(lines[i]);
    if (vals.length < 2) continue; // skip empty rows
    const row = {};
    headers.forEach((h, idx) => { row[h] = vals[idx] || ''; });
    rows.push(row);
  }
  return { headers, rows };
}

// Normalise column name lookups — AusPost CSVs have varying column names
function findCol(headers, candidates) {
  for (const c of candidates) {
    const match = headers.find(h => h.includes(c));
    if (match) return match;
  }
  return null;
}

function parseDate(raw) {
  if (!raw) return null;
  // YYYYMMDD format
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  // DD/MM/YYYY
  const dmy = raw.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  // ISO-ish
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return null;
}

function parseNum(raw) {
  if (!raw || raw === '') return 0;
  // Remove $ and whitespace
  const cleaned = String(raw).replace(/[$\s,]/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : Math.round(n * 100) / 100;
}

// ── POST /api/3pl/auspost — upload CSV ───────────────────────────────────────
router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const text = req.file.buffer.toString('utf-8');
    const { headers, rows } = parseCsv(text);

    if (rows.length === 0) {
      return res.status(400).json({ error: 'CSV has no data rows' });
    }

    // Find columns by flexible matching
    const colConsignment = findCol(headers, ['CONSIGNMENT ID', 'CONSIGNMENT', 'CON ID']);
    const colDate        = findCol(headers, ['LODGEMENT DATE', 'LODGEMENT', 'SHIP DATE']);
    const colRef         = findCol(headers, ['CUSTOMER REFDOC', 'CUSTOMER REF', 'REFDOC', 'REFERENCE']);
    const colAmount      = findCol(headers, ['AMOUNT']);
    const colFsc         = findCol(headers, ['FSC']);
    const colFscExp      = findCol(headers, ['FSC FOR EXP', 'FSC EXP', 'EXPRESS FSC']);
    const colTotal       = findCol(headers, ['TOTAL']);
    const colDesc        = findCol(headers, ['DESCRIPTION', 'SERVICE', 'SERVICE TYPE']);
    const colState       = findCol(headers, ['TO STATE', 'STATE', 'DEST STATE', 'RECEIVER STATE']);

    if (!colConsignment && !colRef) {
      return res.status(400).json({
        error: 'Could not find CONSIGNMENT ID or CUSTOMER REFDOC column. Found columns: ' + headers.join(', '),
      });
    }

    const records = [];
    let skipped = 0;

    for (const row of rows) {
      const consignmentId = row[colConsignment] || '';
      const amount = parseNum(row[colAmount]);
      const fsc = parseNum(row[colFsc]) + parseNum(row[colFscExp]);

      // Compute total: use CSV total if present, else amount + fsc
      let totalCost = colTotal ? parseNum(row[colTotal]) : amount + fsc;
      if (totalCost === 0 && amount > 0) totalCost = amount + fsc;

      const lodgementDate = parseDate(row[colDate]);

      if (!consignmentId && !row[colRef]) {
        skipped++;
        continue;
      }

      records.push({
        consignment_id: consignmentId || `REF-${row[colRef]}`,
        lodgement_date: lodgementDate || '1970-01-01',
        shopify_ref: row[colRef] || null,
        amount,
        fsc: Math.round(fsc * 100) / 100,
        total_cost: Math.round(totalCost * 100) / 100,
        service_type: row[colDesc] || null,
        to_state: row[colState] || null,
      });
    }

    if (records.length === 0) {
      return res.status(400).json({ error: 'No valid records found in CSV' });
    }

    // Upsert by consignment_id
    const { data, error } = await supabase
      .from('auspost_freight_costs')
      .upsert(records, { onConflict: 'consignment_id' })
      .select();

    if (error) return res.status(500).json({ error: error.message });

    res.json({
      success: true,
      imported: data.length,
      skipped,
      total_rows: rows.length,
    });
  } catch (err) {
    console.error('AusPost CSV import error:', err.message);
    res.status(500).json({ error: 'Failed to import CSV: ' + err.message });
  }
});

// ── GET /api/3pl/auspost/summary — freight costs for a period ────────────────
router.get('/summary', async (req, res) => {
  const { start_date, end_date } = req.query;

  try {
    let query = supabase
      .from('auspost_freight_costs')
      .select('lodgement_date, amount, fsc, total_cost, service_type');

    if (start_date) query = query.gte('lodgement_date', start_date);
    if (end_date)   query = query.lte('lodgement_date', end_date);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const rows = data || [];
    const totalAmountCents = rows.reduce((s, r) => s + Math.round(parseFloat(r.amount || 0) * 100), 0);
    const totalFscCents = rows.reduce((s, r) => s + Math.round(parseFloat(r.fsc || 0) * 100), 0);
    const totalCostCents = rows.reduce((s, r) => s + Math.round(parseFloat(r.total_cost || 0) * 100), 0);

    // Breakdown by service type
    const byService = {};
    for (const r of rows) {
      const svc = r.service_type || 'Unknown';
      if (!byService[svc]) byService[svc] = { consignments: 0, totalCents: 0 };
      byService[svc].consignments++;
      byService[svc].totalCents += Math.round(parseFloat(r.total_cost || 0) * 100);
    }

    res.json({
      consignments: rows.length,
      total_amount: totalAmountCents / 100,
      total_fsc: totalFscCents / 100,
      total_cost: totalCostCents / 100,
      avg_cost_per_consignment: rows.length > 0 ? Math.round(totalCostCents / rows.length) / 100 : 0,
      by_service: Object.entries(byService).map(([svc, d]) => ({
        service_type: svc,
        consignments: d.consignments,
        total_cost: d.totalCents / 100,
      })),
    });
  } catch (err) {
    console.error('AusPost summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/3pl/auspost/records — list individual records ───────────────────
router.get('/records', async (req, res) => {
  const { start_date, end_date, limit = 100, offset = 0 } = req.query;

  try {
    let query = supabase
      .from('auspost_freight_costs')
      .select('*')
      .order('lodgement_date', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (start_date) query = query.gte('lodgement_date', start_date);
    if (end_date)   query = query.lte('lodgement_date', end_date);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({ records: data || [], total: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/3pl/auspost/all — clear all records ──────────────────────────
router.delete('/all', async (req, res) => {
  const { error } = await supabase
    .from('auspost_freight_costs')
    .delete()
    .neq('id', '00000000-0000-0000-0000-000000000000'); // delete all rows

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
