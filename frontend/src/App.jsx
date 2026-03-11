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

function defaultRange() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const start = `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const end = `${y}-${String(m + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return { start, end, label: 'This Month' };
}

export default function App() {
  const [activeTab, setActiveTab] = useState('Dashboard');
  const [dateRange, setDateRange] = useState(defaultRange());
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [syncError, setSyncError] = useState(null);

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
