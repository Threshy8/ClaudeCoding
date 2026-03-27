import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useDemoMask } from '../contexts/DemoModeContext';
import { BASE_URL, apiFetch, formatCurrency as _fmt, fmtDate } from '../utils';

const CATEGORY_COLOR  = { inbound: '#3b82f6', outbound: '#f59e0b', delivery: '#06b6d4', packaging: '#64748b', other: '#8b5cf6' };
const CATEGORY_LABEL  = { inbound: 'Inbound',  outbound: 'Outbound', delivery: 'Delivery', packaging: 'Packaging', other: 'Other'  };
const SUPPLIER_COLOR  = { scc: '#d97706', packaging: '#64748b' };
const SUPPLIER_LABEL  = { scc: 'SCC', packaging: 'PACKAGING' };
const COST_TYPE_COLOR = { variable: '#10b981', fixed: '#6b7280' };
const COST_TYPE_LABEL = { variable: 'Variable', fixed: 'Fixed' };

export default function FulfillmentTab({ dateRange }) {
  const [view, setView] = useState('invoices'); // 'invoices' | 'costsheet' | 'auspost' | 'pkgmap'

  return (
    <div>
      {/* Sub-nav */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        {[['invoices', 'Invoices'], ['costsheet', 'Order Cost Sheet'], ['auspost', 'Australia Post'], ['pkgmap', 'Packaging SKU Map']].map(([key, label]) => (
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
      {view === 'auspost'    && <AusPostView    dateRange={dateRange} />}
      {view === 'pkgmap'     && <PackagingSkuMapView />}
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
  const [matchedOrders, setMatchedOrders] = useState({});
  const [loadingOrders, setLoadingOrders] = useState(null);
  const [uploading, setUploading]       = useState(false);
  const [uploadError, setUploadError]   = useState(null);
  const [parsed, setParsed]             = useState(null);
  const [saving, setSaving]             = useState(false);
  const [invoiceSummary, setInvoiceSummary]   = useState(null);
  const [summaryLoading, setSummaryLoading]   = useState(false);
  const [activeTab, setActiveTab]             = useState(0);
  const fileRef = useRef();
  const { mc, mn } = useDemoMask();

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
    if (!matchedOrders[id]) {
      setLoadingOrders(id);
      try {
        const data = await apiFetch(`/api/fulfillment/invoices/${id}/matched-orders`);
        setMatchedOrders(prev => ({ ...prev, [id]: data }));
      } catch (e) { /* ignore */ }
      finally { setLoadingOrders(null); }
    }
  };

  const handleFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true); setUploadError(null); setParsed(null); setActiveTab(0);
    try {
      const formData = new FormData();
      formData.append('pdf', file);
      const res = await fetch(`${BASE_URL}/api/fulfillment/parse-pdf`, { method: 'POST', body: formData });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || 'Parse failed'); }
      const result = await res.json();
      if (!result?.invoices?.length) {
        throw new Error('No invoices could be extracted from this PDF');
      }
      for (const inv of result.invoices) {
        if (!Array.isArray(inv.line_items) || inv.line_items.length === 0) {
          throw new Error(`Invoice ${inv.invoice_ref || 'unknown'} has no line items`);
        }
      }
      setParsed(result);
      if (result.invoices.length === 1) generateSummary(result.invoices[0]);
    } catch (err) { setUploadError(err.message); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const handleSaveOne = async (invIdx) => {
    setSaving(true); setUploadError(null);
    try {
      await apiFetch('/api/fulfillment/invoices', {
        method: 'POST',
        body: JSON.stringify({ ...parsed.invoices[invIdx], pdf_path: parsed.pdf_path || null }),
      });
      const remaining = parsed.invoices.filter((_, i) => i !== invIdx);
      if (remaining.length === 0) {
        setParsed(null); setInvoiceSummary(null); setActiveTab(0);
      } else {
        setParsed({ ...parsed, invoices: remaining });
        setActiveTab(Math.min(activeTab, remaining.length - 1));
      }
      load();
    } catch (e) { setUploadError(e.message); }
    finally { setSaving(false); }
  };

  const handleSaveAll = async () => {
    setSaving(true); setUploadError(null);
    console.log('[SaveAll] Starting. Invoice count:', parsed.invoices.length);
    console.log('[SaveAll] Invoice refs:', parsed.invoices.map((inv, i) => `[${i}] ref=${inv.invoice_ref} date=${inv.invoice_date} lines=${inv.line_items?.length}`));
    try {
      for (let i = 0; i < parsed.invoices.length; i++) {
        const inv = parsed.invoices[i];
        console.log(`[SaveAll] Saving invoice ${i}/${parsed.invoices.length}: ref=${inv.invoice_ref}, date=${inv.invoice_date}, line_items=${inv.line_items?.length}, due_date=${inv.due_date}`);
        console.log(`[SaveAll] Invoice ${i} full payload:`, JSON.stringify(inv).slice(0, 500));
        try {
          await apiFetch('/api/fulfillment/invoices', {
            method: 'POST',
            body: JSON.stringify({ ...inv, pdf_path: parsed.pdf_path || null }),
          });
          console.log(`[SaveAll] Invoice ${i} (${inv.invoice_ref}) saved OK`);
        } catch (innerErr) {
          console.error(`[SaveAll] Invoice ${i} (${inv.invoice_ref}) FAILED:`, innerErr.message);
          throw innerErr;
        }
      }
      console.log('[SaveAll] All done, clearing state');
      setParsed(null); setInvoiceSummary(null); setActiveTab(0);
      load();
    } catch (e) { console.error('[SaveAll] Aborted with error:', e.message); setUploadError(e.message); }
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

  const updateParsedLine = (invIdx, lineIdx, field, value) => {
    setParsed(prev => {
      if (!prev?.invoices?.[invIdx]?.line_items) return prev;
      const invoices = prev.invoices.map((inv, i) => {
        if (i !== invIdx) return inv;
        const items = [...inv.line_items];
        items[lineIdx] = { ...items[lineIdx], [field]: value };
        return { ...inv, line_items: items };
      });
      return { ...prev, invoices };
    });
  };

  const updateParsedInvoice = (invIdx, field, value) => {
    setParsed(prev => {
      if (!prev?.invoices?.[invIdx]) return prev;
      const invoices = prev.invoices.map((inv, i) =>
        i === invIdx ? { ...inv, [field]: value } : inv
      );
      return { ...prev, invoices };
    });
  };

  return (
    <div>
      {/* Summary cards — improved */}
      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
          {[
            { label: 'Total 3PL Cost', value: mc(_fmt(summary.total)), sub: `${mc(_fmt(Math.round(summary.total * 110) / 100))} inc GST · ${dateRange?.label || 'Period'}`, color: 'var(--text-primary)', bg: 'var(--bg-card)' },
            { label: 'Fixed Costs', value: mc(_fmt(summary.fixed)), sub: summary.packaging > 0 ? `Incl. ${mc(_fmt(summary.packaging))} packaging` : 'Storage, receiving, labour', color: COST_TYPE_COLOR.fixed, bg: `${COST_TYPE_COLOR.fixed}0f` },
            { label: 'Variable Costs', value: mc(_fmt(summary.variable)), sub: 'Pick/pack, dispatch per order', color: COST_TYPE_COLOR.variable, bg: `${COST_TYPE_COLOR.variable}0f` },
            { label: 'Variable / Unit', value: summary.cost_per_unit > 0 ? mc(_fmt(summary.cost_per_unit)) : '—', sub: summary.units_shipped > 0 ? `${mn(summary.units_shipped)} units shipped` : 'No units data', color: 'var(--text-primary)', bg: 'var(--bg-card)' },
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
      {parsed && parsed.invoices && (
        <div className="card" style={{ marginBottom: 24, border: '1.5px solid var(--accent)', padding: 20 }}>
          {/* Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>
                Review Parsed Invoice{parsed.invoices.length > 1 ? 's' : ''}
                {parsed.invoices.length > 1 && <span className="text-muted" style={{ fontWeight: 400, marginLeft: 8 }}>({parsed.invoices.length} invoices)</span>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => { setParsed(null); setInvoiceSummary(null); setActiveTab(0); }}>Discard All</button>
              {parsed.invoices.length > 1 && (
                <button className="btn btn-primary" onClick={handleSaveAll} disabled={saving}>
                  {saving ? 'Saving…' : `Save All (${parsed.invoices.length})`}
                </button>
              )}
            </div>
          </div>

          {/* AI summary (single invoice only) */}
          {parsed.invoices.length === 1 && (invoiceSummary || summaryLoading) && (
            <div style={{
              background: 'var(--accent-dim)', border: '1px solid var(--accent)', borderRadius: 8,
              padding: '10px 14px', marginBottom: 16, display: 'flex', alignItems: 'flex-start', gap: 10,
            }}>
              <span style={{ fontSize: 16, marginTop: 1 }}>✦</span>
              <div style={{ fontSize: 13, color: 'var(--accent)', lineHeight: 1.5, fontWeight: 500 }}>
                {summaryLoading ? 'Generating summary…' : (invoiceSummary || '')}
              </div>
            </div>
          )}

          {/* Tabs (multi-invoice) */}
          {parsed.invoices.length > 1 && (
            <div style={{ display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap' }}>
              {parsed.invoices.map((inv, idx) => (
                <button
                  key={idx}
                  onClick={() => setActiveTab(idx)}
                  style={{
                    padding: '6px 14px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
                    fontWeight: activeTab === idx ? 600 : 400,
                    border: activeTab === idx ? '1.5px solid var(--accent)' : '1.5px solid var(--border)',
                    background: activeTab === idx ? 'var(--accent-dim)' : 'transparent',
                    color: activeTab === idx ? 'var(--accent)' : 'var(--text-muted)',
                  }}
                >
                  {inv.invoice_ref || `Invoice ${idx + 1}`}
                  {inv.invoice_date && ` · ${fmtDate(inv.invoice_date)}`}
                </button>
              ))}
            </div>
          )}

          {/* Active invoice content */}
          {(() => {
            const inv = parsed.invoices[activeTab];
            if (!inv) return null;
            return (
              <div>
                {/* Invoice meta + due date + save */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
                  <div className="text-muted" style={{ fontSize: 13 }}>
                    {inv.period_description || 'No period'} · {fmtDate(inv.invoice_date)}
                    {inv.invoice_ref && ` · Ref: ${inv.invoice_ref}`}
                    {inv.units_shipped != null && inv.units_shipped > 0 && ` · ${mn(inv.units_shipped)} units shipped`}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <label style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>Supplier:</label>
                      <select
                        value={inv.supplier || 'scc'}
                        onChange={e => updateParsedInvoice(activeTab, 'supplier', e.target.value)}
                        style={{
                          fontSize: 12, padding: '4px 8px', borderRadius: 6,
                          border: '1px solid var(--border)', background: 'var(--bg-card)',
                          color: 'var(--text-primary)',
                        }}
                      >
                        <option value="scc">SCC</option>
                        <option value="packaging">Packaging</option>
                      </select>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <label style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>Due:</label>
                      <input
                        type="date"
                        value={inv.due_date || ''}
                        onChange={e => updateParsedInvoice(activeTab, 'due_date', e.target.value || null)}
                        style={{
                          fontSize: 12, padding: '4px 8px', borderRadius: 6,
                          border: '1px solid var(--border)', background: 'var(--bg-card)',
                          color: 'var(--text-primary)',
                        }}
                      />
                    </div>
                    <button className="btn btn-primary btn-sm" onClick={() => handleSaveOne(activeTab)} disabled={saving}>
                      {saving ? 'Saving…' : `Save ${inv.invoice_ref || 'Invoice'}`}
                    </button>
                  </div>
                </div>

                {/* Line items table */}
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Description</th>
                        <th>Category</th>
                        <th>Cost Type</th>
                        <th>Variable Type</th>
                        <th className="text-right">Qty</th>
                        <th className="text-right">Rate</th>
                        <th className="text-right">Ex GST</th>
                        <th className="text-right">GST</th>
                        <th>SKU Mapping</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(inv.line_items || []).map((li, idx) => (
                        <tr key={idx}>
                          <td style={{ fontSize: 13 }}>
                            {li.description}
                            {li.category === 'packaging' && li.matched_skus?.length > 0 && (
                              <div style={{ fontSize: 10, color: '#64748b', marginTop: 3, fontWeight: 500 }}>
                                Used for: {li.matched_box || li.matched_skus.join(', ')}
                              </div>
                            )}
                          </td>
                          <td>
                            <EditableSelect value={li.category} onChange={v => updateParsedLine(activeTab, idx, 'category', v)}
                              options={[['inbound','Inbound'],['outbound','Outbound'],['delivery','Delivery'],['packaging','Packaging'],['other','Other']]}
                              color={CATEGORY_COLOR[li.category]} />
                          </td>
                          <td>
                            <EditableSelect value={li.cost_type} onChange={v => updateParsedLine(activeTab, idx, 'cost_type', v)}
                              options={[['variable','Variable'],['fixed','Fixed']]}
                              color={COST_TYPE_COLOR[li.cost_type]} />
                          </td>
                          <td>
                            {li.cost_type === 'variable' ? (
                              <EditableSelect
                                value={li.variable_type || 'per_unit'}
                                onChange={v => updateParsedLine(activeTab, idx, 'variable_type', v)}
                                options={[['per_order','Per Order'],['per_unit','Per Unit']]}
                                color={li.variable_type === 'per_order' ? '#f59e0b' : '#8b5cf6'} />
                            ) : (
                              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>—</span>
                            )}
                          </td>
                          <td className="text-right text-muted" style={{ fontSize: 13 }}>{mn(li.quantity ?? '—')}</td>
                          <td className="text-right text-muted" style={{ fontSize: 13 }}>{li.unit_rate ? mc(_fmt(li.unit_rate)) : '—'}</td>
                          <td className="text-right" style={{ fontSize: 13, fontWeight: 500 }}>{mc(_fmt(li.amount_ex_gst))}</td>
                          <td className="text-right text-muted" style={{ fontSize: 13 }}>{mc(_fmt(li.gst))}</td>
                          <td>
                            <input
                              type="text"
                              value={li.sku_mapping || ''}
                              onChange={e => updateParsedLine(activeTab, idx, 'sku_mapping', e.target.value || null)}
                              placeholder="e.g. Carina, Cyclops"
                              style={{
                                fontSize: 11, padding: '3px 6px', borderRadius: 4, width: 120,
                                border: '1px solid var(--border)', background: 'var(--bg-card)',
                                color: 'var(--text-primary)',
                              }}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ borderTop: '2px solid var(--border)' }}>
                        <td colSpan={6} style={{ fontWeight: 600, fontSize: 13, paddingTop: 10 }}>Total</td>
                        <td className="text-right" style={{ fontWeight: 700, fontSize: 14, paddingTop: 10 }}>
                          {mc(_fmt((inv.line_items || []).reduce((s, li) => s + (parseFloat(li.amount_ex_gst) || 0), 0)))}
                        </td>
                        <td className="text-right" style={{ fontWeight: 600, fontSize: 13, paddingTop: 10 }}>
                          {mc(_fmt((inv.line_items || []).reduce((s, li) => s + (parseFloat(li.gst) || 0), 0)))}
                        </td>
                        <td></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>

                {/* Category + type badges */}
                <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
                  {[['inbound','inbound',CATEGORY_COLOR],['outbound','outbound',CATEGORY_COLOR],['delivery','delivery',CATEGORY_COLOR],['packaging','packaging',CATEGORY_COLOR],['variable','variable',COST_TYPE_COLOR],['fixed','fixed',COST_TYPE_COLOR]].map(([key, field, colorMap]) => {
                    const total = (inv.line_items || [])
                      .filter(li => li.category === key || li.cost_type === key)
                      .reduce((s, li) => s + (parseFloat(li.amount_ex_gst) || 0), 0);
                    if (total === 0) return null;
                    const label = CATEGORY_LABEL[key] || COST_TYPE_LABEL[key];
                    const color = colorMap[key];
                    return (
                      <div key={key} style={{ padding: '5px 12px', borderRadius: 20, background: `${color}18`, border: `1px solid ${color}40`, fontSize: 12, color, fontWeight: 600 }}>
                        {label}: {mc(_fmt(total))}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}
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
                    <th>Payment</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map(inv => (
                    <React.Fragment key={inv.id}>
                      <tr style={{ cursor: 'pointer' }} onClick={() => toggleExpand(inv.id)}>
                        <td className="text-muted">{fmtDate(inv.invoice_date)}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {(() => {
                            const sup = inv.supplier || 'scc';
                            const supColor = SUPPLIER_COLOR[sup] || SUPPLIER_COLOR.scc;
                            const supLabel = SUPPLIER_LABEL[sup] || sup.toUpperCase();
                            return (
                              <span style={{ display: 'inline-block', padding: '2px 7px', borderRadius: 4, background: `${supColor}18`, color: supColor, fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', marginRight: 8, verticalAlign: 'middle' }}>
                                {supLabel}
                              </span>
                            );
                          })()}
                          <span style={{ fontWeight: 500 }}>{inv.period_description || '—'}</span>
                          {inv.invoice_ref && <span className="text-muted" style={{ fontSize: 12, marginLeft: 8 }}>{inv.invoice_ref}</span>}
                        </td>
                        <td className="text-right">{mn(inv.units_shipped ?? '—')}</td>
                        <td className="text-right" style={{ color: COST_TYPE_COLOR.fixed }}>
                          {inv.fixed_total > 0 ? mc(_fmt(inv.fixed_total)) : '—'}
                        </td>
                        <td className="text-right" style={{ color: COST_TYPE_COLOR.variable }}>
                          {inv.variable_total > 0 ? mc(_fmt(inv.variable_total)) : '—'}
                        </td>
                        <td className="text-right" style={{ fontWeight: 600 }}>{mc(_fmt(inv.total_ex_gst))}</td>
                        <td className="text-right text-muted">{mc(_fmt(inv.total_inc_gst))}</td>
                        <td onClick={e => e.stopPropagation()}>
                          <PaymentStatusCell inv={inv} onUpdate={(updated) => {
                            setInvoices(prev => prev.map(i => i.id === updated.id ? { ...i, ...updated } : i));
                          }} />
                        </td>
                        <td onClick={e => e.stopPropagation()}>
                          <div style={{ display: 'flex', gap: 6 }}>
                            {inv.pdf_url && (
                              <a href={inv.pdf_url} target="_blank" rel="noopener noreferrer"
                                className="btn btn-ghost btn-sm" style={{ fontSize: 12, textDecoration: 'none' }}>
                                PDF
                              </a>
                            )}
                            <button className="btn btn-ghost btn-sm" onClick={() => toggleExpand(inv.id)} style={{ fontSize: 12 }}>
                              {expandedId === inv.id ? '▲ Hide' : '▼ Lines'}
                            </button>
                            <button className="btn btn-danger btn-sm" onClick={() => handleDelete(inv.id)}>Delete</button>
                          </div>
                        </td>
                      </tr>
                      {expandedId === inv.id && (
                        <tr>
                          <td colSpan={9} style={{ padding: 0, background: 'var(--bg-subtle)' }}>
                            <div style={{ padding: '12px 20px' }}>
                              {loadingLines === inv.id
                                ? <div className="text-muted" style={{ fontSize: 13, padding: 8 }}>Loading…</div>
                                : <LineItemsTable items={lineItems[inv.id] || []} />}

                              {/* Matched Orders */}
                              <div style={{ marginTop: 20, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
                                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 6 }}>
                                  Matched Shopify Orders — {matchedOrders[inv.id]?.period
                                    ? `${fmtDate(matchedOrders[inv.id].period.start)} to ${fmtDate(matchedOrders[inv.id].period.end)}`
                                    : ''}
                                </div>
                                {/* Reconciliation banner */}
                                {matchedOrders[inv.id]?.reconciliation && (() => {
                                  const r = matchedOrders[inv.id].reconciliation;
                                  if (r.matched === true) return (
                                    <div style={{ fontSize: 12, background: '#22c55e18', border: '1px solid #22c55e40', borderRadius: 6, padding: '6px 10px', marginBottom: 10, color: '#16a34a', display: 'flex', gap: 8, alignItems: 'center' }}>
                                      ✓ <strong>Reconciled</strong> — Invoice shows {mn(r.invoice_dispatched)} dispatches, Shopify shows {mn(r.shopify_scc_orders)} SCC orders. Exact match.
                                    </div>
                                  );
                                  if (r.matched === false) return (
                                    <div style={{ fontSize: 12, background: '#ef444418', border: '1px solid #ef444440', borderRadius: 6, padding: '6px 10px', marginBottom: 10, color: '#dc2626', display: 'flex', gap: 8, alignItems: 'center' }}>
                                      ⚠ <strong>Mismatch</strong> — Invoice shows {mn(r.invoice_dispatched)} dispatches, Shopify shows {mn(r.shopify_scc_orders)} SCC orders ({r.shopify_scc_orders - r.invoice_dispatched > 0 ? '+' : ''}{mn(r.shopify_scc_orders - r.invoice_dispatched)}). Costs may be approximate.
                                    </div>
                                  );
                                  return (
                                    <div style={{ fontSize: 12, background: '#f59e0b18', border: '1px solid #f59e0b40', borderRadius: 6, padding: '6px 10px', marginBottom: 10, color: '#d97706' }}>
                                      ℹ Shopify shows {mn(r.shopify_scc_orders)} SCC orders — invoice dispatch count unknown.
                                    </div>
                                  );
                                })()}
                                {matchedOrders[inv.id]?.cost_method === 'accurate' && (
                                  <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
                                    <span style={{ fontSize: 12, color: '#f59e0b', fontWeight: 600 }}>
                                      {mc(_fmt(matchedOrders[inv.id].rate_per_order))} per order (flat)
                                    </span>
                                    <span style={{ fontSize: 12, color: '#8b5cf6', fontWeight: 600 }}>
                                      + {mc(_fmt(matchedOrders[inv.id].rate_per_unit))} per unit
                                    </span>
                                  </div>
                                )}
                                {loadingOrders === inv.id ? (
                                  <div className="text-muted" style={{ fontSize: 13 }}>Loading orders…</div>
                                ) : !matchedOrders[inv.id]?.orders?.length ? (
                                  <div className="text-muted" style={{ fontSize: 13 }}>No orders found for this period.</div>
                                ) : (
                                  <table style={{ fontSize: 12, width: '100%' }}>
                                    <thead>
                                      <tr style={{ borderBottom: '1px solid var(--border)' }}>
                                        {['Date', 'Order #', 'SKUs', 'Units', 'Revenue', '3PL Cost', 'Fulfilled by SCC'].map((h, i) => (
                                          <th key={h} style={{ padding: '4px 8px 8px', textAlign: i >= 3 ? 'right' : 'left', fontWeight: 600, color: 'var(--text-muted)', fontSize: 11 }}>{h}</th>
                                        ))}
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {matchedOrders[inv.id].orders.map(order => (
                                        <tr key={order.shopify_order_id} style={{ borderBottom: '1px solid var(--border)' }}>
                                          <td style={{ padding: '6px 8px 6px 0', color: 'var(--text-muted)' }}>{fmtDate(order.order_date)}</td>
                                          <td style={{ padding: '6px 8px' }}>
                                            <span className="mono" style={{ fontSize: 11 }}>#{order.order_number || order.shopify_order_id}</span>
                                          </td>
                                          <td style={{ padding: '6px 8px', color: 'var(--text-muted)', maxWidth: 220 }}>
                                            {order.line_items.map(li => `${li.sku} ×${mn(li.quantity)}`).join(', ')}
                                          </td>
                                          <td style={{ padding: '6px 8px', textAlign: 'right' }}>{mn(order.total_units)}</td>
                                          <td style={{ padding: '6px 8px', textAlign: 'right' }}>{mc(_fmt(order.total_revenue))}</td>
                                          <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 600, color: order.variable_3pl_cost > 0 ? COST_TYPE_COLOR.variable : 'var(--text-muted)' }}>
                                            {order.variable_3pl_cost > 0 ? mc(_fmt(order.variable_3pl_cost)) : '—'}
                                          </td>
                                          <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                                            {order.is_scc
                                              ? <span style={{ color: '#22c55e', fontWeight: 700 }}>✓ Yes</span>
                                              : <span style={{ color: 'var(--text-muted)' }}>No</span>}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                    <tfoot>
                                      <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 700 }}>
                                        <td colSpan={3} style={{ padding: '8px 8px 4px 0', fontSize: 12 }}>Total</td>
                                        <td style={{ padding: '8px 8px 4px', textAlign: 'right' }}>{mn(matchedOrders[inv.id].orders.reduce((s, o) => s + o.total_units, 0))}</td>
                                        <td style={{ padding: '8px 8px 4px', textAlign: 'right' }}>{mc(_fmt(matchedOrders[inv.id].orders.reduce((s, o) => s + o.total_revenue, 0)))}</td>
                                        <td style={{ padding: '8px 8px 4px', textAlign: 'right', color: COST_TYPE_COLOR.variable }}>{mc(_fmt(matchedOrders[inv.id].orders.reduce((s, o) => s + o.variable_3pl_cost, 0)))}</td>
                                        <td></td>
                                      </tr>
                                    </tfoot>
                                  </table>
                                )}
                              </div>
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
  const { mc, mn } = useDemoMask();

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
          <div className="stat-value">{mc(_fmt(grand_total_3pl))}</div>
          <div className="stat-sub">{dateRange?.label || 'Period'} · Ex GST</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Fixed Costs (One-time)</div>
          <div className="stat-value" style={{ color: COST_TYPE_COLOR.fixed }}>{mc(_fmt(fixed_costs.total))}</div>
          <div className="stat-sub">Storage, receiving, freight</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Variable Cost / Unit</div>
          <div className="stat-value" style={{ color: COST_TYPE_COLOR.variable }}>
            {variable_costs.cost_per_unit > 0 ? mc(_fmt(variable_costs.cost_per_unit)) : '—'}
          </div>
          <div className="stat-sub">
            {variable_costs.units_shipped > 0
              ? `${mn(variable_costs.units_shipped)} units · ${mc(_fmt(variable_costs.total))} total`
              : 'No invoice data'}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Orders Shown</div>
          <div className="stat-value">{mn(orders.length)}</div>
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
              <div style={{ fontWeight: 700, fontSize: 18, color: COST_TYPE_COLOR.fixed }}>{mc(_fmt(fixed_costs.total))}</div>
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
                    <td className="text-right" style={{ fontWeight: 500 }}>{mc(_fmt(li.amount))}</td>
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
            {mc(_fmt(variable_costs.cost_per_unit))} per unit × order quantity
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
                      <td><span className="mono" style={{ fontSize: 12 }}>#{order.order_number || order.shopify_order_id}</span></td>
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
                        {order.line_items.map(li => `${li.sku} ×${mn(li.quantity)}`).join(', ')}
                      </td>
                      <td className="text-right">{mn(order.total_units)}</td>
                      <td className="text-right">{mc(_fmt(order.total_revenue))}</td>
                      <td className="text-right" style={{ fontWeight: 600, color: variable_costs.cost_per_unit > 0 ? COST_TYPE_COLOR.variable : 'var(--text-muted)' }}>
                        {variable_costs.cost_per_unit > 0 ? mc(_fmt(order.variable_3pl_cost)) : '—'}
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
                                    <td style={{ padding: '3px 0', textAlign: 'right' }}>{mn(li.quantity)}</td>
                                    <td style={{ padding: '3px 0', textAlign: 'right', fontWeight: 500 }}>
                                      {variable_costs.cost_per_unit > 0 ? mc(_fmt(li.quantity * variable_costs.cost_per_unit)) : '—'}
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
                  <td className="text-right" style={{ paddingTop: 10 }}>{mn(orders.reduce((s, o) => s + o.total_units, 0))}</td>
                  <td className="text-right" style={{ paddingTop: 10 }}>{mc(_fmt(orders.reduce((s, o) => s + o.total_revenue, 0)))}</td>
                  <td className="text-right" style={{ paddingTop: 10, color: COST_TYPE_COLOR.variable }}>
                    {mc(_fmt(orders.reduce((s, o) => s + o.variable_3pl_cost, 0)))}
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
function PaymentStatusCell({ inv, onUpdate }) {
  const [loading, setLoading] = useState(false);
  const status = inv.payment_status || 'unpaid';

  // Auto-flag overdue: unpaid + due date passed (invoice_date + 14 days)
  const dueDate = new Date(inv.invoice_date);
  dueDate.setDate(dueDate.getDate() + 14);
  const isOverdue = status === 'unpaid' && new Date() > dueDate;
  const effectiveStatus = isOverdue ? 'overdue' : status;

  const CONFIG = {
    paid:    { label: 'Paid',    bg: '#22c55e18', color: '#16a34a', border: '#22c55e40' },
    unpaid:  { label: 'Unpaid',  bg: '#f59e0b18', color: '#d97706', border: '#f59e0b40' },
    overdue: { label: 'Overdue', bg: '#ef444418', color: '#dc2626', border: '#ef444440' },
  };

  const cfg = CONFIG[effectiveStatus];

  const update = async (newStatus) => {
    setLoading(true);
    try {
      const data = await apiFetch(`/api/fulfillment/invoices/${inv.id}/payment`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payment_status: newStatus }),
      });
      onUpdate(data);
    } catch (e) { alert('Update failed: ' + e.message); }
    finally { setLoading(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 120 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
          background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.border}`,
          textTransform: 'uppercase', letterSpacing: '0.06em',
        }}>
          {cfg.label}
        </span>
        {status === 'paid' && inv.paid_date && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtDate(inv.paid_date)}</span>
        )}
        {effectiveStatus === 'overdue' && (
          <span style={{ fontSize: 11, color: '#dc2626' }}>Due {fmtDate(dueDate.toISOString().split('T')[0])}</span>
        )}
      </div>
      {status !== 'paid' && (
        <button
          className="btn btn-ghost btn-sm"
          style={{ fontSize: 11, padding: '2px 8px', color: '#16a34a', borderColor: '#22c55e40' }}
          onClick={() => update('paid')}
          disabled={loading}
        >
          {loading ? '…' : '✓ Mark Paid'}
        </button>
      )}
      {status === 'paid' && (
        <button
          className="btn btn-ghost btn-sm"
          style={{ fontSize: 11, padding: '2px 8px', color: 'var(--text-muted)' }}
          onClick={() => update('unpaid')}
          disabled={loading}
        >
          {loading ? '…' : 'Undo'}
        </button>
      )}
    </div>
  );
}

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

function LineItemsTable({ items }) {
  const { mc, mn } = useDemoMask();
  if (!items.length) return <div className="text-muted" style={{ fontSize: 13 }}>No line items.</div>;
  const grouped = { inbound: [], outbound: [], delivery: [], packaging: [], other: [] };
  for (const li of items) (grouped[li.category] || grouped.other).push(li);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {['inbound', 'outbound', 'delivery', 'packaging', 'other'].map(cat => {
        if (!grouped[cat].length) return null;
        const catTotal = grouped[cat].reduce((s, li) => s + parseFloat(li.amount_ex_gst || 0), 0);
        return (
          <div key={cat}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: CATEGORY_COLOR[cat], marginBottom: 6 }}>
              {CATEGORY_LABEL[cat]} — {mc(_fmt(catTotal))}
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
                    <td style={{ padding: '4px 0', textAlign: 'right', color: 'var(--text-muted)', width: 60 }}>{mn(li.quantity ?? '')}</td>
                    <td style={{ padding: '4px 0', textAlign: 'right', color: 'var(--text-muted)', width: 80 }}>{li.unit_rate ? mc(_fmt(li.unit_rate)) : ''}</td>
                    <td style={{ padding: '4px 0 4px 16px', textAlign: 'right', fontWeight: 500, width: 90 }}>{mc(_fmt(li.amount_ex_gst))}</td>
                    <td style={{ padding: '4px 0 4px 8px', textAlign: 'right', color: 'var(--text-muted)', width: 70 }}>+{mc(_fmt(li.gst))} GST</td>
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

// ─── Packaging SKU Map View ──────────────────────────────────────────────────
function PackagingSkuMapView() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // id or 'new'
  const [form, setForm] = useState({ box_code: '', box_description: '', skus: '', notes: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/fulfillment/packaging-sku-map');
      setRows(await res.json());
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const startEdit = (row) => {
    setEditing(row.id);
    setForm({ box_code: row.box_code, box_description: row.box_description || '', skus: (row.skus || []).join(', '), notes: row.notes || '' });
  };

  const startNew = () => {
    setEditing('new');
    setForm({ box_code: '', box_description: '', skus: '', notes: '' });
  };

  const save = async () => {
    const payload = {
      box_code: form.box_code.trim(),
      box_description: form.box_description.trim() || null,
      skus: form.skus.split(',').map(s => s.trim()).filter(Boolean),
      notes: form.notes.trim() || null,
    };
    if (!payload.box_code) return;
    try {
      if (editing === 'new') {
        await apiFetch('/api/fulfillment/packaging-sku-map', { method: 'POST', body: JSON.stringify(payload) });
      } else {
        await apiFetch(`/api/fulfillment/packaging-sku-map/${editing}`, { method: 'PUT', body: JSON.stringify(payload) });
      }
      setEditing(null);
      load();
    } catch (e) { setError(e.message); }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this mapping?')) return;
    try {
      await apiFetch(`/api/fulfillment/packaging-sku-map/${id}`, { method: 'DELETE' });
      load();
    } catch (e) { setError(e.message); }
  };

  if (loading) return <div className="loading">Loading…</div>;

  return (
    <div>
      <div className="section-header">
        <div>
          <div className="section-title">Packaging SKU Map</div>
          <div className="text-muted" style={{ fontSize: 12, marginTop: 2 }}>
            Maps box codes from packaging invoices to product SKUs. Used to auto-tag packaging line items during PDF parsing.
          </div>
        </div>
        <button className="btn btn-primary" onClick={startNew}>+ Add Mapping</button>
      </div>

      {error && <div className="error-msg" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="card">
        {rows.length === 0 && !editing ? (
          <div className="empty">No mappings yet. Add a box code mapping to get started.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Box Code</th>
                  <th>Description</th>
                  <th>Product SKUs</th>
                  <th>Notes</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  editing === row.id ? (
                    <tr key={row.id}>
                      <td><input value={form.box_code} onChange={e => setForm({ ...form, box_code: e.target.value })} style={inputStyle} /></td>
                      <td><input value={form.box_description} onChange={e => setForm({ ...form, box_description: e.target.value })} style={inputStyle} /></td>
                      <td><input value={form.skus} onChange={e => setForm({ ...form, skus: e.target.value })} placeholder="BLK1CAR, BRN1CAR" style={{ ...inputStyle, width: 220 }} /></td>
                      <td><input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} style={inputStyle} /></td>
                      <td>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button className="btn btn-primary btn-sm" onClick={save}>Save</button>
                          <button className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    <tr key={row.id}>
                      <td style={{ fontWeight: 600, fontFamily: 'monospace', fontSize: 13 }}>{row.box_code}</td>
                      <td className="text-muted" style={{ fontSize: 13 }}>{row.box_description || '—'}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {(row.skus || []).map(sku => (
                            <span key={sku} style={{ padding: '2px 6px', borderRadius: 4, background: 'var(--accent-dim)', color: 'var(--accent)', fontSize: 11, fontWeight: 600, fontFamily: 'monospace' }}>
                              {sku}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="text-muted" style={{ fontSize: 12 }}>{row.notes || '—'}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button className="btn btn-ghost btn-sm" onClick={() => startEdit(row)} style={{ fontSize: 12 }}>Edit</button>
                          <button className="btn btn-danger btn-sm" onClick={() => handleDelete(row.id)}>Del</button>
                        </div>
                      </td>
                    </tr>
                  )
                ))}
                {editing === 'new' && (
                  <tr>
                    <td><input value={form.box_code} onChange={e => setForm({ ...form, box_code: e.target.value })} placeholder="BX200B" style={inputStyle} /></td>
                    <td><input value={form.box_description} onChange={e => setForm({ ...form, box_description: e.target.value })} placeholder="Brown RSC 200mm" style={inputStyle} /></td>
                    <td><input value={form.skus} onChange={e => setForm({ ...form, skus: e.target.value })} placeholder="BLK1CAR, BRN1CAR" style={{ ...inputStyle, width: 220 }} /></td>
                    <td><input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="Optional notes" style={inputStyle} /></td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button className="btn btn-primary btn-sm" onClick={save}>Save</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

const inputStyle = { fontSize: 12, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)', width: 150 };

// ─── Australia Post View ─────────────────────────────────────────────────────
function AusPostView({ dateRange }) {
  const [summary, setSummary] = useState(null);
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const fileRef = useRef();
  const { mc, mn } = useDemoMask();

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams();
      if (dateRange?.start) params.set('start_date', dateRange.start);
      if (dateRange?.end)   params.set('end_date', dateRange.end);
      const [summaryData, recordsData] = await Promise.all([
        apiFetch(`/api/3pl/auspost/summary?${params}`),
        apiFetch(`/api/3pl/auspost/records?${params}&limit=200`),
      ]);
      setSummary(summaryData);
      setRecords(recordsData.records || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [dateRange]);

  useEffect(() => { load(); }, [load]);

  const handleUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true); setUploadResult(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`${BASE_URL}/api/3pl/auspost`, { method: 'POST', body: formData });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || 'Upload failed'); }
      const result = await res.json();
      setUploadResult({ type: 'success', text: `Imported ${result.imported} consignments${result.skipped ? ` (${result.skipped} skipped)` : ''}.` });
      load();
    } catch (err) { setUploadResult({ type: 'error', text: err.message }); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const handleClearAll = async () => {
    if (!window.confirm('Delete ALL Australia Post freight records? This cannot be undone.')) return;
    try {
      await apiFetch('/api/3pl/auspost/all', { method: 'DELETE' });
      setUploadResult({ type: 'success', text: 'All records deleted.' });
      load();
    } catch (err) { setUploadResult({ type: 'error', text: err.message }); }
  };

  if (loading) return <div className="loading">Loading Australia Post data...</div>;
  if (error) return <div className="error-msg">{error}</div>;

  return (
    <div>
      {/* KPI cards */}
      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
          {[
            { label: 'Total Freight Cost', value: mc(_fmt(summary.total_cost)), sub: `${dateRange?.label || 'Period'}` },
            { label: 'Consignments', value: mn(summary.consignments), sub: 'Shipments in period' },
            { label: 'Avg Cost / Shipment', value: mc(_fmt(summary.avg_cost_per_consignment)), sub: 'Including fuel surcharge' },
            { label: 'Fuel Surcharge', value: mc(_fmt(summary.total_fsc)), sub: 'FSC total' },
          ].map(({ label, value, sub }) => (
            <div key={label} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: '16px 18px' }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>{label}</div>
              <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>{value}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{sub}</div>
            </div>
          ))}
        </div>
      )}

      {/* Service type breakdown */}
      {summary && summary.by_service && summary.by_service.length > 0 && (
        <div className="card" style={{ marginBottom: 20, padding: '16px 20px' }}>
          <div className="card-title" style={{ marginBottom: 10 }}>By Service Type</div>
          <div style={{ display: 'flex', gap: 20 }}>
            {summary.by_service.map(svc => (
              <div key={svc.service_type} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{
                  display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                  background: svc.service_type.toLowerCase().includes('express') ? '#f59e0b' : '#3b82f6',
                }} />
                <span style={{ fontSize: 13 }}>
                  {svc.service_type}: <strong>{mn(svc.consignments)}</strong> shipments — {mc(_fmt(svc.total_cost))}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Upload section */}
      <div className="section-header">
        <div>
          <div className="section-title">Australia Post Freight Records</div>
          <div className="text-muted" style={{ fontSize: 12, marginTop: 2 }}>{records.length} record{records.length !== 1 ? 's' : ''} in period</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {records.length > 0 && (
            <button className="btn btn-ghost" onClick={handleClearAll} style={{ fontSize: 12 }}>Clear All</button>
          )}
          <label className="btn btn-primary" style={{ cursor: 'pointer' }}>
            {uploading ? 'Importing...' : '+ Upload CSV'}
            <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" style={{ display: 'none' }} onChange={handleUpload} disabled={uploading} />
          </label>
        </div>
      </div>

      {uploadResult && (
        <div className={`sync-banner ${uploadResult.type}`} style={{ borderRadius: 'var(--radius)', marginBottom: 16 }}>
          <span>{uploadResult.text}</span>
          <button className="banner-close" onClick={() => setUploadResult(null)}>✕</button>
        </div>
      )}

      {/* Records table */}
      {records.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Consignment ID</th>
                  <th>SCC Reference</th>
                  <th>Service</th>
                  <th>State</th>
                  <th className="text-right">Base</th>
                  <th className="text-right">FSC</th>
                  <th className="text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {records.map(r => (
                  <tr key={r.id}>
                    <td>{fmtDate(r.lodgement_date)}</td>
                    <td><span className="mono" style={{ fontSize: 11 }}>{r.consignment_id}</span></td>
                    <td>{r.shopify_ref || <span className="text-muted">—</span>}</td>
                    <td style={{ fontSize: 12 }}>
                      {r.service_type ? (
                        <span style={{
                          padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 600,
                          background: (r.service_type || '').toLowerCase().includes('express')
                            ? 'rgba(245,158,11,0.1)' : 'rgba(59,130,246,0.1)',
                          color: (r.service_type || '').toLowerCase().includes('express')
                            ? '#d97706' : '#2563eb',
                        }}>
                          {(r.service_type || '').includes('Express') ? 'Express' : 'Standard'}
                        </span>
                      ) : '—'}
                    </td>
                    <td style={{ fontSize: 12 }}>{r.to_state || '—'}</td>
                    <td className="text-right">{mc(_fmt(r.amount))}</td>
                    <td className="text-right" style={{ color: 'var(--text-muted)' }}>{mc(_fmt(r.fsc))}</td>
                    <td className="text-right" style={{ fontWeight: 600 }}>{mc(_fmt(r.total_cost))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={5} style={{ fontWeight: 700, color: 'var(--text-muted)', fontSize: 12 }}>
                    TOTAL ({mn(records.length)} consignments)
                  </td>
                  <td className="text-right" style={{ fontWeight: 700 }}>
                    {mc(_fmt(records.reduce((s, r) => s + parseFloat(r.amount || 0), 0)))}
                  </td>
                  <td className="text-right" style={{ fontWeight: 700, color: 'var(--text-muted)' }}>
                    {mc(_fmt(records.reduce((s, r) => s + parseFloat(r.fsc || 0), 0)))}
                  </td>
                  <td className="text-right" style={{ fontWeight: 700 }}>
                    {mc(_fmt(records.reduce((s, r) => s + parseFloat(r.total_cost || 0), 0)))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {records.length === 0 && !loading && (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <div style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 8 }}>No Australia Post freight data for this period.</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Upload a CSV from Australia Post to see shipping costs here.</div>
        </div>
      )}
    </div>
  );
}
