import React, { useEffect, useState, useCallback, useRef } from 'react';
import { getCapitalExpenses, createCapitalExpense, deleteCapitalExpense, parseCapitalReceipt } from '../api';

const CATEGORIES = ['Machinery', 'Equipment', 'Furniture', 'Vehicle', 'Technology', 'Other'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const CATEGORY_COLORS = {
  Machinery:   { bg: '#FEF3C7', text: '#92400E' },
  Equipment:   { bg: '#DBEAFE', text: '#1E40AF' },
  Furniture:   { bg: '#E0E7FF', text: '#3730A3' },
  Vehicle:     { bg: '#D1FAE5', text: '#065F46' },
  Technology:  { bg: '#EDE9FE', text: '#5B21B6' },
  Other:       { bg: '#F3F4F6', text: '#374151' },
};

function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso + 'T12:00:00');
  return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

function fmtCurrency(val) {
  if (val == null || isNaN(val)) return '$0.00';
  return '$' + Number(val).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const emptyForm = { name: '', category: 'Equipment', amount: '', purchase_date: '', notes: '' };

export default function CapitalExpensesTab() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Image upload state
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);
  const dropZoneRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getCapitalExpenses();
      setItems(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name || !form.category || !form.amount || !form.purchase_date) return;
    setSaving(true);
    setError(null);
    try {
      await createCapitalExpense(form);
      setForm(emptyForm);
      setPreview(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this capital expense?')) return;
    try {
      await deleteCapitalExpense(id);
      setItems(prev => prev.filter(i => i.id !== id));
    } catch (err) {
      setError(err.message);
    }
  };

  // Shared: compress image then send to parse endpoint
  const processFile = async (file) => {
    if (!file.type.startsWith('image/')) {
      setError('Please upload an image file (JPG, PNG)');
      return;
    }

    setUploading(true);
    setError(null);

    try {
      // Show preview
      const previewUrl = URL.createObjectURL(file);
      setPreview(previewUrl);

      // Compress image
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = URL.createObjectURL(file);
      });
      const MAX = 1500;
      let { width, height } = img;
      if (width > MAX || height > MAX) {
        const scale = MAX / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(img.src);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
      const base64 = dataUrl.split(',')[1];

      const { parsed } = await parseCapitalReceipt({ image_base64: base64, media_type: 'image/jpeg' });

      setForm({
        name: parsed.name || '',
        category: CATEGORIES.includes(parsed.category) ? parsed.category : 'Other',
        amount: parsed.amount != null ? String(parsed.amount) : '',
        purchase_date: parsed.purchase_date || '',
        notes: parsed.notes || '',
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    processFile(file);
  };

  // Cmd+V paste support
  const handlePaste = useCallback((e) => {
    if (uploading) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) processFile(file);
        return;
      }
    }
  }, [uploading]); // eslint-disable-line

  // Drag & drop
  const handleDragOver = (e) => { e.preventDefault(); setDragOver(true); };
  const handleDragLeave = () => setDragOver(false);
  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) processFile(file);
  };

  const total = items.reduce((s, i) => s + Number(i.amount || 0), 0);
  const hasFormData = form.name || form.amount || form.purchase_date || form.notes;

  return (
    <div
      tabIndex={0}
      onPaste={handlePaste}
      style={{ maxWidth: 960, margin: '0 auto', outline: 'none' }}
    >
      <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 20px', letterSpacing: '-0.02em' }}>Capital Expenses</h2>

      {error && (
        <div style={st.errorBanner}>
          {error}
          <button onClick={() => setError(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: 14, padding: '0 4px' }}>x</button>
        </div>
      )}

      {/* Two-panel layout */}
      <div style={st.panelRow}>
        {/* Left: Manual form */}
        <form onSubmit={handleSubmit} style={st.formCard}>
          <div style={st.cardHeader}>Add Manually</div>

          <div style={st.fieldGroup}>
            <label style={st.label}>Asset Name</label>
            <input
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. MacBook Pro 16&quot;"
              required
              style={st.input}
            />
          </div>

          <div style={st.fieldGroup}>
            <label style={st.label}>Category</label>
            <select
              value={form.category}
              onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
              style={st.input}
            >
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ ...st.fieldGroup, flex: 1 }}>
              <label style={st.label}>Amount (AUD)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.amount}
                onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                placeholder="0.00"
                required
                style={st.input}
              />
            </div>
            <div style={{ ...st.fieldGroup, flex: 1 }}>
              <label style={st.label}>Purchase Date</label>
              <input
                type="date"
                value={form.purchase_date}
                onChange={e => setForm(f => ({ ...f, purchase_date: e.target.value }))}
                required
                style={st.input}
              />
            </div>
          </div>

          <div style={st.fieldGroup}>
            <label style={st.label}>Notes <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}>(optional)</span></label>
            <input
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              placeholder="Supplier, invoice ref, etc."
              style={st.input}
            />
          </div>

          <button type="submit" disabled={saving} style={st.primaryBtn}>
            {saving ? 'Adding...' : 'Add Expense'}
          </button>

          {hasFormData && (
            <button type="button" onClick={() => { setForm(emptyForm); setPreview(null); }} style={st.clearBtn}>Clear form</button>
          )}
        </form>

        {/* Right: Upload receipt image */}
        <div style={st.uploadCard}>
          <div style={st.cardHeader}>Upload Receipt</div>

          <div
            ref={dropZoneRef}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            style={{
              ...st.dropZone,
              borderColor: dragOver ? 'var(--accent)' : 'var(--border)',
              background: dragOver ? 'var(--accent-dim2)' : 'var(--bg)',
            }}
          >
            {uploading ? (
              <div style={st.dropContent}>
                <div style={{ fontSize: 24, marginBottom: 8, animation: 'spin 1s linear infinite' }}>+</div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Parsing receipt...</div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>Extracting details with AI</div>
              </div>
            ) : preview ? (
              <div style={{ ...st.dropContent, position: 'relative', width: '100%' }}>
                <button
                  onClick={() => setPreview(null)}
                  style={st.previewCloseBtn}
                  title="Clear image"
                >x</button>
                <img src={preview} alt="Receipt preview" style={{ maxWidth: '100%', maxHeight: 160, borderRadius: 6, objectFit: 'contain', marginBottom: 8 }} />
                <div style={{ fontSize: 12, color: 'var(--green)', fontWeight: 600 }}>Extracted — review the form on the left</div>
                <button
                  onClick={() => { setPreview(null); if (fileInputRef.current) fileInputRef.current.click(); }}
                  style={{ ...st.linkBtn, marginTop: 4 }}
                >
                  Upload a different image
                </button>
              </div>
            ) : (
              <div style={st.dropContent}>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <polyline points="21 15 16 10 5 21" />
                </svg>
                <div style={{ fontSize: 13, fontWeight: 600, marginTop: 10 }}>
                  Drop image here, or{' '}
                  <span onClick={() => fileInputRef.current?.click()} style={{ color: 'var(--accent)', cursor: 'pointer', textDecoration: 'underline' }}>browse</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
                  JPG, PNG — or paste with Cmd+V
                </div>
              </div>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileUpload}
            hidden
          />

          {!preview && !uploading && (
            <label
              style={st.uploadBtn}
              onClick={() => fileInputRef.current?.click()}
            >
              + Upload Invoice
            </label>
          )}
        </div>
      </div>

      {/* Table */}
      <div style={st.tableCard}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={st.th}>Date</th>
              <th style={st.th}>Name</th>
              <th style={st.th}>Category</th>
              <th style={{ ...st.th, textAlign: 'right' }}>Amount</th>
              <th style={st.th}>Notes</th>
              <th style={{ ...st.th, width: 40 }}></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} style={st.emptyCell}>Loading...</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={6} style={st.emptyCell}>No capital expenses recorded yet</td></tr>
            ) : items.map((item, idx) => {
              const catColor = CATEGORY_COLORS[item.category] || CATEGORY_COLORS.Other;
              return (
                <tr key={item.id} style={{ background: idx % 2 === 1 ? 'var(--bg-alt)' : 'transparent' }}>
                  <td style={st.td}>{fmtDate(item.purchase_date)}</td>
                  <td style={{ ...st.td, fontWeight: 500, color: 'var(--text)' }}>{item.name}</td>
                  <td style={st.td}>
                    <span style={{ ...st.badge, background: catColor.bg, color: catColor.text }}>{item.category}</span>
                  </td>
                  <td style={{ ...st.td, textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: 'var(--text)' }}>
                    {fmtCurrency(item.amount)}
                  </td>
                  <td style={{ ...st.td, color: 'var(--text-muted)', fontSize: 12, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.notes || '-'}
                  </td>
                  <td style={{ ...st.td, textAlign: 'center' }}>
                    <button onClick={() => handleDelete(item.id)} style={st.trashBtn} title="Delete">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Summary bar */}
        {items.length > 0 && (
          <div style={st.summaryBar}>
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              {items.length} item{items.length !== 1 ? 's' : ''}
            </span>
            <span style={{ fontWeight: 700, fontSize: 14, fontVariantNumeric: 'tabular-nums' }}>
              Total: {fmtCurrency(total)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

const st = {
  panelRow: {
    display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24,
  },
  formCard: {
    display: 'flex', flexDirection: 'column', gap: 14,
    padding: '20px 24px', background: 'var(--bg-card)', border: '1px solid var(--border)',
    borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-sm)',
  },
  uploadCard: {
    display: 'flex', flexDirection: 'column', gap: 12,
    padding: '20px 24px', background: 'var(--bg-card)', border: '1px solid var(--border)',
    borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-sm)',
  },
  cardHeader: {
    fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
    color: 'var(--text-muted)', marginBottom: 2,
  },
  fieldGroup: {
    display: 'flex', flexDirection: 'column', gap: 4,
  },
  label: {
    fontSize: 12, fontWeight: 600, color: 'var(--text-body)',
  },
  input: {
    padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
    fontSize: 13, background: 'var(--bg)', outline: 'none', width: '100%',
    transition: 'border-color 0.15s',
  },
  primaryBtn: {
    padding: '10px', borderRadius: 'var(--radius-sm)', fontSize: 13, fontWeight: 600,
    background: '#1a1a1a', color: '#fff', border: 'none', cursor: 'pointer',
    marginTop: 4,
  },
  clearBtn: {
    background: 'none', border: 'none', cursor: 'pointer', fontSize: 12,
    color: 'var(--text-dim)', textAlign: 'center', padding: '4px 0',
  },
  dropZone: {
    border: '2px dashed var(--border)', borderRadius: 'var(--radius-sm)',
    padding: 20, transition: 'all 0.15s', cursor: 'pointer', minHeight: 180,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  dropContent: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center',
  },
  uploadBtn: {
    display: 'block', textAlign: 'center', padding: '10px', borderRadius: 'var(--radius-sm)',
    fontSize: 13, fontWeight: 600, background: 'var(--accent)', color: '#fff',
    border: 'none', cursor: 'pointer',
  },
  linkBtn: {
    background: 'none', border: 'none', cursor: 'pointer', fontSize: 12,
    color: 'var(--text-muted)', textDecoration: 'underline', padding: 0,
  },
  previewCloseBtn: {
    position: 'absolute', top: -4, right: -4, width: 22, height: 22, borderRadius: '50%',
    background: 'var(--bg-card)', border: '1px solid var(--border)', cursor: 'pointer',
    fontSize: 12, lineHeight: '20px', textAlign: 'center', padding: 0,
    color: 'var(--text-muted)', boxShadow: 'var(--shadow-xs)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  tableCard: {
    background: 'var(--bg-card)', border: '1px solid var(--border)',
    borderRadius: 'var(--radius)', overflow: 'hidden', boxShadow: 'var(--shadow-sm)',
  },
  th: {
    padding: '10px 12px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
    letterSpacing: '0.05em', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)',
    textAlign: 'left', background: 'var(--bg-alt)',
  },
  td: {
    padding: '10px 12px', fontSize: 13, borderBottom: '1px solid var(--border-light)',
  },
  emptyCell: {
    padding: 40, textAlign: 'center', color: 'var(--text-dim)', fontSize: 13,
  },
  badge: {
    display: 'inline-block', padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600,
    whiteSpace: 'nowrap',
  },
  trashBtn: {
    background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)',
    padding: 4, borderRadius: 4, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    transition: 'color 0.15s',
  },
  summaryBar: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '12px 16px', borderTop: '2px solid var(--border)', background: 'var(--bg-alt)',
  },
  errorBanner: {
    background: 'var(--red-dim)', color: 'var(--red)', padding: '10px 16px',
    borderRadius: 8, marginBottom: 16, fontSize: 13, fontWeight: 500,
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  },
};
