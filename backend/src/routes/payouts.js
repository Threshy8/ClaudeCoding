const express = require('express');
const router = express.Router();
const axios = require('axios');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Exchange client credentials for an OAuth access token
async function getOAuthToken(storeUrl, clientId, clientSecret) {
  const base = storeUrl.replace(/\/$/, '');
  const tokenUrl = `${base}/admin/oauth/access_token`;
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
  });

  const response = await axios.post(tokenUrl, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    maxRedirects: 0,
    validateStatus: (status) => status >= 200 && status < 300,
  });

  const data = response.data;
  if (!data || !data.access_token) {
    throw new Error(data?.errors || 'No access_token in Shopify response');
  }
  return data.access_token;
}

async function getAccessToken() {
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
  if (accessToken) return accessToken;

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  const storeUrl = process.env.SHOPIFY_STORE_URL;
  if (clientId && clientSecret && storeUrl) {
    return getOAuthToken(storeUrl, clientId, clientSecret);
  }

  throw new Error('Shopify auth not configured. Set SHOPIFY_ACCESS_TOKEN or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET');
}

async function shopifyGet(url, token, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await axios.get(url, {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
        },
      });
    } catch (err) {
      if (err.response?.status === 429 && attempt < retries) {
        const retryAfter = parseFloat(err.response.headers['retry-after']) || 1;
        await sleep(retryAfter * 1000);
        continue;
      }
      throw err;
    }
  }
}

// Fetch all balance transactions for a payout (paginated)
async function fetchPayoutTransactions(storeUrl, token, payoutId) {
  const txns = [];
  let url = `${storeUrl}/admin/api/2024-01/shopify_payments/balance/transactions.json?payout_id=${payoutId}&limit=250`;

  let pageCount = 0;
  while (url) {
    if (pageCount > 0) await sleep(500);
    const response = await shopifyGet(url, token);
    pageCount++;

    const batch = response.data.transactions || [];
    txns.push(...batch);

    const linkHeader = response.headers['link'];
    if (linkHeader && linkHeader.includes('rel="next"')) {
      const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      url = match ? match[1] : null;
    } else {
      url = null;
    }
  }

  return txns;
}

// GET /api/payouts?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
router.get('/', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    if (!start_date || !end_date) {
      return res.status(400).json({ error: 'start_date and end_date required' });
    }

    const storeUrl = (process.env.SHOPIFY_STORE_URL || '').replace(/\/$/, '');
    if (!storeUrl) {
      return res.status(500).json({ error: 'SHOPIFY_STORE_URL not configured' });
    }

    const token = await getAccessToken();

    // Fetch all payouts in date range (paginated)
    const payouts = [];
    let url = `${storeUrl}/admin/api/2024-01/shopify_payments/payouts.json?date_min=${start_date}&date_max=${end_date}&limit=100`;

    let pageCount = 0;
    while (url) {
      if (pageCount > 0) await sleep(500);
      const response = await shopifyGet(url, token);
      pageCount++;

      const batch = response.data.payouts || [];
      payouts.push(...batch);

      const linkHeader = response.headers['link'];
      if (linkHeader && linkHeader.includes('rel="next"')) {
        const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        url = match ? match[1] : null;
      } else {
        url = null;
      }
    }

    // Fetch transactions for each payout to build the breakdown
    const summary = {
      payout_count: payouts.length,
      total_amount: 0,
      charges_gross: 0,
      charges_fee: 0,
      refunds_gross: 0,
      refunds_fee: 0,
      adjustments_gross: 0,
      reserved_funds: 0,
    };

    for (const p of payouts) {
      summary.total_amount += parseFloat(p.amount || 0);

      // Fetch balance transactions for this payout
      try {
        const txns = await fetchPayoutTransactions(storeUrl, token, p.id);
        for (const t of txns) {
          const amount = parseFloat(t.amount || 0);
          const fee = parseFloat(t.fee || 0);
          switch (t.type) {
            case 'charge':
              summary.charges_gross += amount + fee; // gross = net + fee
              summary.charges_fee += fee;
              break;
            case 'refund':
              summary.refunds_gross += amount; // refunds are negative
              summary.refunds_fee += fee;
              break;
            case 'adjustment':
              summary.adjustments_gross += amount;
              break;
            case 'reserve_transfer':
            case 'reserved_funds':
              summary.reserved_funds += amount;
              break;
            default:
              // payout type = the payout itself, skip
              if (t.type !== 'payout') {
                summary.adjustments_gross += amount;
              }
              break;
          }
        }
      } catch (txnErr) {
        console.warn(`[Payouts] Failed to fetch transactions for payout ${p.id}:`, txnErr.message);
        // Continue without breakdown for this payout
      }
    }

    // Round all values
    for (const key of Object.keys(summary)) {
      if (key === 'payout_count') continue;
      summary[key] = Math.round(summary[key] * 100) / 100;
    }

    res.json({
      payouts: payouts.map(p => ({
        id: p.id,
        date: p.date,
        amount: parseFloat(p.amount || 0),
        status: p.status,
        currency: p.currency,
      })),
      summary,
    });
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.errors || err.message;
    console.error(`[Payouts] Error (HTTP ${status || 'N/A'}):`, detail);

    // If it's a scope/auth issue (403) or not-found (404), return empty payouts
    // so the frontend gracefully falls back to revenue calculation
    if (status === 403 || status === 404 || status === 401) {
      console.warn('[Payouts] Likely missing scope read_shopify_payments_payouts — returning empty');
      return res.json({
        payouts: [],
        summary: { payout_count: 0, total_amount: 0, charges_gross: 0, charges_fee: 0, refunds_gross: 0, refunds_fee: 0, adjustments_gross: 0, reserved_funds: 0 },
        warning: `Shopify Payments API returned ${status}. Ensure your app has the read_shopify_payments_payouts scope.`,
      });
    }

    res.status(500).json({ error: detail });
  }
});

module.exports = router;
