import React, { useEffect, useState, useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Area, ReferenceLine,
} from 'recharts';
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

function _fmtFull(n) {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(n || 0);
}

function fmtDate(d) {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
}

function fmtShortDate(d) {
  if (!d) return '';
  const [, m, day] = d.split('-');
  return `${day}/${m}`;
}

// ─── Status Badges ───────────────────────────────────────────────────────────

const STATUS_CONFIG = {
  danger:      { label: 'DANGER',      bg: 'rgba(220,38,38,0.10)',  color: '#dc2626', border: 'rgba(220,38,38,0.25)',  dot: '#dc2626' },
  order_now:   { label: 'ORDER NOW',   bg: 'rgba(249,115,22,0.10)', color: '#ea580c', border: 'rgba(249,115,22,0.25)', dot: '#f97316' },
  warning:     { label: 'WARNING',     bg: 'rgba(234,179,8,0.10)',  color: '#ca8a04', border: 'rgba(234,179,8,0.25)',  dot: '#eab308' },
  ok:          { label: 'OK',          bg: 'rgba(34,197,94,0.10)',  color: '#16a34a', border: 'rgba(34,197,94,0.25)',  dot: '#22c55e' },
  no_movement: { label: 'NO MOVEMENT', bg: 'rgba(148,163,184,0.10)',color: '#64748b', border: 'rgba(148,163,184,0.25)',dot: '#94a3b8' },
};

function StatusBadge({ status }) {
  const c = STATUS_CONFIG[status] || STATUS_CONFIG.ok;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 10px', borderRadius: 12, fontSize: 10, fontWeight: 700,
      letterSpacing: '0.04em', background: c.bg, color: c.color,
      border: `1px solid ${c.border}`, whiteSpace: 'nowrap',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: c.dot }} />
      {c.label}
    </span>
  );
}

const GAP_CONFIG = {
  sufficient:   { label: 'Sufficient',   bg: 'rgba(34,197,94,0.10)',  color: '#16a34a' },
  at_risk:      { label: 'At Risk',      bg: 'rgba(234,179,8,0.10)',  color: '#ca8a04' },
  insufficient: { label: 'Insufficient', bg: 'rgba(220,38,38,0.10)',  color: '#dc2626' },
};

function GapBadge({ status }) {
  const c = GAP_CONFIG[status] || GAP_CONFIG.sufficient;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 9px', borderRadius: 10,
      fontSize: 11, fontWeight: 600, background: c.bg, color: c.color,
    }}>{c.label}</span>
  );
}

