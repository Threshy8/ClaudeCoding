import React, { useEffect, useState } from 'react';
import { getCogsSummary } from '../api';
import { triggerLabel } from './DateRangePicker';

function fmt(n) {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(n || 0);
}

export default function Dashboard({ dateRange }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!dateRange?.start || !dateRange?.end) return;
    setLoading(true);
    setError(null);
    getCogsSummary(dateRange)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [dateRange]);

  if (loading) return <div className="loading">Loading dashboard…</div>;
  if (error)   return <div className="error-msg">{error}</div>;
  if (!data)   return null;

  const margin = data.gross_margin_pct;
  const marginClass = margin >= 30 ? 'green' : margin >= 10 ? 'accent' : 'red';
  const rangeLabel = triggerLabel(dateRange);

  return (
    <div>
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">Revenue</div>
          <div className="kpi-value">{fmt(data.total_revenue)}</div>
          <div className="kpi-sub">{rangeLabel}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">True COGS</div>
          <div className="kpi-value red">{fmt(data.total_cogs)}</div>
          <div className="kpi-sub">Units sold × avg cost</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Inventory Asset Value</div>
          <div className="kpi-value accent">{fmt(data.total_inventory_value)}</div>
          <div className="kpi-sub">Stock on hand</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Gross Margin</div>
          <div className={`kpi-value ${marginClass}`}>{margin != null ? `${margin}%` : '—'}</div>
          <div className="kpi-sub">(Revenue − COGS) / Revenue</div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">SKU Breakdown — {rangeLabel}</div>
        {data.sku_breakdown.length === 0 ? (
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
                {data.sku_breakdown.map((row) => {
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
                      <td className="text-right">
                        {m != null ? <span className={`badge ${mClass}`}>{m}%</span> : <span className="text-muted">—</span>}
                      </td>
                      <td className="text-right">{row.units_on_hand}</td>
                      <td className="text-right">{fmt(row.inventory_value)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
