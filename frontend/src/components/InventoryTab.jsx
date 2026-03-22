import React, { useEffect, useState, useMemo } from 'react';
import { useDemoMask } from '../contexts/DemoModeContext';
import { BASE_URL, formatCurrency as _fmt } from '../utils';

function getLocation() {
  return 'SCC';
}

const LOCATION_COLORS = {
  'SCC':             { bg: 'rgba(59,130,246,0.10)', color: '#2563eb', border: 'rgba(59,130,246,0.25)' },
  'Laser Engraving': { bg: 'rgba(139,92,246,0.10)',  color: '#7c3aed', border: 'rgba(139,92,246,0.25)' },
  'GermanDrop':      { bg: 'rgba(249,115,22,0.10)',  color: '#ea580c', border: 'rgba(249,115,22,0.25)' },
};

function LocationBadge({ location }) {
  const c = LOCATION_COLORS[location] || LOCATION_COLORS['SCC'];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 9px', borderRadius: 10, fontSize: 10, fontWeight: 700,
      letterSpacing: '0.04em', background: c.bg, color: c.color,
      border: `1px solid ${c.border}`, whiteSpace: 'nowrap',
    }}>{location}</span>
  );
}

function LowStockBadge() {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 700,
      background: 'rgba(220,38,38,0.08)', color: '#dc2626',
      border: '1px solid rgba(220,38,38,0.2)',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#dc2626' }} />
      Low
    </span>
  );
}

function StockBar({ current, original }) {
  const max = original > 0 ? original : current;
  const pct = max > 0 ? Math.min((current / max) * 100, 100) : 0;
  const color = pct > 50 ? 'var(--green)' : pct > 20 ? 'var(--accent)' : 'var(--red)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
      <span style={{ fontSize: 13, fontWeight: 600, minWidth: 24, textAlign: 'right' }}>{current}</span>
      <div style={{
        width: 56, height: 6, borderRadius: 3,
        background: 'var(--border-light)', overflow: 'hidden', flexShrink: 0,
      }}>
        <div style={{
          height: '100%', borderRadius: 3, background: color,
          width: `${pct}%`, transition: 'width 0.3s ease',
        }} />
      </div>
    </div>
  );
}

function SoldArrow({ value }) {
  if (!value) return <span style={{ color: 'var(--text-dim)' }}>0</span>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      <span style={{ fontSize: 13 }}>{value}</span>
      <span style={{ color: value > 0 ? 'var(--green)' : 'var(--text-dim)', fontSize: 10 }}>
        {value > 0 ? '▲' : '—'}
      </span>
    </span>
  );
}

function extractFamily(productName) {
  if (!productName) return 'Other';
  // e.g. "The Atlas - Black" → "Atlas", "Carina Gold" → "Carina"
  const cleaned = productName.replace(/^The\s+/i, '');
  const match = cleaned.match(/^([A-Za-z]+)/);
  return match ? match[1] : 'Other';
}

function extractVariant(productName) {
  if (!productName) return '';
  const cleaned = productName.replace(/^The\s+/i, '');
  // Remove the family name and any separator
  const family = cleaned.match(/^([A-Za-z]+)/)?.[1] || '';
  return cleaned.slice(family.length).replace(/^\s*[-–—]\s*/, '').trim() || cleaned;
}

