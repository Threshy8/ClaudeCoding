import React, { useEffect, useState, useCallback } from 'react';
import { getXeroStatus, getXeroPnl, disconnectXero, getCapitalExpenses } from '../api';

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
      const [data, capex] = await Promise.all([
        getXeroPnl(dates.start, dates.end),
        getCapitalExpenses(dates.start, dates.end).catch(() => []),
      ]);
      setPnlData(data);
      setCapexItems(capex);
    } catch (err) {
      setPnlError(err.message);
    } finally {
      setPnlLoading(false);
    }
  }, [dates]);

  // Auto-fetch P&L when connected
  useEffect(() => {
    if (status?.connected) fetchPnl();
  }, [status?.connected, fetchPnl]);

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
      </div>

      {pnlError && <div style={styles.errorBanner}>{pnlError}</div>}

      {pnlLoading && !pnlData && (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>Loading P&amp;L data...</div>
      )}

      {pnlData && <PnlTable data={pnlData} />}

      {pnlData && capexItems.length > 0 && <CapitalItemsSection items={capexItems} />}
    </div>
  );
}

function pctOf(amount, revenue) {
  if (!revenue) return null;
  return ((amount / revenue) * 100).toFixed(1) + '%';
}

function PnlTable({ data }) {
  const revenue = data.tradingIncome.total;

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
          <TotalRow label="Total Cost of Sales" amount={data.costOfSales.total} pct={pctOf(data.costOfSales.total, revenue)} />

          {/* Gross Profit */}
          <HighlightRow label="Gross Profit" amount={data.grossProfit} pct={pctOf(data.grossProfit, revenue)} />

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

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function CapitalItemsSection({ items }) {
  const total = items.reduce((s, i) => s + Number(i.amount || 0), 0);

  return (
    <div style={{ marginTop: 24 }}>
      <h3 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 12px', letterSpacing: '-0.01em' }}>Capital Items</h3>
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden', boxShadow: 'var(--shadow-sm)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...capexTh, textAlign: 'left' }}>Date</th>
              <th style={{ ...capexTh, textAlign: 'left' }}>Name</th>
              <th style={{ ...capexTh, textAlign: 'left' }}>Category</th>
              <th style={{ ...capexTh, textAlign: 'right' }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => {
              const d = new Date(item.purchase_date + 'T12:00:00');
              const dateStr = `${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`;
              return (
                <tr key={item.id}>
                  <td style={capexTd}>{dateStr}</td>
                  <td style={{ ...capexTd, fontWeight: 500 }}>{item.name}</td>
                  <td style={capexTd}>{item.category}</td>
                  <td style={{ ...capexTd, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(Number(item.amount))}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '2px solid var(--border)' }}>
              <td colSpan={3} style={{ ...capexTd, fontWeight: 700 }}>Total Capital Items</td>
              <td style={{ ...capexTd, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8, fontStyle: 'italic' }}>
        Note: These items may be recorded as COGS in Xero
      </p>
    </div>
  );
}

const capexTh = { padding: '10px 12px', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' };
const capexTd = { padding: '8px 12px', fontSize: 13, borderBottom: '1px solid var(--border-light)' };

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
