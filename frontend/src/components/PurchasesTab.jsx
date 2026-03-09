import React, { useEffect, useState, useCallback } from 'react';
import { getPurchases, createPurchase, deletePurchase } from '../api';

function fmt(n) {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(n || 0);
}

function formatDate(d) {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
}

const EMPTY_FORM = {
  sku: '',
  product_name: '',
  quantity: '',
  unit_cost: '',
  purchase_date: '',
  supplier_notes: '',
};

export default function PurchasesTab() {
  const [purchases, setPurchases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getPurchases()
      .then(setPurchases)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleOpen = () => {
    setForm({ ...EMPTY_FORM, purchase_date: new Date().toISOString().split('T')[0] });
    setSaveError(null);
    setShowModal(true);
  };

  const handleClose = () => { setShowModal(false); setSaveError(null); };

  const handleChange = (e) => setForm((f) => ({ ...f, [e.target.name]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    try {
      await createPurchase({
        ...form,
        quantity: parseInt(form.quantity),
        unit_cost: parseFloat(form.unit_cost),
      });
      setShowModal(false);
      load();
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this purchase record?')) return;
    setDeletingId(id);
    try {
      await deletePurchase(id);
      setPurchases((p) => p.filter((r) => r.id !== id));
    } catch (err) {
      alert('Delete failed: ' + err.message);
    } finally {
      setDeletingId(null);
    }
  };

  const totalValue = purchases.reduce((s, p) => s + p.quantity * parseFloat(p.unit_cost), 0);

  return (
    <div>
      {error && <div className="error-msg">{error}</div>}

      <div className="section-header">
        <div>
          <div className="section-title">Stock Purchases</div>
          {!loading && (
            <div className="text-muted" style={{ fontSize: 12, marginTop: 2 }}>
              {purchases.length} records · Total value: {fmt(totalValue)}
            </div>
          )}
        </div>
        <button className="btn btn-primary" onClick={handleOpen}>+ Log Purchase</button>
      </div>

      {loading ? (
        <div className="loading">Loading purchases…</div>
      ) : (
        <div className="card">
          {purchases.length === 0 ? (
            <div className="empty">No purchases yet. Click "Log Purchase" to add your first stock entry.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>SKU</th>
                    <th>Product</th>
                    <th className="text-right">Qty</th>
                    <th className="text-right">Unit Cost</th>
                    <th className="text-right">Total Cost</th>
                    <th>Notes</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {purchases.map((p) => (
                    <tr key={p.id}>
                      <td className="text-muted">{formatDate(p.purchase_date)}</td>
                      <td><span className="mono">{p.sku}</span></td>
                      <td>{p.product_name}</td>
                      <td className="text-right">{p.quantity}</td>
                      <td className="text-right">{fmt(p.unit_cost)}</td>
                      <td className="text-right">{fmt(p.quantity * parseFloat(p.unit_cost))}</td>
                      <td className="text-muted" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.supplier_notes || '—'}
                      </td>
                      <td>
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => handleDelete(p.id)}
                          disabled={deletingId === p.id}
                        >
                          {deletingId === p.id ? '…' : 'Delete'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Log Purchase Modal */}
      {showModal && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && handleClose()}>
          <div className="modal">
            <div className="modal-title">Log Purchase</div>
            {saveError && <div className="error-msg">{saveError}</div>}
            <form onSubmit={handleSubmit}>
              <div className="form-grid">
                <div className="form-group">
                  <label>SKU *</label>
                  <input name="sku" value={form.sku} onChange={handleChange} required placeholder="e.g. ROL-SUB-124060" />
                </div>
                <div className="form-group">
                  <label>Purchase Date *</label>
                  <input type="date" name="purchase_date" value={form.purchase_date} onChange={handleChange} required />
                </div>
                <div className="form-group full">
                  <label>Product Name *</label>
                  <input name="product_name" value={form.product_name} onChange={handleChange} required placeholder="e.g. Rolex Submariner 124060" />
                </div>
                <div className="form-group">
                  <label>Quantity *</label>
                  <input type="number" name="quantity" value={form.quantity} onChange={handleChange} required min="1" placeholder="1" />
                </div>
                <div className="form-group">
                  <label>Unit Cost (AUD) *</label>
                  <input type="number" name="unit_cost" value={form.unit_cost} onChange={handleChange} required min="0" step="0.01" placeholder="15000.00" />
                </div>
                <div className="form-group full">
                  <label>Supplier Notes</label>
                  <textarea name="supplier_notes" value={form.supplier_notes} onChange={handleChange} placeholder="Optional — dealer name, invoice ref, etc." />
                </div>
              </div>

              {form.quantity && form.unit_cost && (
                <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--accent-dim)', borderRadius: 'var(--radius-sm)', fontSize: 13, color: 'var(--accent)' }}>
                  Total cost: {new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(parseInt(form.quantity || 0) * parseFloat(form.unit_cost || 0))}
                </div>
              )}

              <div className="modal-footer">
                <button type="button" className="btn btn-ghost" onClick={handleClose}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? 'Saving…' : 'Save Purchase'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
