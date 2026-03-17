import React, { useEffect, useState } from 'react';
import { triggerLabel } from './DateRangePicker';
import { useDemoMask } from '../contexts/DemoModeContext';

const BASE_URL = process.env.REACT_APP_API_URL || '';

async function apiFetch(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function _fmt(n) {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(n || 0);
}

function toIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function buildDashboardPresets() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const today = toIso(now);
  const pad = (n) => String(n).padStart(2, '0');

  // Monday of this week
  const dayOfWeek = (now.getDay() + 6) % 7; // 0 = Monday
  const monday = new Date(now);
  monday.setDate(now.getDate() - dayOfWeek);
  const weekStart = toIso(monday);

  const thisMonthStart = `${y}-${pad(m + 1)}-01`;

  const lastM = m === 0 ? 11 : m - 1;
  const lastY = m === 0 ? y - 1 : y;
  const lastMonthStart = `${lastY}-${pad(lastM + 1)}-01`;
  const lastMonthEnd = toIso(new Date(y, m, 0));

  const l3m = m - 2;
  const l3y = l3m < 0 ? y - 1 : y;
  const l3mAdj = ((l3m % 12) + 12) % 12;
  const last3Start = `${l3y}-${pad(l3mAdj + 1)}-01`;

  const thisYearStart = `${y}-01-01`;

  return [
    { label: 'Today',         start: today,          end: today },
    { label: 'This Week',     start: weekStart,      end: today },
    { label: 'This Month',    start: thisMonthStart, end: today },
    { label: 'Last Month',    start: lastMonthStart, end: lastMonthEnd },
    { label: 'Last 3 Months', start: last3Start,     end: lastMonthEnd },
    { label: 'This Year',     start: thisYearStart,  end: today },
  ];
}