export default function InventoryTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [expandedFamilies, setExpandedFamilies] = useState({});
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

  const filtered = useMemo(() => {
    if (!data?.skus) return [];
    if (!search.trim()) return data.skus;
    const q = search.toLowerCase();
    return data.skus.filter(s =>
      s.sku.toLowerCase().includes(q) ||
      (s.product_name || '').toLowerCase().includes(q)
    );
  }, [data, search]);

  const families = useMemo(() => {
    const map = {};
    for (const row of filtered) {
      const family = extractFamily(row.product_name);
      if (!map[family]) map[family] = { name: family, skus: [], totalUnits: 0, totalSold: 0, totalInvValue: 0, totalRetValue: 0, totalOriginal: 0, hasLowStock: false };
      map[family].skus.push(row);
      map[family].totalUnits += row.quantity_remaining;
      map[family].totalSold += row.units_sold_this_month;
      map[family].totalInvValue += row.inventory_value;
      map[family].totalRetValue += row.retail_value;
      map[family].totalOriginal += (row.quantity_remaining + row.units_sold_this_month);
      if (row.low_stock) map[family].hasLowStock = true;
    }
    return Object.values(map).sort((a, b) => b.totalRetValue - a.totalRetValue);
  }, [filtered]);

  const totalUnits = filtered.reduce((s, r) => s + r.quantity_remaining, 0);
  const totalInvValue = filtered.reduce((s, r) => s + r.inventory_value, 0);
  const totalRetValue = filtered.reduce((s, r) => s + r.retail_value, 0);
  const lowStockCount = filtered.filter(r => r.low_stock).length;

  const toggleFamily = (name) => {
    setExpandedFamilies(prev => ({ ...prev, [name]: !prev[name] }));
  };

  if (loading) return <div className="loading">Loading inventory data...</div>;
  if (error) return <div className="error-msg">{error}</div>;
  if (!data) return null;

  return (
    <div>
      {/* KPI Cards */}
      <div className="kpi-grid" style={{ marginBottom: 24 }}>
        {[
          { label: 'Total SKUs', value: mn(filtered.length), cls: '' },
          { label: 'Units in Stock', value: mn(totalUnits), cls: '' },
          { label: 'Inventory Value', value: mc(_fmt(totalInvValue)), cls: '' },
          { label: 'Retail Value', value: mc(_fmt(totalRetValue)), cls: 'green' },
        ].map(c => (
          <div key={c.label} className="kpi-card">
            <div className="kpi-label">{c.label}</div>
            <div className={`kpi-value ${c.cls}`}>{c.value}</div>
            {c.label === 'Units in Stock' && lowStockCount > 0 && (
              <div style={{ marginTop: 8, fontSize: 11, color: '#dc2626', fontWeight: 600 }}>
                {lowStockCount} SKU{lowStockCount > 1 ? 's' : ''} low
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Search / Filter Bar */}
      <div className="card" style={{ marginBottom: 20, padding: '14px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ color: 'var(--text-dim)', fontSize: 16, flexShrink: 0 }}>⌕</span>
          <input
            type="text"
            placeholder="Search by product name or SKU..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              flex: 1, border: 'none', background: 'transparent', padding: '4px 0',
              fontSize: 13, color: 'var(--text)', outline: 'none',
            }}
          />
          {search && (
            <button onClick={() => setSearch('')} style={{
              background: 'none', border: 'none', color: 'var(--text-muted)',
              cursor: 'pointer', fontSize: 14, padding: '2px 6px',
            }}>✕</button>
          )}
          <span style={{ fontSize: 11, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
            {families.length} famil{families.length === 1 ? 'y' : 'ies'} · {filtered.length} SKUs
          </span>
        </div>
      </div>

      {/* Inventory Table */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '18px 24px 0' }}>
          <div className="card-title" style={{ marginBottom: 14 }}>Stock Levels by Product Family</div>
        </div>

        {filtered.length === 0 ? (
          <div className="empty">No inventory matches your search.</div>
        ) : (
          <div className="table-wrap">
            <table style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ paddingLeft: 24, width: 36 }}></th>
                  <th>Product</th>
                  <th>Location</th>
                  <th className="text-right">In Stock</th>
                  <th className="text-right">Sold This Month</th>
                  <th className="text-right">Unit Cost</th>
                  <th className="text-right">Inventory Value</th>
                  <th className="text-right">Retail Value</th>
                  <th>PO #</th>
                </tr>
              </thead>
              <tbody>
                {families.map((fam, fi) => {
                  const isExpanded = expandedFamilies[fam.name];
                  const familyBg = fi % 2 === 0 ? 'var(--bg-card)' : 'var(--bg-alt)';
                  return (
                    <React.Fragment key={fam.name}>
                      {/* Family summary row */}
                      <tr
                        onClick={() => toggleFamily(fam.name)}
                        style={{
                          cursor: 'pointer', background: familyBg,
                          borderBottom: isExpanded ? 'none' : undefined,
                        }}
                      >
                        <td style={{ paddingLeft: 24, width: 36, paddingRight: 0, color: 'var(--text-muted)', fontSize: 10 }}>
                          {isExpanded ? '▼' : '▶'}
                        </td>
                        <td style={{ fontWeight: 700, color: 'var(--text)', fontSize: 14 }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                            {fam.name}
                            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>
                              {fam.skus.length} variant{fam.skus.length > 1 ? 's' : ''}
                            </span>
                            {fam.hasLowStock && <LowStockBadge />}
                          </span>
                        </td>
                        <td>
                          {/* Show unique locations */}
                          <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            {[...new Set(fam.skus.map(s => getLocation(s.sku)))].map(loc => (
                              <LocationBadge key={loc} location={loc} />
                            ))}
                          </span>
                        </td>
                        <td className="text-right">
                          <StockBar current={fam.totalUnits} original={fam.totalOriginal} />
                        </td>
                        <td className="text-right">
                          <SoldArrow value={mn(fam.totalSold)} />
                        </td>
                        <td className="text-right" style={{ color: 'var(--text-muted)' }}>—</td>
                        <td className="text-right" style={{ fontWeight: 600 }}>{mc(_fmt(fam.totalInvValue))}</td>
                        <td className="text-right" style={{ fontWeight: 600, color: 'var(--green)' }}>{mc(_fmt(fam.totalRetValue))}</td>
                        <td></td>
                      </tr>

                      {/* Expanded SKU rows */}
                      {isExpanded && fam.skus.map((row, ri) => (
                        <tr key={row.sku} style={{
                          background: ri % 2 === 0 ? 'var(--bg-alt)' : 'var(--bg-card)',
                        }}>
                          <td style={{ paddingLeft: 24, width: 36 }}></td>
                          <td style={{ paddingLeft: 28 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span style={{ fontSize: 13, color: 'var(--text-body)' }}>
                                {extractVariant(row.product_name)}
                              </span>
                              <span className="mono" style={{ color: 'var(--text-dim)', fontSize: 11 }}>
                                {row.sku}
                              </span>
                              {row.low_stock && <LowStockBadge />}
                            </div>
                          </td>
                          <td><LocationBadge location={getLocation(row.sku)} /></td>
                          <td className="text-right">
                            <StockBar
                              current={mn(row.quantity_remaining)}
                              original={row.quantity_remaining + row.units_sold_this_month}
                            />
                          </td>
                          <td className="text-right">
                            <SoldArrow value={mn(row.units_sold_this_month)} />
                          </td>
                          <td className="text-right">{mc(_fmt(row.unit_cost))}</td>
                          <td className="text-right">{mc(_fmt(row.inventory_value))}</td>
                          <td className="text-right">{mc(_fmt(row.retail_value))}</td>
                          <td style={{
                            fontSize: 11, color: 'var(--text-muted)',
                            maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>
                            {row.po_numbers.join(', ')}
                          </td>
                        </tr>
                      ))}
                    </React.Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td></td>
                  <td style={{ fontWeight: 700, color: 'var(--text-muted)', fontSize: 12 }}>
                    TOTAL ({filtered.length} SKUs across {families.length} families)
                  </td>
                  <td></td>
                  <td className="text-right" style={{ fontWeight: 700 }}>{mn(totalUnits)}</td>
                  <td className="text-right" style={{ fontWeight: 700 }}>{mn(filtered.reduce((s, r) => s + r.units_sold_this_month, 0))}</td>
                  <td></td>
                  <td className="text-right" style={{ fontWeight: 700 }}>{mc(_fmt(totalInvValue))}</td>
                  <td className="text-right" style={{ fontWeight: 700, color: 'var(--green)' }}>{mc(_fmt(totalRetValue))}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
