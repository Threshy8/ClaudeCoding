import React, { useEffect, useState, useRef } from 'react';
import { getCogsSummary } from '../api';
import { triggerLabel } from './DateRangePicker';
import { useDemoMask } from '../contexts/DemoModeContext';

const BASE_URL = process.env.REACT_APP_API_URL || '';

async function apiFetch(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function _fmt(n) {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(n || 0);
}

function fmtDate(d) {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
}

function MarginBadge({ pct }) {
  const { mp } = useDemoMask();
  if (pct == null) return <span className="text-muted">—</span>;
  const cls = pct >= 30 ? 'badge-green' : pct >= 10 ? 'badge-yellow' : 'badge-red';
  return <span className={`badge ${cls}`}>{mp(pct)}</span>;
}

function CogsSourceBadge({ isFifo }) {
  return (
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
  );
}

function CostTooltip({ entry }) {
  const [show, setShow] = useState(false);
  const ref = useRef(null);
  const { mc } = useDemoMask();

  if (!entry) return null;

  const purchase = parseFloat(entry.purchase_cost) || 0;
  const shipping = parseFloat(entry.gd_shipping) || 0;
  const handling = parseFloat(entry.scc_handling) || 0;
  const total = purchase + shipping + handling;

  return (
    <span ref={ref} style={{ position: 'relative', cursor: 'help' }}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {mc(_fmt(total))}
      {show && (
        <div style={{
          position: 'absolute', bottom: '100%', right: 0, marginBottom: 6,
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 8, padding: '10px 14px', boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
          whiteSpace: 'nowrap', zIndex: 100, fontSize: 12, lineHeight: 1.8,
          minWidth: 180,
        }}>
          <div style={{ fontWeight: 700, marginBottom: 4, color: 'var(--text)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Cost breakdown</div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Purchase cost</span><span style={{ fontWeight: 600 }}>{mc(_fmt(purchase))}</span></div>
          {shipping > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>GD shipping</span><span style={{ fontWeight: 600 }}>{mc(_fmt(shipping))}</span></div>}
          {handling > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>SCC handling</span><span style={{ fontWeight: 600 }}>{mc(_fmt(handling))}</span></div>}
          <div style={{ borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4, display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}><span>Total COGS</span><span>{mc(_fmt(total))}</span></div>
        </div>
      )}
    </span>
  );
}

function SkuView({ data, rangeLabel, fifoMap, isFifo }) {
  const { mc, mn } = useDemoMask();
  const rows = (data.sku_breakdown || []).filter(r => !(r.sku || '').toLowerCase().includes('x-redo'));
  const sortedRows = [...rows].sort((a, b) => b.revenue - a.revenue);
  const totalUnits  = rows.reduce((s, r) => s + r.units_sold, 0);
  const totalRev    = rows.reduce((s, r) => s + r.revenue, 0);
  const totalCogs   = rows.reduce((s, r) => s + (isFifo && fifoMap[r.sku] ? fifoMap[r.sku].total_cogs : r.cogs), 0);
  const totalProfit = totalRev - totalCogs;
  const totalMargin = totalRev > 0 ? Math.round(totalProfit / totalRev * 100) : null;

  return (
    <div className="card">
      <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        Sales & COGS by SKU — {rangeLabel}
        <CogsSourceBadge isFifo={isFifo} />
      </div>
      {sortedRows.length === 0 ? (
        <div className="empty">No sales data for this period.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>SKU</th><th>Product</th>
                <th className="text-right">Units Sold</th><th className="text-right">Avg Unit Cost</th>
                <th className="text-right">Revenue</th><th className="text-right">COGS</th>
                <th className="text-right">Gross Profit</th><th className="text-right">Margin %</th>
                <th className="text-right">Units on Hand</th><th className="text-right">Inv. Value</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row) => {
                const fifoEntry = fifoMap[row.sku];
                const cogs = isFifo && fifoEntry ? fifoEntry.total_cogs : row.cogs;
                const avgCost = isFifo && fifoEntry && fifoEntry.units_sold > 0
                  ? fifoEntry.total_cogs / fifoEntry.units_sold
                  : row.avg_unit_cost;
                const profit = row.revenue - cogs;
                const margin = row.revenue > 0 ? Math.round(profit / row.revenue * 100) : null;
                return (
                  <tr key={row.sku}>
                    <td><span className="mono">{row.sku}</span></td>
                    <td>{row.product_name}</td>
                    <td className="text-right">{mn(row.units_sold)}</td>
                    <td className="text-right">{mc(_fmt(avgCost))}</td>
                    <td className="text-right">{mc(_fmt(row.revenue))}</td>
                    <td className="text-right">
                      {isFifo && fifoEntry
                        ? <CostTooltip entry={fifoEntry} />
                        : mc(_fmt(cogs))
                      }
                    </td>
                    <td className="text-right" style={{ color: profit >= 0 ? 'var(--green)' : 'var(--red)' }}>{mc(_fmt(profit))}</td>
                    <td className="text-right"><MarginBadge pct={margin != null ? margin : row.gross_margin_pct} /></td>
                    <td className="text-right">{mn(row.units_on_hand)}</td>
                    <td className="text-right">{mc(_fmt(row.inventory_value))}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid var(--border-light)', fontWeight: 700 }}>
                <td colSpan={2} style={{ color: 'var(--text-muted)', fontSize: 12 }}>TOTAL</td>
                <td className="text-right">{mn(totalUnits)}</td><td></td>
                <td className="text-right">{mc(_fmt(totalRev))}</td>
                <td className="text-right">{mc(_fmt(totalCogs))}</td>
                <td className="text-right" style={{ color: totalProfit >= 0 ? 'var(--green)' : 'var(--red)' }}>{mc(_fmt(totalProfit))}</td>
                <td className="text-right"><MarginBadge pct={totalMargin} /></td>
                <td className="text-right">{mn(rows.reduce((s, r) => s + r.units_on_hand, 0))}</td>
                <td className="text-right">{mc(_fmt(data.total_inventory_value))}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

function OrderView({ dateRange, rangeLabel }) {
  const [orders, setOrders]   = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const [expandedId, setExpanded] = useState(null);
  const { mc, mn, mname } = useDemoMask();

  useEffect(() => {
    if (!dateRange?.start || !dateRange?.end) return;
    setLoading(true);
    setError(null);
    apiFetch(`/api/cogs/orders?start_date=${dateRange.start}&end_date=${dateRange.end}&store=au`)
      .then(setOrders)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [dateRange]);

  if (loading) return <div className="loading">Loading orders…</div>;
  if (error)   return <div className="error-msg">{error}</div>;

  const totalRev    = orders.reduce((s, o) => s + o.total_revenue, 0);
  const totalCogs   = orders.reduce((s, o) => s + o.total_cogs, 0);
  const totalProfit = totalRev - totalCogs;
  const totalMargin = totalRev > 0 ? Math.round(totalProfit / totalRev * 100) : null;

  const locationLabel = (loc) => {
    const l = (loc || '').toLowerCase();
    if (l.includes('southern cross') || l.includes('beverley')) return <span style={{ color: '#06b6d4', fontWeight: 600 }}>SCC</span>;
    if (l.includes('gd-fulfillment')) return <span style={{ color: '#8b5cf6', fontWeight: 600 }}>GD</span>;
    return <span style={{ color: 'var(--text-muted)' }}>Self</span>;
  };

  return (
    <div className="card">
      <div className="card-title">Sales & COGS by Order — {rangeLabel}</div>
      {orders.length === 0 ? (
        <div className="empty">No orders for this period.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th><th>Order #</th><th>Customer</th><th>SKUs</th><th>Via</th>
                <th className="text-right">Units</th><th className="text-right">Revenue</th>
                <th className="text-right">COGS</th><th className="text-right">Gross Profit</th>
                <th className="text-right">Margin %</th><th></th>
              </tr>
            </thead>
            <tbody>
              {orders.map(o => (
                <React.Fragment key={o.shopify_order_id}>
                  <tr style={{ borderBottom: expandedId === o.shopify_order_id ? 'none' : '1px solid var(--border)' }}>
                    <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{fmtDate(o.order_date)}</td>
                    <td><span className="mono" style={{ fontSize: 12 }}>#{o.order_number}</span></td>
                    <td style={{ fontSize: 13 }}>{mname(o.customer_name)}</td>
                    <td style={{ color: 'var(--text-muted)', fontSize: 12, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {o.line_items.map(li => li.sku).join(', ')}
                    </td>
                    <td style={{ fontSize: 12 }}>{locationLabel(o.fulfillment_location)}</td>
                    <td className="text-right">{mn(o.total_units)}</td>
                    <td className="text-right">{mc(_fmt(o.total_revenue))}</td>
                    <td className="text-right">{mc(_fmt(o.total_cogs))}</td>
                    <td className="text-right" style={{ color: o.gross_profit >= 0 ? 'var(--green)' : 'var(--red)' }}>{mc(_fmt(o.gross_profit))}</td>
                    <td className="text-right"><MarginBadge pct={o.gross_margin_pct} /></td>
                    <td>
                      <button className="btn btn-ghost btn-sm" style={{ fontSize: 11 }}
                        onClick={() => setExpanded(expandedId === o.shopify_order_id ? null : o.shopify_order_id)}>
                        {expandedId === o.shopify_order_id ? '▲' : '▼'}
                      </button>
                    </td>
                  </tr>
                  {expandedId === o.shopify_order_id && (
                    <tr>
                      <td colSpan={11} style={{ padding: '0 0 8px 0', background: 'var(--bg-subtle)' }}>
                        <div style={{ padding: '10px 16px' }}>
                          <table style={{ fontSize: 12, width: '100%' }}>
                            <thead>
                              <tr>{['SKU','Product','Qty','Revenue','COGS','Profit'].map(h => (
                                <th key={h} style={{ padding: '4px 8px', fontWeight: 600, color: 'var(--text-muted)', fontSize: 11, textAlign: h==='SKU'||h==='Product'?'left':'right' }}>{h}</th>
                              ))}</tr>
                            </thead>
                            <tbody>
                              {o.line_items.map((li, i) => (
                                <tr key={i}>
                                  <td style={{ padding: '4px 8px', fontWeight: 600 }}>{li.sku}</td>
                                  <td style={{ padding: '4px 8px', color: 'var(--text-muted)' }}>{li.product_name}</td>
                                  <td style={{ padding: '4px 8px', textAlign: 'right' }}>{mn(li.qty)}</td>
                                  <td style={{ padding: '4px 8px', textAlign: 'right' }}>{mc(_fmt(li.revenue))}</td>
                                  <td style={{ padding: '4px 8px', textAlign: 'right' }}>{mc(_fmt(li.cogs))}</td>
                                  <td style={{ padding: '4px 8px', textAlign: 'right', color: (li.revenue-li.cogs)>=0?'var(--green)':'var(--red)' }}>{mc(_fmt(li.revenue-li.cogs))}</td>
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
              <tr style={{ borderTop: '2px solid var(--border-light)', fontWeight: 700 }}>
                <td colSpan={5} style={{ color: 'var(--text-muted)', fontSize: 12 }}>TOTAL ({orders.length} orders)</td>
                <td className="text-right">{mn(orders.reduce((s, o) => s + o.total_units, 0))}</td>
                <td className="text-right">{mc(_fmt(totalRev))}</td>
                <td className="text-right">{mc(_fmt(totalCogs))}</td>
                <td className="text-right" style={{ color: totalProfit >= 0 ? 'var(--green)' : 'var(--red)' }}>{mc(_fmt(totalProfit))}</td>
                <td className="text-right"><MarginBadge pct={totalMargin} /></td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

export default function SalesCogsTab({ dateRange }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [view, setView]       = useState('sku');
  const [fifoMap, setFifoMap] = useState({});
  const [isFifo, setIsFifo]   = useState(false);
  const { mc, mp } = useDemoMask();

  useEffect(() => {
    if (!dateRange?.start || !dateRange?.end) return;
    setLoading(true);
    setError(null);
    setIsFifo(false);
    setFifoMap({});

    const summaryPromise = getCogsSummary(dateRange);
    const fifoPromise = apiFetch(`/api/cogs/entries?start_date=${dateRange.start}&end_date=${dateRange.end}&store=au`)
      .catch(() => null);

    Promise.all([summaryPromise, fifoPromise])
      .then(([summaryData, fifoData]) => {
        setData(summaryData);

        // Build FIFO map by SKU if entries exist
        if (fifoData && Array.isArray(fifoData) && fifoData.length > 0) {
          const map = {};
          for (const e of fifoData) {
            if (!map[e.sku]) {
              map[e.sku] = { total_cogs: 0, units_sold: 0, purchase_cost: 0, gd_shipping: 0, scc_handling: 0 };
            }
            const qty = e.quantity_sold || 0;
            const unitCost = parseFloat(e.unit_cost) || 0;
            const gdShip = parseFloat(e.gd_shipping_per_unit) || 0;
            const sccHandle = parseFloat(e.scc_handling_per_unit) || 0;
            map[e.sku].units_sold += qty;
            map[e.sku].purchase_cost += qty * unitCost;
            map[e.sku].gd_shipping += qty * gdShip;
            map[e.sku].scc_handling += qty * sccHandle;
            map[e.sku].total_cogs += qty * (unitCost + gdShip + sccHandle);
          }
          // Round all values
          for (const sku of Object.keys(map)) {
            for (const k of Object.keys(map[sku])) {
              map[sku][k] = Math.round(map[sku][k] * 100) / 100;
            }
          }
          setFifoMap(map);
          setIsFifo(true);
        }
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [dateRange]);

  if (loading) return <div className="loading">Loading COGS data…</div>;
  if (error)   return <div className="error-msg">{error}</div>;
  if (!data)   return null;

  const rangeLabel = triggerLabel(dateRange);
  const skuRows    = (data.sku_breakdown || []).filter(r => !(r.sku || '').toLowerCase().includes('x-redo'));
  const totalRev   = skuRows.reduce((s, r) => s + r.revenue, 0);
  const totalCogs  = skuRows.reduce((s, r) => s + (isFifo && fifoMap[r.sku] ? fifoMap[r.sku].total_cogs : r.cogs), 0);
  const margin     = totalRev > 0 ? Math.round((totalRev - totalCogs) / totalRev * 100) : 0;

  return (
    <div>
      <div className="kpi-grid" style={{ marginBottom: 24 }}>
        {[
          { label: 'Period Revenue', value: mc(_fmt(totalRev)), cls: '' },
          { label: 'Period COGS',    value: mc(_fmt(totalCogs)), cls: 'red' },
          { label: 'Gross Profit',   value: mc(_fmt(totalRev - totalCogs)), cls: 'green' },
          { label: 'Gross Margin',   value: mp(margin), cls: margin >= 30 ? 'green' : margin >= 10 ? 'accent' : 'red' },
        ].map(c => (
          <div key={c.label} className="kpi-card">
            <div className="kpi-label">{c.label}</div>
            <div className={`kpi-value ${c.cls}`}>{c.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
        {[['sku', 'By SKU'], ['order', 'By Order']].map(([key, label]) => (
          <button key={key} onClick={() => setView(key)} style={{
            padding: '6px 16px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer',
            border: '1px solid var(--border)',
            background: view === key ? 'var(--accent)' : 'var(--bg-card)',
            color: view === key ? '#fff' : 'var(--text)',
          }}>{label}</button>
        ))}
      </div>

      {view === 'sku'
        ? <SkuView data={{ ...data, sku_breakdown: skuRows }} rangeLabel={rangeLabel} fifoMap={fifoMap} isFifo={isFifo} />
        : <OrderView dateRange={dateRange} rangeLabel={rangeLabel} />
      }

      <div style={{ marginTop: 16, padding: '12px 16px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
        <strong style={{ color: 'var(--text)' }}>
          {isFifo ? 'FIFO Cost Method:' : 'Average Cost Method:'}
        </strong>{' '}
        {isFifo
          ? 'Unit cost determined by First-In-First-Out from purchase orders. COGS = purchase cost + GD shipping + SCC handling. Hover COGS values for breakdown.'
          : 'Unit cost = weighted average of all purchases. COGS = units sold × average unit cost. Inventory value = units on hand × average unit cost.'
        }
      </div>
    </div>
  );
}
