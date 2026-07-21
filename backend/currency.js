'use strict';

// Currency formatting — unified ¥ / $ display for meter costs.
//
// Both the renderer (pet.js / panel.js) and the main process (tray menu budget
// label) need the same symbol + formatting.  This module exports the pure
// functions; the config module stores the active currency preference.
//
// Currency codes:
//   'USD' — US Dollar ($)
//   'CNY' — Chinese Yuan (¥)
//
// The fxRate is stored separately so users can set their own exchange rate
// (default 7.2 CNY per USD).  When currency === 'USD', fxRate is irrelevant.

const SYMBOLS = Object.freeze({
  USD: '$',
  CNY: '¥',
});

const DEFAULT_CURRENCY = 'USD';
const DEFAULT_FX_RATE = 7.2;

// Known currency codes.
const CURRENCIES = Object.freeze(['USD', 'CNY']);

function isValidCurrency(c) {
  return c === 'USD' || c === 'CNY';
}

/**
 * Return the currency symbol for a given currency code.
 * @param {string} currency - 'USD' or 'CNY'
 * @returns {string} '$' or '¥'
 */
function symbol(currency) {
  if (!isValidCurrency(currency)) return SYMBOLS[DEFAULT_CURRENCY];
  return SYMBOLS[currency] || SYMBOLS[DEFAULT_CURRENCY];
}

/**
 * Format a cost value to a display string with the appropriate currency symbol.
 * Handles the USD→CNY conversion when the currency is CNY.
 *
 * @param {number} cost - Cost in USD (from meter stats, always stored in USD)
 * @param {string} currency - 'USD' or 'CNY'
 * @param {number} fxRate - Exchange rate (CNY per USD), default 7.2
 * @returns {string} e.g. "$0.123" or "¥0.89"
 */
function formatCost(cost, currency, fxRate) {
  const n = Number(cost) || 0;
  const cur = isValidCurrency(currency) ? currency : DEFAULT_CURRENCY;
  const rate = Number.isFinite(fxRate) && fxRate > 0 ? fxRate : DEFAULT_FX_RATE;
  const sym = SYMBOLS[cur] || '$';
  const display = cur === 'CNY' ? n * rate : n;
  // Show 3 decimal places for small amounts, 2 for larger
  if (Math.abs(display) < 1) return sym + display.toFixed(3);
  if (Math.abs(display) < 100) return sym + display.toFixed(2);
  return sym + display.toFixed(1);
}

/**
 * Format a cost value for tooltip/hover — more precision than formatCost.
 * @param {number} cost - Cost in USD
 * @param {string} currency
 * @param {number} fxRate
 * @returns {string}
 */
function formatCostPrecise(cost, currency, fxRate) {
  const n = Number(cost) || 0;
  const cur = isValidCurrency(currency) ? currency : DEFAULT_CURRENCY;
  const rate = Number.isFinite(fxRate) && fxRate > 0 ? fxRate : DEFAULT_FX_RATE;
  const sym = SYMBOLS[cur] || '$';
  const display = cur === 'CNY' ? n * rate : n;
  return sym + display.toFixed(3);
}

/**
 * Format a budget label in tray menu: "¥ 71" or "$ 10".
 * Budget amounts in config are always stored in USD.
 *
 * @param {number} usdAmount - Budget amount in USD
 * @param {string} currency
 * @param {number} fxRate
 * @returns {string} e.g. "$10" or "¥72"
 */
function budgetLabel(usdAmount, currency, fxRate) {
  const n = Number(usdAmount) || 0;
  const cur = isValidCurrency(currency) ? currency : DEFAULT_CURRENCY;
  const rate = Number.isFinite(fxRate) && fxRate > 0 ? fxRate : DEFAULT_FX_RATE;
  const sym = SYMBOLS[cur] || '$';
  const display = cur === 'CNY' ? n * rate : n;
  return sym + Math.round(display);
}

module.exports = { formatCost, formatCostPrecise, budgetLabel, symbol, isValidCurrency, CURRENCIES, DEFAULT_CURRENCY, DEFAULT_FX_RATE };
