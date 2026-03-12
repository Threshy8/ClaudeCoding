import React, { useEffect, useState } from 'react';
import { useDemoMask } from '../contexts/DemoModeContext';

const BASE_URL = process.env.REACT_APP_API_URL || '';

function _fmt(n) {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(n || 0);
}

const LASER_SKUS = ['BLK1VYG', 'BLK2VYG', 'BLK3VYG'];

function getLocation(sku) {
  if (LASER_SKUS.includes(sku)) return 'SCC / Laser';
  return 'SCC';
}

function matchesFilter(sku, filter) {
  if (filter === 'All') return true;
  if (filter === 'Laser Engraving') return LASER_SKUS.includes(sku);
  if (filter === 'SCC') return true; // all stock is at SCC
  if (filter === 'GermanDrop') return false; // future use
  return true;
}

export default function InventoryTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('All');
  const { mc, mn } = useDemoMask();

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`${BASE_URL}/api/inventory/summary?store=au`)
      .then(r => { if (!r.ok) throw new Error('Failed to load inventory'); return r.json(); })
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading">Loading inventory data...</div>;
  if (error) return <div className="error-msg">{error}</div>;
  if (!data) return null;

  const filtered = (data.skus || []).filter(s => matchesFilter(s.sku, filter));
  const totalUnits = filtered.reduce((s, r) => s + r.quantity_remaining, 0);
  const totalInvValue = filtered.reduce((s, r) => s + r.inventory_value, 0);
  const totalRetValue = filtered.reduce((s, r) => s + r.retail_value, 0);

  return (
    <div>
      <div className="kpi-grid" style={{ marginBottom: 24 }}>
        {[
          { label: 'Total SKUs', value: mn(filtered.length), cls: '' },
          { label: 'Total Units', value: mn(totalUnits), cls: '' },
          { label: 'Inventory Value (Cost)', value: mc(_fmt(totalInvValue)), cls: '' },
          { label: 'Retail Value', value: mc(_fmt(totalRetValue)), cls: 'green' },
        ].map(c => (
          <div key={c.label} className="kpi-card">
            <div className="kpi-label">{c.label}</div>
            <div className={`kpi-value ${c.cls}`}>{c.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {['All', 'SCC', 'Laser Engraving', 'GermanDrop'].map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            padding: '6px 16px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer',
            border: '1px solid var(--border)',
            background: filter === f ? 'var(--accent)' : 'var(--bg-card)',
            color: filter === f ? '#fff' : 'var(--text)',
          }}>{f}</button>
        ))}
      </div>

      <div className="card">
        <div className="card-title">Stock Levels</div>
        {filtered.length === 0 ? (
          <div className="empty">No inventory for this filter.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Product</th>
                  <th>Location</th>
                  <th className="text-right">Units in Stock</th>
                  <th className="text-right">Sold This Month</th>
                  <th className="text-right">Unit Cost</th>
                  <th className="text-right">Inventory Value</th>
                  <th className="text-right">Retail Value</th>
                  <th>PO #</th>
                  <th>Low Stock</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(row => (
                  <tr key={row.sku} style={row.low_stock ? { background: 'rgba(245,158,11,0.08)' } : undefined}>
                    <td><span className="mono">{row.sku}</span></td>
                    <td>{row.product_name}</td>
                    <td style={{ fontSize: 12 }}>{getLocation(row.sku)}</td>
                    <td className="text-right">{mn(row.quantity_remaining)}</td>
                    <td className="text-right">{mn(row.units_sold_this_month)}</td>
                    <td className="text-right">{mc(_fmt(row.unit_cost))}</td>
                    <td className="text-right">{mc(_fmt(row.inventory_value))}</td>
                    <td className="text-right">{mc(_fmt(row.retail_value))}</td>
                    <td style={{ fontSize: 11, color: 'var(--text-muted)', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.po_numbers.join(', ')}
                    </td>
                    <td>
                      {row.low_stock && (
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700,
                          background: 'rgba(245,158,11,0.15)', color: '#d97706',
                          border: '1px solid rgba(245,158,11,0.3)',
                        }}>Low</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--border-light)', fontWeight: 700 }}>
                  <td colSpan={3} style={{ color: 'var(--text-muted)', fontSize: 12 }}>TOTAL ({filtered.length} SKUs)</td>
                  <td className="text-right">{mn(totalUnits)}</td>
                  <td className="text-right">{mn(filtered.reduce((s, r) => s + r.units_sold_this_month, 0))}</td>
                  <td></td>
                  <td className="text-right">{mc(_fmt(totalInvValue))}</td>
                  <td className="text-right">{mc(_fmt(totalRetValue))}</td>
                  <td colSpan={2}></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
