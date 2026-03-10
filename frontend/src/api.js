/**
 * API client — all backend calls live here.
 * In development, CRA proxy forwards /api/* to http://localhost:3001.
 * In production, set REACT_APP_API_URL to your Railway backend URL.
 */

const BASE_URL = process.env.REACT_APP_API_URL || '';

async function request(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Request failed: ${res.status}`);
  }

  // CSV responses — return raw text
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/csv')) {
    return res.text();
  }

  return res.json();
}

// Purchases
export const getPurchases = () => request('/api/purchases');
export const createPurchase = (body) => request('/api/purchases', { method: 'POST', body: JSON.stringify(body) });
export const deletePurchase = (id) => request(`/api/purchases/${id}`, { method: 'DELETE' });

// Products
export const getProducts = () => request('/api/products');

// COGS — through: optional YYYY-MM-DD to cap period (match Shopify month-to-date)
export const getCogsSummary = (period, through) => {
  const params = new URLSearchParams({ period });
  if (through) params.set('through', through);
  return request(`/api/cogs/summary?${params}`);
};

// Shopify sync
export const syncShopify = (store = 'au') =>
  request('/api/sync/shopify', { method: 'POST', body: JSON.stringify({ store }) });

// Journal export — returns CSV text
export const exportJournal = (period) =>
  request(`/api/journal/export?period=${period}&format=csv`);
