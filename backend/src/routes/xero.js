const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const supabase = require('../db/supabase');

const router = express.Router();

const SCOPES = 'openid profile email offline_access accounting.reports.profitandloss.read accounting.settings.read';
const XERO_AUTH_URL = 'https://login.xero.com/identity/connect/authorize';
const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';
const XERO_TIMEOUT = 15000;

// Ensure xero_tokens table exists
async function ensureTable() {
  try {
    const { error } = await supabase.rpc('exec_sql', {
      query: `CREATE TABLE IF NOT EXISTS xero_tokens (
        id SERIAL PRIMARY KEY,
        access_token TEXT,
        refresh_token TEXT,
        expires_at TIMESTAMP,
        tenant_id TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )`
    });
    if (error) console.warn('ensureTable RPC unavailable — table should be created via SQL editor:', error.message);
  } catch (err) {
    console.warn('ensureTable RPC unavailable — table should be created via SQL editor:', err.message);
  }
}

// Get stored token row (most recent)
async function getStoredToken() {
  const { data, error } = await supabase
    .from('xero_tokens')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  if (error || !data) return null;
  return data;
}

// Save or update token
async function saveToken(tokenData) {
  try {
    // Delete old tokens first
    const { error: deleteError } = await supabase.from('xero_tokens').delete().neq('id', 0);
    if (deleteError) console.error('Failed to clear old tokens:', deleteError.message);

    const { error: insertError } = await supabase.from('xero_tokens').insert(tokenData);
    if (insertError) throw new Error(`Failed to save token: ${insertError.message}`);
  } catch (err) {
    console.error('saveToken error:', err.message);
    throw err;
  }
}

// Get authenticated access token, refreshing if expired
async function getAuthenticatedTokens() {
  const stored = await getStoredToken();
  if (!stored) throw new Error('No Xero connection found');

  const expiresAt = new Date(stored.expires_at);
  if (expiresAt <= new Date()) {
    // Refresh the token
    const tokenRes = await axios.post(XERO_TOKEN_URL, new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: stored.refresh_token,
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      auth: { username: process.env.XERO_CLIENT_ID, password: process.env.XERO_CLIENT_SECRET },
      timeout: XERO_TIMEOUT,
    });

    const newTokens = tokenRes.data;
    await saveToken({
      access_token: newTokens.access_token,
      refresh_token: newTokens.refresh_token,
      expires_at: new Date(Date.now() + newTokens.expires_in * 1000).toISOString(),
      tenant_id: stored.tenant_id,
    });

    return { accessToken: newTokens.access_token, tenantId: stored.tenant_id };
  }

  return { accessToken: stored.access_token, tenantId: stored.tenant_id };
}

// ---- Routes ----

// GET /connect — initiate OAuth2 flow (no outgoing requests, just redirect)
router.get('/connect', (req, res) => {
  try {
    const state = crypto.randomBytes(16).toString('hex');
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: process.env.XERO_CLIENT_ID,
      redirect_uri: process.env.XERO_REDIRECT_URI,
      scope: SCOPES,
      state,
    });
    res.redirect(`${XERO_AUTH_URL}?${params.toString()}`);
  } catch (err) {
    console.error('Xero connect error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /callback — handle OAuth2 callback
router.get('/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) throw new Error('No authorization code received');

    // Exchange code for tokens
    const tokenRes = await axios.post(XERO_TOKEN_URL, new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.XERO_REDIRECT_URI,
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      auth: { username: process.env.XERO_CLIENT_ID, password: process.env.XERO_CLIENT_SECRET },
      timeout: XERO_TIMEOUT,
    });

    const tokenSet = tokenRes.data;

    // Get tenant (org) info
    const connectionsRes = await axios.get(XERO_CONNECTIONS_URL, {
      headers: { Authorization: `Bearer ${tokenSet.access_token}` },
      timeout: XERO_TIMEOUT,
    });
    const activeTenant = connectionsRes.data?.[0];

    await ensureTable();
    await saveToken({
      access_token: tokenSet.access_token,
      refresh_token: tokenSet.refresh_token,
      expires_at: new Date(Date.now() + tokenSet.expires_in * 1000).toISOString(),
      tenant_id: activeTenant?.tenantId || null,
    });

    res.redirect('https://watchtheroad.vercel.app/xero?connected=true');
  } catch (err) {
    console.error('Xero callback error:', err);
    res.redirect(`https://watchtheroad.vercel.app/xero?error=${encodeURIComponent(err.message)}`);
  }
});

