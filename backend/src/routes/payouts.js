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

    // Aggregate payout summary across all payouts in range
    const summary = {
      payout_count: payouts.length,
      total_amount: 0,        // net payout to bank
      charges_gross: 0,
      charges_fee: 0,
      charges_net: 0,
      refunds_gross: 0,
      refunds_fee: 0,
      adjustments_gross: 0,
      reserved_funds: 0,
    };

    for (const p of payouts) {
      summary.total_amount += parseFloat(p.amount || 0);
      // summary fields from payout.summary if present
      const s = p.summary;
      if (s) {
        summary.charges_gross += parseFloat(s.charges_gross || 0);
        summary.charges_fee += parseFloat(s.charges_fee || 0);
        summary.charges_net += parseFloat(s.charges_net || 0);
        summary.refunds_gross += parseFloat(s.refunds_gross || 0);
        summary.refunds_fee += parseFloat(s.refunds_fee || 0);
        summary.adjustments_gross += parseFloat(s.adjustments_gross || 0);
        summary.reserved_funds += parseFloat(s.reserved_funds || 0);
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
    console.error('[Payouts] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
