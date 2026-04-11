import React, { useEffect, useState, useCallback } from 'react';
import { getCapitalExpenses, createCapitalExpense, deleteCapitalExpense } from '../api';

const CATEGORIES = ['Machinery', 'Equipment', 'Furniture', 'Vehicle', 'Technology', 'Other'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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

  const total = items.reduce((s, i) => s + Number(i.amount || 0), 0);

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <h2 style={styles.heading}>Capital Expenses</h2>

      {/* Add form */}
      <form onSubmit={handleSubmit} style={styles.form}>
        <input
          placeholder="Name"
          value={form.name}
          onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
          required
          style={styles.input}
        />
        <select
          value={form.category}
          onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
          style={styles.input}
        >
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <input
          type="number"
          step="0.01"
          min="0"
          placeholder="Amount"
          value={form.amount}
          onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
          required
          style={{ ...styles.input, width: 120 }}
        />
        <input
          type="date"
          value={form.purchase_date}
          onChange={e => setForm(f => ({ ...f, purchase_date: e.target.value }))}
          required
          style={styles.input}
        />
        <input
          placeholder="Notes (optional)"
          value={form.notes}
          onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
          style={{ ...styles.input, flex: 1 }}
        />
        <button type="submit" disabled={saving} style={styles.addBtn}>
          {saving ? 'Adding...' : 'Add'}
        </button>
      </form>

      {error && <div style={styles.errorBanner}>{error}</div>}

      {/* Table */}
      <div style={styles.card}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Date</th>
              <th style={styles.th}>Name</th>
              <th style={styles.th}>Category</th>
              <th style={{ ...styles.th, textAlign: 'right' }}>Amount</th>
              <th style={styles.th}>Notes</th>
              <th style={{ ...styles.th, width: 50 }}></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} style={styles.emptyCell}>Loading...</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={6} style={styles.emptyCell}>No capital expenses recorded</td></tr>
            ) : items.map(item => (
              <tr key={item.id}>
                <td style={styles.td}>{fmtDate(item.purchase_date)}</td>
                <td style={{ ...styles.td, fontWeight: 500 }}>{item.name}</td>
                <td style={styles.td}>
                  <span style={styles.badge}>{item.category}</span>
                </td>
                <td style={{ ...styles.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtCurrency(item.amount)}</td>
                <td style={{ ...styles.td, color: 'var(--text-muted)', fontSize: 12 }}>{item.notes || '-'}</td>
                <td style={styles.td}>
                  <button onClick={() => handleDelete(item.id)} style={styles.deleteBtn} title="Delete">x</button>
                </td>
              </tr>
            ))}
          </tbody>
          {items.length > 0 && (
            <tfoot>
              <tr style={{ borderTop: '2px solid var(--border)' }}>
                <td colSpan={3} style={{ ...styles.td, fontWeight: 700, fontSize: 13 }}>Total</td>
                <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700, fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{fmtCurrency(total)}</td>
                <td colSpan={2}></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

const styles = {
  heading: { fontSize: 18, fontWeight: 700, margin: '0 0 20px', letterSpacing: '-0.02em' },
  form: {
    display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 20,
    padding: '16px 20px', background: 'var(--bg-card)', border: '1px solid var(--border)',
    borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-xs)',
  },
  input: {
    padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)',
    fontSize: 13, background: 'var(--bg)', outline: 'none',
  },
  addBtn: {
    padding: '8px 20px', borderRadius: 8, fontSize: 13, fontWeight: 600,
    background: '#1a1a1a', color: '#fff', border: 'none', cursor: 'pointer',
  },
  card: {
    background: 'var(--bg-card)', border: '1px solid var(--border)',
    borderRadius: 'var(--radius)', overflow: 'hidden', boxShadow: 'var(--shadow-sm)',
  },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: {
    padding: '10px 12px', fontSize: 12, fontWeight: 600, textTransform: 'uppercase',
    letterSpacing: '0.04em', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', textAlign: 'left',
  },
  td: { padding: '10px 12px', fontSize: 13, borderBottom: '1px solid var(--border-light)' },
  emptyCell: { padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 },
  badge: {
    display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600,
    background: 'var(--accent-dim)', color: 'var(--accent-deep)',
  },
  deleteBtn: {
    background: 'none', border: '1px solid var(--border)', borderRadius: 6,
    cursor: 'pointer', fontSize: 12, color: 'var(--red)', padding: '2px 8px',
  },
  errorBanner: {
    background: 'var(--red-dim)', color: 'var(--red)', padding: '10px 16px',
    borderRadius: 8, marginBottom: 16, fontSize: 13, fontWeight: 500,
  },
};
