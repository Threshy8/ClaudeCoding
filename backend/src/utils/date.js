const TZ = process.env.SHOPIFY_STORE_TIMEZONE || 'Australia/Sydney';

/**
 * Convert an ISO date string to YYYY-MM-DD in the store's timezone.
 */
function toStoreDate(isoString) {
  if (!isoString) return null;
  const d = new Date(isoString);
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

module.exports = { toStoreDate, TZ };
