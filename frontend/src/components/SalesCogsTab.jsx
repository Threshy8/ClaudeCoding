import React, { useEffect, useState } from 'react';
import { getCogsSummary } from '../api';

function fmt(n) {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(n || 0);
}

export default function SalesCogsTab({ period }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getCogsSummary(period)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [period]);

  if (loading) return <div className="loading">Loading COGS data…</div>;
  if (error) return <div className="error-msg">{error}</div>;
  if (!data) return null;

  return (
    <div>
      {/* Period KPIs */}
      <div className="kpi-grid" style={{ marginBottom: 24 }}>
        <div className="kpi-card">
          <div className="kpi-label">Period Revenue</div>
          <div className="kpi-value">{fmt(data.total_revenue)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Period COGS</div>
          <div className="kpi-value red">{fmt(data.total_cogs)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Gross Profit</div>
          <div className="kpi-value green">{fmt(data.total_revenue - data.total_cogs)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Gross Margin</div>
          <div className={`kpi-value ${data.gross_margin_pct >= 30 ? 'green' : data.gross_margin_pct >= 10 ? 'accent' : 'red'}`}>
            {data.gross_margin_pct != null ? `${data.gross_margin_pct}%` : '—'}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Sales & COGS by SKU — {period}</div>
        {data.sku_breakdown.length === 0 ? (
          <div className="empty">
            No sales data for {period}. Use the "Sync Shopify" button to pull orders, or check that the period is correct.
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Product</th>
                  <th className="text-right">Units Sold</th>
                  <th className="text-right">Avg Unit Cost</th>
                  <th className="text-right">Revenue</th>
                  <th className="text-right">COGS</th>
                  <th className="text-right">Gross Profit</th>
                  <th className="text-right">Margin %</th>
                  <th className="text-right">Units on Hand</th>
                  <th className="text-right">Inv. Value</th>
                </tr>
              </thead>
              <tbody>
                {data.sku_breakdown.map((row) => {
                  const profit = row.revenue - row.cogs;
                  const m = row.gross_margin_pct;
                  const mClass = m == null ? '' : m >= 30 ? 'badge-green' : m >= 10 ? 'badge-yellow' : 'badge-red';
                  return (
                    <tr key={row.sku}>
                      <td><span className="mono">{row.sku}</span></td>
                      <td>{row.product_name}</td>
                      <td className="text-right">{row.units_sold}</td>
                      <td className="text-right">{fmt(row.avg_unit_cost)}</td>
                      <td className="text-right">{fmt(row.revenue)}</td>
                      <td className="text-right">{fmt(row.cogs)}</td>
                      <td className="text-right" style={{ color: profit >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {fmt(profit)}
                      </td>
                      <td className="text-right">
                        {m != null ? (
                          <span className={`badge ${mClass}`}>{m}%</span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className="text-right">{row.units_on_hand}</td>
                      <td className="text-right">{fmt(row.inventory_value)}</td>
                    </tr>
                  );
                })}
              </tbody>
              {/* Totals row */}
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--border-light)', fontWeight: 700 }}>
                  <td colSpan={2} style={{ color: 'var(--text-muted)', fontSize: 12 }}>TOTAL</td>
                  <td className="text-right">{data.sku_breakdown.reduce((s, r) => s + r.units_sold, 0)}</td>
                  <td></td>
                  <td className="text-right">{fmt(data.total_revenue)}</td>
                  <td className="text-right">{fmt(data.total_cogs)}</td>
                  <td className="text-right" style={{ color: (data.total_revenue - data.total_cogs) >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {fmt(data.total_revenue - data.total_cogs)}
                  </td>
                  <td className="text-right">
                    <span className={`badge ${data.gross_margin_pct >= 30 ? 'badge-green' : data.gross_margin_pct >= 10 ? 'badge-yellow' : 'badge-red'}`}>
                      {data.gross_margin_pct}%
                    </span>
                  </td>
                  <td className="text-right">{data.sku_breakdown.reduce((s, r) => s + r.units_on_hand, 0)}</td>
                  <td className="text-right">{fmt(data.total_inventory_value)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* Explanation */}
      <div style={{ marginTop: 16, padding: '12px 16px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
        <strong style={{ color: 'var(--text)' }}>Average Cost Method:</strong> Unit cost = weighted average of all purchases for each SKU.
        COGS = units sold in period × average unit cost.
        Inventory value = units on hand (purchased − sold all time) × average unit cost.
      </div>
    </div>
  );
}
