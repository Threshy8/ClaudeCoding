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

const CATEGORY_COLOR  = { inbound: '#3b82f6', outbound: '#f59e0b', other: '#8b5cf6' };
const CATEGORY_LABEL  = { inbound: 'Inbound',  outbound: 'Outbound',  other: 'Other'  };
const COST_TYPE_COLOR = { variable: '#10b981', fixed: '#6b7280' };
const COST_TYPE_LABEL = { variable: 'Variable', fixed: 'Fixed' };

async function apiFetch(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export default function FulfillmentTab({ dateRange }) {
  const [view, setView] = useState('invoices'); // 'invoices' | 'costsheet'

  return (
    <div>
      {/* Sub-nav */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        {[['invoices', '📋 Invoices'], ['costsheet', '📊 Order Cost Sheet']].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setView(key)}
            style={{
              padding: '7px 18px',
              borderRadius: 8,
              border: view === key ? '1.5px solid var(--accent)' : '1.5px solid var(--border)',
              background: view === key ? 'var(--accent-dim)' : 'transparent',
              color: view === key ? 'var(--accent)' : 'var(--text-muted)',
              fontWeight: view === key ? 600 : 400,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {view === 'invoices'   && <InvoicesView   dateRange={dateRange} />}
      {view === 'costsheet'  && <CostSheetView  dateRange={dateRange} />}
    </div>
  );
}

// ─── Invoices View ────────────────────────────────────────────────────────────
function InvoicesView({ dateRange }) {
  const [invoices, setInvoices]         = useState([]);
  const [summary, setSummary]           = useState(null);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState(null);
  const [expandedId, setExpandedId]     = useState(null);
  const [lineItems, setLineItems]       = useState({});
  const [loadingLines, setLoadingLines] = useState(null);
  const [uploading, setUploading]       = useState(false);
  const [uploadError, setUploadError]   = useState(null);
  const [parsed, setParsed]             = useState(null);
  const [saving, setSaving]             = useState(false);
  const [invoiceSummary, setInvoiceSummary]   = useState(null);
  const [summaryLoading, setSummaryLoading]   = useState(false);
  const fileRef = useRef();

  const generateSummary = async (parsedData) => {
    setSummaryLoading(true); setInvoiceSummary(null);
    try {
      const data = await apiFetch('/api/fulfillment/summarise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsedData),
      });
      setInvoiceSummary(data.summary || '');
    } catch (e) { /* non-critical */ }
    finally { setSummaryLoading(false); }
  };

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams();
      if (dateRange?.start) params.set('start_date', dateRange.start);
      if (dateRange?.end)   params.set('end_date',   dateRange.end);
      const data = await apiFetch(`/api/fulfillment/summary?${params}`);
      setInvoices(data.invoices || []);
      setSummary(data.totals   || null);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
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
    setUploading(true); setUploadError(null); setParsed(null);
    try {
      const formData = new FormData();
      formData.append('pdf', file);
      const res = await fetch(`${BASE_URL}/api/fulfillment/parse-pdf`, { method: 'POST', body: formData });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || 'Parse failed'); }
      const result = await res.json();
      setParsed(result);
      generateSummary(result);
    } catch (err) { setUploadError(err.message); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiFetch('/api/fulfillment/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      setParsed(null); setInvoiceSummary(null); load();
    } catch (e) { setUploadError(e.message); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this invoice and all its line items?')) return;
    try {
      await apiFetch(`/api/fulfillment/invoices/${id}`, { method: 'DELETE' });
      setInvoices(prev => prev.filter(i => i.id !== id));
      if (expandedId === id) setExpandedId(null);
    } catch (e) { alert('Delete failed: ' + e.message); }
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
      {/* Summary cards — improved */}
      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
          {[
            { label: 'Total 3PL Cost', value: fmt(summary.total), sub: `Ex GST · ${dateRange?.label || 'Period'}`, color: 'var(--text-primary)', bg: 'var(--bg-card)' },
            { label: 'Fixed Costs', value: fmt(summary.fixed), sub: 'Storage, receiving, labour', color: COST_TYPE_COLOR.fixed, bg: `${COST_TYPE_COLOR.fixed}0f` },
            { label: 'Variable Costs', value: fmt(summary.variable), sub: 'Pick/pack, dispatch per order', color: COST_TYPE_COLOR.variable, bg: `${COST_TYPE_COLOR.variable}0f` },
            { label: 'Variable / Unit', value: summary.cost_per_unit > 0 ? fmt(summary.cost_per_unit) : '—', sub: summary.units_shipped > 0 ? `${summary.units_shipped} units shipped` : 'No units data', color: 'var(--text-primary)', bg: 'var(--bg-card)' },
          ].map(({ label, value, sub, color, bg }) => (
            <div key={label} style={{ background: bg, border: '1px solid var(--border)', borderRadius: 10, padding: '16px 18px' }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>{label}</div>
              <div style={{ fontSize: 22, fontWeight: 700, color, marginBottom: 4 }}>{value}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{sub}</div>
            </div>
          ))}
        </div>
      )}

      <div className="section-header">
        <div>
          <div className="section-title">3PL Invoices</div>
          {!loading && <div className="text-muted" style={{ fontSize: 12, marginTop: 2 }}>{invoices.length} invoice{invoices.length !== 1 ? 's' : ''} in period</div>}
        </div>
        <label className="btn btn-primary" style={{ cursor: 'pointer' }}>
          {uploading ? <><span className="spin">↻</span> Parsing PDF…</> : '+ Upload Invoice PDF'}
          <input ref={fileRef} type="file" accept="application/pdf" style={{ display: 'none' }} onChange={handleFileChange} disabled={uploading} />
        </label>
      </div>

      {uploadError && <div className="error-msg" style={{ marginBottom: 16 }}>{uploadError}</div>}
      {error       && <div className="error-msg">{error}</div>}

      {/* Parsed review panel */}
      {parsed && (
        <div className="card" style={{ marginBottom: 24, border: '1.5px solid var(--accent)', padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>Review Parsed Invoice</div>
              <div className="text-muted" style={{ fontSize: 13 }}>
                {parsed.period_description || 'No period'} · {fmtDate(parsed.invoice_date)}
                {parsed.invoice_ref   && ` · Ref: ${parsed.invoice_ref}`}
                {parsed.units_shipped && ` · ${parsed.units_shipped} units shipped`}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => { setParsed(null); setInvoiceSummary(null); }}>Discard</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save Invoice'}</button>
            </div>
          </div>

          {/* AI summary banner */}
          <div style={{
            background: 'var(--accent-dim)', border: '1px solid var(--accent)', borderRadius: 8,
            padding: '10px 14px', marginBottom: 16, display: 'flex', alignItems: 'flex-start', gap: 10,
          }}>
            <span style={{ fontSize: 16, marginTop: 1 }}>✦</span>
            <div style={{ fontSize: 13, color: 'var(--accent)', lineHeight: 1.5, fontWeight: 500 }}>
              {summaryLoading ? 'Generating summary…' : (invoiceSummary || '')}
            </div>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Description</th>
                  <th>Category</th>
                  <th>Cost Type</th>
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
                      <EditableSelect value={li.category} onChange={v => updateParsedLine(idx, 'category', v)}
                        options={[['inbound','Inbound'],['outbound','Outbound'],['other','Other']]}
                        color={CATEGORY_COLOR[li.category]} />
                    </td>
                    <td>
                      <EditableSelect value={li.cost_type} onChange={v => updateParsedLine(idx, 'cost_type', v)}
                        options={[['variable','Variable'],['fixed','Fixed']]}
                        color={COST_TYPE_COLOR[li.cost_type]} />
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
                  <td colSpan={5} style={{ fontWeight: 600, fontSize: 13, paddingTop: 10 }}>Total</td>
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

          {/* Category + type badges */}
          <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
            {[['inbound','inbound',CATEGORY_COLOR],['outbound','outbound',CATEGORY_COLOR],['variable','variable',COST_TYPE_COLOR],['fixed','fixed',COST_TYPE_COLOR]].map(([key, field, colorMap]) => {
              const total = parsed.line_items
                .filter(li => li.category === key || li.cost_type === key)
                .reduce((s, li) => s + (parseFloat(li.amount_ex_gst) || 0), 0);
              if (total === 0) return null;
              const label = CATEGORY_LABEL[key] || COST_TYPE_LABEL[key];
              const color = colorMap[key];
              return (
                <div key={key} style={{ padding: '5px 12px', borderRadius: 20, background: `${color}18`, border: `1px solid ${color}40`, fontSize: 12, color, fontWeight: 600 }}>
                  {label}: {fmt(total)}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Invoices table */}
      {loading ? <div className="loading">Loading invoices…</div> : (
        <div className="card">
          {invoices.length === 0 ? (
            <div className="empty">No invoices in this period. Upload a 3PL invoice PDF to get started.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Period / Reference</th>
                    <th className="text-right">Units</th>
                    <th className="text-right">Fixed</th>
                    <th className="text-right">Variable</th>
                    <th className="text-right">Total Ex GST</th>
                    <th className="text-right">Inc GST</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map(inv => (
                    <React.Fragment key={inv.id}>
                      <tr style={{ cursor: 'pointer' }} onClick={() => toggleExpand(inv.id)}>
                        <td className="text-muted">{fmtDate(inv.invoice_date)}</td>
                        <td>
                          <span style={{ fontWeight: 500 }}>{inv.period_description || '—'}</span>
                          {inv.invoice_ref && <span className="text-muted" style={{ fontSize: 12, marginLeft: 8 }}>{inv.invoice_ref}</span>}
                        </td>
                        <td className="text-right">{inv.units_shipped ?? '—'}</td>
                        <td className="text-right" style={{ color: COST_TYPE_COLOR.fixed }}>
                          <InvoiceCostTypTotal invoiceId={inv.id} lineItems={lineItems} costType="fixed" />
                        </td>
                        <td className="text-right" style={{ color: COST_TYPE_COLOR.variable }}>
                          <InvoiceCostTypTotal invoiceId={inv.id} lineItems={lineItems} costType="variable" />
                        </td>
                        <td className="text-right" style={{ fontWeight: 600 }}>{fmt(inv.total_ex_gst)}</td>
                        <td className="text-right text-muted">{fmt(inv.total_inc_gst)}</td>
                        <td onClick={e => e.stopPropagation()}>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button className="btn btn-ghost btn-sm" onClick={() => toggleExpand(inv.id)} style={{ fontSize: 12 }}>
                              {expandedId === inv.id ? '▲ Hide' : '▼ Lines'}
                            </button>
                            <button className="btn btn-danger btn-sm" onClick={() => handleDelete(inv.id)}>Delete</button>
                          </div>
                        </td>
                      </tr>
                      {expandedId === inv.id && (
                        <tr>
                          <td colSpan={8} style={{ padding: 0, background: 'var(--bg-subtle)' }}>
                            <div style={{ padding: '12px 20px' }}>
                              {loadingLines === inv.id
                                ? <div className="text-muted" style={{ fontSize: 13, padding: 8 }}>Loading…</div>
                                : <LineItemsTable items={lineItems[inv.id] || []} />}
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

// ─── Order Cost Sheet View ────────────────────────────────────────────────────
function CostSheetView({ dateRange }) {
  const [data, setData]             = useState(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [expandedOrder, setExpandedOrder] = useState(null);
  const [selectedLocation, setSelectedLocation] = useState('all');

  const load = useCallback(async (location) => {
    if (!dateRange?.start || !dateRange?.end) return;
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams({ start_date: dateRange.start, end_date: dateRange.end });
      if (location && location !== 'all') params.set('location', location);
      const res = await apiFetch(`/api/fulfillment/order-cost-sheet?${params}`);
      setData(res);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [dateRange]);

  useEffect(() => { load(selectedLocation); }, [load, selectedLocation]);

  const handleLocationChange = (loc) => {
    setSelectedLocation(loc);
    setExpandedOrder(null);
  };

  if (loading) return <div className="loading">Loading cost sheet…</div>;
  if (error)   return <div className="error-msg">{error}</div>;
  if (!data)   return null;

  const { fixed_costs, variable_costs, orders, grand_total_3pl, available_locations } = data;
  const noFulfillmentData = fixed_costs.total === 0 && variable_costs.total === 0;

  return (
    <div>
      {/* Location filter */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <span style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 500 }}>Filter by location:</span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {['all', ...(available_locations || [])].map(loc => (
            <button
              key={loc}
              onClick={() => handleLocationChange(loc)}
              style={{
                padding: '5px 14px',
                borderRadius: 20,
                border: selectedLocation === loc ? '1.5px solid var(--accent)' : '1.5px solid var(--border)',
                background: selectedLocation === loc ? 'var(--accent-dim)' : 'transparent',
                color: selectedLocation === loc ? 'var(--accent)' : 'var(--text-muted)',
                fontWeight: selectedLocation === loc ? 600 : 400,
                fontSize: 12,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {loc === 'all' ? 'All Locations' : loc}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 4 }}>
          {orders.length} order{orders.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Summary cards */}
      <div className="stats-grid" style={{ marginBottom: 24 }}>
        <div className="stat-card">
          <div className="stat-label">Grand Total 3PL</div>
          <div className="stat-value">{fmt(grand_total_3pl)}</div>
          <div className="stat-sub">{dateRange?.label || 'Period'} · Ex GST</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Fixed Costs (One-time)</div>
          <div className="stat-value" style={{ color: COST_TYPE_COLOR.fixed }}>{fmt(fixed_costs.total)}</div>
          <div className="stat-sub">Storage, receiving, freight</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Variable Cost / Unit</div>
          <div className="stat-value" style={{ color: COST_TYPE_COLOR.variable }}>
            {variable_costs.cost_per_unit > 0 ? fmt(variable_costs.cost_per_unit) : '—'}
          </div>
          <div className="stat-sub">
            {variable_costs.units_shipped > 0
              ? `${variable_costs.units_shipped} units · ${fmt(variable_costs.total)} total`
              : 'No invoice data'}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Orders Shown</div>
          <div className="stat-value">{orders.length}</div>
          <div className="stat-sub">
            {selectedLocation === 'all' ? 'All locations' : selectedLocation}
          </div>
        </div>
      </div>

      {noFulfillmentData && (
        <div className="card" style={{ marginBottom: 20, padding: '14px 20px', borderLeft: '3px solid var(--accent)', background: 'var(--accent-dim)' }}>
          <div style={{ fontSize: 13, color: 'var(--accent)', fontWeight: 500 }}>
            No 3PL invoices uploaded for this period — upload invoices in the Invoices tab to see cost allocations.
          </div>
        </div>
      )}

      {/* Fixed costs block */}
      {fixed_costs.line_items.length > 0 && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>Fixed / One-Time Costs</div>
                <div className="text-muted" style={{ fontSize: 12, marginTop: 2 }}>Period costs — not allocated per order</div>
              </div>
              <div style={{ fontWeight: 700, fontSize: 18, color: COST_TYPE_COLOR.fixed }}>{fmt(fixed_costs.total)}</div>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Description</th>
                  <th>Category</th>
                  <th className="text-right">Amount Ex GST</th>
                </tr>
              </thead>
              <tbody>
                {fixed_costs.line_items.map((li, i) => (
                  <tr key={i}>
                    <td style={{ fontSize: 13 }}>{li.description}</td>
                    <td>
                      <span style={{ fontSize: 11, fontWeight: 600, color: CATEGORY_COLOR[li.category], textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        {CATEGORY_LABEL[li.category] || li.category}
                      </span>
                    </td>
                    <td className="text-right" style={{ fontWeight: 500 }}>{fmt(li.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Orders table */}
      <div className="section-header" style={{ marginBottom: 12 }}>
        <div className="section-title">Per-Order Variable Cost Breakdown</div>
        {variable_costs.cost_per_unit > 0 && (
          <div className="text-muted" style={{ fontSize: 12 }}>
            {fmt(variable_costs.cost_per_unit)} per unit × order quantity
          </div>
        )}
      </div>

      <div className="card">
        {orders.length === 0 ? (
          <div className="empty">No orders found for the selected location and period.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Order #</th>
                  <th>Location</th>
                  <th>Items</th>
                  <th className="text-right">Units</th>
                  <th className="text-right">Revenue</th>
                  <th className="text-right">Variable 3PL Cost</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {orders.map(order => (
                  <React.Fragment key={order.shopify_order_id}>
                    <tr>
                      <td className="text-muted">{fmtDate(order.order_date)}</td>
                      <td><span className="mono" style={{ fontSize: 12 }}>#{order.shopify_order_id}</span></td>
                      <td>
                        <span style={{
                          fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10,
                          background: 'var(--bg-subtle)', color: 'var(--text-muted)',
                          whiteSpace: 'nowrap',
                        }}>
                          {order.fulfillment_location || '—'}
                        </span>
                      </td>
                      <td style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 200 }}>
                        {order.line_items.map(li => `${li.sku} ×${li.quantity}`).join(', ')}
                      </td>
                      <td className="text-right">{order.total_units}</td>
                      <td className="text-right">{fmt(order.total_revenue)}</td>
                      <td className="text-right" style={{ fontWeight: 600, color: variable_costs.cost_per_unit > 0 ? COST_TYPE_COLOR.variable : 'var(--text-muted)' }}>
                        {variable_costs.cost_per_unit > 0 ? fmt(order.variable_3pl_cost) : '—'}
                      </td>
                      <td>
                        <button
                          className="btn btn-ghost btn-sm"
                          style={{ fontSize: 11 }}
                          onClick={() => setExpandedOrder(expandedOrder === order.shopify_order_id ? null : order.shopify_order_id)}
                        >
                          {expandedOrder === order.shopify_order_id ? '▲' : '▼'}
                        </button>
                      </td>
                    </tr>
                    {expandedOrder === order.shopify_order_id && (
                      <tr>
                        <td colSpan={8} style={{ padding: 0, background: 'var(--bg-subtle)' }}>
                          <div style={{ padding: '10px 20px' }}>
                            <table style={{ fontSize: 12, width: '100%' }}>
                              <thead>
                                <tr>
                                  {['SKU', 'Product', 'Qty', '3PL Cost'].map((h, i) => (
                                    <th key={h} style={{ textAlign: i >= 2 ? 'right' : 'left', paddingBottom: 4, color: 'var(--text-muted)', fontWeight: 500 }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {order.line_items.map((li, i) => (
                                  <tr key={i}>
                                    <td style={{ padding: '3px 0' }}><span className="mono">{li.sku}</span></td>
                                    <td style={{ padding: '3px 0', color: 'var(--text-muted)' }}>{li.product_name}</td>
                                    <td style={{ padding: '3px 0', textAlign: 'right' }}>{li.quantity}</td>
                                    <td style={{ padding: '3px 0', textAlign: 'right', fontWeight: 500 }}>
                                      {variable_costs.cost_per_unit > 0 ? fmt(li.quantity * variable_costs.cost_per_unit) : '—'}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 700 }}>
                  <td colSpan={4} style={{ paddingTop: 10 }}>Total</td>
                  <td className="text-right" style={{ paddingTop: 10 }}>{orders.reduce((s, o) => s + o.total_units, 0)}</td>
                  <td className="text-right" style={{ paddingTop: 10 }}>{fmt(orders.reduce((s, o) => s + o.total_revenue, 0))}</td>
                  <td className="text-right" style={{ paddingTop: 10, color: COST_TYPE_COLOR.variable }}>
                    {fmt(orders.reduce((s, o) => s + o.variable_3pl_cost, 0))}
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function EditableSelect({ value, onChange, options, color }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        fontSize: 11, padding: '2px 6px', borderRadius: 4,
        border: '1px solid var(--border)', background: 'var(--bg-card)',
        color: color || 'inherit', fontWeight: 600, cursor: 'pointer',
      }}
    >
      {options.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
    </select>
  );
}

function InvoiceCostTypTotal({ invoiceId, lineItems, costType }) {
  const items = lineItems[invoiceId];
  if (!items) return <span className="text-muted" style={{ fontSize: 12 }}>—</span>;
  const total = items.filter(li => li.cost_type === costType).reduce((s, li) => s + parseFloat(li.amount_ex_gst || 0), 0);
  return <span>{total > 0 ? fmt(total) : '—'}</span>;
}

function LineItemsTable({ items }) {
  if (!items.length) return <div className="text-muted" style={{ fontSize: 13 }}>No line items.</div>;
  const grouped = { inbound: [], outbound: [], other: [] };
  for (const li of items) (grouped[li.category] || grouped.other).push(li);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {['inbound', 'outbound', 'other'].map(cat => {
        if (!grouped[cat].length) return null;
        const catTotal = grouped[cat].reduce((s, li) => s + parseFloat(li.amount_ex_gst || 0), 0);
        return (
          <div key={cat}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: CATEGORY_COLOR[cat], marginBottom: 6 }}>
              {CATEGORY_LABEL[cat]} — {fmt(catTotal)}
            </div>
            <table style={{ fontSize: 12, width: '100%' }}>
              <tbody>
                {grouped[cat].map((li, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '4px 8px 4px 0' }}>{li.description}</td>
                    <td style={{ padding: '4px 8px', width: 70 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: COST_TYPE_COLOR[li.cost_type], textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        {COST_TYPE_LABEL[li.cost_type] || li.cost_type}
                      </span>
                    </td>
                    <td style={{ padding: '4px 0', textAlign: 'right', color: 'var(--text-muted)', width: 60 }}>{li.quantity ?? ''}</td>
                    <td style={{ padding: '4px 0', textAlign: 'right', color: 'var(--text-muted)', width: 80 }}>{li.unit_rate ? fmt(li.unit_rate) : ''}</td>
                    <td style={{ padding: '4px 0 4px 16px', textAlign: 'right', fontWeight: 500, width: 90 }}>{fmt(li.amount_ex_gst)}</td>
                    <td style={{ padding: '4px 0 4px 8px', textAlign: 'right', color: 'var(--text-muted)', width: 70 }}>+{fmt(li.gst)} GST</td>
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
