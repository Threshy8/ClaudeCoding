import React, { useState, useEffect, useCallback } from 'react';
import Dashboard from './components/Dashboard';
import PurchasesTab from './components/PurchasesTab';
import SalesCogsTab from './components/SalesCogsTab';
import JournalTab from './components/JournalTab';
import { syncShopify } from './api';
import './App.css';

const TABS = ['Dashboard', 'Stock Purchases', 'Sales & COGS', 'Journal Export'];

// Returns current month as YYYY-MM
function currentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export default function App() {
  const [activeTab, setActiveTab] = useState('Dashboard');
  const [period, setPeriod] = useState(currentPeriod());
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
            <span className="logo-icon">⌚</span>
            <div>
              <div className="logo-title">The Watch Box Co.</div>
              <div className="logo-sub">COGS & Inventory Manager</div>
            </div>
          </div>
        </div>

        <div className="header-right">
          {/* Period selector */}
          <div className="period-selector">
            <label className="period-label">Period</label>
            <input
              type="month"
              className="period-input"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
            />
          </div>

          {/* Sync button */}
          <button
            className={`sync-btn ${syncing ? 'syncing' : ''}`}
            onClick={handleSync}
            disabled={syncing}
          >
            {syncing ? (
              <>
                <span className="spin">↻</span> Syncing…
              </>
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
              Sync complete — {syncResult.orders_processed} orders processed,{' '}
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
        {activeTab === 'Dashboard' && <Dashboard period={period} />}
        {activeTab === 'Stock Purchases' && <PurchasesTab />}
        {activeTab === 'Sales & COGS' && <SalesCogsTab period={period} />}
        {activeTab === 'Journal Export' && <JournalTab period={period} />}
      </main>
    </div>
  );
}