// ─── Custom Tooltip ──────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: 'var(--bg-card)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '10px 14px', boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
      fontSize: 12,
    }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{fmtDate(label)}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
          <span style={{ color: p.color }}>{p.name}</span>
          <span style={{ fontWeight: 600 }}>{_fmtFull(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Section 1: Revenue Forecast ─────────────────────────────────────────────

function RevenueForecast({ mc }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    apiFetch('/api/forecast/revenue?store=au')
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const chartData = useMemo(() => {
    if (!data) return [];
    const hist = data.historical.map(h => ({
      date: h.date,
      revenue: h.revenue,
      rolling7d: h.rolling_7d,
    }));
    const proj = data.forecast.map(f => ({
      date: f.date,
      projected: f.projected,
      low: f.low,
      high: f.high,
    }));
    // Bridge: last historical point + first forecast point
    const lastHist = hist[hist.length - 1];
    if (lastHist && proj.length > 0) {
      hist.push({
        date: lastHist.date,
        projected: lastHist.rolling7d || lastHist.revenue,
        low: lastHist.rolling7d || lastHist.revenue,
        high: lastHist.rolling7d || lastHist.revenue,
      });
    }
    return [...hist, ...proj];
  }, [data]);

  if (loading) return <div className="loading">Loading revenue forecast...</div>;
  if (error) return <div className="error-msg">{error}</div>;
  if (!data) return null;

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div>
      <div className="kpi-grid" style={{ marginBottom: 24 }}>
        <div className="kpi-card">
          <div className="kpi-label">Avg Daily Revenue</div>
          <div className="kpi-value">{mc(_fmt(data.summary.avg_daily))}</div>
          <div className="kpi-sub">Last 30 days</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Projected This Month</div>
          <div className="kpi-value accent">{mc(_fmt(data.summary.projected_this_month))}</div>
          <div className="kpi-sub">Actual + forecast remaining days</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Projected Next Month</div>
          <div className="kpi-value">{mc(_fmt(data.summary.projected_next_month))}</div>
          <div className="kpi-sub">Based on 30-day avg</div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Revenue — 90 Day History & 30 Day Forecast</div>
        <div style={{ width: '100%', height: 340 }}>
          <ResponsiveContainer>
            <LineChart data={chartData} margin={{ top: 10, right: 20, bottom: 10, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
              <XAxis
                dataKey="date"
                tickFormatter={fmtShortDate}
                tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                interval={13}
              />
              <YAxis
                tickFormatter={v => `$${Math.round(v / 1000)}k`}
                tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                width={50}
              />
              <Tooltip content={<ChartTooltip />} />
              <ReferenceLine x={today} stroke="var(--text-dim)" strokeDasharray="4 4" label="" />

              {/* Confidence band */}
              <Area
                dataKey="high"
                stroke="none"
                fill="rgba(201,168,76,0.08)"
                fillOpacity={1}
                connectNulls={false}
                dot={false}
                activeDot={false}
                legendType="none"
              />
              <Area
                dataKey="low"
                stroke="none"
                fill="var(--bg-card)"
                fillOpacity={1}
                connectNulls={false}
                dot={false}
                activeDot={false}
                legendType="none"
              />

              {/* Actual revenue */}
              <Line
                dataKey="revenue"
                name="Actual Revenue"
                stroke="var(--accent)"
                strokeWidth={1.5}
                dot={false}
                connectNulls={false}
              />
              {/* 7d rolling */}
              <Line
                dataKey="rolling7d"
                name="7-Day Avg"
                stroke="var(--accent-deep)"
                strokeWidth={2}
                dot={false}
                connectNulls={false}
              />
              {/* Projected */}
              <Line
                dataKey="projected"
                name="Projected"
                stroke="var(--accent-light)"
                strokeWidth={2}
                strokeDasharray="6 4"
                dot={false}
                connectNulls={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

// ─── Section 2: Stock Runout & Reorder Alerts ────────────────────────────────

function StockRunout({ mc, mn }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    apiFetch('/api/forecast/stockout?store=au')
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading">Calculating stockout risk...</div>;
  if (error) return <div className="error-msg">{error}</div>;
  if (!data || data.length === 0) return <div className="empty">No stock data available.</div>;

  const today = new Date().toISOString().slice(0, 10);
  const urgentCount = data.filter(r => r.status === 'danger' || r.status === 'order_now').length;

  return (
    <div>
      {urgentCount > 0 && (
        <div style={{
          background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.18)',
          borderLeft: '3px solid #dc2626', borderRadius: 'var(--radius)',
          padding: '14px 20px', marginBottom: 20, fontSize: 13, color: '#991b1b',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{ fontSize: 18 }}>⚠</span>
          <span>
            <strong>{urgentCount} SKU{urgentCount > 1 ? 's' : ''}</strong> need{urgentCount === 1 ? 's' : ''} immediate reorder attention — stockout within lead time window.
          </span>
        </div>
      )}

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '18px 24px 0' }}>
          <div className="card-title" style={{ marginBottom: 14 }}>Stock Runout & Reorder Alerts</div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>SKU</th>
                <th>Product</th>
                <th className="text-right">In Stock</th>
                <th className="text-right">Daily Velocity</th>
                <th className="text-right">Days Until Stockout</th>
                <th>Reorder By</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.map(row => (
                <tr key={row.sku}>
                  <td><span className="mono">{row.sku}</span></td>
                  <td>{row.product_name}</td>
                  <td className="text-right">{mn(row.quantity_remaining)}</td>
                  <td className="text-right">
                    {row.daily_velocity > 0
                      ? <span>{mn(row.daily_velocity)}<span style={{ color: 'var(--text-dim)', fontSize: 11 }}>/day</span></span>
                      : <span style={{ color: 'var(--text-dim)' }}>—</span>
                    }
                  </td>
                  <td className="text-right">
                    {row.days_until_stockout != null
                      ? <span style={{ fontWeight: 600, color: row.days_until_stockout < 30 ? '#dc2626' : row.days_until_stockout < 90 ? '#ea580c' : 'var(--text)' }}>
                          {mn(row.days_until_stockout)}
                        </span>
                      : <span style={{ color: 'var(--text-dim)' }}>∞</span>
                    }
                  </td>
                  <td>
                    {row.reorder_by_date
                      ? <span style={{
                          fontWeight: 600, fontSize: 12,
                          color: row.reorder_by_date <= today ? '#dc2626' : 'var(--text-body)',
                        }}>
                          {fmtDate(row.reorder_by_date)}
                          {row.reorder_by_date <= today && (
                            <span style={{
                              marginLeft: 6, padding: '1px 6px', borderRadius: 8,
                              fontSize: 9, fontWeight: 700, background: 'rgba(220,38,38,0.10)',
                              color: '#dc2626',
                            }}>OVERDUE</span>
                          )}
                        </span>
                      : <span style={{ color: 'var(--text-dim)' }}>—</span>
                    }
                  </td>
                  <td><StatusBadge status={row.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Section 3: Peak Period Comparison ───────────────────────────────────────

function PeakPeriod({ mc, mn }) {
  // Default to last BFCM
  const [periodStart, setPeriodStart] = useState('2025-11-24');
  const [periodEnd, setPeriodEnd] = useState('2025-12-02');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchData = () => {
    setLoading(true);
    setError(null);
    apiFetch(`/api/forecast/peak-period?store=au&period_start=${periodStart}&period_end=${periodEnd}`)
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  };

  // Load on mount with default BFCM dates
  const [didLoad, setDidLoad] = useState(false);
  useEffect(() => {
    if (!didLoad) { fetchData(); setDidLoad(true); }
  }, [didLoad]); // eslint-disable-line

  return (
    <div>
      {/* Date picker */}
      <div className="card" style={{ marginBottom: 20, padding: '14px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--text-muted)' }}>
            Peak Period
          </span>
          <input
            type="date"
            value={periodStart}
            onChange={e => setPeriodStart(e.target.value)}
            style={{ padding: '6px 10px', fontSize: 13, borderRadius: 6, width: 'auto' }}
          />
          <span style={{ color: 'var(--text-dim)' }}>to</span>
          <input
            type="date"
            value={periodEnd}
            onChange={e => setPeriodEnd(e.target.value)}
            style={{ padding: '6px 10px', fontSize: 13, borderRadius: 6, width: 'auto' }}
          />
          <button
            className="btn btn-primary btn-sm"
            onClick={fetchData}
            disabled={loading}
          >
            Analyse
          </button>
        </div>
      </div>

      {loading && <div className="loading">Analysing peak period...</div>}
      {error && <div className="error-msg">{error}</div>}

      {data && !loading && (
        <>
          {/* KPI summary */}
          <div className="kpi-grid" style={{ marginBottom: 24 }}>
            <div className="kpi-card">
              <div className="kpi-label">Peak Revenue</div>
              <div className="kpi-value">{mc(_fmt(data.total_revenue))}</div>
              <div className="kpi-sub">{fmtDate(periodStart)} – {fmtDate(periodEnd)}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Peak Units Sold</div>
              <div className="kpi-value">{mn(data.total_units)}</div>
              <div className="kpi-sub">Across {(data.sku_breakdown || []).length} SKUs</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Event Capacity</div>
              <div className={`kpi-value ${data.equivalent_events >= 1 ? 'green' : 'red'}`}>
                {data.equivalent_events != null ? `${data.equivalent_events}x` : '—'}
              </div>
              <div className="kpi-sub">Equivalent peak events at current stock</div>
            </div>
          </div>

          {/* Gap Analysis Table */}
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '18px 24px 0' }}>
              <div className="card-title" style={{ marginBottom: 14 }}>
                Stock Gap Analysis — Current Stock vs Peak Demand
              </div>
            </div>
            {(data.gap_analysis || []).length === 0 ? (
              <div className="empty">No sales during this period.</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>Product</th>
                      <th className="text-right">Peak Units Sold</th>
                      <th className="text-right">Peak Revenue</th>
                      <th className="text-right">Current Stock</th>
                      <th className="text-right">Stock Gap</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.gap_analysis.map(row => (
                      <tr key={row.sku}>
                        <td><span className="mono">{row.sku}</span></td>
                        <td>{row.product_name}</td>
                        <td className="text-right">{mn(row.peak_units_sold)}</td>
                        <td className="text-right">{mc(_fmtFull(row.peak_revenue))}</td>
                        <td className="text-right">{mn(row.current_stock)}</td>
                        <td className="text-right" style={{
                          fontWeight: 600,
                          color: row.stock_gap < 0 ? '#dc2626' : row.stock_gap === 0 ? '#ca8a04' : 'var(--green)',
                        }}>
                          {row.stock_gap > 0 ? '+' : ''}{mn(row.stock_gap)}
                        </td>
                        <td><GapBadge status={row.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export default function ForecastTab() {
  const { mc, mn } = useDemoMask();
  const [section, setSection] = useState('revenue');

  return (
    <div>
      {/* Section toggle */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 24, flexWrap: 'wrap' }}>
        {[
          ['revenue', 'Revenue Forecast'],
          ['stockout', 'Stock Runout'],
          ['peak', 'Peak Period (BFCM)'],
        ].map(([key, label]) => (
          <button key={key} onClick={() => setSection(key)} style={{
            padding: '8px 18px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer',
            border: '1px solid var(--border)',
            background: section === key ? 'var(--accent)' : 'var(--bg-card)',
            color: section === key ? '#fff' : 'var(--text)',
            transition: 'all 0.15s',
          }}>{label}</button>
        ))}
      </div>

      {section === 'revenue' && <RevenueForecast mc={mc} />}
      {section === 'stockout' && <StockRunout mc={mc} mn={mn} />}
      {section === 'peak' && <PeakPeriod mc={mc} mn={mn} />}
    </div>
  );
}
