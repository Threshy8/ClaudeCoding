import React, { useEffect, useState } from 'react';
import { useDemoMask } from '../contexts/DemoModeContext';

const BASE_URL = process.env.REACT_APP_API_URL || '';

async function apiFetch(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function _fmt(n) {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);
}

function fmtRangeLabel(dateRange) {
  if (dateRange.label && dateRange.label !== 'Custom') return dateRange.label;
  if (!dateRange.start || !dateRange.end) return 'Select range';
  const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmt = (iso) => {
    const d = new Date(iso + 'T12:00:00');
    return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`;
  };
  if (dateRange.start === dateRange.end) return fmt(dateRange.start);
  return `${fmt(dateRange.start)} – ${fmt(dateRange.end)}`;
}

// Map cryptic NO-SKU identifiers to friendly display names
function friendlyProductName(sku, productName) {
  if (/^NO-SKU-/i.test(sku || '')) {
    // Use product_name if it's meaningful, otherwise map common patterns
    if (productName && !/^NO-SKU/i.test(productName)) return productName;
    return 'Item Personalisation';
  }
  return productName || sku;
}

export default function Dashboard({ dateRange }) {
  const [skuData, setSkuData] = useState(null);
  const [inventory, setInventory] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isFifo, setIsFifo] = useState(false);
  const { mc, mn, mp } = useDemoMask();

  useEffect(() => {
    if (!dateRange?.start || !dateRange?.end) return;
    setLoading(true);
    setError(null);
    setIsFifo(false);

    const params = new URLSearchParams({ start_date: dateRange.start, end_date: dateRange.end, store: 'au' });

    // Fetch FIFO SKU data (fall back to WAC summary if FIFO has no useful cost data)
    const fifoPromise = apiFetch(`/api/cogs/entries/by-sku?${params}`)
      .then(data => {
        const breakdown = data?.sku_breakdown || [];
        const hasCostData = breakdown.some(r => (r.cogs || 0) > 0);
        if (breakdown.length > 0 && hasCostData) {
          setIsFifo(true);
          return data;
        }
        // FIFO has no entries or all COGS are zero — try WAC
        return apiFetch(`/api/cogs/summary?${params}`).then(wac => {
          const wacHasCost = (wac?.sku_breakdown || []).some(r => (r.cogs || 0) > 0);
          if (!wacHasCost && breakdown.length > 0) {
            // WAC also has no cost data — use FIFO anyway (it has revenue)
            setIsFifo(true);
            return data;
          }
          return wac;
        });
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
  const rows = (skuData.sku_breakdown || [])
    .filter(r => !VIRTUAL_SKUS.includes((r.sku || '').toLowerCase()))
    .sort((a, b) => (b.revenue || 0) - (a.revenue || 0));

  // Single source of truth from the backend for the revenue/breakdown figures
  const grossSales = skuData.gross_sales || 0;
  const totalReturns = skuData.total_returns || 0;
  const shippingRevenue = skuData.shipping_revenue || 0;
  const redoFees = skuData.redo_fees || 0;
  const totalCollected = skuData.total_collected || 0;
  const totalCogs = rows.reduce((s, r) => s + (r.cogs || 0), 0);
  const netProductRevenue = grossSales - totalReturns;
  const grossProfit = netProductRevenue - totalCogs;
  const margin = netProductRevenue > 0 ? Math.round(grossProfit / netProductRevenue * 100) : null;
  const marginClass = margin == null ? '' : margin >= 30 ? 'green' : margin >= 10 ? 'accent' : 'red';

  const inventoryValue = inventory?.total_inventory_value ?? skuData.total_inventory_value ?? 0;

  const rangeLabel = fmtRangeLabel(dateRange);

  // Check if we have any cost data at all
  const hasCostData = rows.some(r => (r.cogs || 0) > 0 || (r.avg_unit_cost || 0) > 0);

  return (
    <div>
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">Revenue</div>
          <div className="kpi-value">{mc(_fmt(totalCollected))}</div>
          <div className="kpi-sub">{rangeLabel}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">True COGS</div>
          <div className="kpi-value red">{hasCostData ? mc(_fmt(totalCogs)) : '—'}</div>
          <div className="kpi-sub">{isFifo ? 'FIFO costing' : 'Weighted avg cost'}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Inventory Asset Value</div>
          <div className="kpi-value accent">{mc(_fmt(inventoryValue))}</div>
          <div className="kpi-sub">Stock on hand</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Gross Margin</div>
          <div className={`kpi-value ${marginClass}`}>{margin != null && hasCostData ? mp(margin) : '—'}</div>
          <div className="kpi-sub">(Revenue − COGS) / Revenue</div>
        </div>
      </div>

      {/* Total Sales Breakdown */}
      <div className="card sales-breakdown">
        <div className="card-title">Total Sales Breakdown — {rangeLabel}</div>
        <div className="sb-rows">
          <div className="sb-row">
            <span className="sb-label">Gross Sales</span>
            <span className="sb-value">{mc(_fmt(grossSales))}</span>
          </div>
          {totalReturns > 0 && (
            <div className="sb-row sb-negative">
              <span className="sb-label">Returns</span>
              <span className="sb-value">−{mc(_fmt(totalReturns))}</span>
            </div>
          )}
          {shippingRevenue > 0 && (
            <div className="sb-row">
              <span className="sb-label">Shipping Charges</span>
              <span className="sb-value">{mc(_fmt(shippingRevenue))}</span>
            </div>
          )}
          {redoFees > 0 && (
            <div className="sb-row">
              <span className="sb-label">Redo Fees</span>
              <span className="sb-value">{mc(_fmt(redoFees))}</span>
            </div>
          )}
          <div className="sb-row sb-total">
            <span className="sb-label">Total Collected</span>
            <span className="sb-value">{mc(_fmt(totalCollected))}</span>
          </div>
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
            <table className="sku-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Product</th>
                  <th className="text-right">Units</th>
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
                  const rowHasCost = (row.cogs || 0) > 0 || (avgCost || 0) > 0;
                  const profit = (row.revenue || 0) - (row.cogs || 0);
                  const m = row.revenue > 0 && rowHasCost ? Math.round(profit / row.revenue * 100) : null;
                  const mClass = m == null ? '' : m >= 50 ? 'badge-green' : m >= 20 ? 'badge-yellow' : 'badge-red';
                  const isNoSku = /^NO-SKU-/i.test(row.sku || '');
                  return (
                    <tr key={row.sku}>
                      <td><span className={isNoSku ? 'sku-nosku' : 'mono'}>{isNoSku ? 'CUSTOM' : row.sku}</span></td>
                      <td>{friendlyProductName(row.sku, row.product_name)}</td>
                      <td className="text-right">{mn(row.units_sold)}</td>
                      <td className="text-right">{rowHasCost ? mc(_fmt(avgCost)) : <span className="text-muted">—</span>}</td>
                      <td className="text-right">{mc(_fmt(row.revenue))}</td>
                      <td className="text-right">{rowHasCost ? mc(_fmt(row.cogs)) : <span className="text-muted">—</span>}</td>
                      <td className="text-right">
                        {m != null ? <span className={`badge ${mClass}`}>{mp(m)}</span> : <span className="text-muted">—</span>}
                      </td>
                      <td className="text-right">{mn(row.units_on_hand)}</td>
                      <td className="text-right">{row.inventory_value > 0 ? mc(_fmt(row.inventory_value)) : <span className="text-muted">—</span>}</td>
                    </tr>
                  );
                })}
                {redoFees > 0 && (
                  <tr key="x-redo">
                    <td><span className="sku-virtual">REDO</span></td>
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
                {shippingRevenue > 0 && (
                  <tr key="shipping">
                    <td><span className="sku-virtual">SHIP</span></td>
                    <td>Shipping Charges</td>
                    <td className="text-right"><span className="text-muted">—</span></td>
                    <td className="text-right"><span className="text-muted">—</span></td>
                    <td className="text-right">{mc(_fmt(shippingRevenue))}</td>
                    <td className="text-right"><span className="text-muted">—</span></td>
                    <td className="text-right"><span className="text-muted">—</span></td>
                    <td className="text-right"><span className="text-muted">—</span></td>
                    <td className="text-right"><span className="text-muted">—</span></td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2}>TOTAL</td>
                  <td className="text-right">{mn(rows.reduce((s, r) => s + r.units_sold, 0))}</td>
                  <td></td>
                  <td className="text-right">{mc(_fmt(totalCollected))}</td>
                  <td className="text-right">{hasCostData ? mc(_fmt(totalCogs)) : <span className="text-muted">—</span>}</td>
                  <td className="text-right">
                    {margin != null && hasCostData
                      ? <span className={`badge ${margin >= 50 ? 'badge-green' : margin >= 20 ? 'badge-yellow' : 'badge-red'}`}>{mp(margin)}</span>
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
