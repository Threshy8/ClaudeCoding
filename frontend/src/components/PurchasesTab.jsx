import React, { useEffect, useState, useCallback } from 'react';
import { useDemoMask } from '../contexts/DemoModeContext';

const BASE_URL = process.env.REACT_APP_API_URL || '';

async function apiFetch(path, opts = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function apiFetchMultipart(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, { method: 'POST', body });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function _fmt(n) {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);
}

function fmtDate(d) {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
}

// ─── Status badge ─────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const map = {
    open:    { bg: 'rgba(16,185,129,0.12)', color: '#059669', border: 'rgba(16,185,129,0.25)' },
    partial: { bg: 'rgba(245,158,11,0.12)', color: '#d97706', border: 'rgba(245,158,11,0.25)' },
    closed:  { bg: 'rgba(107,114,128,0.12)', color: '#6b7280', border: 'rgba(107,114,128,0.25)' },
  };
  const s = map[status] || map.open;
  return (
    <span style={{
      padding: '2px 10px', borderRadius: 12, fontSize: 11, fontWeight: 700,
      background: s.bg, color: s.color, border: `1px solid ${s.border}`,
      textTransform: 'uppercase', letterSpacing: '0.04em',
    }}>{status}</span>
  );
}

function DestinationBadge({ destination }) {
  const isDirect = destination === 'direct_to_customer' || !destination;
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 700,
      background: isDirect ? 'rgba(139,92,246,0.12)' : 'rgba(6,182,212,0.12)',
      color: isDirect ? '#7c3aed' : '#0891b2',
      border: `1px solid ${isDirect ? 'rgba(139,92,246,0.25)' : 'rgba(6,182,212,0.25)'}`,
      letterSpacing: '0.03em', whiteSpace: 'nowrap',
    }}>{isDirect ? 'GD Direct' : 'GD → SCC'}</span>
  );
}

const CURRENCY_SYMBOLS = { CNY: '¥', USD: 'US$', EUR: '€', GBP: '£', AUD: '$' };

