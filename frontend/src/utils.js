/**
 * Shared utilities — formatters, API helpers, constants.
 * Import from here instead of redefining per component.
 */

export const BASE_URL = process.env.REACT_APP_API_URL || '';

export async function apiFetch(path, opts = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export function formatCurrency(n) {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-AU', {
    style: 'currency', currency: 'AUD',
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(Number(n) || 0);
}

export function fmtDate(d) {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
}

const SKU_COLOURS = {
  BLK: 'Black', BRN: 'Brown', GRN: 'Green', GRY: 'Grey',
  WHT: 'White', TAN: 'Tan',   BLU: 'Blue',  RED: 'Red',
};

const SKU_MODELS = {
  CAR: 'Carina', ORI: 'Orion',   VYG: 'Voyager', ATS: 'Atlas',
  CYC: 'Cyclops', IMP: 'Imperium', TAU: 'Taurus',  LEO: 'Leone',
};

/**
 * Parse a SKU in [COLOUR_PREFIX][DIGIT][MODEL_CODE] format, e.g. BLK1CAR.
 * Returns { colour, variantNum, modelCode } with human-readable names,
 * or nulls for any part that is unrecognised.
 */
export function parseSku(externalId) {
  if (!externalId) return { colour: null, variantNum: null, modelCode: null };
  const m = String(externalId).trim().toUpperCase().match(/^([A-Z]{3})(\d)([A-Z]{2,4})$/);
  if (!m) return { colour: null, variantNum: null, modelCode: null };
  return {
    colour:    SKU_COLOURS[m[1]] || null,
    variantNum: parseInt(m[2], 10),
    modelCode: SKU_MODELS[m[3]] || null,
  };
}
