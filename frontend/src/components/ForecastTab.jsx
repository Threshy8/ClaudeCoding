import React, { useEffect, useState, useMemo } from 'react';
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Area, ReferenceLine, ReferenceArea,
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

// ─── Status Config ───────────────────────────────────────────────────────────

const STATUS_CONFIG = {
  danger:      { label: 'DANGER',      bg: 'rgba(220,38,38,0.09)',  color: '#dc2626', border: 'rgba(220,38,38,0.22)',  dot: '#dc2626', rowBorder: '#dc2626' },
  order_now:   { label: 'ORDER NOW',   bg: 'rgba(249,115,22,0.09)', color: '#ea580c', border: 'rgba(249,115,22,0.22)', dot: '#f97316', rowBorder: '#f97316' },
  warning:     { label: 'WARNING',     bg: 'rgba(234,179,8,0.09)',  color: '#ca8a04', border: 'rgba(234,179,8,0.22)',  dot: '#eab308', rowBorder: '#eab308' },
  ok:          { label: 'OK',          bg: 'var(--green-dim)',      color: 'var(--green)', border: 'rgba(42,122,75,0.22)',  dot: '#22c55e', rowBorder: '#22c55e' },
  no_movement: { label: 'NO MOVEMENT', bg: 'rgba(148,163,184,0.08)',color: '#64748b', border: 'rgba(148,163,184,0.20)',dot: '#94a3b8', rowBorder: '#cbd5e1' },
};

function StatusBadge({ status }) {
  const c = STATUS_CONFIG[status] || STATUS_CONFIG.ok;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 10px', borderRadius: 20, fontSize: 10, fontWeight: 700,
      letterSpacing: '0.04em', background: c.bg, color: c.color,
      border: `1px solid ${c.border}`, whiteSpace: 'nowrap',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: c.dot }} />
      {c.label}
    </span>
  );
}

const GAP_CONFIG = {
  sufficient:   { label: 'Sufficient',   bg: 'var(--green-dim)',     color: 'var(--green)', border: 'rgba(42,122,75,0.20)' },
  at_risk:      { label: 'At Risk',      bg: 'var(--accent-dim)',    color: 'var(--accent-deep)', border: 'rgba(201,168,76,0.25)' },
  insufficient: { label: 'Insufficient', bg: 'var(--red-dim)',       color: 'var(--red)', border: 'rgba(184,50,50,0.20)' },
};

function GapBadge({ status }) {
  const c = GAP_CONFIG[status] || GAP_CONFIG.sufficient;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', padding: '2px 10px', borderRadius: 20,
      fontSize: 11, fontWeight: 600, background: c.bg, color: c.color,
      border: `1px solid ${c.border}`,
    }}>{c.label}</span>
  );
}