// GET /status — check connection status
router.get('/status', async (req, res) => {
  try {
    const stored = await getStoredToken();
    if (!stored) {
      return res.json({ connected: false, tenant_name: null });
    }

    let tenantName = null;
    try {
      const { accessToken, tenantId } = await getAuthenticatedTokens();
      const connectionsRes = await axios.get(XERO_CONNECTIONS_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: XERO_TIMEOUT,
      });
      const tenant = connectionsRes.data?.find(t => t.tenantId === tenantId);
      tenantName = tenant?.tenantName || null;
    } catch (authErr) {
      console.error('Xero status: token invalid, clearing:', authErr.message);
      await supabase.from('xero_tokens').delete().neq('id', 0);
      return res.json({ connected: false, tenant_name: null });
    }

    res.json({ connected: true, tenant_name: tenantName });
  } catch (err) {
    console.error('Xero status error:', err);
    res.json({ connected: false, tenant_name: null });
  }
});

// GET /pnl — fetch Profit & Loss report
router.get('/pnl', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate query params required' });
    }

    const { accessToken, tenantId } = await getAuthenticatedTokens();

    const response = await axios.get('https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Xero-Tenant-Id': tenantId,
        Accept: 'application/json',
      },
      params: { fromDate: startDate, toDate: endDate },
      timeout: XERO_TIMEOUT,
    });

    const report = response.data?.Reports?.[0];
    if (!report) {
      return res.status(404).json({ error: 'No P&L report returned from Xero' });
    }

    const result = parsePnlReport(report);
    res.json(result);
  } catch (err) {
    console.error('Xero P&L error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /disconnect — remove tokens
router.post('/disconnect', async (req, res) => {
  try {
    const { error } = await supabase.from('xero_tokens').delete().neq('id', 0);
    if (error) throw new Error(`Failed to delete tokens: ${error.message}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Xero disconnect error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- P&L Report Parser ----

function parsePnlReport(report) {
  const sections = {};
  let currentSection = null;

  // Xero REST API uses capital keys (Rows, RowType, Title, Cells, Value)
  const rows = report.Rows || report.rows || [];

  for (const row of rows) {
    const rowType = row.RowType || row.rowType;
    const title = row.Title || row.title;
    const subRows = row.Rows || row.rows || [];
    const cells = row.Cells || row.cells;

    if (rowType === 'Section' && title) {
      currentSection = title;
      sections[currentSection] = [];
      for (const subRow of subRows) {
        const subType = subRow.RowType || subRow.rowType;
        const subCells = subRow.Cells || subRow.cells;
        if (subType === 'Row' && subCells) {
          const label = subCells[0]?.Value || subCells[0]?.value || '';
          const amount = parseFloat(subCells[1]?.Value || subCells[1]?.value) || 0;
          sections[currentSection].push({ label, amount });
        }
        if (subType === 'SummaryRow' && subCells) {
          const label = subCells[0]?.Value || subCells[0]?.value || '';
          const amount = parseFloat(subCells[1]?.Value || subCells[1]?.value) || 0;
          sections[currentSection].push({ label, amount, isSummary: true });
        }
      }
    }
    if (rowType === 'Row' && cells) {
      const label = cells[0]?.Value || cells[0]?.value || '';
      const amount = parseFloat(cells[1]?.Value || cells[1]?.value) || 0;
      if (label.toLowerCase().includes('gross profit')) {
        sections['Gross Profit'] = [{ label, amount }];
      }
      if (label.toLowerCase().includes('net profit')) {
        sections['Net Profit'] = [{ label, amount }];
      }
    }
  }

  // Build structured response
  const tradingIncome = {};
  let tradingTotal = 0;
  for (const item of sections['Trading Income'] || sections['Income'] || sections['Revenue'] || []) {
    if (item.isSummary) {
      tradingTotal = item.amount;
    } else {
      const key = item.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/, '');
      tradingIncome[key] = item.amount;
    }
  }

  const costOfSales = {};
  let cosTotal = 0;
  for (const item of sections['Less Cost of Sales'] || sections['Cost of Sales'] || []) {
    if (item.isSummary) {
      cosTotal = item.amount;
    } else {
      const key = item.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/, '');
      costOfSales[key] = item.amount;
    }
  }

  const operatingExpenses = {};
  let opexTotal = 0;
  for (const item of sections['Less Operating Expenses'] || sections['Operating Expenses'] || sections['Expenses'] || []) {
    if (item.isSummary) {
      opexTotal = item.amount;
    } else {
      operatingExpenses[item.label] = item.amount;
    }
  }

  const grossProfit = sections['Gross Profit']?.[0]?.amount || (tradingTotal - cosTotal);
  const netProfit = sections['Net Profit']?.[0]?.amount || (grossProfit - opexTotal);

  return {
    tradingIncome: { ...tradingIncome, total: tradingTotal },
    costOfSales: { ...costOfSales, total: cosTotal },
    grossProfit,
    operatingExpenses,
    totalOperatingExpenses: opexTotal,
    netProfit,
    // Also return raw sections for full fidelity display
    rawSections: sections,
  };
}

module.exports = router;
