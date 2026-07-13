import React, { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import * as XLSX from 'xlsx';
import { useDemoMask } from '../contexts/DemoModeContext';
import { apiFetch, formatCurrency as _fmt, fmtDate, parseSku } from '../utils';

function getLocations(row) {
  return (row.locations && row.locations.length > 0) ? row.locations : ['SCC'];
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

function StockBadges({ scc, gd, mn }) {
  if (!scc && !gd) return null;
  const badges = [];
  if (scc > 0) {
    const c = LOCATION_COLORS['SCC'];
    badges.push(
      <span key="scc" style={{
        display: 'inline-flex', alignItems: 'center', gap: 3,
        padding: '1px 7px', borderRadius: 8, fontSize: 10, fontWeight: 600,
        background: c.bg, color: c.color, border: `1px solid ${c.border}`,
      }}>SCC {mn(scc)}</span>
    );
  }
  if (gd > 0) {
    const c = LOCATION_COLORS['GermanDrop'];
    badges.push(
      <span key="gd" style={{
        display: 'inline-flex', alignItems: 'center', gap: 3,
        padding: '1px 7px', borderRadius: 8, fontSize: 10, fontWeight: 600,
        background: c.bg, color: c.color, border: `1px solid ${c.border}`,
      }}>GD {mn(gd)}</span>
    );
  }
  return <span style={{ display: 'inline-flex', gap: 4, marginLeft: 6 }}>{badges}</span>;
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

function extractFamily(productName) {
  if (!productName) return 'Other';
  const cleaned = productName.replace(/^The\s+/i, '');
  const match = cleaned.match(/^([A-Za-z]+)/);
  return match ? match[1] : 'Other';
}

function extractVariant(productName) {
  if (!productName) return '';
  const cleaned = productName.replace(/^The\s+/i, '');
  const family = cleaned.match(/^([A-Za-z]+)/)?.[1] || '';
  return cleaned.slice(family.length).replace(/^\s*[-–—]\s*/, '').trim() || cleaned;
}

function parseCsvText(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const splitRow = (line) => {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === ',' && !inQuotes) { result.push(current.trim()); current = ''; continue; }
      current += ch;
    }
    result.push(current.trim());
    return result;
  };
  const headers = splitRow(lines[0]).map(h => h.toUpperCase().trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = splitRow(lines[i]);
    if (vals.length < 2) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = vals[idx] || ''; });
    rows.push(row);
  }
  return rows;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export default function InventoryTab() {
  const [snapshots, setSnapshots] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [data, setData] = useState(null); // { snapshot, lines, totals }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [expandedFamilies, setExpandedFamilies] = useState({});
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const [snapshotDate, setSnapshotDate] = useState(todayIso());
  const fileRef = useRef();
  const { mc, mn } = useDemoMask();

  const loadSnapshotList = useCallback(async () => {
    const list = await apiFetch('/api/inventory/snapshots');
    setSnapshots(list);
    return list;
  }, []);

  // Initial mount: load snapshot list, auto-select newest
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadSnapshotList()
      .then(list => {
        if (cancelled) return;
        if (list.length > 0) setSelectedId(list[0].id);
        else { setData(null); setLoading(false); }
      })
      .catch(e => { if (!cancelled) { setError(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [loadSnapshotList]);

  // When selection changes, fetch that snapshot's detail
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setLoading(true);
    apiFetch(`/api/inventory/snapshots/${selectedId}`)
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selectedId]);

  const handleUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!snapshotDate) {
      setUploadResult({ type: 'error', text: 'Pick a snapshot date first.' });
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    setUploading(true); setUploadResult(null);
    try {
      let rows;
      const isExcel = /\.xlsx?$/i.test(file.name) ||
        file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        file.type === 'application/vnd.ms-excel';

      if (isExcel) {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const jsonRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
        rows = jsonRows.map(r => {
          const norm = {};
          for (const [k, v] of Object.entries(r)) {
            norm[k.trim().toUpperCase().replace(/\s+/g, ' ')] = typeof v === 'string' ? v : String(v);
          }
          return norm;
        });
      } else {
        const text = await file.text();
        rows = parseCsvText(text);
      }
      if (rows.length === 0) throw new Error('No data rows found in file');

      const first = rows[0];
      const headers = Object.keys(first);
      // SKU column priority: ExternalId > SKU > ItemCode (search each group in order)
      const SKU_PRIORITY  = [['EXTERNALID', 'EXTERNAL ID'], ['SKU'], ['ITEMCODE', 'ITEM CODE', 'STOCK CODE', 'PRODUCT CODE']];
      const COUNT_ALIASES = ['PHYSICAL', 'COUNT', 'QTY', 'QUANTITY', 'AVAILABLE', 'ON HAND'];
      const NAME_ALIASES  = ['DESCRIPTION', 'PRODUCT NAME', 'PRODUCT', 'NAME', 'ITEM NAME', 'ITEM'];
      const normalize = (h) => h.trim().toUpperCase().replace(/\s+/g, ' ');
      const skuCol = SKU_PRIORITY.reduce((found, aliases) =>
        found || headers.find(h => aliases.includes(normalize(h))), null);
      const countCol = headers.find(h => COUNT_ALIASES.includes(normalize(h)));
      const nameCol  = headers.find(h => NAME_ALIASES.includes(normalize(h)));

      if (!skuCol || !countCol) {
        throw new Error(`Could not find SKU and count columns. Found: ${headers.join(', ')}. Expected: ExternalId/SKU/ItemCode + Physical/Count/Qty/Quantity`);
      }

      const lines = rows
        .filter(r => r[skuCol] && r[countCol] !== '')
        .map(r => ({
          sku: String(r[skuCol]).trim(),
          product_name: nameCol ? String(r[nameCol] || '').trim() : '',
          quantity: parseInt(r[countCol], 10) || 0,
        }))
        .filter(l => l.sku);

      if (lines.length === 0) throw new Error('No valid SKU/count rows found');

      const created = await apiFetch('/api/inventory/snapshots', {
        method: 'POST',
        body: JSON.stringify({
          snapshot_date: snapshotDate,
          label: `Physical count — ${snapshotDate}`,
          lines,
        }),
      });

      setUploadResult({
        type: 'success',
        text: `Snapshot saved for ${fmtDate(snapshotDate)}: ${lines.length} SKUs.`,
      });

      await loadSnapshotList();
      setSelectedId(created.snapshot.id);
    } catch (err) {
      setUploadResult({ type: 'error', text: err.message });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  // Map snapshot lines → the shape the existing family render expects
  const skus = useMemo(() => {
    if (!data?.lines) return [];
    return data.lines.map(l => {
      const isGd = (l.location || '').toLowerCase().includes('german') || (l.location || '').toLowerCase() === 'gd';
      return {
        sku: l.sku,
        product_name: l.product_name || l.sku,
        quantity_remaining: l.quantity,
        unit_cost: l.unit_cost,
        retail_price: l.retail_price,
        inventory_value: l.inventory_value,
        retail_value: l.retail_value,
        scc_stock: isGd ? 0 : l.quantity,
        gd_stock: isGd ? l.quantity : 0,
        locations: [isGd ? 'GermanDrop' : 'SCC'],
        units_sold_this_month: 0,
        po_numbers: [],
        low_stock: l.quantity < 10,
      };
    });
  }, [data]);

  const filtered = useMemo(() => {
    if (!skus.length) return [];
    if (!search.trim()) return skus;
    const q = search.toLowerCase();
    return skus.filter(s =>
      s.sku.toLowerCase().includes(q) ||
      (s.product_name || '').toLowerCase().includes(q)
    );
  }, [skus, search]);

  const families = useMemo(() => {
    const map = {};
    for (const row of filtered) {
      const family = extractFamily(row.product_name);
      if (!map[family]) map[family] = { name: family, skus: [], totalUnits: 0, totalSold: 0, totalInvValue: 0, totalRetValue: 0, totalOriginal: 0, hasLowStock: false, totalScc: 0, totalGd: 0 };
      map[family].skus.push(row);
      map[family].totalUnits += row.quantity_remaining;
      map[family].totalScc += (row.scc_stock || 0);
      map[family].totalGd += (row.gd_stock || 0);
      map[family].totalSold += row.units_sold_this_month;
      map[family].totalInvValue += row.inventory_value;
      map[family].totalRetValue += row.retail_value;
      map[family].totalOriginal += (row.quantity_remaining + row.units_sold_this_month);
      if (row.low_stock) map[family].hasLowStock = true;
    }
    return Object.values(map).sort((a, b) => b.totalRetValue - a.totalRetValue);
  }, [filtered]);

  // Totals — prefer authoritative totals from the backend (cents-accurate) when
  // the user isn't searching; recompute from filtered rows otherwise.
  const totals = useMemo(() => {
    if (!search.trim() && data?.totals) {
      return {
        units: data.totals.total_units,
        skus: data.totals.total_skus,
        inv: data.totals.total_inventory_value,
        ret: data.totals.total_retail_value,
      };
    }
    return {
      units: filtered.reduce((s, r) => s + r.quantity_remaining, 0),
      skus: filtered.length,
      inv: filtered.reduce((s, r) => s + r.inventory_value, 0),
      ret: filtered.reduce((s, r) => s + r.retail_value, 0),
    };
  }, [filtered, data, search]);
  const lowStockCount = filtered.filter(r => r.low_stock).length;

  const toggleFamily = (name) => {
    setExpandedFamilies(prev => ({ ...prev, [name]: !prev[name] }));
  };

  // Header (date dropdown + upload) — shared by every render branch
  const renderHeader = () => (
    <div style={{
      display: 'flex', flexWrap: 'wrap', alignItems: 'center',
      justifyContent: 'space-between', gap: 12, marginBottom: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <label style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>
          Snapshot:
        </label>
        <select
          value={selectedId || ''}
          onChange={e => setSelectedId(e.target.value)}
          disabled={snapshots.length === 0}
          style={{
            padding: '6px 10px', borderRadius: 'var(--radius)',
            border: '1px solid var(--border)', background: 'var(--bg-card)',
            color: 'var(--text)', fontSize: 13, minWidth: 200,
          }}
        >
          {snapshots.length === 0 && <option value="">No snapshots yet</option>}
          {snapshots.map(s => (
            <option key={s.id} value={s.id}>
              {fmtDate(s.snapshot_date)}{s.label ? ` — ${s.label}` : ''}
            </option>
          ))}
        </select>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <label style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>
          Upload as of:
        </label>
        <input
          type="date"
          value={snapshotDate}
          onChange={e => setSnapshotDate(e.target.value)}
          disabled={uploading}
          style={{
            padding: '6px 10px', borderRadius: 'var(--radius)',
            border: '1px solid var(--border)', background: 'var(--bg-card)',
            color: 'var(--text)', fontSize: 13,
          }}
        />
        <label className="btn btn-primary" style={{ cursor: uploading ? 'not-allowed' : 'pointer' }}>
          {uploading ? 'Importing...' : '+ Upload Physical Count'}
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            style={{ display: 'none' }}
            onChange={handleUpload}
            disabled={uploading}
          />
        </label>
      </div>
    </div>
  );

  if (error) return <div className="error-msg">{error}</div>;
  if (loading && snapshots.length === 0) return <div className="loading">Loading inventory data...</div>;

  // Empty state — no snapshots exist yet
  if (snapshots.length === 0) {
    return (
      <div>
        {renderHeader()}
        {uploadResult && (
          <div className={`sync-banner ${uploadResult.type}`} style={{ borderRadius: 'var(--radius)', marginBottom: 16 }}>
            <span>{uploadResult.text}</span>
            <button className="banner-close" onClick={() => setUploadResult(null)}>✕</button>
          </div>
        )}
        <div className="card" style={{ padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 14, color: 'var(--text-muted)' }}>
            No inventory snapshots yet. Pick a date above and upload a physical count to get started.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {renderHeader()}

      {uploadResult && (
        <div className={`sync-banner ${uploadResult.type}`} style={{ borderRadius: 'var(--radius)', marginBottom: 16 }}>
          <span>{uploadResult.text}</span>
          <button className="banner-close" onClick={() => setUploadResult(null)}>✕</button>
        </div>
      )}

      {data?.snapshot && (
        <div style={{
          fontSize: 12, color: 'var(--text-muted)', marginBottom: 12,
        }}>
          Showing inventory as of <strong>{fmtDate(data.snapshot.snapshot_date)}</strong>
          {data.snapshot.label ? ` — ${data.snapshot.label}` : ''}
        </div>
      )}

      {/* KPI Cards */}
      <div className="kpi-grid" style={{ marginBottom: 24 }}>
        {[
          { label: 'Total SKUs', value: mn(totals.skus), cls: '' },
          { label: 'Units in Stock', value: mn(totals.units), cls: '' },
          { label: 'Inventory Value', value: mc(_fmt(totals.inv)), cls: '' },
          { label: 'Retail Value', value: mc(_fmt(totals.ret)), cls: 'green' },
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

        {loading ? (
          <div className="loading" style={{ padding: 24 }}>Loading snapshot...</div>
        ) : filtered.length === 0 ? (
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
                  <th className="text-right">Unit Cost</th>
                  <th className="text-right">Inventory Value</th>
                  <th className="text-right">Retail Value</th>
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
                          <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            {[...new Set(fam.skus.flatMap(s => getLocations(s)))].map(loc => (
                              <LocationBadge key={loc} location={loc} />
                            ))}
                          </span>
                        </td>
                        <td className="text-right">
                          <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                            <StockBar current={fam.totalUnits} original={fam.totalOriginal} />
                            <StockBadges scc={fam.totalScc} gd={fam.totalGd} mn={mn} />
                          </span>
                        </td>
                        <td className="text-right" style={{ color: 'var(--text-muted)' }}>—</td>
                        <td className="text-right" style={{ fontWeight: 600 }}>{mc(_fmt(fam.totalInvValue))}</td>
                        <td className="text-right" style={{ fontWeight: 600, color: 'var(--green)' }}>{mc(_fmt(fam.totalRetValue))}</td>
                      </tr>

                      {/* Expanded SKU rows */}
                      {isExpanded && fam.skus.map((row, ri) => (
                        <tr key={row.sku} style={{
                          background: ri % 2 === 0 ? 'var(--bg-alt)' : 'var(--bg-card)',
                        }}>
                          <td style={{ paddingLeft: 24, width: 36 }}></td>
                          <td style={{ paddingLeft: 28 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              {(() => {
                                const parsed = parseSku(row.sku);
                                const label = parsed.colour
                                  ? `${parsed.colour} · ${parsed.variantNum}-Watch`
                                  : extractVariant(row.product_name);
                                return (
                                  <span style={{ fontSize: 13, color: 'var(--text-body)' }}>
                                    {label}
                                  </span>
                                );
                              })()}
                              <span className="mono" style={{ color: 'var(--text-dim)', fontSize: 11 }}>
                                {row.sku}
                              </span>
                              {row.low_stock && <LowStockBadge />}
                            </div>
                          </td>
                          <td>
                            <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                              {getLocations(row).map(loc => (
                                <LocationBadge key={loc} location={loc} />
                              ))}
                            </span>
                          </td>
                          <td className="text-right">
                            <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                              <StockBar
                                current={mn(row.quantity_remaining)}
                                original={row.quantity_remaining + row.units_sold_this_month}
                              />
                              <StockBadges scc={row.scc_stock} gd={row.gd_stock} mn={mn} />
                            </span>
                          </td>
                          <td className="text-right">{mc(_fmt(row.unit_cost))}</td>
                          <td className="text-right">{mc(_fmt(row.inventory_value))}</td>
                          <td className="text-right">{mc(_fmt(row.retail_value))}</td>
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
                  <td className="text-right" style={{ fontWeight: 700 }}>{mn(totals.units)}</td>
                  <td></td>
                  <td className="text-right" style={{ fontWeight: 700 }}>{mc(_fmt(totals.inv))}</td>
                  <td className="text-right" style={{ fontWeight: 700, color: 'var(--green)' }}>{mc(_fmt(totals.ret))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
