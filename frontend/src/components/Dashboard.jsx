import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useDemoMask } from '../contexts/DemoModeContext';
import { apiFetch, formatCurrency as _fmt } from '../utils';

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtRangeLabel(dateRange) {
  if (dateRange.label && dateRange.label !== 'Custom') return dateRange.label;
  if (!dateRange.start || !dateRange.end) return 'Select range';
  const fmt = (iso) => {
    const d = new Date(iso + 'T12:00:00');
    return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`;
  };
  if (dateRange.start === dateRange.end) return fmt(dateRange.start);
  return `${fmt(dateRange.start)} – ${fmt(dateRange.end)}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso + 'T12:00:00');
  return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

// Map cryptic NO-SKU identifiers to friendly display names
function friendlyProductName(sku, productName) {
  if (/^NO-SKU-/i.test(sku || '')) {
    if (productName && !/^NO-SKU/i.test(productName)) return productName;
    return 'Item Personalisation';
  }
  return productName || sku;
}

// Group SKU rows by product_name into product families
function groupByProduct(rows) {
  const groups = {};
  for (const row of rows) {
    const name = friendlyProductName(row.sku, row.product_name);
    if (!groups[name]) {
      groups[name] = { name, variants: [] };
    }
    groups[name].variants.push(row);
  }

  return Object.values(groups).map(g => {
    const units = g.variants.reduce((s, r) => s + (r.units_sold || 0), 0);
    const unitsGross = g.variants.reduce((s, r) => s + (r.units_gross || r.units_sold || 0), 0);
    const unitsReturned = g.variants.reduce((s, r) => s + (r.units_returned || 0), 0);
    const refundDetails = g.variants.flatMap(r => r.refund_details || []);
    const revenue = g.variants.reduce((s, r) => s + (r.revenue || 0), 0);
    const cogs = g.variants.reduce((s, r) => s + (r.cogs || 0), 0);
    const onHand = g.variants.reduce((s, r) => s + (r.units_on_hand || 0), 0);
    const invValue = g.variants.reduce((s, r) => s + (r.inventory_value || 0), 0);
    const hasCost = g.variants.some(r => (r.cogs || 0) > 0 || (r.avg_unit_cost || 0) > 0);
    const avgCost = units > 0 && hasCost ? cogs / units : 0;
    const profit = revenue - cogs;
    const margin = revenue > 0 && hasCost ? Math.round(profit / revenue * 100) : null;

    return {
      name: g.name,
      units,
      unitsGross,
      unitsReturned,
      refundDetails,
      avgCost,
      revenue,
      cogs,
      onHand,
      invValue,
      hasCost,
      margin,
      variants: g.variants.sort((a, b) => (b.revenue || 0) - (a.revenue || 0)),
    };
  }).sort((a, b) => b.revenue - a.revenue);
}

function ReturnPopover({ details, mc }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) close();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, close]);

  if (!details || details.length === 0) return null;

  return (
    <span className="return-popover-anchor" ref={ref}>
      <span
        className="units-return-detail return-popover-trigger"
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
      >
        −{details.reduce((s, d) => s + (d.quantity || 0), 0)} returned
      </span>
      {open && (
        <div className="return-popover">
          <div className="return-popover-title">Return Details</div>
          {details.map((d, i) => (
            <div key={i} className="return-popover-row">
              <div className="return-popover-order">
                #{d.order_number}
                <span className="return-popover-date">{fmtDate(d.refund_date)}</span>
              </div>
              <div className="return-popover-meta">
                <span>{d.quantity} unit{d.quantity !== 1 ? 's' : ''}</span>
                <span className="return-popover-amount">{mc(_fmt(d.refund_amount))}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

export default function Dashboard({ dateRange }) {
  const [skuData, setSkuData] = useState(null);
  const [inventory, setInventory] = useState(null);
  const [freight, setFreight] = useState(null);
  const [payoutData, setPayoutData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isFifo, setIsFifo] = useState(false);
  const [expanded, setExpanded] = useState({});
  const { mc, mn, mp } = useDemoMask();

  const toggleExpand = (name) => {
    setExpanded(prev => ({ ...prev, [name]: !prev[name] }));
  };

  useEffect(() => {
    if (!dateRange?.start || !dateRange?.end) return;
    setLoading(true);
    setError(null);
    setIsFifo(false);

    const params = new URLSearchParams({ start_date: dateRange.start, end_date: dateRange.end, store: 'au' });

    const fifoPromise = apiFetch(`/api/cogs/entries/by-sku?${params}`)
      .then(data => {
        // If backend signals partial FIFO coverage, fall back to summary
        if (data?.partial) return apiFetch(`/api/cogs/summary?${params}`);
        const breakdown = data?.sku_breakdown || [];
        const hasCostData = breakdown.some(r => (r.cogs || 0) > 0);
        if (breakdown.length > 0 && hasCostData) {
          setIsFifo(true);
          return data;
        }
        return apiFetch(`/api/cogs/summary?${params}`).then(wac => {
          const wacHasCost = (wac?.sku_breakdown || []).some(r => (r.cogs || 0) > 0);
          if (!wacHasCost && breakdown.length > 0) {
            setIsFifo(true);
            return data;
          }
          return wac;
        });
      })
      .catch(() => apiFetch(`/api/cogs/summary?${params}`));

    const invPromise = apiFetch('/api/inventory/summary?store=au').catch(() => null);

    const freightParams = new URLSearchParams();
    if (dateRange.start) freightParams.set('start_date', dateRange.start);
    if (dateRange.end)   freightParams.set('end_date', dateRange.end);
    const freightPromise = apiFetch(`/api/3pl/auspost/summary?${freightParams}`).catch(() => null);

    const payoutParams = new URLSearchParams({ start_date: dateRange.start, end_date: dateRange.end });
    const payoutPromise = apiFetch(`/api/payouts?${payoutParams}`).catch(() => null);

    Promise.all([fifoPromise, invPromise, freightPromise, payoutPromise])
      .then(([sku, inv, freight, payouts]) => {
        setSkuData(sku);
        setInventory(inv);
        setFreight(freight);
        setPayoutData(payouts);
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

  const productGroups = groupByProduct(rows);

  const grossSales = skuData.gross_sales || 0;
  const totalDiscounts = skuData.total_discounts || 0;
  const totalReturns = skuData.total_returns || 0;
  const shippingRevenue = skuData.shipping_revenue || 0;
  const redoFees = skuData.redo_fees || 0;
  const totalCollected = skuData.total_collected || 0;
  const netSales = skuData.net_sales || (grossSales - totalDiscounts - totalReturns);
  const totalCogs = rows.reduce((s, r) => s + (r.cogs || 0), 0);
  const shippingCosts = freight?.total_cost || 0;
  const netProductRevenue = netSales;
  const grossProfit = netProductRevenue - totalCogs - shippingCosts;
  const margin = netProductRevenue > 0 ? Math.round(grossProfit / netProductRevenue * 100) : null;
  const marginClass = margin == null ? '' : margin >= 30 ? 'green' : margin >= 10 ? 'accent' : 'red';

  const inventoryValue = inventory?.total_inventory_value ?? skuData.total_inventory_value ?? 0;

  // Payout data (from Shopify Payments API)
  // Only show payout view if we actually have payouts with a non-zero amount
  const payoutSummary = payoutData?.summary || {};
  const payoutTotal = payoutSummary.total_amount || 0;
  const hasPayout = payoutData?.summary?.payout_count > 0 && payoutTotal !== 0;
  const payoutChargesGross = payoutSummary.charges_gross || 0;
  const payoutRefunds = payoutSummary.refunds_gross || 0;
  const payoutFees = payoutSummary.charges_fee || 0;
  const payoutAdjustments = payoutSummary.adjustments_gross || 0;
  const payoutReserved = payoutSummary.reserved_funds || 0;

  const rangeLabel = fmtRangeLabel(dateRange);

  const hasCostData = rows.some(r => (r.cogs || 0) > 0 || (r.avg_unit_cost || 0) > 0);

  const marginBadge = (m) => {
    if (m == null) return <span className="text-muted">—</span>;
    const cls = m >= 50 ? 'badge-green' : m >= 20 ? 'badge-yellow' : 'badge-red';
    return <span className={`badge ${cls}`}>{mp(m)}</span>;
  };

  const unitsCell = (net, gross, returned, refundDetails) => {
    if (!returned || returned <= 0) return mn(net);
    return (
      <span className="units-with-returns">
        <span>{mn(net)}</span>
        <span className="units-return-summary">{mn(gross)} sold</span>
        <ReturnPopover details={refundDetails || []} mc={mc} />
      </span>
    );
  };

  return (
    <div>
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">{hasPayout ? 'PAYOUTS' : 'REVENUE'}</div>
          <div className="kpi-value">{mc(_fmt(hasPayout ? payoutTotal : totalCollected))}</div>
          <div className="kpi-sub">{hasPayout ? `${payoutSummary.payout_count} payout${payoutSummary.payout_count !== 1 ? 's' : ''} · ${rangeLabel}` : rangeLabel}</div>
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
          <div className="kpi-sub">{shippingCosts > 0 ? '(Rev − COGS − Shipping) / Rev' : '(Revenue − COGS) / Revenue'}</div>
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
          {totalDiscounts > 0 && (
            <div className="sb-row sb-negative">
              <span className="sb-label">Discounts</span>
              <span className="sb-value">−{mc(_fmt(totalDiscounts))}</span>
            </div>
          )}
          {totalReturns > 0 && (
            <div className="sb-row sb-negative">
              <span className="sb-label">Returns</span>
              <span className="sb-value">−{mc(_fmt(totalReturns))}</span>
            </div>
          )}
          <div className="sb-row sb-subtotal">
            <span className="sb-label">Net Sales</span>
            <span className="sb-value">{mc(_fmt(netSales))}</span>
          </div>
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
          {(hasCostData || shippingCosts > 0) && (
            <>
              {hasCostData && (
                <div className="sb-row sb-negative" style={{ marginTop: 8 }}>
                  <span className="sb-label">COGS</span>
                  <span className="sb-value">−{mc(_fmt(totalCogs))}</span>
                </div>
              )}
              {shippingCosts > 0 && (
                <div className="sb-row sb-negative">
                  <span className="sb-label">Outbound Shipping (AusPost)</span>
                  <span className="sb-value">−{mc(_fmt(shippingCosts))}</span>
                </div>
              )}
              <div className="sb-row sb-total">
                <span className="sb-label">True Margin</span>
                <span className="sb-value" style={{ color: grossProfit >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {mc(_fmt(grossProfit))}
                  {margin != null && <span style={{ fontSize: 12, fontWeight: 500, marginLeft: 6, opacity: 0.7 }}>({mp(margin)})</span>}
                </span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Payout Breakdown (from Shopify Payments) */}
      {hasPayout && (
        <div className="card sales-breakdown">
          <div className="card-title">Payout Breakdown — {rangeLabel}</div>
          <div className="sb-rows">
            <div className="sb-row">
              <span className="sb-label">Charges (Gross)</span>
              <span className="sb-value">{mc(_fmt(payoutChargesGross))}</span>
            </div>
            {payoutRefunds !== 0 && (
              <div className="sb-row sb-negative">
                <span className="sb-label">Refunds</span>
                <span className="sb-value">−{mc(_fmt(Math.abs(payoutRefunds)))}</span>
              </div>
            )}
            {payoutFees !== 0 && (
              <div className="sb-row sb-negative">
                <span className="sb-label">Processing Fees</span>
                <span className="sb-value">−{mc(_fmt(Math.abs(payoutFees)))}</span>
              </div>
            )}
            {payoutAdjustments !== 0 && (
              <div className="sb-row">
                <span className="sb-label">Adjustments</span>
                <span className="sb-value">{mc(_fmt(payoutAdjustments))}</span>
              </div>
            )}
            {payoutReserved !== 0 && (
              <div className="sb-row sb-negative">
                <span className="sb-label">Reserved Funds</span>
                <span className="sb-value">−{mc(_fmt(Math.abs(payoutReserved)))}</span>
              </div>
            )}
            <div className="sb-row sb-total">
              <span className="sb-label">Net Payout</span>
              <span className="sb-value">{mc(_fmt(payoutTotal))}</span>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          Product Breakdown — {rangeLabel}
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
        {productGroups.length === 0 ? (
          <div className="empty">No sales data for this period. Sync Shopify or log purchases first.</div>
        ) : (
          <div className="table-wrap">
            <table className="sku-table">
              <thead>
                <tr>
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
                {productGroups.map((group) => {
                  const isExpanded = expanded[group.name] || false;
                  const hasVariants = group.variants.length > 1;
                  return (
                    <React.Fragment key={group.name}>
                      <tr
                        className={`product-row ${hasVariants ? 'expandable' : ''} ${isExpanded ? 'expanded' : ''}`}
                        onClick={hasVariants ? () => toggleExpand(group.name) : undefined}
                      >
                        <td>
                          <span className="product-name-cell">
                            {hasVariants && (
                              <span className={`expand-chevron ${isExpanded ? 'open' : ''}`}>›</span>
                            )}
                            <span>{group.name}</span>
                            {hasVariants && (
                              <span className="variant-count">{group.variants.length} variants</span>
                            )}
                          </span>
                        </td>
                        <td className="text-right">{unitsCell(group.units, group.unitsGross, group.unitsReturned, group.refundDetails)}</td>
                        <td className="text-right">{group.hasCost ? mc(_fmt(group.avgCost)) : <span className="text-muted">—</span>}</td>
                        <td className="text-right">{mc(_fmt(group.revenue))}</td>
                        <td className="text-right">{group.hasCost ? mc(_fmt(group.cogs)) : <span className="text-muted">—</span>}</td>
                        <td className="text-right">{marginBadge(group.margin)}</td>
                        <td className="text-right">{mn(group.onHand)}</td>
                        <td className="text-right">{group.invValue > 0 ? mc(_fmt(group.invValue)) : <span className="text-muted">—</span>}</td>
                      </tr>
                      {isExpanded && group.variants.map((row) => {
                        const avgCost = row.units_sold > 0 ? row.cogs / row.units_sold : row.avg_unit_cost || 0;
                        const rowHasCost = (row.cogs || 0) > 0 || (avgCost || 0) > 0;
                        const profit = (row.revenue || 0) - (row.cogs || 0);
                        const m = row.revenue > 0 && rowHasCost ? Math.round(profit / row.revenue * 100) : null;
                        return (
                          <tr key={row.sku} className="variant-row">
                            <td>
                              <span className="variant-sku-cell">
                                <span className="mono">{row.sku}</span>
                              </span>
                            </td>
                            <td className="text-right">{unitsCell(row.units_sold, row.units_gross, row.units_returned, row.refund_details)}</td>
                            <td className="text-right">{rowHasCost ? mc(_fmt(avgCost)) : <span className="text-muted">—</span>}</td>
                            <td className="text-right">{mc(_fmt(row.revenue))}</td>
                            <td className="text-right">{rowHasCost ? mc(_fmt(row.cogs)) : <span className="text-muted">—</span>}</td>
                            <td className="text-right">{marginBadge(m)}</td>
                            <td className="text-right">{mn(row.units_on_hand)}</td>
                            <td className="text-right">{row.inventory_value > 0 ? mc(_fmt(row.inventory_value)) : <span className="text-muted">—</span>}</td>
                          </tr>
                        );
                      })}
                    </React.Fragment>
                  );
                })}
                {redoFees > 0 && (
                  <tr key="x-redo">
                    <td><span className="sku-virtual">REDO</span> Redo Returns Fee</td>
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
                    <td><span className="sku-virtual">SHIP</span> Shipping Charges</td>
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
                  <td>TOTAL</td>
                  <td className="text-right">{unitsCell(
                    rows.reduce((s, r) => s + (r.units_sold || 0), 0),
                    rows.reduce((s, r) => s + (r.units_gross || r.units_sold || 0), 0),
                    rows.reduce((s, r) => s + (r.units_returned || 0), 0),
                    rows.flatMap(r => r.refund_details || []),
                  )}</td>
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
