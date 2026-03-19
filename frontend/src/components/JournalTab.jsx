import React, { useEffect, useState } from 'react';
import { getCogsSummary, exportJournal } from '../api';
import { triggerLabel } from './DateRangePicker';
import { useDemoMask } from '../contexts/DemoModeContext';

function _fmt(n) {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);
}

function downloadCsv(content, filename) {
  const blob = new Blob([content], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function JournalTab({ dateRange }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState(null);
  const { mc, mn } = useDemoMask();

  useEffect(() => {
    if (!dateRange?.start || !dateRange?.end) return;
    setLoading(true);
    setError(null);
    getCogsSummary(dateRange)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [dateRange]);

  // Derive a YYYY-MM period from the end of the range (for journal date + export filename)
  const period = dateRange?.end ? dateRange.end.slice(0, 7) : '';
  const [year, month] = period ? period.split('-') : ['', ''];
  const lastDay = year && month ? new Date(parseInt(year), parseInt(month), 0).getDate() : '';
  const journalDate = lastDay ? `${lastDay}/${month}/${year}` : '';

  const handleExport = async () => {
    setExporting(true);
    setExportMsg(null);
    try {
      const csv = await exportJournal(period);
      const filename = `xero-journal-${period}.csv`;
      downloadCsv(csv, filename);
      setExportMsg({ type: 'success', text: `Downloaded ${filename} — import into Xero via Accounting > Manual Journals.` });
    } catch (err) {
      setExportMsg({ type: 'error', text: 'Export failed: ' + err.message });
    } finally {
      setExporting(false);
    }
  };

  if (loading) return <div className="loading">Loading journal data…</div>;
  if (error)   return <div className="error-msg">{error}</div>;
  if (!data)   return null;

  const hasCogs = data.sku_breakdown.some((s) => s.cogs > 0);
  const rangeLabel = triggerLabel(dateRange);

  return (
    <div>
      <div className="journal-info">
        <strong>Xero Journal Entry — {rangeLabel}</strong>
        <br />
        This journal moves the COGS for goods sold in the selected period from the Inventory Asset account
        to the Cost of Goods Sold account. Post this at period-end.
        <div className="journal-account-note" style={{ marginTop: 8 }}>
          Account codes used: <strong>1500</strong> — Inventory Asset (CR) · <strong>5000</strong> — Cost of Goods Sold (DR)
          <br />
          Adjust these account codes to match your Xero chart of accounts before importing.
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-title">Journal Summary</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>Journal Date</div>
            <div style={{ fontWeight: 700 }}>{journalDate || '—'}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>Total COGS DR</div>
            <div style={{ fontWeight: 700, color: 'var(--red)' }}>{mc(_fmt(data.total_cogs))}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>Total Inventory CR</div>
            <div style={{ fontWeight: 700, color: 'var(--green)' }}>{mc(_fmt(data.total_cogs))}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>SKUs with Sales</div>
            <div style={{ fontWeight: 700 }}>{mn(data.sku_breakdown.filter((s) => s.cogs > 0).length)}</div>
          </div>
        </div>
      </div>

      {exportMsg && (
        <div className={`sync-banner ${exportMsg.type}`} style={{ borderRadius: 'var(--radius)', marginBottom: 16 }}>
          <span>{exportMsg.text}</span>
          <button className="banner-close" onClick={() => setExportMsg(null)}>✕</button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
        <button
          className="btn btn-primary"
          onClick={handleExport}
          disabled={exporting || !hasCogs}
        >
          {exporting ? '⟳ Generating…' : '↓ Export CSV for Xero'}
        </button>
        {!hasCogs && (
          <span style={{ color: 'var(--text-muted)', fontSize: 13, alignSelf: 'center' }}>
            No sales data for this period — sync Shopify or select a range with sales.
          </span>
        )}
      </div>

      {hasCogs && (
        <div className="card">
          <div className="card-title">Journal Lines Preview</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Account</th>
                  <th>Description</th>
                  <th className="text-right">Debit (DR)</th>
                  <th className="text-right">Credit (CR)</th>
                </tr>
              </thead>
              <tbody>
                {data.sku_breakdown.filter((s) => s.cogs > 0).map((row) => (
                  <React.Fragment key={row.sku}>
                    <tr>
                      <td className="text-muted">{journalDate}</td>
                      <td><span className="mono">5000</span> <span className="text-muted">— COGS</span></td>
                      <td style={{ fontSize: 12 }}>
                        COGS – {row.product_name} ({row.sku})<br />
                        <span className="text-muted">{mn(row.units_sold)} units @ {mc(_fmt(row.avg_unit_cost))}</span>
                      </td>
                      <td className="text-right" style={{ color: 'var(--red)' }}>{mc(_fmt(row.cogs))}</td>
                      <td className="text-right text-muted">—</td>
                    </tr>
                    <tr>
                      <td className="text-muted">{journalDate}</td>
                      <td><span className="mono">1500</span> <span className="text-muted">— Inventory</span></td>
                      <td style={{ fontSize: 12 }}>Inventory reduction – {row.product_name} ({row.sku})</td>
                      <td className="text-right text-muted">—</td>
                      <td className="text-right" style={{ color: 'var(--green)' }}>{mc(_fmt(row.cogs))}</td>
                    </tr>
                  </React.Fragment>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--border-light)', fontWeight: 700 }}>
                  <td colSpan={3} style={{ color: 'var(--text-muted)', fontSize: 12 }}>TOTAL</td>
                  <td className="text-right" style={{ color: 'var(--red)' }}>{mc(_fmt(data.total_cogs))}</td>
                  <td className="text-right" style={{ color: 'var(--green)' }}>{mc(_fmt(data.total_cogs))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      <div style={{ marginTop: 16, padding: '14px 16px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.8 }}>
        <strong style={{ color: 'var(--text)', fontSize: 13 }}>How to import into Xero:</strong>
        <ol style={{ paddingLeft: 18, marginTop: 8 }}>
          <li>In Xero, go to <strong>Accounting → Manual Journals</strong></li>
          <li>Click <strong>Import</strong> (top right)</li>
          <li>Upload the downloaded CSV file</li>
          <li>Review the journal, then click <strong>Post</strong></li>
          <li>Verify account codes 1500 (Inventory) and 5000 (COGS) match your chart of accounts</li>
        </ol>
      </div>
    </div>
  );
}
