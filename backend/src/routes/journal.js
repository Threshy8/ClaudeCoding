const express = require('express');
const router = express.Router();
const { buildCogsData } = require('./cogs');

/**
 * Xero manual journal CSV format:
 * Narration, Date, AccountCode, Description, Amount (positive = debit, negative = credit)
 *
 * Journal entries:
 * DR  Cost of Goods Sold (5000)    = total COGS
 * CR  Inventory Asset (1500)       = total COGS (credit inventory)
 *
 * One line per SKU for detail, plus a summary header.
 */

// GET /api/journal/export?period=2026-02&format=csv
router.get('/export', async (req, res) => {
  const { period, format } = req.query;

  if (!period || !/^\d{4}-\d{2}$/.test(period)) {
    return res.status(400).json({ error: 'period query param required in format YYYY-MM' });
  }

  try {
    const [year, month] = period.split('-').map(Number);
    const periodStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const periodEnd   = month === 12
      ? `${year + 1}-01-01`
      : `${year}-${String(month + 1).padStart(2, '0')}-01`;
    const cogsData = await buildCogsData(periodStart, periodEnd, period);
    const { sku_breakdown, total_cogs, period: p } = cogsData;

    const [year, month] = p.split('-');
    const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
    const journalDate = `${lastDay}/${month}/${year}`; // Xero DD/MM/YYYY

    const narration = `COGS Recognition - ${period}`;

    // Build rows for Xero journal import
    const rows = [];

    // Header row (required by Xero)
    rows.push(['*Narration', '*Date', '*AccountCode', 'Description', '*Amount', 'TaxRate']);

    // One debit line per SKU sold (COGS account)
    for (const sku of sku_breakdown.filter((s) => s.cogs > 0)) {
      rows.push([
        narration,
        journalDate,
        '5000', // COGS account code (adjust to match your Xero chart)
        `COGS - ${sku.product_name} (${sku.sku}) - ${sku.units_sold} units @ $${sku.avg_unit_cost}`,
        sku.cogs.toFixed(2),
        'BAS Excluded',
      ]);
    }

    // One credit line per SKU (Inventory Asset account)
    for (const sku of sku_breakdown.filter((s) => s.cogs > 0)) {
      rows.push([
        narration,
        journalDate,
        '1500', // Inventory Asset account code (adjust to match your Xero chart)
        `Inventory reduction - ${sku.product_name} (${sku.sku})`,
        (-sku.cogs).toFixed(2),
        'BAS Excluded',
      ]);
    }

    if (format === 'csv' || !format) {
      const csvLines = rows.map((row) =>
        row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')
      );

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="xero-journal-${period}.csv"`
      );
      return res.send(csvLines.join('\n'));
    }

    // JSON fallback
    res.json({ period, entries: rows.slice(1), total_cogs });
  } catch (err) {
    console.error('Journal export error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
