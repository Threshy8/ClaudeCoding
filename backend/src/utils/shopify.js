const axios = require('axios');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Rate-limit-aware Shopify GET with retry on 429.
 * Respects Retry-After header, defaults to 1s wait.
 */
async function shopifyGet(url, accessToken, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await axios.get(url, {
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
      });
    } catch (err) {
      if (err.response?.status === 429 && attempt < retries) {
        const retryAfter = parseFloat(err.response.headers['retry-after']) || 1;
        console.log(`[shopify] Rate limited (429), waiting ${retryAfter}s before retry ${attempt}/${retries}...`);
        await sleep(retryAfter * 1000);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Get Shopify access token — prefers env SHOPIFY_ACCESS_TOKEN,
 * falls back to OAuth client_credentials grant.
 */
async function getShopifyAccessToken() {
  const storeUrl = process.env.SHOPIFY_STORE_URL;
  if (process.env.SHOPIFY_ACCESS_TOKEN) return process.env.SHOPIFY_ACCESS_TOKEN;

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!storeUrl || !clientId || !clientSecret) return null;

  const base = storeUrl.replace(/\/$/, '');
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
  });
  const response = await axios.post(`${base}/admin/oauth/access_token`, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    maxRedirects: 0,
    validateStatus: (status) => status >= 200 && status < 300,
  });

  const data = response.data;
  if (typeof data === 'string' && data.trim().toLowerCase().startsWith('<!')) {
    throw new Error('Shopify returned HTML instead of JSON. Check store URL and app installation.');
  }
  if (!data || !data.access_token) {
    throw new Error(data?.errors || 'No access_token in Shopify response');
  }
  return data.access_token;
}

module.exports = { sleep, shopifyGet, getShopifyAccessToken };
