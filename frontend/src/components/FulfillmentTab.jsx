import React, { useEffect, useState, useCallback, useRef } from 'react';

const BASE_URL = process.env.REACT_APP_API_URL || '';

function fmt(n) {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(n || 0);
}
function fmtDate(d) {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
}

const CATEGORY_LABEL = { inbound: 'Inbound', outbound: 'Outbound', other: 'Other' };
const CATEGORY_COLOR = { inbound: '#3b82f6', outbound: '#f59e0b', other: '#8b5cf6' };

async function apiFetch(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export default function FulfillmentTab({ dateRange }) {
  const [invoices, setInvoices]       = useState([]);
  const [summary, setSummary]         = useState(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [expandedId, setExpandedId]   = useState(null);
  const [lineItems, setLineItems]     = useState({});
  const [loadingLines, setLoadingLines] = useState(null);

  // Upload / parse state
  const [uploading, setUploading]     = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [parsed, setParsed]           = useState(null); // parsed invoice awaiting review
  const [saving, setSaving]           = useState(false);
  const fileRef = useRef();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (dateRange?.start) params.set('start_date', dateRange.start);
      if (dateRange?.end)   params.set('end_date',   dateRange.end);
      const data = await apiFetch(`/api/fulfillment/summary?${params}`);
      setInvoices(data.invoices || []);
      setSummary(data.totals || null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [dateRange]);

  useEffect(() => { load(); }, [load]);

  const toggleExpand = async (id) => {
    if (expandedId === id) { setExpandedId(null); return; }
    setExpandedId(id);
    if (!lineItems[id]) {
      setLoadingLines(id);
      try {
        const data = await apiFetch(`/api/fulfillment/invoices/${id}/line-items`);
        setLineItems(prev => ({ ...prev, [id]: data }));
      } catch (e) { /* ignore */ }
      finally { setLoadingLines(null); }
    }
  };

  const handleFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    setParsed(null);
    try {
      const formData = new FormData();
      formData.append('pdf', file);
      const res = await fetch(`${BASE_URL}/api/fulfillment/parse-pdf`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || 'Parse failed');
      }
      const data = await res.json();
      setParsed(data);
    } catch (err) {
      setUploadError(err.message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleSave = async () => {
    if (!parsed) return;
    setSaving(true);
    try {
      await apiFetch('/api/fulfillment/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      setParsed(null);
      load();
    } catch (e) {
      setUploadError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this invoice and all its line items?')) return;
    try {
      await apiFetch(`/api/fulfillment/invoices/${id}`, { method: 'DELETE' });
      setInvoices(prev => prev.filter(i => i.id !== id));
      if (expandedId === id) setExpandedId(null);
    } catch (e) {
      alert('Delete failed: ' + e.message);
    }
  };

  const updateParsedLine = (idx, field, value) => {
    setParsed(prev => {
      const items = [...prev.line_items];
      items[idx] = { ...items[idx], [field]: value };
      return { ...prev, line_items: items };
    });
  };

  return (
    <div>
      {/* Summary Cards */}
      {summary && (
        <div className="stats-grid" style={{ marginBottom: 24 }}>
          <div className="stat-card">
            <div className="stat-label">Total 3PL Cost</div>
            <div className="stat-value">{fmt(summary.total)}</div>
            <div className="stat-sub">Ex GST · {dateRange?.label || 'Period'}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Inbound (Receiving)</div>
            <div className="stat-value" style={{ color: CATEGORY_COLOR.inbound }}>{fmt(summary.inbound)}</div>
            <div className="stat-sub">Storage, put-away, receiving</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Outbound (Fulfilment)</div>
            <div className="stat-value" style={{ color: CATEGORY_COLOR.outbound }}>{fmt(summary.outbound)}</div>
            <div className="stat-sub">Pick/pack, dispatch, freight</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Cost Per Unit Shipped</div>
            <div className="stat-value">{summary.cost_per_unit > 0 ? fmt(summary.cost_per_unit) : '—'}</div>
            <div className="stat-sub">{summary.units_shipped > 0 ? `${summary.units_shipped} units shipped` : 'No units data'}</div>
          </div>
        </div>
      )}

      {/* Upload section */}
      <div className="section-header">
        <div>
          <div className="section-title">3PL Invoices</div>
          {!loading && (
            <div className="text-muted" style={{ fontSize: 12, marginTop: 2 }}>
              {invoices.length} invoice{invoices.length !== 1 ? 's' : ''} in period
            </div>
          )}
        </div>
        <label className="btn btn-primary" style={{ cursor: 'pointer' }}>
          {uploading ? <><span className="spin">↻</span> Parsing PDF…</> : '+ Upload Invoice PDF'}
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf"
            style={{ display: 'none' }}
            onChange={handleFileChange}
            disabled={uploading}
          />
        </label>
      </div>

      {uploadError && <div className="error-msg" style={{ marginBottom: 16 }}>{uploadError}</div>}
      {error && <div className="error-msg">{error}</div>}

      {/* Parsed invoice review panel */}
      {parsed && (
        <div className="card" style={{ marginBottom: 24, border: '1.5px solid var(--accent)', padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>
                Review Parsed Invoice
              </div>
              <div className="text-muted" style={{ fontSize: 13 }}>
                {parsed.period_description || 'No period description'} · {fmtDate(parsed.invoice_date)}
                {parsed.invoice_ref && ` · Ref: ${parsed.invoice_ref}`}
                {parsed.units_shipped && ` · ${parsed.units_shipped} units shipped`}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => setParsed(null)}>Discard</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save Invoice'}
              </button>
            </div>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Description</th>
                  <th>Category</th>
                  <th className="text-right">Qty</th>
                  <th className="text-right">Rate</th>
                  <th className="text-right">Ex GST</th>
                  <th className="text-right">GST</th>
                </tr>
              </thead>
              <tbody>
                {parsed.line_items.map((li, idx) => (
                  <tr key={idx}>
                    <td style={{ fontSize: 13 }}>{li.description}</td>
                    <td>
                      <select
                        value={li.category}
                        onChange={e => updateParsedLine(idx, 'category', e.target.value)}
                        style={{
                          fontSize: 12,
                          padding: '2px 6px',
                          borderRadius: 4,
                          border: '1px solid var(--border)',
                          background: 'var(--bg-card)',
                          color: CATEGORY_COLOR[li.category] || 'inherit',
                          fontWeight: 600,
                          cursor: 'pointer',
                        }}
                      >
                        <option value="inbound">Inbound</option>
                        <option value="outbound">Outbound</option>
                        <option value="other">Other</option>
                      </select>
                    </td>
                    <td className="text-right text-muted" style={{ fontSize: 13 }}>{li.quantity ?? '—'}</td>
                    <td className="text-right text-muted" style={{ fontSize: 13 }}>{li.unit_rate ? fmt(li.unit_rate) : '—'}</td>
                    <td className="text-right" style={{ fontSize: 13, fontWeight: 500 }}>{fmt(li.amount_ex_gst)}</td>
                    <td className="text-right text-muted" style={{ fontSize: 13 }}>{fmt(li.gst)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--border)' }}>
                  <td colSpan={4} style={{ fontWeight: 600, fontSize: 13, paddingTop: 10 }}>Total</td>
                  <td className="text-right" style={{ fontWeight: 700, fontSize: 14, paddingTop: 10 }}>
                    {fmt(parsed.line_items.reduce((s, li) => s + (parseFloat(li.amount_ex_gst) || 0), 0))}
                  </td>
                  <td className="text-right" style={{ fontWeight: 600, fontSize: 13, paddingTop: 10 }}>
                    {fmt(parsed.line_items.reduce((s, li) => s + (parseFloat(li.gst) || 0), 0))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Category breakdown preview */}
          <div style={{ display: 'flex', gap: 16, marginTop: 16, flexWrap: 'wrap' }}>
            {['inbound', 'outbound', 'other'].map(cat => {
              const total = parsed.line_items
                .filter(li => li.category === cat)
                .reduce((s, li) => s + (parseFloat(li.amount_ex_gst) || 0), 0);
              if (total === 0) return null;
              return (
                <div key={cat} style={{
                  padding: '6px 14px',
                  borderRadius: 20,
                  background: `${CATEGORY_COLOR[cat]}18`,
                  border: `1px solid ${CATEGORY_COLOR[cat]}40`,
                  fontSize: 13,
                  color: CATEGORY_COLOR[cat],
                  fontWeight: 600,
                }}>
                  {CATEGORY_LABEL[cat]}: {fmt(total)}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Invoices list */}
      {loading ? (
        <div className="loading">Loading invoices…</div>
      ) : (
        <div className="card">
          {invoices.length === 0 ? (
            <div className="empty">
              No invoices in this period. Upload a 3PL invoice PDF to get started.
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Period / Reference</th>
                    <th className="text-right">Units Shipped</th>
                    <th className="text-right">Inbound</th>
                    <th className="text-right">Outbound</th>
                    <th className="text-right">Total Ex GST</th>
                    <th className="text-right">Total Inc GST</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map(inv => (
                    <React.Fragment key={inv.id}>
                      <tr
                        style={{ cursor: 'pointer' }}
                        onClick={() => toggleExpand(inv.id)}
                      >
                        <td className="text-muted">{fmtDate(inv.invoice_date)}</td>
                        <td>
                          <span style={{ fontWeight: 500 }}>{inv.period_description || '—'}</span>
                          {inv.invoice_ref && (
                            <span className="text-muted" style={{ fontSize: 12, marginLeft: 8 }}>
                              {inv.invoice_ref}
                            </span>
                          )}
                        </td>
                        <td className="text-right">{inv.units_shipped ?? '—'}</td>
                        <td className="text-right" style={{ color: CATEGORY_COLOR.inbound }}>
                          {/* computed below via line items — show placeholder */}
                          <InvoiceCategoryTotal invoiceId={inv.id} lineItems={lineItems} category="inbound" />
                        </td>
                        <td className="text-right" style={{ color: CATEGORY_COLOR.outbound }}>
                          <InvoiceCategoryTotal invoiceId={inv.id} lineItems={lineItems} category="outbound" />
                        </td>
                        <td className="text-right" style={{ fontWeight: 600 }}>{fmt(inv.total_ex_gst)}</td>
                        <td className="text-right text-muted">{fmt(inv.total_inc_gst)}</td>
                        <td onClick={e => e.stopPropagation()}>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => toggleExpand(inv.id)}
                              style={{ fontSize: 12 }}
                            >
                              {expandedId === inv.id ? '▲ Hide' : '▼ Lines'}
                            </button>
                            <button
                              className="btn btn-danger btn-sm"
                              onClick={() => handleDelete(inv.id)}
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>

                      {/* Expanded line items */}
                      {expandedId === inv.id && (
                        <tr>
                          <td colSpan={8} style={{ padding: 0, background: 'var(--bg-subtle)' }}>
                            <div style={{ padding: '12px 20px' }}>
                              {loadingLines === inv.id ? (
                                <div className="text-muted" style={{ fontSize: 13, padding: 8 }}>Loading line items…</div>
                              ) : (
                                <LineItemsTable items={lineItems[inv.id] || []} />
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function InvoiceCategoryTotal({ invoiceId, lineItems, category }) {
  const items = lineItems[invoiceId];
  if (!items) return <span className="text-muted" style={{ fontSize: 12 }}>—</span>;
  const total = items
    .filter(li => li.category === category)
    .reduce((s, li) => s + parseFloat(li.amount_ex_gst || 0), 0);
  return <span>{total > 0 ? fmt(total) : '—'}</span>;
}

function LineItemsTable({ items }) {
  if (!items.length) return <div className="text-muted" style={{ fontSize: 13 }}>No line items.</div>;

  const grouped = { inbound: [], outbound: [], other: [] };
  for (const li of items) {
    (grouped[li.category] || grouped.other).push(li);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {['inbound', 'outbound', 'other'].map(cat => {
        if (!grouped[cat].length) return null;
        const catTotal = grouped[cat].reduce((s, li) => s + parseFloat(li.amount_ex_gst || 0), 0);
        return (
          <div key={cat}>
            <div style={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: CATEGORY_COLOR[cat],
              marginBottom: 6,
            }}>
              {CATEGORY_LABEL[cat]} — {fmt(catTotal)}
            </div>
            <table style={{ fontSize: 12, width: '100%' }}>
              <tbody>
                {grouped[cat].map((li, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '4px 8px 4px 0', color: 'var(--text)' }}>{li.description}</td>
                    <td style={{ padding: '4px 0', textAlign: 'right', color: 'var(--text-muted)', width: 60 }}>
                      {li.quantity ?? ''}
                    </td>
                    <td style={{ padding: '4px 0', textAlign: 'right', color: 'var(--text-muted)', width: 80 }}>
                      {li.unit_rate ? fmt(li.unit_rate) : ''}
                    </td>
                    <td style={{ padding: '4px 0 4px 16px', textAlign: 'right', fontWeight: 500, width: 90 }}>
                      {fmt(li.amount_ex_gst)}
                    </td>
                    <td style={{ padding: '4px 0 4px 8px', textAlign: 'right', color: 'var(--text-muted)', width: 70 }}>
                      +{fmt(li.gst)} GST
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
