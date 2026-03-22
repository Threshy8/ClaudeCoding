const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const multer = require('multer');
const XLSX = require('xlsx');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseFileToRows(buffer, originalname) {
  const ext = (originalname || '').toLowerCase();
  if (ext.endsWith('.csv')) {
    return parseCsvBuffer(buffer);
  }
  // Excel (.xlsx, .xls)
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const jsonRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  if (jsonRows.length === 0) return { headers: [], rows: [] };
  // Normalise headers to uppercase
  const headers = Object.keys(jsonRows[0]).map(h => h.toUpperCase().trim());
  const rows = jsonRows.map(r => {
    const out = {};
    for (const [k, v] of Object.entries(r)) {
      out[k.toUpperCase().trim()] = v;
    }
    return out;
  });
  return { headers, rows };
}

function parseCsvBuffer(buffer) {
  const text = buffer.toString('utf-8');
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };

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
    if (vals.length < 2) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = vals[idx] || ''; });
    rows.push(row);
  }
  return { headers, rows };
}

function findCol(headers, candidates) {
  for (const c of candidates) {
    const match = headers.find(h => h.includes(c));
    if (match) return match;
  }
  return null;
}

function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // YYYYMMDD (number or string)
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  // Excel serial date number (e.g. 46102)
  if (/^\d{5}$/.test(s)) {
    const d = new Date((parseInt(s) - 25569) * 86400 * 1000);
    return d.toISOString().slice(0, 10);
  }
  // DD/MM/YYYY
  const dmy = s.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  // ISO-ish
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

function parseNum(raw) {
  if (raw == null || raw === '') return null;
  const cleaned = String(raw).replace(/[$\s,]/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : Math.round(n * 100) / 100;
}

function isExpress(serviceType) {
  return (serviceType || '').toLowerCase().includes('express');
}

// ── POST /api/3pl/auspost — upload CSV/Excel ─────────────────────────────────
router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const { headers, rows } = parseFileToRows(req.file.buffer, req.file.originalname);

    if (rows.length === 0) {
      return res.status(400).json({ error: 'File has no data rows' });
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
      const consignmentId = String(row[colConsignment] || '').trim();
      const amount = parseNum(row[colAmount]) || 0;
      const serviceType = row[colDesc] ? String(row[colDesc]).trim() : null;

      // FSC: read from both FSC columns; if both are blank/zero, auto-calculate
      let fscStd = colFsc ? parseNum(row[colFsc]) : null;
      let fscExp = colFscExp ? parseNum(row[colFscExp]) : null;
      let fsc;

      if ((fscStd != null && fscStd > 0) || (fscExp != null && fscExp > 0)) {
        // Use explicit values from the file
        fsc = (fscStd || 0) + (fscExp || 0);
      } else if (amount > 0) {
        // Auto-calculate FSC based on service type
        fsc = isExpress(serviceType)
          ? Math.round(amount * 0.1105 * 100) / 100
          : Math.round(amount * 0.067 * 100) / 100;
      } else {
        fsc = 0;
      }

      // Total: use CSV/Excel total if present and non-zero, else calculate
      const fileTotal = colTotal ? parseNum(row[colTotal]) : null;
      const totalCost = (fileTotal != null && fileTotal > 0)
        ? fileTotal
        : Math.round((amount + fsc) * 100) / 100;

      const lodgementDate = parseDate(row[colDate]);
      const ref = colRef ? String(row[colRef] || '').trim() : '';

      if (!consignmentId && !ref) {
        skipped++;
        continue;
      }

      records.push({
        consignment_id: consignmentId || `REF-${ref}`,
        lodgement_date: lodgementDate || '1970-01-01',
        shopify_ref: ref || null,
        amount,
        fsc: Math.round(fsc * 100) / 100,
        total_cost: Math.round(totalCost * 100) / 100,
        service_type: serviceType,
        to_state: colState ? (String(row[colState] || '').trim() || null) : null,
      });
    }

    if (records.length === 0) {
      return res.status(400).json({ error: 'No valid records found in file' });
    }

    // Upsert by consignment_id (safe for re-uploads)
    const { data, error } = await supabase
      .from('auspost_freight_costs')
      .upsert(records, { onConflict: 'consignment_id' })
      .select();

    if (error) return res.status(500).json({ error: error.message });

    const totalFreight = records.reduce((s, r) => s + r.total_cost, 0);

    res.json({
      success: true,
      imported: data.length,
      skipped,
      total_rows: rows.length,
      total_freight: Math.round(totalFreight * 100) / 100,
    });
  } catch (err) {
    console.error('AusPost import error:', err.message);
    res.status(500).json({ error: 'Failed to import file: ' + err.message });
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
