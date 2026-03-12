import React, { useState, useEffect } from 'react';
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

function fmtDate(d) {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
}

function _fmt(n) {
  if (n == null) return '—';
  return '$' + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function daysBetween(d1, d2) {
  if (!d1 || !d2) return null;
  const diff = (new Date(d2) - new Date(d1)) / (1000 * 60 * 60 * 24);
  return Math.round(diff);
}

// ─── Refunds Sub-tab ──────────────────────────────────────────────────────────
function RefundsView({ dateRange }) {
  const [refunds, setRefunds]     = useState([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);
  const [search, setSearch]       = useState('');
  const [sortField, setSortField] = useState('refund_date');
  const [sortDir, setSortDir]     = useState('desc');
  const { mc, mn } = useDemoMask();

  useEffect(() => {
    load();
  }, [dateRange]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ store: 'au' });
      if (dateRange?.start) params.set('start_date', dateRange.start);
      if (dateRange?.end)   params.set('end_date',   dateRange.end);
      const data = await apiFetch(`/api/cogs/refunds?${params}`);
      setRefunds(data || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  const filtered = refunds.filter(r => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (r.sku || '').toLowerCase().includes(q) ||
      (r.product_name || '').toLowerCase().includes(q) ||
      (r.order_number || r.shopify_order_id || '').toLowerCase().includes(q)
    );
  });

  const sorted = [...filtered].sort((a, b) => {
    let av = a[sortField], bv = b[sortField];
    if (av == null) av = '';
    if (bv == null) bv = '';
    if (sortDir === 'asc') return av > bv ? 1 : -1;
    return av < bv ? 1 : -1;
  });

  function toggleSort(field) {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('desc'); }
  }

  function SortIcon({ field }) {
    if (sortField !== field) return <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>↕</span>;
    return <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>;
  }

  // Summary stats
  const totalRefunds    = sorted.length;
  const totalUnits      = sorted.reduce((s, r) => s + (r.quantity_refunded || 0), 0);
  const totalValue      = sorted.reduce((s, r) => s + (parseFloat(r.refund_subtotal) || 0), 0);
  const avgDaysToRefund = (() => {
    const valid = sorted.filter(r => r.order_date && r.refund_date);
    if (!valid.length) return null;
    return Math.round(valid.reduce((s, r) => s + daysBetween(r.order_date, r.refund_date), 0) / valid.length);
  })();

  // Group by SKU for summary
  const bySku = {};
  for (const r of sorted) {
    if (!bySku[r.sku]) bySku[r.sku] = { sku: r.sku, product_name: r.product_name, count: 0, units: 0, value: 0 };
    bySku[r.sku].count++;
    bySku[r.sku].units += r.quantity_refunded || 0;
    bySku[r.sku].value += parseFloat(r.refund_subtotal) || 0;
  }
  const skuSummary = Object.values(bySku).sort((a, b) => b.units - a.units);

  return (
    <div>
      {/* Summary cards */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
        {[
          { label: 'Total Refunds', value: mn(totalRefunds), sub: 'transactions' },
          { label: 'Units Returned', value: mn(totalUnits), sub: 'items' },
          { label: 'Refund Value', value: mc(_fmt(totalValue)), sub: 'ex GST' },
          { label: 'Avg Days to Refund', value: avgDaysToRefund != null ? mn(`${avgDaysToRefund}d`) : '—', sub: 'order → refund' },
        ].map(c => (
          <div key={c.label} style={{
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderRadius: 10, padding: '16px 20px', minWidth: 160, flex: 1,
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 6 }}>{c.label}</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{c.value}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{c.sub}</div>
          </div>
        ))}
      </div>

      {/* SKU breakdown */}
      {skuSummary.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 10 }}>By SKU</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {skuSummary.map(s => (
              <div key={s.sku} style={{
                background: 'var(--bg-card)', border: '1px solid var(--border)',
                borderRadius: 8, padding: '10px 14px', fontSize: 13,
              }}>
                <span style={{ fontWeight: 600 }}>{s.sku}</span>
                <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>{mn(s.units)} units</span>
                <span style={{ color: '#ef4444', marginLeft: 8 }}>{mc(_fmt(s.value))}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Search + table */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
          Refund Transactions {sorted.length > 0 && `(${sorted.length})`}
        </div>
        <input
          placeholder="Search SKU, order #..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            padding: '6px 12px', borderRadius: 6, fontSize: 13,
            border: '1px solid var(--border)', background: 'var(--bg)',
            width: 220, outline: 'none',
          }}
        />
      </div>

      {error && <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 12 }}>{error}</div>}

      {loading ? (
        <div className="text-muted" style={{ fontSize: 13, padding: 16 }}>Loading refunds…</div>
      ) : sorted.length === 0 ? (
        <div className="text-muted" style={{ fontSize: 13, padding: 16 }}>No refunds found for this period.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border)' }}>
                {[
                  { label: 'Order #',        field: 'order_number' },
                  { label: 'Order Date',     field: 'order_date' },
                  { label: 'Refund Date',    field: 'refund_date' },
                  { label: 'Days to Refund', field: null },
                  { label: 'SKU',            field: 'sku' },
                  { label: 'Product',        field: 'product_name' },
                  { label: 'Qty',            field: 'quantity_refunded' },
                  { label: 'Refund Value',   field: 'refund_subtotal' },
                ].map(col => (
                  <th
                    key={col.label}
                    onClick={() => col.field && toggleSort(col.field)}
                    style={{
                      padding: '8px 10px 10px', textAlign: col.label === 'Qty' || col.label === 'Refund Value' ? 'right' : 'left',
                      fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em',
                      color: 'var(--text-muted)', cursor: col.field ? 'pointer' : 'default',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {col.label}{col.field && <SortIcon field={col.field} />}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => {
                const days = daysBetween(r.order_date, r.refund_date);
                const daysColor = days == null ? 'var(--text-muted)' : days > 30 ? '#ef4444' : days > 14 ? '#f59e0b' : '#16a34a';
                return (
                  <tr key={`${r.shopify_refund_id}-${r.sku}-${i}`} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 10px' }}>
                      <span className="mono" style={{ fontSize: 12 }}>
                        #{r.order_number || r.shopify_order_id}
                      </span>
                    </td>
                    <td style={{ padding: '8px 10px', color: 'var(--text-muted)' }}>{fmtDate(r.order_date)}</td>
                    <td style={{ padding: '8px 10px', color: 'var(--text-muted)' }}>{fmtDate(r.refund_date)}</td>
                    <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                      {days != null ? (
                        <span style={{ fontSize: 12, fontWeight: 600, color: daysColor }}>{mn(`${days}d`)}</span>
                      ) : '—'}
                    </td>
                    <td style={{ padding: '8px 10px', fontWeight: 600 }}>{r.sku}</td>
                    <td style={{ padding: '8px 10px', color: 'var(--text-muted)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.product_name}</td>
                    <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600 }}>{mn(r.quantity_refunded)}</td>
                    <td style={{ padding: '8px 10px', textAlign: 'right', color: '#ef4444', fontWeight: 600 }}>{mc(_fmt(r.refund_subtotal))}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid var(--border)', background: 'var(--bg-subtle)' }}>
                <td colSpan={6} style={{ padding: '8px 10px', fontWeight: 700, fontSize: 12 }}>Total</td>
                <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700 }}>{mn(totalUnits)}</td>
                <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color: '#ef4444' }}>{mc(_fmt(totalValue))}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Resends Sub-tab ──────────────────────────────────────────────────────────
function ResendsView({ dateRange }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const { mc, mn, mname } = useDemoMask();

  useEffect(() => {
    if (!dateRange?.start || !dateRange?.end) return;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ store: 'au', start_date: dateRange.start, end_date: dateRange.end });
    apiFetch(`/api/cogs/resends?${params}`)
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [dateRange]);

  const summary = data?.summary || { total_resends: 0, total_units_resent: 0, total_estimated_cogs: 0 };
  const orders = data?.orders || [];
  const avgCostPerResend = summary.total_resends > 0
    ? Math.round(summary.total_estimated_cogs / summary.total_resends * 100) / 100
    : 0;

  const locationLabel = (loc) => {
    const l = (loc || '').toLowerCase();
    if (l.includes('southern cross') || l.includes('beverley')) return <span style={{ color: '#06b6d4', fontWeight: 600 }}>SCC</span>;
    if (l.includes('gd-fulfillment')) return <span style={{ color: '#8b5cf6', fontWeight: 600 }}>GD</span>;
    return <span style={{ color: 'var(--text-muted)' }}>Self</span>;
  };

  return (
    <div>
      {/* Summary cards */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
        {[
          { label: 'Total Resends', value: mn(summary.total_resends), sub: 'orders' },
          { label: 'Units Resent', value: mn(summary.total_units_resent), sub: 'items' },
          { label: 'Estimated COGS', value: mc(_fmt(summary.total_estimated_cogs)), sub: 'cost of resends' },
          { label: 'Avg Cost per Resend', value: mc(_fmt(avgCostPerResend)), sub: 'per order' },
        ].map(c => (
          <div key={c.label} style={{
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderRadius: 10, padding: '16px 20px', minWidth: 160, flex: 1,
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 6 }}>{c.label}</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{c.value}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{c.sub}</div>
          </div>
        ))}
      </div>

      {error && <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 12 }}>{error}</div>}

      {loading ? (
        <div className="text-muted" style={{ fontSize: 13, padding: 16 }}>Loading resends…</div>
      ) : orders.length === 0 ? (
        <div className="text-muted" style={{ fontSize: 13, padding: 16 }}>No resend orders found for this period.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border)' }}>
                {['Order #', 'Original Order', 'Customer', 'Date', 'SKUs / Products', 'Units', 'Est. COGS', 'Via'].map(h => (
                  <th key={h} style={{
                    padding: '8px 10px 10px', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
                    textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap',
                    textAlign: ['Units', 'Est. COGS'].includes(h) ? 'right' : 'left',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {orders.map(o => (
                <tr key={o.shopify_order_id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 10px' }}>
                    <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>#{o.order_number}</span>
                  </td>
                  <td style={{ padding: '8px 10px' }}>
                    <span className="mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>#{o.original_order_number}</span>
                  </td>
                  <td style={{ padding: '8px 10px', fontSize: 13 }}>{mname(o.customer_name)}</td>
                  <td style={{ padding: '8px 10px', color: 'var(--text-muted)', fontSize: 12 }}>{fmtDate(o.order_date)}</td>
                  <td style={{ padding: '8px 10px', color: 'var(--text-muted)', fontSize: 12, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {o.line_items.map(li => `${li.sku} x${mn(li.qty)}`).join(', ')}
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600 }}>{mn(o.total_units)}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600, color: '#ef4444' }}>{mc(_fmt(o.estimated_cogs))}</td>
                  <td style={{ padding: '8px 10px', fontSize: 12 }}>{locationLabel(o.fulfillment_location)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid var(--border)', background: 'var(--bg-subtle)' }}>
                <td colSpan={5} style={{ padding: '8px 10px', fontWeight: 700, fontSize: 12 }}>Total ({orders.length} resends)</td>
                <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700 }}>{mn(summary.total_units_resent)}</td>
                <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color: '#ef4444' }}>{mc(_fmt(summary.total_estimated_cogs))}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Main RefundsTab ──────────────────────────────────────────────────────────
export default function RefundsTab({ dateRange }) {
  const [subTab, setSubTab] = useState('refunds');

  return (
    <div style={{ padding: '24px 32px' }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {[['refunds', 'Refunds'], ['resends', 'Resends']].map(([key, label]) => (
          <button key={key} onClick={() => setSubTab(key)} style={{
            padding: '7px 18px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer',
            border: '1px solid var(--border)',
            background: subTab === key ? 'var(--accent)' : 'var(--bg-card)',
            color: subTab === key ? '#fff' : 'var(--text)',
          }}>{label}</button>
        ))}
      </div>

      {subTab === 'refunds' ? <RefundsView dateRange={dateRange} /> : <ResendsView dateRange={dateRange} />}
    </div>
  );
}
