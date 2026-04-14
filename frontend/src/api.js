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

// COGS — accepts a dateRange { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }
export const getCogsSummary = ({ start, end }) => {
  const params = new URLSearchParams({ start_date: start, end_date: end });
  return request(`/api/cogs/summary?${params}`);
};

// Shopify sync
export const syncShopify = (store = 'au') =>
  request('/api/sync/shopify', { method: 'POST', body: JSON.stringify({ store }) });

// Redo returns sync
export const syncRedo = (store = 'au') =>
  request('/api/sync/redo', { method: 'POST', body: JSON.stringify({ store }) });

// Journal export — returns CSV text
export const exportJournal = (period) =>
  request(`/api/journal/export?period=${period}&format=csv`);

// Capital Expenses
export const getCapitalExpenses = (startDate, endDate) => {
  const params = new URLSearchParams();
  if (startDate) params.set('start_date', startDate);
  if (endDate) params.set('end_date', endDate);
  return request(`/api/capital-expenses?${params}`);
};
export const createCapitalExpense = (body) =>
  request('/api/capital-expenses', { method: 'POST', body: JSON.stringify(body) });
export const updateCapitalExpense = (id, updates) =>
  request(`/api/capital-expenses/${id}`, { method: 'PATCH', body: JSON.stringify(updates) });
export const deleteCapitalExpense = (id) =>
  request(`/api/capital-expenses/${id}`, { method: 'DELETE' });
export const parseCapitalReceipt = ({ text, image_base64, media_type }) =>
  request('/api/capital-expenses/parse-receipt', { method: 'POST', body: JSON.stringify({ text, image_base64, media_type }) });

// GermanDrop wallet
export const getGermanDropBalance = () => request('/api/purchases/germandrop/balance');

// Xero
export const getXeroStatus = () => request('/api/xero/status');
export const getXeroPnl = (startDate, endDate) =>
  request(`/api/xero/pnl?startDate=${startDate}&endDate=${endDate}`);
export const disconnectXero = () =>
  request('/api/xero/disconnect', { method: 'POST' });