export default function Dashboard({ dateRange, onDateRangeChange }) {
  const [skuData, setSkuData] = useState(null);
  const [inventory, setInventory] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isFifo, setIsFifo] = useState(false);
  const { mc, mn, mp } = useDemoMask();

  const presets = buildDashboardPresets();

  useEffect(() => {
    if (!dateRange?.start || !dateRange?.end) return;
    setLoading(true);
    setError(null);
    setIsFifo(false);

    const params = new URLSearchParams({ start_date: dateRange.start, end_date: dateRange.end, store: 'au' });

    // Fetch FIFO SKU data (fall back to WAC summary), and inventory in parallel
    const fifoPromise = apiFetch(`/api/cogs/entries/by-sku?${params}`)
      .then(data => {
        if (data?.sku_breakdown?.length > 0) {
          setIsFifo(true);
          return data;
        }
        // Fall back to WAC
        return apiFetch(`/api/cogs/summary?${params}`);
      })
      .catch(() => apiFetch(`/api/cogs/summary?${params}`));

    const invPromise = apiFetch('/api/inventory/summary?store=au').catch(() => null);

    Promise.all([fifoPromise, invPromise])
      .then(([sku, inv]) => {
        setSkuData(sku);
        setInventory(inv);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [dateRange]);

  if (loading) return <div className="loading">Loading dashboard…</div>;
  if (error)   return <div className="error-msg">{error}</div>;
  if (!skuData) return null;

  const VIRTUAL_SKUS = ['x-redo', 'shipping', 'tax'];
  const rows = (skuData.sku_breakdown || []).filter(r => !VIRTUAL_SKUS.includes((r.sku || '').toLowerCase()));
  const totalRevenue = rows.reduce((s, r) => s + (r.revenue || 0), 0);
  const redoFees = skuData.redo_fees || 0;
  const shippingTotal = skuData.shipping_total || 0;
  const taxTotal = skuData.tax_total || 0;
  const totalCollected = totalRevenue + redoFees + shippingTotal + taxTotal;
  const totalCogs = rows.reduce((s, r) => s + (r.cogs || 0), 0);
  const grossProfit = totalRevenue - totalCogs;
  const margin = totalRevenue > 0 ? Math.round(grossProfit / totalRevenue * 100) : null;
  const marginClass = margin == null ? '' : margin >= 30 ? 'green' : margin >= 10 ? 'accent' : 'red';

  const inventoryValue = inventory?.total_inventory_value ?? skuData.total_inventory_value ?? 0;

  const rangeLabel = triggerLabel(dateRange);

  return (
    <div>
      {/* Date range preset buttons + custom date inputs */}
      <div className="dash-range-bar">
        <div className="dash-range-presets">
          {presets.map((p) => (
            <button
              key={p.label}
              className={`dash-range-btn${dateRange.label === p.label ? ' dash-range-active' : ''}`}
              onClick={() => onDateRangeChange({ start: p.start, end: p.end, label: p.label })}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="dash-range-divider" />
        <div className="dash-range-custom">
          <label className="dash-range-label">From</label>
          <input
            type="date"
            className="dash-range-input"
            value={dateRange.start || ''}
            onChange={(e) => {
              const start = e.target.value;
              if (start && dateRange.end && start <= dateRange.end) {
                onDateRangeChange({ start, end: dateRange.end, label: 'Custom' });
              }
            }}
          />
          <label className="dash-range-label">To</label>
          <input
            type="date"
            className="dash-range-input"
            value={dateRange.end || ''}
            onChange={(e) => {
              const end = e.target.value;
              if (end && dateRange.start && end >= dateRange.start) {
                onDateRangeChange({ start: dateRange.start, end, label: 'Custom' });
              }
            }}
          />
        </div>
      </div>

      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">Revenue</div>
          <div className="kpi-value">{mc(_fmt(totalCollected))}</div>
          <div className="kpi-sub">{rangeLabel}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">True COGS</div>
          <div className="kpi-value red">{mc(_fmt(totalCogs))}</div>
          <div className="kpi-sub">{isFifo ? 'FIFO costing' : 'Weighted avg cost'}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Inventory Asset Value</div>
          <div className="kpi-value accent">{mc(_fmt(inventoryValue))}</div>
          <div className="kpi-sub">Stock on hand</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Gross Margin</div>
          <div className={`kpi-value ${marginClass}`}>{margin != null ? mp(margin) : '—'}</div>
          <div className="kpi-sub">(Revenue − COGS) / Revenue</div>
        </div>
      </div>

      <div className="card">
        <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          SKU Breakdown — {rangeLabel}
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 700,
            letterSpacing: '0.04em',
            background: isFifo ? 'rgba(16,185,129,0.12)' : 'rgba(245,158,11,0.12)',
            color: isFifo ? '#059669' : '#d97706',
            border: `1px solid ${isFifo ? 'rgba(16,185,129,0.25)' : 'rgba(245,158,11,0.25)'}`,
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: isFifo ? '#10b981' : '#f59e0b',
            }} />
            {isFifo ? 'FIFO' : 'WAC estimate'}
          </span>
        </div>
        {rows.length === 0 ? (
          <div className="empty">No sales data for this period. Sync Shopify or log purchases first.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Product</th>
                  <th className="text-right">Units Sold</th>
                  <th className="text-right">Avg Cost</th>
                  <th className="text-right">Revenue</th>
                  <th className="text-right">COGS</th>
                  <th className="text-right">Margin</th>
                  <th className="text-right">On Hand</th>
                  <th className="text-right">Inv. Value</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const avgCost = row.units_sold > 0 ? row.cogs / row.units_sold : row.avg_unit_cost || 0;
                  const profit = (row.revenue || 0) - (row.cogs || 0);
                  const m = row.revenue > 0 ? Math.round(profit / row.revenue * 100) : null;
                  const mClass = m == null ? '' : m >= 30 ? 'badge-green' : m >= 10 ? 'badge-yellow' : 'badge-red';
                  return (
                    <tr key={row.sku}>
                      <td><span className="mono">{row.sku}</span></td>
                      <td>{row.product_name}</td>
                      <td className="text-right">{mn(row.units_sold)}</td>
                      <td className="text-right">{mc(_fmt(avgCost))}</td>
                      <td className="text-right">{mc(_fmt(row.revenue))}</td>
                      <td className="text-right">{mc(_fmt(row.cogs))}</td>
                      <td className="text-right">
                        {m != null ? <span className={`badge ${mClass}`}>{mp(m)}</span> : <span className="text-muted">—</span>}
                      </td>
                      <td className="text-right">{mn(row.units_on_hand)}</td>
                      <td className="text-right">{mc(_fmt(row.inventory_value))}</td>
                    </tr>
                  );
                })}
                {redoFees > 0 && (
                  <tr key="x-redo">
                    <td><span className="mono">x-redo</span></td>
                    <td>Redo Returns Fee</td>
                    <td className="text-right">{mn(skuData.redo_units || 0)}</td>
                    <td className="text-right"><span className="text-muted">—</span></td>
                    <td className="text-right">{mc(_fmt(redoFees))}</td>
                    <td className="text-right"><span className="text-muted">—</span></td>
                    <td className="text-right"><span className="text-muted">—</span></td>
                    <td className="text-right"><span className="text-muted">—</span></td>
                    <td className="text-right"><span className="text-muted">—</span></td>
                  </tr>
                )}
                {shippingTotal > 0 && (
                  <tr key="shipping">
                    <td><span className="mono">shipping</span></td>
                    <td>Shipping Charges</td>
                    <td className="text-right"><span className="text-muted">—</span></td>
                    <td className="text-right"><span className="text-muted">—</span></td>
                    <td className="text-right">{mc(_fmt(shippingTotal))}</td>
                    <td className="text-right"><span className="text-muted">—</span></td>
                    <td className="text-right"><span className="text-muted">—</span></td>
                    <td className="text-right"><span className="text-muted">—</span></td>
                    <td className="text-right"><span className="text-muted">—</span></td>
                  </tr>
                )}
                {taxTotal > 0 && (
                  <tr key="tax">
                    <td><span className="mono">tax</span></td>
                    <td>Tax Collected</td>
                    <td className="text-right"><span className="text-muted">—</span></td>
                    <td className="text-right"><span className="text-muted">—</span></td>
                    <td className="text-right">{mc(_fmt(taxTotal))}</td>
                    <td className="text-right"><span className="text-muted">—</span></td>
                    <td className="text-right"><span className="text-muted">—</span></td>
                    <td className="text-right"><span className="text-muted">—</span></td>
                    <td className="text-right"><span className="text-muted">—</span></td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--border-light)', fontWeight: 700 }}>
                  <td colSpan={2} style={{ color: 'var(--text-muted)', fontSize: 12 }}>TOTAL</td>
                  <td className="text-right">{mn(rows.reduce((s, r) => s + r.units_sold, 0))}</td>
                  <td></td>
                  <td className="text-right">{mc(_fmt(totalCollected))}</td>
                  <td className="text-right">{mc(_fmt(totalCogs))}</td>
                  <td className="text-right">
                    {margin != null
                      ? <span className={`badge ${margin >= 30 ? 'badge-green' : margin >= 10 ? 'badge-yellow' : 'badge-red'}`}>{mp(margin)}</span>
                      : <span className="text-muted">—</span>}
                  </td>
                  <td className="text-right">{mn(rows.reduce((s, r) => s + (r.units_on_hand || 0), 0))}</td>
                  <td className="text-right">{mc(_fmt(inventoryValue))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