// ─── Custom Tooltip ──────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const visible = payload.filter(p => p.value != null && p.dataKey !== 'high' && p.dataKey !== 'low');
  if (visible.length === 0) return null;
  return (
    <div style={{
      background: 'var(--bg-card)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-sm)', padding: '12px 16px',
      boxShadow: 'var(--shadow)', fontSize: 12, minWidth: 180,
    }}>
      <div style={{
        fontWeight: 600, marginBottom: 6, fontSize: 11, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.06em',
      }}>{fmtDate(label)}</div>
      {visible.map((p, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 20, lineHeight: 1.8 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 3, borderRadius: 1, background: p.color, display: 'inline-block' }} />
            <span style={{ color: 'var(--text-body)' }}>{p.name}</span>
          </span>
          <span style={{ fontWeight: 600, color: 'var(--text)' }}>{_fmtFull(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Forecast Zone Label ─────────────────────────────────────────────────────

function ForecastLabel({ viewBox }) {
  if (!viewBox) return null;
  return (
    <text
      x={viewBox.x + (viewBox.width || 0) / 2}
      y={viewBox.y + 28}
      textAnchor="middle"
      fill="rgba(201,168,76,0.18)"
      fontSize={11}
      fontWeight={700}
      letterSpacing="0.2em"
      fontFamily="var(--font-sans)"
    >
      FORECAST
    </text>
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

  const { chartData, forecastStart, forecastEnd } = useMemo(() => {
    if (!data) return { chartData: [], forecastStart: null, forecastEnd: null };

    const hist = data.historical.map(h => ({
      date: h.date,
      revenue: h.revenue,
      rolling7d: h.rolling_7d,
    }));

    const proj = data.forecast.map(f => ({
      date: f.date,
      projected: f.projected,
      band: [f.low, f.high],
    }));

    // Bridge point: connect rolling avg to projected line
    const lastHist = hist[hist.length - 1];
    if (lastHist && proj.length > 0) {
      const bridgeVal = lastHist.rolling7d || lastHist.revenue;
      proj.unshift({
        date: lastHist.date,
        projected: bridgeVal,
        band: [bridgeVal, bridgeVal],
      });
    }

    return {
      chartData: [...hist, ...proj.slice(1)],
      forecastStart: proj.length > 1 ? proj[1].date : null,
      forecastEnd: proj.length > 0 ? proj[proj.length - 1].date : null,
    };
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

        {/* Legend */}
        <div style={{ display: 'flex', gap: 20, marginBottom: 16, flexWrap: 'wrap' }}>
          {[
            { color: 'var(--accent)', label: 'Daily Revenue', dash: false },
            { color: 'var(--accent-deep)', label: '7-Day Avg', dash: false },
            { color: '#E8B931', label: 'Projected', dash: true },
          ].map(l => (
            <span key={l.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)' }}>
              <span style={{
                width: 16, height: 3, borderRadius: 1, background: l.color, display: 'inline-block',
                ...(l.dash ? { backgroundImage: `repeating-linear-gradient(90deg, ${l.color} 0px, ${l.color} 4px, transparent 4px, transparent 7px)`, background: 'none' } : {}),
              }} />
              {l.label}
            </span>
          ))}
        </div>

        <div style={{ width: '100%', height: 360 }}>
          <ResponsiveContainer>
            <ComposedChart data={chartData} margin={{ top: 10, right: 20, bottom: 10, left: 10 }}>
              <CartesianGrid
                strokeDasharray="none"
                stroke="var(--border-light)"
                strokeOpacity={0.7}
                vertical={false}
              />
              <XAxis
                dataKey="date"
                tickFormatter={fmtShortDate}
                tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                tickLine={false}
                axisLine={{ stroke: 'var(--border)' }}
                interval={13}
              />
              <YAxis
                tickFormatter={v => `$${Math.round(v / 1000)}k`}
                tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                tickLine={false}
                axisLine={false}
                width={48}
              />
              <Tooltip content={<ChartTooltip />} />

              {/* Forecast zone shading */}
              {forecastStart && forecastEnd && (
                <ReferenceArea
                  x1={forecastStart}
                  x2={forecastEnd}
                  fill="rgba(201,168,76,0.04)"
                  fillOpacity={1}
                  label={<ForecastLabel />}
                />
              )}

              {/* Today line */}
              <ReferenceLine
                x={today}
                stroke="var(--accent)"
                strokeWidth={1.5}
                strokeDasharray="4 3"
                label={{
                  value: 'Today',
                  position: 'insideTopRight',
                  fill: 'var(--accent-deep)',
                  fontSize: 10,
                  fontWeight: 600,
                  dy: -4,
                }}
              />

              {/* Confidence band */}
              <Area
                dataKey="band"
                stroke="none"
                fill="rgba(201,168,76,0.10)"
                fillOpacity={1}
                connectNulls={false}
                dot={false}
                activeDot={false}
                legendType="none"
                name="Confidence"
              />

              {/* Daily revenue */}
              <Line
                dataKey="revenue"
                name="Daily Revenue"
                stroke="var(--accent)"
                strokeWidth={1.5}
                strokeOpacity={0.6}
                dot={false}
                connectNulls={false}
              />
              {/* 7d rolling */}
              <Line
                dataKey="rolling7d"
                name="7-Day Avg"
                stroke="var(--accent-deep)"
                strokeWidth={2.5}
                dot={false}
                connectNulls={false}
              />
              {/* Projected */}
              <Line
                dataKey="projected"
                name="Projected"
                stroke="#E8B931"
                strokeWidth={2.5}
                strokeDasharray="8 5"
                dot={false}
                connectNulls={false}
              />
            </ComposedChart>
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

  const daysColor = (d) => {
    if (d == null) return 'var(--text-dim)';
    if (d < 60) return '#dc2626';
    if (d < 90) return '#ea580c';
    return 'var(--green)';
  };

  return (
    <div>
      {urgentCount > 0 && (
        <div style={{
          background: 'linear-gradient(135deg, rgba(220,38,38,0.04) 0%, rgba(220,38,38,0.08) 100%)',
          border: '1px solid rgba(220,38,38,0.15)', borderRadius: 'var(--radius)',
          padding: '16px 22px', marginBottom: 20, fontSize: 13,
          display: 'flex', alignItems: 'center', gap: 14,
          boxShadow: '0 1px 4px rgba(220,38,38,0.06)',
        }}>
          <span style={{
            width: 36, height: 36, borderRadius: '50%',
            background: 'rgba(220,38,38,0.10)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            fontSize: 16,
          }}>⚠</span>
          <div>
            <div style={{ fontWeight: 700, color: '#991b1b', marginBottom: 2 }}>
              Reorder Alert — {urgentCount} SKU{urgentCount > 1 ? 's' : ''}
            </div>
            <div style={{ color: '#b91c1c', fontSize: 12 }}>
              Stockout projected within lead time window. Review and place orders soon.
            </div>
          </div>
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
                <th style={{ width: 4, padding: 0 }}></th>
                <th>SKU</th>
                <th>Product</th>
                <th className="text-right">In Stock</th>
                <th className="text-right">Velocity</th>
                <th className="text-right">Days to Stockout</th>
                <th>Reorder By</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.map(row => {
                const sc = STATUS_CONFIG[row.status] || STATUS_CONFIG.ok;
                return (
                  <tr key={row.sku}>
                    <td style={{
                      width: 4, padding: 0,
                      background: sc.rowBorder,
                      borderBottom: '1px solid var(--bg-card)',
                    }}></td>
                    <td><span className="mono">{row.sku}</span></td>
                    <td>{row.product_name}</td>
                    <td className="text-right" style={{ fontWeight: 600 }}>{mn(row.quantity_remaining)}</td>
                    <td className="text-right">
                      {row.daily_velocity > 0
                        ? <span>
                            <span style={{ fontWeight: 600 }}>{mn(row.daily_velocity)}</span>
                            <span style={{ color: 'var(--text-dim)', fontSize: 10, marginLeft: 2 }}>/day</span>
                          </span>
                        : <span style={{ color: 'var(--text-dim)' }}>—</span>
                      }
                    </td>
                    <td className="text-right">
                      {row.days_until_stockout != null
                        ? <span style={{
                            fontWeight: 700, fontSize: 14,
                            color: daysColor(row.days_until_stockout),
                          }}>
                            {mn(row.days_until_stockout)}
                          </span>
                        : <span style={{ color: 'var(--text-dim)', fontSize: 16 }}>∞</span>
                      }
                    </td>
                    <td>
                      {row.reorder_by_date
                        ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <span style={{
                              fontWeight: 600, fontSize: 12,
                              color: row.reorder_by_date <= today ? '#dc2626' : 'var(--text-body)',
                            }}>
                              {fmtDate(row.reorder_by_date)}
                            </span>
                            {row.reorder_by_date <= today && (
                              <span style={{
                                padding: '2px 8px', borderRadius: 20,
                                fontSize: 9, fontWeight: 700,
                                background: '#dc2626', color: '#fff',
                                letterSpacing: '0.04em',
                              }}>OVERDUE</span>
                            )}
                          </span>
                        : <span style={{ color: 'var(--text-dim)' }}>—</span>
                      }
                    </td>
                    <td><StatusBadge status={row.status} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Section 3: Peak Period Comparison ───────────────────────────────────────

function PeakPeriod({ mc, mn }) {
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

  const [didLoad, setDidLoad] = useState(false);
  useEffect(() => {
    if (!didLoad) { fetchData(); setDidLoad(true); }
  }, [didLoad]); // eslint-disable-line

  return (
    <div>
      {/* Date range selector */}
      <div className="card" style={{ marginBottom: 20, padding: '16px 22px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <span style={{
            fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
            letterSpacing: '0.14em', color: 'var(--text-muted)',
          }}>
            Compare Period
          </span>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: 'var(--bg)', borderRadius: 'var(--radius-sm)',
            padding: '4px 8px', border: '1px solid var(--border-light)',
          }}>
            <input
              type="date"
              value={periodStart}
              onChange={e => setPeriodStart(e.target.value)}
              style={{
                padding: '5px 8px', fontSize: 13, borderRadius: 4, width: 'auto',
                border: 'none', background: 'transparent',
              }}
            />
            <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>→</span>
            <input
              type="date"
              value={periodEnd}
              onChange={e => setPeriodEnd(e.target.value)}
              style={{
                padding: '5px 8px', fontSize: 13, borderRadius: 4, width: 'auto',
                border: 'none', background: 'transparent',
              }}
            />
          </div>
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
                      <th className="text-right">Peak Units</th>
                      <th className="text-right">Peak Revenue</th>
                      <th className="text-right">Current Stock</th>
                      <th className="text-right">Gap</th>
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
                        <td className="text-right" style={{ fontWeight: 600 }}>{mn(row.current_stock)}</td>
                        <td className="text-right" style={{
                          fontWeight: 700,
                          color: row.stock_gap < 0 ? 'var(--red)' : row.stock_gap === 0 ? 'var(--accent-deep)' : 'var(--green)',
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
      <div style={{ display: 'flex', gap: 8, marginBottom: 24, flexWrap: 'wrap' }}>
        {[
          ['revenue', 'Revenue Forecast'],
          ['stockout', 'Stock Runout'],
          ['peak', 'Peak Period (BFCM)'],
        ].map(([key, label]) => (
          <button key={key} onClick={() => setSection(key)} style={{
            padding: '6px 16px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer',
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
