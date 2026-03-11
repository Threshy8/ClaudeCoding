import React, { useState, useCallback } from 'react';
import Dashboard from './components/Dashboard';
import PurchasesTab from './components/PurchasesTab';
import SalesCogsTab from './components/SalesCogsTab';
import JournalTab from './components/JournalTab';
import FulfillmentTab from './components/FulfillmentTab';
import DateRangePicker from './components/DateRangePicker';
import { syncShopify } from './api';
import './App.css';

const TABS = ['Dashboard', 'Stock Purchases', 'Sales & COGS', '3PL Costs', 'Journal Export'];
const APP_PASSWORD = process.env.REACT_APP_PASSWORD || 'watchbox2024';

function defaultRange() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const start = `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const end = `${y}-${String(m + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return { start, end, label: 'This Month' };
}

function PasswordGate({ onUnlock }) {
  const [input, setInput] = useState('');
  const [error, setError] = useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (input === APP_PASSWORD) {
      sessionStorage.setItem('wbc_auth', '1');
      window.location.reload();
    } else {
      setError(true);
      setInput('');
    }
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg, #faf9f7)',
    }}>
      <div style={{
        background: 'var(--bg-card, #fff)', border: '1px solid var(--border, #e5e2dc)',
        borderRadius: 12, padding: '40px 48px', width: 340, boxShadow: '0 4px 24px rgba(0,0,0,0.07)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20,
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 28, marginBottom: 4 }}>📦</div>
          <div style={{ fontWeight: 700, fontSize: 18, letterSpacing: '-0.02em' }}>The Watch Box Co.</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted, #888)', marginTop: 4 }}>Operations Dashboard</div>
        </div>
        <form onSubmit={handleSubmit} style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input
            type="password"
            placeholder="Password"
            value={input}
            onChange={e => { setInput(e.target.value); setError(false); }}
            autoFocus
            style={{
              width: '100%', padding: '10px 14px', borderRadius: 8, fontSize: 14,
              border: `1px solid ${error ? '#ef4444' : 'var(--border, #e5e2dc)'}`,
              outline: 'none', boxSizing: 'border-box',
              background: 'var(--bg, #faf9f7)',
            }}
          />
          {error && <div style={{ fontSize: 12, color: '#ef4444', textAlign: 'center' }}>Incorrect password</div>}
          <button type="submit" style={{
            width: '100%', padding: '10px', borderRadius: 8, fontSize: 14, fontWeight: 600,
            background: '#1a1a1a', color: '#fff', border: 'none', cursor: 'pointer',
          }}>
            Enter
          </button>
        </form>
      </div>
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(() => sessionStorage.getItem('wbc_auth') === '1');
  const [activeTab, setActiveTab] = useState('Dashboard');
  const [dateRange, setDateRange] = useState(defaultRange());
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [syncError, setSyncError] = useState(null);

  if (!authed) return <PasswordGate onUnlock={() => setAuthed(true)} />;

  const handleSync = useCallback(async () => {
    setSyncing(true);
    setSyncResult(null);
    setSyncError(null);
    try {
      const result = await syncShopify('au');
      setSyncResult(result);
    } catch (err) {
      setSyncError(err.message);
    } finally {
      setSyncing(false);
    }
  }, []);

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="header-left">
          <div className="logo">
            <div className="logo-mark">
              <span className="logo-mark-diamond">◆ ◆ ◆</span>
              <div className="logo-mark-line" />
            </div>
            <div className="logo-text">
              <div className="logo-title">The Watch Box Co.</div>
              <div className="logo-sub">Inventory &amp; COGS Manager</div>
            </div>
          </div>
        </div>

        <div className="header-right">
          <DateRangePicker value={dateRange} onChange={setDateRange} />

          <button
            className={`sync-btn ${syncing ? 'syncing' : ''}`}
            onClick={handleSync}
            disabled={syncing}
          >
            {syncing ? (
              <><span className="spin">↻</span> Syncing…</>
            ) : (
              <>↺ Sync Shopify</>
            )}
          </button>
        </div>
      </header>

      {/* Sync feedback */}
      {(syncResult || syncError) && (
        <div className={`sync-banner ${syncError ? 'error' : 'success'}`}>
          {syncError ? (
            <span>Sync failed: {syncError}</span>
          ) : (
            <span>
              Sync complete — {syncResult.orders_fetched ?? syncResult.orders_processed ?? 0} orders fetched,{' '}
              {syncResult.line_items_synced} line items synced.
            </span>
          )}
          <button className="banner-close" onClick={() => { setSyncResult(null); setSyncError(null); }}>✕</button>
        </div>
      )}

      {/* Tab nav */}
      <nav className="tab-nav">
        {TABS.map((tab) => (
          <button
            key={tab}
            className={`tab-btn ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </nav>

      {/* Tab content */}
      <main className="main-content">
        {activeTab === 'Dashboard'      && <Dashboard     dateRange={dateRange} />}
        {activeTab === 'Stock Purchases' && <PurchasesTab />}
        {activeTab === 'Sales & COGS'   && <SalesCogsTab  dateRange={dateRange} />}
        {activeTab === '3PL Costs'      && <FulfillmentTab dateRange={dateRange} />}
        {activeTab === 'Journal Export'  && <JournalTab    dateRange={dateRange} />}
      </main>
    </div>
  );
}