// ─── Purchase Orders Sub-tab ──────────────────────────────────────────────────
function PurchaseOrdersView() {
  const [orders, setOrders]         = useState([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [consumption, setConsumption] = useState(null);
  const [consLoading, setConsLoading] = useState(false);

  // Invoice upload state
  const [uploading, setUploading]     = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [parsed, setParsed]           = useState(null);
  const [parsedMeta, setParsedMeta]   = useState(null);
  const [saving, setSaving]           = useState(false);
  const [saveError, setSaveError]     = useState(null);
  const [deletingId, setDeletingId]   = useState(null);
  const { mc, mn, mp } = useDemoMask();

  const loadOrders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch('/api/purchases/orders');
      setOrders(data || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadOrders(); }, [loadOrders]);

  // Expand PO → load consumption
  const handleExpand = async (id) => {
    if (expandedId === id) {
      setExpandedId(null);
      setConsumption(null);
      return;
    }
    setExpandedId(id);
    setConsLoading(true);
    try {
      const data = await apiFetch(`/api/purchases/orders/${id}/consumption`);
      setConsumption(data);
    } catch (e) {
      setConsumption(null);
    } finally {
      setConsLoading(false);
    }
  };

  // Shared: compress image (or pass-through PDF) then send to parse endpoint
  const processFile = async (file) => {
    setUploading(true);
    setUploadError(null);
    setParsed(null);
    setParsedMeta(null);

    try {
      const isPdf = file.type === 'application/pdf';
      let base64;
      let mediaType;

      if (isPdf) {
        base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        mediaType = 'application/pdf';
      } else {
        const imgUrl = URL.createObjectURL(file);
        const img = await new Promise((resolve, reject) => {
          const i = new Image();
          i.onload = () => resolve(i);
          i.onerror = reject;
          i.src = imgUrl;
        });
        const MAX = 1500;
        let { width, height } = img;
        if (width > MAX || height > MAX) {
          const scale = MAX / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        URL.revokeObjectURL(imgUrl);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
        base64 = dataUrl.split(',')[1];
        mediaType = 'image/jpeg';
      }

      const data = await apiFetch('/api/purchases/parse-invoice', {
        method: 'POST',
        body: JSON.stringify({ image_base64: base64, media_type: mediaType }),
      });

      if (data.parsed) {
        setParsedMeta({
          supplier: data.parsed.supplier || '',
          invoice_date: data.parsed.invoice_date || new Date().toISOString().split('T')[0],
          invoice_reference: data.parsed.invoice_reference || '',
          shipping_cost: data.parsed.shipping_cost || 0,
          notes: data.parsed.notes || '',
          original_currency: data.parsed.original_currency || 'AUD',
          exchange_rate: data.parsed.exchange_rate || 1,
          exchange_rate_date: data.parsed.exchange_rate_date || null,
          destination: 'direct_to_customer',
        });
        setParsed((data.parsed.lines || []).map((l, i) => ({
          _id: i,
          product_name: l.product_name || '',
          sku: l.suggested_sku || '',
          sku_confidence: l.sku_confidence || 'none',
          quantity: l.quantity || 1,
          unit_cost: l.unit_cost || 0,
          original_unit_cost: l.original_unit_cost ?? null,
        })));
      }
    } catch (err) {
      setUploadError(err.message);
    } finally {
      setUploading(false);
    }
  };

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    processFile(file);
  };

  const handlePaste = (e) => {
    if (uploading) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) processFile(file);
        return;
      }
    }
  };

  const updateParsedRow = (idx, field, value) => {
    setParsed(prev => prev.map((r, i) => i === idx ? { ...r, [field]: value } : r));
  };

  const handleSavePO = async () => {
    if (!parsed || parsed.length === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      await apiFetch('/api/purchases/orders', {
        method: 'POST',
        body: JSON.stringify({
          supplier: parsedMeta?.supplier || 'Unknown',
          order_date: parsedMeta?.invoice_date || new Date().toISOString().split('T')[0],
          notes: parsedMeta?.notes || '',
          destination: parsedMeta?.destination || 'direct_to_customer',
          original_currency: parsedMeta?.original_currency || 'AUD',
          exchange_rate: parsedMeta?.exchange_rate || 1,
          lines: parsed.map(r => ({
            sku: r.sku,
            product_name: r.product_name,
            quantity: parseInt(r.quantity) || 1,
            unit_cost: parseFloat(r.unit_cost) || 0,
          })),
        }),
      });
      setParsed(null);
      setParsedMeta(null);
      loadOrders();
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDeletePO = async (id) => {
    if (!window.confirm('Delete this purchase order? This will trigger COGS recompute.')) return;
    setDeletingId(id);
    try {
      await apiFetch(`/api/purchases/orders/${id}`, { method: 'DELETE' });
      setOrders(prev => prev.filter(o => o.id !== id));
      if (expandedId === id) { setExpandedId(null); setConsumption(null); }
    } catch (err) {
      alert('Delete failed: ' + err.message);
    } finally {
      setDeletingId(null);
    }
  };

  const totalValue = orders.reduce((s, o) => s + (parseFloat(o.total_value) || 0), 0);

  return (
    <div>
      {/* Upload section */}
      <div tabIndex={0} onPaste={handlePaste} style={{ outline: 'none', marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Purchase Orders</div>
            {!loading && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                {orders.length} POs · Total value: {mc(_fmt(totalValue))}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
            <label style={{
              padding: '8px 18px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
              background: 'var(--accent)', color: '#fff', border: 'none',
              opacity: uploading ? 0.6 : 1,
            }}>
              {uploading ? 'Parsing…' : '+ Upload Invoice'}
              <input type="file" accept="image/*,application/pdf" onChange={handleFileUpload} hidden disabled={uploading} />
            </label>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Upload, drag & drop, or paste an image (Cmd+V)</span>
          </div>
        </div>
      </div>

      {uploadError && <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 12, padding: '8px 12px', background: 'rgba(239,68,68,0.08)', borderRadius: 8 }}>{uploadError}</div>}

      {/* Parsed invoice review */}
      {parsed && (
        <div style={{ marginBottom: 24, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Review Parsed Invoice</div>
              {parsedMeta && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  {parsedMeta.supplier} · {fmtDate(parsedMeta.invoice_date)}
                  {parsedMeta.invoice_reference && ` · Ref: ${parsedMeta.invoice_reference}`}
                  {parsedMeta.shipping_cost > 0 && ` · Shipping: ${mc(_fmt(parsedMeta.shipping_cost))}`}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => { setParsed(null); setParsedMeta(null); }} style={{
                padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)',
              }}>Discard</button>
              <button onClick={handleSavePO} disabled={saving} style={{
                padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                background: '#059669', border: 'none', color: '#fff', opacity: saving ? 0.6 : 1,
              }}>{saving ? 'Saving…' : 'Save PO'}</button>
            </div>
          </div>
          {saveError && <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 8 }}>{saveError}</div>}

          {/* Currency conversion banner */}
          {parsedMeta && parsedMeta.original_currency && parsedMeta.original_currency !== 'AUD' && (
            <div style={{
              padding: '10px 14px', marginBottom: 14, borderRadius: 8, fontSize: 13, fontWeight: 600,
              background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.30)', color: '#b45309',
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span style={{ fontSize: 16 }}>$</span>
              Invoice currency: {parsedMeta.original_currency} → AUD @ {parsedMeta.exchange_rate} (live rate{parsedMeta.exchange_rate_date ? ` · ${parsedMeta.exchange_rate_date}` : ''})
            </div>
          )}

          {/* Destination selector */}
          {parsedMeta && (
            <div style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>Destination:</span>
              <select
                value={parsedMeta.destination || 'direct_to_customer'}
                onChange={e => setParsedMeta(m => ({ ...m, destination: e.target.value }))}
                style={{
                  padding: '5px 10px', borderRadius: 6, fontSize: 13, border: '1px solid var(--border)',
                  background: 'var(--bg)', color: 'var(--text)', cursor: 'pointer',
                }}>
                <option value="direct_to_customer">GD → Direct to customer</option>
                <option value="scc_warehouse">GD → SCC Warehouse</option>
              </select>
            </div>
          )}

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--border)' }}>
                  <th style={{ padding: '6px 8px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>Product Name</th>
                  <th style={{ padding: '6px 8px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>SKU</th>
                  <th style={{ padding: '6px 8px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', width: 60 }}>Match</th>
                  <th style={{ padding: '6px 8px', textAlign: 'right', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', width: 70 }}>Qty</th>
                  <th style={{ padding: '6px 8px', textAlign: 'right', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', width: 140 }}>Unit Cost</th>
                  <th style={{ padding: '6px 8px', textAlign: 'right', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', width: 110 }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {parsed.map((row, i) => {
                  const confColor = { high: '#059669', medium: '#d97706', low: '#ef4444', none: '#6b7280' }[row.sku_confidence] || '#6b7280';
                  const hasFx = parsedMeta && parsedMeta.original_currency && parsedMeta.original_currency !== 'AUD' && row.original_unit_cost != null;
                  const sym = CURRENCY_SYMBOLS[parsedMeta?.original_currency] || parsedMeta?.original_currency || '';
                  return (
                    <tr key={row._id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '6px 8px' }}>
                        <input value={row.product_name} onChange={e => updateParsedRow(i, 'product_name', e.target.value)}
                          style={{ width: '100%', padding: '4px 6px', border: '1px solid var(--border)', borderRadius: 4, fontSize: 13, background: 'var(--bg)' }} />
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        <input value={row.sku} onChange={e => updateParsedRow(i, 'sku', e.target.value)}
                          style={{ width: '100%', padding: '4px 6px', border: '1px solid var(--border)', borderRadius: 4, fontSize: 13, fontFamily: 'monospace', background: 'var(--bg)' }} />
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: confColor, textTransform: 'uppercase' }}>{row.sku_confidence}</span>
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        <input type="number" value={row.quantity} onChange={e => updateParsedRow(i, 'quantity', e.target.value)}
                          style={{ width: '100%', padding: '4px 6px', border: '1px solid var(--border)', borderRadius: 4, fontSize: 13, textAlign: 'right', background: 'var(--bg)' }} />
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                          <input type="number" step="0.01" value={row.unit_cost} onChange={e => updateParsedRow(i, 'unit_cost', e.target.value)}
                            style={{ width: '100%', padding: '4px 6px', border: '1px solid var(--border)', borderRadius: 4, fontSize: 13, textAlign: 'right', background: 'var(--bg)' }} />
                          {hasFx && (
                            <span style={{ fontSize: 10, color: '#b45309' }}>{mc(`${sym}${Number(row.original_unit_cost).toFixed(2)}`)}</span>
                          )}
                        </div>
                      </td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 600 }}>
                        {mc(_fmt((parseInt(row.quantity) || 0) * (parseFloat(row.unit_cost) || 0)))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--border)' }}>
                  <td colSpan={3} style={{ padding: '8px', fontWeight: 700, fontSize: 12, color: 'var(--text-muted)' }}>
                    TOTAL ({parsed.length} lines)
                  </td>
                  <td style={{ padding: '8px', textAlign: 'right', fontWeight: 700 }}>
                    {mn(parsed.reduce((s, r) => s + (parseInt(r.quantity) || 0), 0))}
                  </td>
                  <td></td>
                  <td style={{ padding: '8px', textAlign: 'right', fontWeight: 700 }}>
                    {mc(_fmt(parsed.reduce((s, r) => s + (parseInt(r.quantity) || 0) * (parseFloat(r.unit_cost) || 0), 0)))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* PO list */}
      {error && <div className="error-msg">{error}</div>}
      {loading ? (
        <div className="loading">Loading purchase orders…</div>
      ) : orders.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          No purchase orders yet. Upload an invoice to create your first PO.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border)' }}>
                {['PO #', 'Supplier', 'Date', 'Status', 'Dest', 'Total Value', 'Units', 'Remaining', ''].map(h => (
                  <th key={h} style={{
                    padding: '8px 10px', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
                    textTransform: 'uppercase', letterSpacing: '0.06em',
                    textAlign: ['Total Value', 'Units', 'Remaining'].includes(h) ? 'right' : 'left',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {orders.map(po => (
                <React.Fragment key={po.id}>
                  <tr style={{ borderBottom: expandedId === po.id ? 'none' : '1px solid var(--border)', cursor: 'pointer' }}
                    onClick={() => handleExpand(po.id)}>
                    <td style={{ padding: '10px', fontWeight: 600 }}>
                      <span className="mono" style={{ fontSize: 12 }}>{po.po_number}</span>
                    </td>
                    <td style={{ padding: '10px' }}>{po.supplier}</td>
                    <td style={{ padding: '10px', color: 'var(--text-muted)', fontSize: 12 }}>{fmtDate(po.order_date)}</td>
                    <td style={{ padding: '10px' }}><StatusBadge status={po.status} /></td>
                    <td style={{ padding: '10px' }}><DestinationBadge destination={po.destination} /></td>
                    <td style={{ padding: '10px', textAlign: 'right', fontWeight: 600 }}>{mc(_fmt(po.total_value))}</td>
                    <td style={{ padding: '10px', textAlign: 'right' }}>{mn(po.total_units_ordered)}</td>
                    <td style={{ padding: '10px', textAlign: 'right' }}>
                      <span style={{ color: po.total_units_remaining > 0 ? 'var(--text)' : 'var(--text-muted)' }}>
                        {mn(po.total_units_remaining)}
                      </span>
                      {po.consumption_pct > 0 && (
                        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 6 }}>({mp(po.consumption_pct)} used)</span>
                      )}
                    </td>
                    <td style={{ padding: '10px', display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button className="btn btn-ghost btn-sm" style={{ fontSize: 11 }}
                        onClick={e => { e.stopPropagation(); handleExpand(po.id); }}>
                        {expandedId === po.id ? '▲' : '▼'}
                      </button>
                      <button className="btn btn-danger btn-sm" style={{ fontSize: 11 }}
                        onClick={e => { e.stopPropagation(); handleDeletePO(po.id); }}
                        disabled={deletingId === po.id}>
                        {deletingId === po.id ? '…' : 'Del'}
                      </button>
                    </td>
                  </tr>
                  {expandedId === po.id && (
                    <tr>
                      <td colSpan={9} style={{ padding: '0 0 12px 0', background: 'var(--bg-subtle)' }}>
                        <div style={{ padding: '12px 20px' }}>
                          {consLoading ? (
                            <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 8 }}>Loading consumption…</div>
                          ) : consumption ? (
                            <div>
                              {(consumption.purchase_order_lines || []).map(line => (
                                <div key={line.id} style={{ marginBottom: 12 }}>
                                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                                    <span className="mono">{line.sku}</span>
                                    <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 8 }}>{line.product_name}</span>
                                    <span style={{ marginLeft: 12 }}>
                                      {mn(line.quantity_consumed || (line.quantity_ordered - line.quantity_remaining))}/{mn(line.quantity_ordered)} units used
                                    </span>
                                    <span style={{ marginLeft: 8 }}>@ {mc(_fmt(line.unit_cost))}</span>
                                  </div>
                                  {line.orders && line.orders.length > 0 ? (
                                    <table style={{ fontSize: 11, width: '100%', marginLeft: 12 }}>
                                      <thead>
                                        <tr>
                                          {['Order #', 'Date', 'Qty', 'Sale Price', 'Profit'].map(h => (
                                            <th key={h} style={{ padding: '3px 8px', fontWeight: 600, color: 'var(--text-muted)', textAlign: h === 'Order #' || h === 'Date' ? 'left' : 'right' }}>{h}</th>
                                          ))}
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {line.orders.map((ord, oi) => (
                                          <tr key={oi}>
                                            <td style={{ padding: '3px 8px' }}>#{ord.order_number}</td>
                                            <td style={{ padding: '3px 8px', color: 'var(--text-muted)' }}>{fmtDate(ord.order_date)}</td>
                                            <td style={{ padding: '3px 8px', textAlign: 'right' }}>{mn(ord.quantity_sold)}</td>
                                            <td style={{ padding: '3px 8px', textAlign: 'right' }}>{mc(_fmt(ord.sale_price))}</td>
                                            <td style={{ padding: '3px 8px', textAlign: 'right', color: (parseFloat(ord.gross_profit) || 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>
                                              {mc(_fmt(ord.gross_profit))}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  ) : (
                                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 12 }}>No orders consumed from this line yet.</div>
                                  )}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No consumption data available.</div>
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
  );
}

// ─── GermanDrop Wallet Sub-tab ────────────────────────────────────────────────
function GermanDropWalletView() {
  const [topups, setTopups]         = useState([]);
  const [orderCosts, setOrderCosts] = useState([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [showForm, setShowForm]     = useState(false);
  const [form, setForm]             = useState({ topup_date: '', amount_aud: '', notes: '' });
  const [saving, setSaving]         = useState(false);
  const { mc } = useDemoMask();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [t, o] = await Promise.all([
        apiFetch('/api/purchases/germandrop/topups'),
        apiFetch('/api/purchases/germandrop/order-costs'),
      ]);
      setTopups(t || []);
      setOrderCosts(o || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const totalTopups = topups.reduce((s, t) => s + (parseFloat(t.amount_aud) || 0), 0);
  const totalSpent = orderCosts.reduce((s, c) => s + (parseFloat(c.shipping_cost) || 0), 0);
  const balance = totalTopups - totalSpent;

  const handleAddTopup = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await apiFetch('/api/purchases/germandrop/topups', {
        method: 'POST',
        body: JSON.stringify({
          topup_date: form.topup_date,
          amount_aud: parseFloat(form.amount_aud),
          notes: form.notes || null,
        }),
      });
      setShowForm(false);
      setForm({ topup_date: '', amount_aud: '', notes: '' });
      load();
    } catch (err) {
      alert('Failed: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="loading">Loading wallet…</div>;
  if (error) return <div className="error-msg">{error}</div>;

  return (
    <div>
      {/* Balance card */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
        {[
          { label: 'Total Topped Up', value: mc(_fmt(totalTopups)), color: '' },
          { label: 'Total GD Order Costs', value: mc(_fmt(totalSpent)), color: '#ef4444' },
          { label: 'Remaining Balance', value: mc(_fmt(balance)), color: balance >= 0 ? '#059669' : '#ef4444' },
        ].map(c => (
          <div key={c.label} style={{
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderRadius: 10, padding: '16px 20px', flex: 1, minWidth: 180,
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 6 }}>{c.label}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: c.color || 'var(--text)' }}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* Add top-up */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
          Top-ups ({topups.length})
        </div>
        <button onClick={() => { setShowForm(!showForm); setForm({ topup_date: new Date().toISOString().split('T')[0], amount_aud: '', notes: '' }); }}
          style={{
            padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
            background: 'var(--accent)', color: '#fff', border: 'none',
          }}>+ Add Top-up</button>
      </div>

      {showForm && (
        <form onSubmit={handleAddTopup} style={{
          marginBottom: 16, padding: 16, background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 8, display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap',
        }}>
          <div>
            <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Date</label>
            <input type="date" value={form.topup_date} onChange={e => setForm(f => ({ ...f, topup_date: e.target.value }))} required
              style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13, background: 'var(--bg)' }} />
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Amount (AUD)</label>
            <input type="number" step="0.01" min="0" value={form.amount_aud} onChange={e => setForm(f => ({ ...f, amount_aud: e.target.value }))} required
              style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13, width: 120, background: 'var(--bg)' }} />
          </div>
          <div style={{ flex: 1, minWidth: 150 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Notes</label>
            <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="e.g. PayPal transfer"
              style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13, width: '100%', background: 'var(--bg)', boxSizing: 'border-box' }} />
          </div>
          <button type="submit" disabled={saving} style={{
            padding: '7px 16px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
            background: '#059669', color: '#fff', border: 'none', opacity: saving ? 0.6 : 1,
          }}>{saving ? 'Saving…' : 'Save'}</button>
          <button type="button" onClick={() => setShowForm(false)} style={{
            padding: '7px 16px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
            background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)',
          }}>Cancel</button>
        </form>
      )}

      {/* Top-ups list */}
      {topups.length > 0 && (
        <div style={{ marginBottom: 24, overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border)' }}>
                {['Date', 'Amount', 'Notes'].map(h => (
                  <th key={h} style={{
                    padding: '6px 10px', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
                    textTransform: 'uppercase', textAlign: h === 'Amount' ? 'right' : 'left',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {topups.map(t => (
                <tr key={t.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 10px', color: 'var(--text-muted)' }}>{fmtDate(t.topup_date)}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600, color: '#059669' }}>{mc(_fmt(t.amount_aud))}</td>
                  <td style={{ padding: '8px 10px', color: 'var(--text-muted)' }}>{t.notes || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* GD Order Costs */}
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 10 }}>
        GD Order Costs ({orderCosts.length})
      </div>
      {orderCosts.length === 0 ? (
        <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          No GermanDrop order costs recorded yet.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border)' }}>
                {['Order #', 'Shipping Cost', 'Notes', 'Date'].map(h => (
                  <th key={h} style={{
                    padding: '6px 10px', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
                    textTransform: 'uppercase', textAlign: h === 'Shipping Cost' ? 'right' : 'left',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {orderCosts.map(c => (
                <tr key={c.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 10px' }}>
                    <span className="mono" style={{ fontSize: 12 }}>#{c.order_number || c.shopify_order_id}</span>
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600, color: '#ef4444' }}>{mc(_fmt(c.shipping_cost))}</td>
                  <td style={{ padding: '8px 10px', color: 'var(--text-muted)' }}>{c.notes || '—'}</td>
                  <td style={{ padding: '8px 10px', color: 'var(--text-muted)', fontSize: 12 }}>{fmtDate(c.created_at?.split('T')[0])}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid var(--border)' }}>
                <td style={{ padding: '8px 10px', fontWeight: 700, fontSize: 12 }}>Total</td>
                <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color: '#ef4444' }}>{mc(_fmt(totalSpent))}</td>
                <td colSpan={2}></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Main PurchasesTab ────────────────────────────────────────────────────────
export default function PurchasesTab() {
  const [subTab, setSubTab] = useState('orders');

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {[['orders', 'Purchase Orders'], ['wallet', 'GermanDrop Wallet']].map(([key, label]) => (
          <button key={key} onClick={() => setSubTab(key)} style={{
            padding: '7px 18px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer',
            border: '1px solid var(--border)',
            background: subTab === key ? 'var(--accent)' : 'var(--bg-card)',
            color: subTab === key ? '#fff' : 'var(--text)',
          }}>{label}</button>
        ))}
      </div>

      {subTab === 'orders' ? <PurchaseOrdersView /> : <GermanDropWalletView />}
    </div>
  );
}
