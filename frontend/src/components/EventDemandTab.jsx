import React, { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { useDemoMask } from '../contexts/DemoModeContext';
import { apiFetch, formatCurrency as _fmt, fmtDate } from '../utils';
import DateRangePicker from './DateRangePicker';

// ── CSV parser ─────────────────────────────────────────────────────────────────

function parseCsvText(text) {
  const rawLines = text.split(/\r?\n/);
  if (rawLines.length < 2) return [];
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
  const headers = splitRow(rawLines[0]);
  const rows = [];
  for (let i = 1; i < rawLines.length; i++) {
    if (!rawLines[i].trim()) continue;
    const vals = splitRow(rawLines[i]);
    const row = {};
    headers.forEach((h, idx) => { row[h] = vals[idx] || ''; });
    rows.push(row);
  }
  return rows;
}

function parseShopifyOrdersCsv(text) {
  const rawRows = parseCsvText(text);
  if (rawRows.length === 0) throw new Error('No data rows found in CSV.');

  const keys = Object.keys(rawRows[0]);
  const findCol = (...aliases) =>
    keys.find(k => aliases.some(a => a.toLowerCase() === k.toLowerCase().trim()));

  const colName      = findCol('Name');
  const colLineName  = findCol('Lineitem name');
  const colLineSku   = findCol('Lineitem sku');
  const colLineQty   = findCol('Lineitem quantity');
  const colLinePrice = findCol('Lineitem price');
  const colShipping  = findCol('Shipping Method', 'Shipping method');
  const colVendor    = findCol('Vendor');

  if (!colLineName || !colLineQty) {
    throw new Error(
      `Missing required columns. Found: ${keys.join(', ')}. ` +
      `Need at minimum: "Lineitem name", "Lineitem quantity".`
    );
  }

  // Pass 1: map order name → shipping method.
  // Shopify only sets Name and Shipping Method on the first row of each order;
  // subsequent line-item rows leave those cells blank.
  const orderShippingMap = {};
  let curOrderP1 = null;
  for (const row of rawRows) {
    const rowName = row[colName]?.trim();
    if (rowName) {
      curOrderP1 = rowName;
      if (!(curOrderP1 in orderShippingMap)) {
        orderShippingMap[curOrderP1] = row[colShipping]?.trim() || '';
      }
    }
  }

  // Add-on/non-product line items to exclude from the product table.
  // Orders containing these still count toward order_count.
  const isAddOn = (name, sku, vendor) => {
    const v = (vendor || '').toLowerCase();
    const s = (sku    || '').toLowerCase();
    return (
      v === 're:do'                                     ||
      s === 'x-redo'                                    ||
      name.startsWith('FREE GIFT |')                    ||
      name === 'Item Personalization'                   ||
      name.includes('Extended Warranty')                ||
      name.includes('AusPost Shipping')                 ||
      name.includes('Additional charges for expedited') ||
      name.includes('Complimentary Gift')               ||
      name.includes('Free Unlimited Return')            ||
      name === 'Free Voyager Travel Case'
    );
  };

  // Pass 2: aggregate line items by (product_name, sku).
  const aggMap = new Map();
  const orderSet = new Set();
  let curOrder = null;

  for (const row of rawRows) {
    const rowName = row[colName]?.trim();
    if (rowName) {
      curOrder = rowName;
      orderSet.add(curOrder);
    }

    const productName = row[colLineName]?.trim();
    if (!productName) continue;

    const sku    = row[colLineSku]?.trim() || '';
    const vendor = colVendor ? row[colVendor]?.trim() || '' : '';
    if (isAddOn(productName, sku, vendor)) continue;


    const qty      = parseInt(row[colLineQty], 10) || 0;
    const price    = parseFloat(row[colLinePrice]) || 0;
    const shipping = curOrder ? (orderShippingMap[curOrder] || '') : '';
    const isExpress = /express/i.test(shipping);

    // Composite key: product_name + sku (blank sku = its own bucket within the name)
    const key = `${productName}\x00${sku}`;
    if (!aggMap.has(key)) {
      aggMap.set(key, {
        product_name: productName,
        sku:          sku || null,
        total_qty:    0,
        total_revenue: 0,
        standard_qty: 0,
        express_qty:  0,
      });
    }
    const entry = aggMap.get(key);
    entry.total_qty     += qty;
    entry.total_revenue  = Math.round((entry.total_revenue + qty * price) * 100) / 100;
    if (isExpress) entry.express_qty += qty;
    else           entry.standard_qty += qty;
  }

  return {
    lines:      [...aggMap.values()].sort((a, b) => b.total_qty - a.total_qty),
    orderCount: orderSet.size,
  };
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function EventDemandTab() {
  const [reports, setReports]       = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [data, setData]             = useState(null); // { report, lines, totals }
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [search, setSearch]         = useState('');
  const [uploading, setUploading]   = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const [label, setLabel]           = useState('');
  const [eventRange, setEventRange] = useState({ start: '', end: '', label: 'Custom' });
  const [deletingId, setDeletingId] = useState(null);
  const [editingReport, setEditingReport] = useState(null);
  const [editLabel, setEditLabel]   = useState('');
  const [editRange, setEditRange]   = useState({ start: '', end: '', label: 'Custom' });
  const [saving, setSaving]         = useState(false);
  const fileRef = useRef();
  const { mc, mn } = useDemoMask();

  const loadReportList = useCallback(async () => {
    const list = await apiFetch('/api/events/demand-reports');
    setReports(list);
    return list;
  }, []);

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this report? This cannot be undone.')) return;
    setDeletingId(id);
    try {
      await apiFetch(`/api/events/demand-reports/${id}`, { method: 'DELETE' });
      const list = await loadReportList();
      if (list.length > 0) setSelectedId(list[0].id);
      else { setSelectedId(null); setData(null); }
    } catch (err) {
      alert('Delete failed: ' + err.message);
    } finally {
      setDeletingId(null);
    }
  };

  const handleEditStart = (r) => {
    setEditingReport(r);
    setEditLabel(r.label);
    setEditRange({ start: r.event_start, end: r.event_end, label: 'Custom' });
  };

  const handleEditSave = async () => {
    if (!editLabel.trim() || !editRange.start || !editRange.end) return;
    setSaving(true);
    try {
      await apiFetch(`/api/events/demand-reports/${editingReport.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ label: editLabel.trim(), event_start: editRange.start, event_end: editRange.end }),
      });
      await loadReportList();
      setEditingReport(null);
      // Re-fetch detail so the subtitle and KPI header reflect updated label/dates
      const d = await apiFetch(`/api/events/demand-reports/${editingReport.id}`);
      setData(d);
    } catch (err) {
      alert('Save failed: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  // Initial mount: load report list, auto-select newest
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadReportList()
      .then(list => {
        if (cancelled) return;
        if (list.length > 0) setSelectedId(list[0].id);
        else { setData(null); setLoading(false); }
      })
      .catch(e => { if (!cancelled) { setError(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [loadReportList]);

  // When selection changes, fetch that report's detail
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setLoading(true);
    apiFetch(`/api/events/demand-reports/${selectedId}`)
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selectedId]);

  const handleUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!label.trim()) {
      setUploadResult({ type: 'error', text: 'Enter an event label first (e.g. "Fathers Day 2025").' });
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    if (!eventRange.start || !eventRange.end) {
      setUploadResult({ type: 'error', text: 'Set the event date range before uploading.' });
      if (fileRef.current) fileRef.current.value = '';
      return;
    }

    setUploading(true);
    setUploadResult(null);
    try {
      const text = await file.text();
      const { lines, orderCount } = parseShopifyOrdersCsv(text);
      if (lines.length === 0) throw new Error('No product lines found after parsing.');

      const created = await apiFetch('/api/events/demand-reports', {
        method: 'POST',
        body: JSON.stringify({
          label:       label.trim(),
          event_start: eventRange.start,
          event_end:   eventRange.end,
          order_count: orderCount,
          lines,
        }),
      });

      setUploadResult({
        type: 'success',
        text: `Report saved: ${lines.length} products across ${orderCount} orders.`,
      });
      await loadReportList();
      setSelectedId(created.report.id);
    } catch (err) {
      setUploadResult({ type: 'error', text: err.message });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const filtered = useMemo(() => {
    if (!data?.lines) return [];
    if (!search.trim()) return data.lines;
    const q = search.toLowerCase();
    return data.lines.filter(l =>
      l.product_name.toLowerCase().includes(q) ||
      (l.sku || '').toLowerCase().includes(q)
    );
  }, [data, search]);

  const filteredTotals = useMemo(() => ({
    total_units:    filtered.reduce((s, l) => s + (l.total_qty    || 0), 0),
    total_standard: filtered.reduce((s, l) => s + (l.standard_qty || 0), 0),
    total_express:  filtered.reduce((s, l) => s + (l.express_qty  || 0), 0),
    total_revenue:  filtered.reduce((s, l) => s + parseFloat(l.total_revenue || 0), 0),
  }), [filtered]);

  const renderHeader = () => (
    <div style={{
      display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end',
      justifyContent: 'space-between', gap: 12, marginBottom: 12,
    }}>
      {/* Report selector + edit/delete */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <label style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, flexShrink: 0 }}>Report:</label>
        <select
          value={selectedId || ''}
          onChange={e => setSelectedId(e.target.value)}
          disabled={reports.length === 0}
          style={{
            padding: '6px 10px', borderRadius: 'var(--radius)',
            border: '1px solid var(--border)', background: 'var(--bg-card)',
            color: 'var(--text)', fontSize: 13, minWidth: 260,
          }}
        >
          {reports.length === 0 && <option value="">No reports yet</option>}
          {reports.map(r => (
            <option key={r.id} value={r.id}>
              {r.label} ({fmtDate(r.event_start)} – {fmtDate(r.event_end)})
            </option>
          ))}
        </select>
        {selectedId && (
          <>
            <button
              onClick={() => { const r = reports.find(r => r.id === selectedId); if (r) handleEditStart(r); }}
              title="Edit report"
              style={{
                background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13, padding: '5px 9px',
                lineHeight: 1,
              }}
            >✎</button>
            <button
              onClick={() => handleDelete(selectedId)}
              disabled={deletingId === selectedId}
              title="Delete report"
              style={{
                background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                color: deletingId === selectedId ? 'var(--text-dim)' : 'var(--red, #dc2626)',
                cursor: deletingId === selectedId ? 'not-allowed' : 'pointer',
                fontSize: 13, padding: '5px 9px', lineHeight: 1,
              }}
            >{deletingId === selectedId ? '…' : '🗑'}</button>
          </>
        )}
      </div>

      {/* Upload form */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>Event Label</label>
          <input
            type="text"
            placeholder='e.g. Fathers Day 2025'
            value={label}
            onChange={e => setLabel(e.target.value)}
            disabled={uploading}
            style={{
              padding: '6px 10px', borderRadius: 'var(--radius)',
              border: '1px solid var(--border)', background: 'var(--bg-card)',
              color: 'var(--text)', fontSize: 13, width: 190,
            }}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>Event Date Range</label>
          <DateRangePicker value={eventRange} onChange={setEventRange} />
        </div>
        <label
          className="btn btn-primary"
          style={{ cursor: uploading ? 'not-allowed' : 'pointer', alignSelf: 'flex-end' }}
        >
          {uploading ? 'Importing…' : '+ Upload Orders CSV'}
          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            style={{ display: 'none' }}
            onChange={handleUpload}
            disabled={uploading}
          />
        </label>
      </div>
    </div>
  );

  if (error) return <div className="error-msg">{error}</div>;
  if (loading && reports.length === 0) return <div className="loading">Loading demand reports…</div>;

  const renderEditCard = () => editingReport && (
    <div className="card" style={{ marginBottom: 12, padding: '14px 20px' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 10 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>Label</label>
          <input
            type="text"
            value={editLabel}
            onChange={e => setEditLabel(e.target.value)}
            style={{
              padding: '6px 10px', borderRadius: 'var(--radius)',
              border: '1px solid var(--border)', background: 'var(--bg-card)',
              color: 'var(--text)', fontSize: 13, width: 210,
            }}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>Date Range</label>
          <DateRangePicker value={editRange} onChange={setEditRange} />
        </div>
        <button
          className="btn btn-primary"
          onClick={handleEditSave}
          disabled={saving || !editLabel.trim() || !editRange.start || !editRange.end}
          style={{ alignSelf: 'flex-end' }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          className="btn"
          onClick={() => setEditingReport(null)}
          disabled={saving}
          style={{ alignSelf: 'flex-end' }}
        >
          Cancel
        </button>
      </div>
    </div>
  );

  // Empty state
  if (reports.length === 0) {
    return (
      <div>
        {renderHeader()}
        {uploadResult && (
          <div className={`sync-banner ${uploadResult.type}`} style={{ borderRadius: 'var(--radius)', marginBottom: 16 }}>
            <span>{uploadResult.text}</span>
            <button className="banner-close" onClick={() => setUploadResult(null)}>✕</button>
          </div>
        )}
        <div className="card" style={{ padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 14, color: 'var(--text-muted)' }}>
            No event demand reports yet. Enter a label, set the date range, then upload a Shopify orders export CSV.
          </div>
        </div>
      </div>
    );
  }

  const { report, totals } = data || {};

  const displayTotals = search.trim() ? filteredTotals : (totals || filteredTotals);

  return (
    <div>
      {renderHeader()}
      {renderEditCard()}

      {uploadResult && (
        <div className={`sync-banner ${uploadResult.type}`} style={{ borderRadius: 'var(--radius)', marginBottom: 16 }}>
          <span>{uploadResult.text}</span>
          <button className="banner-close" onClick={() => setUploadResult(null)}>✕</button>
        </div>
      )}

      {report && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          <strong>{report.label}</strong>
          {' — '}{fmtDate(report.event_start)} to {fmtDate(report.event_end)}
          {report.order_count != null && ` · ${mn(report.order_count)} orders`}
        </div>
      )}

      {/* KPI Cards */}
      <div className="kpi-grid" style={{ marginBottom: 24 }}>
        {[
          { label: 'Orders',     value: mn(report?.order_count ?? 0) },
          { label: 'Units Sold', value: mn(displayTotals.total_units) },
          { label: 'Standard',   value: mn(displayTotals.total_standard) },
          { label: 'Express',    value: mn(displayTotals.total_express) },
          { label: 'Revenue',    value: mc(_fmt(displayTotals.total_revenue)), cls: 'green' },
        ].map(c => (
          <div key={c.label} className="kpi-card">
            <div className="kpi-label">{c.label}</div>
            <div className={`kpi-value ${c.cls || ''}`}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* Search */}
      <div className="card" style={{ marginBottom: 20, padding: '14px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ color: 'var(--text-dim)', fontSize: 16, flexShrink: 0 }}>⌕</span>
          <input
            type="text"
            placeholder="Search by product name or SKU…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              flex: 1, border: 'none', background: 'transparent',
              padding: '4px 0', fontSize: 13, color: 'var(--text)', outline: 'none',
            }}
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14, padding: '2px 6px' }}
            >✕</button>
          )}
          <span style={{ fontSize: 11, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
            {filtered.length} product{filtered.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {/* Product demand table */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '18px 24px 0' }}>
          <div className="card-title" style={{ marginBottom: 14 }}>Product Demand</div>
        </div>

        {loading ? (
          <div className="loading" style={{ padding: 24 }}>Loading report…</div>
        ) : filtered.length === 0 ? (
          <div className="empty">No products match your search.</div>
        ) : (
          <div className="table-wrap">
            <table style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ paddingLeft: 24 }}>Product</th>
                  <th>SKU</th>
                  <th className="text-right">Total Qty</th>
                  <th className="text-right">Standard</th>
                  <th className="text-right">Express</th>
                  <th className="text-right">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((line, i) => (
                  <tr
                    key={`${line.product_name}\x00${line.sku || ''}\x00${i}`}
                    style={{ background: i % 2 === 0 ? 'var(--bg-card)' : 'var(--bg-alt)' }}
                  >
                    <td style={{ paddingLeft: 24, fontWeight: 500, fontSize: 13 }}>
                      {line.product_name}
                    </td>
                    <td className="mono" style={{ color: 'var(--text-muted)' }}>
                      {line.sku || '—'}
                    </td>
                    <td className="text-right" style={{ fontWeight: 700 }}>
                      {mn(line.total_qty)}
                    </td>
                    <td className="text-right" style={{ color: 'var(--text-body)' }}>
                      {mn(line.standard_qty)}
                    </td>
                    <td className="text-right" style={{ color: 'var(--text-body)' }}>
                      {mn(line.express_qty)}
                    </td>
                    <td className="text-right" style={{ fontWeight: 600, color: 'var(--green)' }}>
                      {mc(_fmt(line.total_revenue))}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td style={{ paddingLeft: 24, fontWeight: 700, color: 'var(--text-muted)', fontSize: 12 }}>
                    TOTAL ({filtered.length} product{filtered.length !== 1 ? 's' : ''})
                  </td>
                  <td></td>
                  <td className="text-right" style={{ fontWeight: 700 }}>{mn(filteredTotals.total_units)}</td>
                  <td className="text-right" style={{ fontWeight: 700 }}>{mn(filteredTotals.total_standard)}</td>
                  <td className="text-right" style={{ fontWeight: 700 }}>{mn(filteredTotals.total_express)}</td>
                  <td className="text-right" style={{ fontWeight: 700, color: 'var(--green)' }}>
                    {mc(_fmt(filteredTotals.total_revenue))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
