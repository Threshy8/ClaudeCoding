import React, { useEffect, useState, useCallback } from 'react';
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
  const [receiptText, setReceiptText] = useState('');
  const [extracting, setExtracting] = useState(false);

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

  const handleExtract = async () => {
    if (!receiptText.trim()) return;
    setExtracting(true);
    setError(null);
    try {
      const { parsed } = await parseCapitalReceipt(receiptText);
      setForm({
        name: parsed.name || '',
        category: CATEGORIES.includes(parsed.category) ? parsed.category : 'Other',
        amount: parsed.amount != null ? String(parsed.amount) : '',
        purchase_date: parsed.purchase_date || '',
        notes: parsed.notes || '',
      });
      setReceiptText('');
    } catch (err) {
      setError(err.message);
    } finally {
      setExtracting(false);
    }
  };

  const total = items.reduce((s, i) => s + Number(i.amount || 0), 0);
  const hasFormData = form.name || form.amount || form.purchase_date || form.notes;

  return (
    <div style={{ maxWidth: 960, margin: '0 auto' }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 20px', letterSpacing: '-0.02em' }}>Capital Expenses</h2>

      {error && (
        <div style={s.errorBanner}>
          {error}
          <button onClick={() => setError(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: 14, padding: '0 4px' }}>x</button>
        </div>
      )}

      {/* Two-panel layout */}
      <div style={s.panelRow}>
        {/* Left: Manual form */}
        <form onSubmit={handleSubmit} style={s.formCard}>
          <div style={s.cardHeader}>Add Manually</div>

          <div style={s.fieldGroup}>
            <label style={s.label}>Asset Name</label>
            <input
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. MacBook Pro 16&quot;"
              required
              style={s.input}
            />
          </div>

          <div style={s.fieldGroup}>
            <label style={s.label}>Category</label>
            <select
              value={form.category}
              onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
              style={s.input}
            >
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ ...s.fieldGroup, flex: 1 }}>
              <label style={s.label}>Amount (AUD)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.amount}
                onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                placeholder="0.00"
                required
                style={s.input}
              />
            </div>
            <div style={{ ...s.fieldGroup, flex: 1 }}>
              <label style={s.label}>Purchase Date</label>
              <input
                type="date"
                value={form.purchase_date}
                onChange={e => setForm(f => ({ ...f, purchase_date: e.target.value }))}
                required
                style={s.input}
              />
            </div>
          </div>

          <div style={s.fieldGroup}>
            <label style={s.label}>Notes <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}>(optional)</span></label>
            <input
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              placeholder="Supplier, invoice ref, etc."
              style={s.input}
            />
          </div>

          <button type="submit" disabled={saving} style={s.primaryBtn}>
            {saving ? 'Adding...' : 'Add Expense'}
          </button>

          {hasFormData && (
            <button type="button" onClick={() => setForm(emptyForm)} style={s.clearBtn}>Clear form</button>
          )}
        </form>

        {/* Right: Paste receipt */}
        <div style={s.pasteCard}>
          <div style={s.cardHeader}>Paste Receipt</div>

          <div style={s.pasteIconRow}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
              <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
            </svg>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Paste receipt or invoice text below</span>
          </div>

          <div style={s.pasteDropZone}>
            <textarea
              value={receiptText}
              onChange={e => setReceiptText(e.target.value)}
              placeholder="Paste receipt text here... (e.g. email confirmation, order summary, invoice text)"
              rows={6}
              style={s.textarea}
            />
          </div>

          <button
            onClick={handleExtract}
            disabled={extracting || !receiptText.trim()}
            style={{
              ...s.secondaryBtn,
              opacity: (!receiptText.trim() && !extracting) ? 0.5 : 1,
            }}
          >
            {extracting ? 'Extracting...' : 'Extract with AI'}
          </button>
        </div>
      </div>

      {/* Table */}
      <div style={s.tableCard}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={s.th}>Date</th>
              <th style={s.th}>Name</th>
              <th style={s.th}>Category</th>
              <th style={{ ...s.th, textAlign: 'right' }}>Amount</th>
              <th style={s.th}>Notes</th>
              <th style={{ ...s.th, width: 40 }}></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} style={s.emptyCell}>Loading...</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={6} style={s.emptyCell}>No capital expenses recorded yet</td></tr>
            ) : items.map((item, idx) => {
              const catColor = CATEGORY_COLORS[item.category] || CATEGORY_COLORS.Other;
              return (
                <tr key={item.id} style={{ background: idx % 2 === 1 ? 'var(--bg-alt)' : 'transparent' }}>
                  <td style={s.td}>{fmtDate(item.purchase_date)}</td>
                  <td style={{ ...s.td, fontWeight: 500, color: 'var(--text)' }}>{item.name}</td>
                  <td style={s.td}>
                    <span style={{ ...s.badge, background: catColor.bg, color: catColor.text }}>{item.category}</span>
                  </td>
                  <td style={{ ...s.td, textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: 'var(--text)' }}>
                    {fmtCurrency(item.amount)}
                  </td>
                  <td style={{ ...s.td, color: 'var(--text-muted)', fontSize: 12, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.notes || '-'}
                  </td>
                  <td style={{ ...s.td, textAlign: 'center' }}>
                    <button onClick={() => handleDelete(item.id)} style={s.trashBtn} title="Delete">
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
          <div style={s.summaryBar}>
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

const s = {
  panelRow: {
    display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24,
  },
  formCard: {
    display: 'flex', flexDirection: 'column', gap: 14,
    padding: '20px 24px', background: 'var(--bg-card)', border: '1px solid var(--border)',
    borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-sm)',
  },
  pasteCard: {
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
  pasteIconRow: {
    display: 'flex', alignItems: 'center', gap: 8,
  },
  pasteDropZone: {
    border: '2px dashed var(--border)', borderRadius: 'var(--radius-sm)',
    padding: 2, background: 'var(--bg)',
  },
  textarea: {
    width: '100%', padding: '10px 12px', border: 'none', borderRadius: 'var(--radius-sm)',
    fontSize: 13, background: 'transparent', outline: 'none', resize: 'vertical',
    fontFamily: 'var(--font-sans)', boxSizing: 'border-box', lineHeight: 1.5,
  },
  secondaryBtn: {
    padding: '10px', borderRadius: 'var(--radius-sm)', fontSize: 13, fontWeight: 600,
    background: 'var(--bg)', color: 'var(--text-body)', border: '1px solid var(--border)',
    cursor: 'pointer', transition: 'all 0.15s',
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
