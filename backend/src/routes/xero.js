const express = require('express');
const { XeroClient } = require('xero-node');
const supabase = require('../db/supabase');

const router = express.Router();

const SCOPES = 'openid profile email offline_access accounting.reports.profitandloss.read accounting.settings.read';

function createXeroClient() {
  return new XeroClient({
    clientId: process.env.XERO_CLIENT_ID,
    clientSecret: process.env.XERO_CLIENT_SECRET,
    redirectUris: [process.env.XERO_REDIRECT_URI],
    scopes: SCOPES.split(' '),
  });
}

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

// Build an authenticated XeroClient from stored tokens
async function getAuthenticatedClient() {
  const stored = await getStoredToken();
  if (!stored) throw new Error('No Xero connection found');

  const xero = createXeroClient();

  // Set the token set on the client
  xero.setTokenSet({
    access_token: stored.access_token,
    refresh_token: stored.refresh_token,
    expires_at: Math.floor(new Date(stored.expires_at).getTime() / 1000),
    token_type: 'Bearer',
    scope: SCOPES,
  });

  // Check if token is expired and refresh if needed
  const expiresAt = new Date(stored.expires_at);
  if (expiresAt <= new Date()) {
    const newTokenSet = await xero.refreshToken();
    await saveToken({
      access_token: newTokenSet.access_token,
      refresh_token: newTokenSet.refresh_token,
      expires_at: new Date(newTokenSet.expires_at * 1000).toISOString(),
      tenant_id: stored.tenant_id,
    });
  }

  return { xero, tenantId: stored.tenant_id };
}

// ---- Routes ----

// GET /connect — initiate OAuth2 flow
router.get('/connect', async (req, res) => {
  try {
    const xero = createXeroClient();
    const consentUrl = await xero.buildConsentUrl();
    res.redirect(consentUrl);
  } catch (err) {
    console.error('Xero connect error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /callback — handle OAuth2 callback
router.get('/callback', async (req, res) => {
  try {
    const xero = createXeroClient();
    const tokenSet = await xero.apiCallback(req.url);

    await xero.updateTenants();
    const activeTenant = xero.tenants[0];

    await ensureTable();
    await saveToken({
      access_token: tokenSet.access_token,
      refresh_token: tokenSet.refresh_token,
      expires_at: new Date(tokenSet.expires_at * 1000).toISOString(),
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

    // Attempt to authenticate (refreshes token if expired)
    let tenantName = null;
    try {
      const { xero, tenantId } = await getAuthenticatedClient();
      await xero.updateTenants();
      const tenant = xero.tenants.find(t => t.tenantId === tenantId);
      tenantName = tenant?.tenantName || null;
    } catch (authErr) {
      // Token refresh failed — connection is no longer valid
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

    const { xero, tenantId } = await getAuthenticatedClient();

    const response = await xero.accountingApi.getReportProfitAndLoss(
      tenantId,
      startDate,       // fromDate
      endDate,         // toDate
      undefined,       // periods
      undefined,       // timeframe
      undefined,       // trackingCategoryID
      undefined,       // trackingCategoryID2
      undefined,       // trackingOptionID
      undefined,       // trackingOptionID2
      undefined,       // standardLayout
      undefined,       // paymentsOnly
    );

    const report = response.body?.reports?.[0];
    if (!report) {
      return res.status(404).json({ error: 'No P&L report returned from Xero' });
    }

    // Parse the report rows into structured data
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

  for (const row of report.rows || []) {
    if (row.rowType === 'Section' && row.title) {
      currentSection = row.title;
      sections[currentSection] = [];
      for (const subRow of row.rows || []) {
        if (subRow.rowType === 'Row' && subRow.cells) {
          const label = subRow.cells[0]?.value || '';
          const amount = parseFloat(subRow.cells[1]?.value) || 0;
          sections[currentSection].push({ label, amount });
        }
        if (subRow.rowType === 'SummaryRow' && subRow.cells) {
          const label = subRow.cells[0]?.value || '';
          const amount = parseFloat(subRow.cells[1]?.value) || 0;
          sections[currentSection].push({ label, amount, isSummary: true });
        }
      }
    }
    if (row.rowType === 'Row' && row.cells) {
      const label = row.cells[0]?.value || '';
      const amount = parseFloat(row.cells[1]?.value) || 0;
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
