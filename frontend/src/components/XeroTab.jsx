import React, { useEffect, useState, useCallback } from 'react';
import * as XLSX from 'xlsx';
import { getXeroStatus, getXeroPnl, disconnectXero, getCapitalExpenses, getGermanDropBalance, getInventoryValuation } from '../api';

const BASE_URL = process.env.REACT_APP_API_URL || '';

function formatCurrency(val) {
  if (val == null || isNaN(val)) return '$0.00';
  const neg = val < 0;
  const formatted = Math.abs(val).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return neg ? `($${formatted})` : `$${formatted}`;
}

function defaultDateRange() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return { start: `${y}-${m}-01`, end: `${y}-${m}-${String(now.getDate()).padStart(2, '0')}` };
}

export default function XeroTab() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pnlData, setPnlData] = useState(null);
  const [pnlLoading, setPnlLoading] = useState(false);
  const [pnlError, setPnlError] = useState(null);
  const [dates, setDates] = useState(defaultDateRange);
  const [successMsg, setSuccessMsg] = useState(null);
  const [capexItems, setCapexItems] = useState([]);
  const [gdBalance, setGdBalance] = useState(null);
  const [valuation, setValuation] = useState(null);
  const [valuationLoading, setValuationLoading] = useState(false);

  // Check for ?connected=true in URL on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('connected') === 'true') {
      setSuccessMsg('Successfully connected to Xero!');
      // Clean up URL
      window.history.replaceState({}, '', window.location.pathname);
    }
    if (params.get('error')) {
      setPnlError(`Connection failed: ${params.get('error')}`);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const checkStatus = useCallback(async () => {
    setLoading(true);
    try {
      const s = await getXeroStatus();
      setStatus(s);
    } catch {
      setStatus({ connected: false });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { checkStatus(); }, [checkStatus]);

  const fetchPnl = useCallback(async () => {
    setPnlLoading(true);
    setPnlError(null);
    try {
      const [data, capex, gd] = await Promise.all([
        getXeroPnl(dates.start, dates.end),
        getCapitalExpenses(dates.start, dates.end).catch(() => []),
        getGermanDropBalance().catch(() => null),
      ]);
      setPnlData(data);
      setCapexItems(capex);
      setGdBalance(gd);
    } catch (err) {
      setPnlError(err.message);
    } finally {
      setPnlLoading(false);
    }
  }, [dates]);

  const fetchValuation = useCallback(async () => {
    setValuationLoading(true);
    try {
      const data = await getInventoryValuation();
      setValuation(data);
    } catch {
      setValuation(null);
    } finally {
      setValuationLoading(false);
    }
  }, []);

  // Auto-fetch P&L when connected
  useEffect(() => {
    if (status?.connected) fetchPnl();
  }, [status?.connected, fetchPnl]);

  // Always fetch inventory valuation on mount
  useEffect(() => { fetchValuation(); }, [fetchValuation]);

  const handleDisconnect = async () => {
    if (!window.confirm('Disconnect from Xero?')) return;
    try {
      await disconnectXero();
      setStatus({ connected: false });
      setPnlData(null);
      setSuccessMsg(null);
    } catch (err) {
      setPnlError(err.message);
    }
  };

  const handleConnect = () => {
    window.location.href = `${BASE_URL}/api/xero/connect`;
  };

  if (loading) {
    return <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>Checking Xero connection...</div>;
  }

  // Not connected — show connect button
  if (!status?.connected) {
    return (
      <div style={{ maxWidth: 480, margin: '60px auto', textAlign: 'center' }}>
        <div style={styles.card}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>X</div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 8px' }}>Connect to Xero</h2>
          <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: '0 0 24px', lineHeight: 1.5 }}>
            Link your Xero account to view Profit &amp; Loss reports directly in the dashboard.
          </p>
          {pnlError && <div style={styles.errorBanner}>{pnlError}</div>}
          <button onClick={handleConnect} style={styles.connectBtn}>
            Connect to Xero
          </button>
        </div>
      </div>
    );
  }

  // Connected
  return (
    <div style={{ maxWidth: 800, margin: '0 auto' }}>
      {/* Success banner */}
      {successMsg && (
        <div style={styles.successBanner}>
          {successMsg}
          <button onClick={() => setSuccessMsg(null)} style={styles.bannerClose}>x</button>
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Xero P&amp;L</h2>
          {status.tenant_name && (
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              Connected to {status.tenant_name}
            </span>
          )}
        </div>
        <button onClick={handleDisconnect} style={styles.disconnectBtn}>Disconnect</button>
      </div>

      {/* Date range */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 24 }}>
        <label style={{ fontSize: 13, color: 'var(--text-muted)' }}>From</label>
        <input
          type="date"
          value={dates.start}
          onChange={e => setDates(d => ({ ...d, start: e.target.value }))}
          style={styles.dateInput}
        />
        <label style={{ fontSize: 13, color: 'var(--text-muted)' }}>To</label>
        <input
          type="date"
          value={dates.end}
          onChange={e => setDates(d => ({ ...d, end: e.target.value }))}
          style={styles.dateInput}
        />
        <button onClick={fetchPnl} disabled={pnlLoading} style={styles.fetchBtn}>
          {pnlLoading ? 'Loading...' : 'Refresh'}
        </button>
        {pnlData && (
          <button onClick={() => exportPnlToXlsx(pnlData, capexItems, gdBalance, dates, status?.tenant_name)} style={styles.exportBtn}>
            Export .xlsx
          </button>
        )}
      </div>

      {pnlError && <div style={styles.errorBanner}>{pnlError}</div>}

      {pnlLoading && !pnlData && (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>Loading P&amp;L data...</div>
      )}

      {pnlData && <PnlTable data={pnlData} capexItems={capexItems} gdBalance={gdBalance} dates={dates} tenantName={status?.tenant_name} />}

      {/* Inventory Valuation */}
      <div style={{ marginTop: 32 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Inventory Valuation</h2>
          <button onClick={fetchValuation} disabled={valuationLoading} style={styles.fetchBtn}>
            {valuationLoading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
        {valuationLoading && !valuation && (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>Loading valuation...</div>
        )}
        {valuation && <ValuationTable data={valuation} />}
      </div>
    </div>
  );
}

function pctOf(amount, revenue) {
  if (!revenue) return null;
  return ((amount / revenue) * 100).toFixed(1) + '%';
}

const GD_USD_TO_AUD = 1.45;

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function buildExportFilename(dates, tenantName) {
  const d = new Date(dates.start + 'T12:00:00');
  const month = MONTH_NAMES[d.getMonth()];
  const year = d.getFullYear();
  const org = (tenantName || '88ROAS').replace(/[^a-zA-Z0-9]/g, '');
  return `${org}_PL_${month}${year}.xlsx`;
}

function exportPnlToXlsx(data, capexItems, gdBalance, dates, tenantName) {
  const revenue = data.tradingIncome.total;
  const capexTotal = capexItems.reduce((s, i) => s + Number(i.amount || 0), 0);
  const gdBalanceUsd = gdBalance && gdBalance.balance_aud > 0 ? gdBalance.balance_aud : 0;
  const gdBalanceAud = Math.round(gdBalanceUsd * GD_USD_TO_AUD * 100) / 100;
  const totalDeductions = capexTotal + gdBalanceAud;
  const trueCos = data.costOfSales.total - totalDeductions;
  const trueGrossProfit = revenue - trueCos;

  const rows = [];
  const pct = (v) => revenue ? ((v / revenue) * 100).toFixed(1) + '%' : '';

  rows.push(['Account', 'Amount', '% of Revenue']);
  rows.push([]);

  // Trading Income
  rows.push(['Trading Income', '', '']);
  for (const [k, v] of Object.entries(data.tradingIncome)) {
    if (k === 'total') continue;
    rows.push(['  ' + k.replace(/_/g, ' '), v, pct(v)]);
  }
  rows.push(['Total Trading Income', data.tradingIncome.total, '100.0%']);
  rows.push([]);

  // Cost of Sales
  rows.push(['Less Cost of Sales', '', '']);
  for (const [k, v] of Object.entries(data.costOfSales)) {
    if (k === 'total') continue;
    rows.push(['  ' + k.replace(/_/g, ' '), v, pct(v)]);
  }
  rows.push(['Total Cost of Sales (Xero)', data.costOfSales.total, pct(data.costOfSales.total)]);

  // Capital Items
  if (capexTotal > 0) {
    rows.push([]);
    rows.push(['Less: Capital Items', '', '']);
    for (const item of capexItems) {
      rows.push(['  ' + item.name, -Number(item.amount), pct(Number(item.amount))]);
    }
    rows.push(['Total Capital Items', -capexTotal, pct(capexTotal)]);
  }

  // Prepaid Balances
  if (gdBalanceAud > 0) {
    rows.push([]);
    rows.push(['Less: Prepaid Balances', '', '']);
    rows.push([`  GermanDrop Wallet (US$${gdBalanceUsd.toFixed(2)} x ${GD_USD_TO_AUD})`, -gdBalanceAud, pct(gdBalanceAud)]);
  }

  // Adjusted totals
  if (capexTotal > 0 || gdBalanceAud > 0) {
    rows.push([]);
    rows.push(['True Adjusted COGS', trueCos, pct(trueCos)]);
  }

  rows.push([]);
  rows.push(['Gross Profit (Xero)', data.grossProfit, pct(data.grossProfit)]);

  if (capexTotal > 0 || gdBalanceAud > 0) {
    rows.push(['True Adjusted Gross Profit', trueGrossProfit, pct(trueGrossProfit)]);
  }

  rows.push([]);

  // Operating Expenses
  rows.push(['Less Operating Expenses', '', '']);
  for (const [label, amount] of Object.entries(data.operatingExpenses)) {
    rows.push(['  ' + label, amount, pct(amount)]);
  }
  rows.push(['Total Operating Expenses', data.totalOperatingExpenses, pct(data.totalOperatingExpenses)]);
  rows.push([]);
  rows.push(['Net Profit', data.netProfit, pct(data.netProfit)]);

  const ws = XLSX.utils.aoa_to_sheet(rows);
  // Set column widths
  ws['!cols'] = [{ wch: 40 }, { wch: 16 }, { wch: 14 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'P&L');
  XLSX.writeFile(wb, buildExportFilename(dates, tenantName));
}

function PnlTable({ data, capexItems = [], gdBalance = null, dates, tenantName }) {
  const revenue = data.tradingIncome.total;
  const capexTotal = capexItems.reduce((s, i) => s + Number(i.amount || 0), 0);
  const hasCapex = capexTotal > 0;
  const adjustedCos = data.costOfSales.total - capexTotal;
  const adjustedGrossProfit = revenue - adjustedCos;

  const gdBalanceUsd = gdBalance && gdBalance.balance_aud > 0 ? gdBalance.balance_aud : 0;
  const gdBalanceAud = Math.round(gdBalanceUsd * GD_USD_TO_AUD * 100) / 100;
  const hasGd = gdBalanceAud > 0;
  const hasAdjustments = hasCapex || hasGd;
  const totalDeductions = capexTotal + gdBalanceAud;
  const trueCos = data.costOfSales.total - totalDeductions;
  const trueGrossProfit = revenue - trueCos;

  return (
    <div style={styles.card}>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Account</th>
            <th style={{ ...styles.th, textAlign: 'right' }}>Amount</th>
            <th style={{ ...styles.th, textAlign: 'right', width: 90 }}>% of Revenue</th>
          </tr>
        </thead>
        <tbody>
          {/* Trading Income */}
          <SectionHeader title="Trading Income" />
          {Object.entries(data.tradingIncome).filter(([k]) => k !== 'total').map(([label, amount]) => (
            <ItemRow key={label} label={label.replace(/_/g, ' ')} amount={amount} pct={pctOf(amount, revenue)} />
          ))}
          <TotalRow label="Total Trading Income" amount={data.tradingIncome.total} pct={revenue ? '100.0%' : null} />

          {/* Cost of Sales */}
          <SectionHeader title="Less Cost of Sales" />
          {Object.entries(data.costOfSales).filter(([k]) => k !== 'total').map(([label, amount]) => (
            <ItemRow key={label} label={label.replace(/_/g, ' ')} amount={amount} pct={pctOf(amount, revenue)} />
          ))}
          <TotalRow label="Total Cost of Sales (Xero)" amount={data.costOfSales.total} pct={pctOf(data.costOfSales.total, revenue)} />

          {/* Capital items adjustment */}
          {hasCapex && (
            <>
              <tr>
                <td colSpan={3} style={{ padding: '10px 12px 4px 24px', fontSize: 13, fontWeight: 600, color: 'var(--green)' }}>
                  Less: Capital Items
                  <span
                    title="Capital purchases recorded in this period that may be included in Xero COGS"
                    style={{ display: 'inline-block', marginLeft: 6, width: 15, height: 15, borderRadius: '50%', background: 'var(--bg-alt)', border: '1px solid var(--border)', textAlign: 'center', lineHeight: '14px', fontSize: 10, color: 'var(--text-muted)', cursor: 'help', verticalAlign: 'middle' }}
                  >?</span>
                </td>
              </tr>
              {capexItems.map(item => (
                <tr key={item.id}>
                  <td style={{ padding: '4px 12px 4px 40px', fontSize: 12, color: 'var(--text-muted)' }}>{item.name}</td>
                  <td style={{ padding: '4px 12px', fontSize: 12, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--green)' }}>{formatCurrency(-Number(item.amount))}</td>
                  <td style={{ ...pctStyle, fontSize: 11, color: 'var(--text-dim)' }}>{pctOf(Number(item.amount), revenue)}</td>
                </tr>
              ))}
              <tr style={{ borderTop: '1px solid var(--border-light)' }}>
                <td style={{ padding: '6px 12px 6px 24px', fontSize: 13, fontWeight: 600, color: 'var(--green)' }}>Total Capital Items</td>
                <td style={{ padding: '6px 12px', fontSize: 13, fontWeight: 600, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--green)' }}>{formatCurrency(-capexTotal)}</td>
                <td style={{ ...pctStyle, fontWeight: 600, color: 'var(--green)' }}>{pctOf(capexTotal, revenue)}</td>
              </tr>
              {!hasGd && (
                <tr style={{ borderTop: '1px solid var(--border-light)' }}>
                  <td style={{ padding: '8px 12px 8px 16px', fontSize: 13, fontWeight: 700 }}>Adjusted Cost of Sales</td>
                  <td style={{ padding: '8px 12px', fontSize: 13, fontWeight: 700, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(adjustedCos)}</td>
                  <td style={{ ...pctStyle, fontWeight: 700 }}>{pctOf(adjustedCos, revenue)}</td>
                </tr>
              )}
            </>
          )}

          {/* GermanDrop Wallet */}
          {hasGd && (
            <>
              <tr>
                <td colSpan={3} style={{ padding: '10px 12px 4px 24px', fontSize: 13, fontWeight: 600, color: 'var(--green)' }}>
                  Less: Prepaid Balances
                  <span
                    title="Funds loaded into GermanDrop wallet recorded as COGS but not yet spent on inventory"
                    style={{ display: 'inline-block', marginLeft: 6, width: 15, height: 15, borderRadius: '50%', background: 'var(--bg-alt)', border: '1px solid var(--border)', textAlign: 'center', lineHeight: '14px', fontSize: 10, color: 'var(--text-muted)', cursor: 'help', verticalAlign: 'middle' }}
                  >?</span>
                </td>
              </tr>
              <tr>
                <td style={{ padding: '4px 12px 4px 40px', fontSize: 12, color: 'var(--text-muted)' }}>GermanDrop Wallet (unspent){gdBalanceUsd > 0 && <span style={{ color: 'var(--text-dim)', marginLeft: 6, fontSize: 11 }}>US${gdBalanceUsd.toFixed(2)} x {GD_USD_TO_AUD}</span>}</td>
                <td style={{ padding: '4px 12px', fontSize: 12, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--green)' }}>{formatCurrency(-gdBalanceAud)}</td>
                <td style={{ ...pctStyle, fontSize: 11, color: 'var(--text-dim)' }}>{pctOf(gdBalanceAud, revenue)}</td>
              </tr>
            </>
          )}

          {/* True Adjusted COGS (when both capex and GD exist, or just GD) */}
          {hasAdjustments && (
            <tr style={{ borderTop: '1px solid var(--border-light)' }}>
              <td style={{ padding: '8px 12px 8px 16px', fontSize: 13, fontWeight: 700 }}>True Adjusted COGS</td>
              <td style={{ padding: '8px 12px', fontSize: 13, fontWeight: 700, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(trueCos)}</td>
              <td style={{ ...pctStyle, fontWeight: 700 }}>{pctOf(trueCos, revenue)}</td>
            </tr>
          )}

          {/* Gross Profit */}
          <HighlightRow label="Gross Profit (Xero)" amount={data.grossProfit} pct={pctOf(data.grossProfit, revenue)} />

          {/* True Adjusted Gross Profit */}
          {hasAdjustments && (
            <tr style={{ background: 'rgba(42,122,75,0.07)' }}>
              <td style={{ padding: '10px 12px', fontSize: 14, fontWeight: 700, borderTop: '2px solid var(--green)', borderBottom: '2px solid var(--green)', color: 'var(--green)' }}>True Adjusted Gross Profit</td>
              <td style={{ padding: '10px 12px', fontSize: 14, fontWeight: 700, textAlign: 'right', fontVariantNumeric: 'tabular-nums', borderTop: '2px solid var(--green)', borderBottom: '2px solid var(--green)', color: 'var(--green)' }}>{formatCurrency(trueGrossProfit)}</td>
              <td style={{ ...pctStyle, fontWeight: 700, fontSize: 13, borderTop: '2px solid var(--green)', borderBottom: '2px solid var(--green)', color: 'var(--green)' }}>{pctOf(trueGrossProfit, revenue)}</td>
            </tr>
          )}

          {/* Operating Expenses */}
          <SectionHeader title="Less Operating Expenses" />
          {Object.entries(data.operatingExpenses).map(([label, amount]) => (
            <ItemRow key={label} label={label} amount={amount} pct={pctOf(amount, revenue)} />
          ))}
          <TotalRow label="Total Operating Expenses" amount={data.totalOperatingExpenses} pct={pctOf(data.totalOperatingExpenses, revenue)} />

          {/* Net Profit */}
          <HighlightRow label="Net Profit" amount={data.netProfit} pct={pctOf(data.netProfit, revenue)} bold />
        </tbody>
      </table>
    </div>
  );
}

function ValuationTable({ data }) {
  return (
    <div style={styles.card}>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>SKU</th>
            <th style={styles.th}>Product</th>
            <th style={{ ...styles.th, textAlign: 'right' }}>Units on Hand</th>
            <th style={{ ...styles.th, textAlign: 'right' }}>Cost/Unit</th>
            <th style={{ ...styles.th, textAlign: 'right' }}>Shipping/Unit</th>
            <th style={{ ...styles.th, textAlign: 'right' }}>Total Value</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map(item => (
            <tr key={item.sku}>
              <td style={{ padding: '6px 12px', fontSize: 13, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{item.sku}</td>
              <td style={{ padding: '6px 12px', fontSize: 13, color: 'var(--text-body)' }}>{item.product_name}</td>
              <td style={{ padding: '6px 12px', fontSize: 13, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{item.units.toLocaleString()}</td>
              <td style={{ padding: '6px 12px', fontSize: 13, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(item.unit_cost)}</td>
              <td style={{ padding: '6px 12px', fontSize: 13, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)' }}>{item.shipping_per_unit != null ? formatCurrency(item.shipping_per_unit) : '—'}</td>
              <td style={{ padding: '6px 12px', fontSize: 13, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(item.total_value)}</td>
            </tr>
          ))}
          <tr style={{ borderTop: '2px solid var(--border)', background: 'var(--accent-dim2)' }}>
            <td colSpan={5} style={{ padding: '10px 12px', fontSize: 14, fontWeight: 700 }}>Grand Total</td>
            <td style={{ padding: '10px 12px', fontSize: 14, fontWeight: 700, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(data.grand_total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

const pctStyle = { padding: '6px 12px', fontSize: 12, textAlign: 'right', color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' };

function SectionHeader({ title }) {
  return (
    <tr>
      <td colSpan={3} style={{ padding: '14px 12px 6px', fontWeight: 700, fontSize: 13, color: 'var(--text)', letterSpacing: '-0.01em', borderBottom: '1px solid var(--border-light)' }}>
        {title}
      </td>
    </tr>
  );
}

function ItemRow({ label, amount, pct }) {
  return (
    <tr>
      <td style={{ padding: '6px 12px 6px 24px', fontSize: 13, color: 'var(--text-body)', textTransform: 'capitalize' }}>{label}</td>
      <td style={{ padding: '6px 12px', fontSize: 13, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(amount)}</td>
      <td style={pctStyle}>{pct}</td>
    </tr>
  );
}

function TotalRow({ label, amount, pct }) {
  return (
    <tr style={{ borderTop: '1px solid var(--border-light)' }}>
      <td style={{ padding: '8px 12px 8px 16px', fontSize: 13, fontWeight: 600 }}>{label}</td>
      <td style={{ padding: '8px 12px', fontSize: 13, fontWeight: 600, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(amount)}</td>
      <td style={{ ...pctStyle, fontWeight: 600 }}>{pct}</td>
    </tr>
  );
}

function HighlightRow({ label, amount, pct, bold }) {
  const borderStyle = { borderTop: '2px solid var(--border)', borderBottom: '2px solid var(--border)' };
  return (
    <tr style={{ background: 'var(--accent-dim2)' }}>
      <td style={{ padding: '10px 12px', fontSize: 14, fontWeight: bold ? 700 : 600, ...borderStyle }}>{label}</td>
      <td style={{ padding: '10px 12px', fontSize: 14, fontWeight: bold ? 700 : 600, textAlign: 'right', fontVariantNumeric: 'tabular-nums', ...borderStyle, color: amount < 0 ? 'var(--red)' : 'var(--green)' }}>{formatCurrency(amount)}</td>
      <td style={{ ...pctStyle, fontWeight: bold ? 700 : 600, fontSize: 13, ...borderStyle }}>{pct}</td>
    </tr>
  );
}

const styles = {
  card: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    padding: 0,
    overflow: 'hidden',
    boxShadow: 'var(--shadow-sm)',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
  },
  th: {
    padding: '12px',
    fontSize: 12,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color: 'var(--text-muted)',
    borderBottom: '1px solid var(--border)',
    textAlign: 'left',
  },
  connectBtn: {
    padding: '12px 32px',
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    background: '#0078C8',
    color: '#fff',
    border: 'none',
    cursor: 'pointer',
  },
  disconnectBtn: {
    padding: '6px 16px',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 500,
    background: 'var(--bg)',
    color: 'var(--red)',
    border: '1px solid var(--border)',
    cursor: 'pointer',
  },
  dateInput: {
    padding: '7px 12px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    fontSize: 13,
    background: 'var(--bg-card)',
  },
  fetchBtn: {
    padding: '7px 18px',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    background: '#1a1a1a',
    color: '#fff',
    border: 'none',
    cursor: 'pointer',
  },
  exportBtn: {
    padding: '7px 18px',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    background: 'var(--bg-card)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    cursor: 'pointer',
  },
  successBanner: {
    background: 'var(--green-dim)',
    color: 'var(--green)',
    padding: '10px 16px',
    borderRadius: 8,
    marginBottom: 16,
    fontSize: 13,
    fontWeight: 500,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  errorBanner: {
    background: 'var(--red-dim)',
    color: 'var(--red)',
    padding: '10px 16px',
    borderRadius: 8,
    marginBottom: 16,
    fontSize: 13,
    fontWeight: 500,
  },
  bannerClose: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: 14,
    color: 'inherit',
    padding: '0 4px',
  },
};
