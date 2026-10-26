/**
 * Currency precision registry and currency-safe formatting utilities.
 * Uses integer minor units to eliminate floating-point arithmetic errors.
 */

export interface CurrencyMetadata {
  code: string;
  decimals: number;
  symbol: string;
  name: string;
}

export const CURRENCY_REGISTRY: Record<string, CurrencyMetadata> = {
  USD: { code: 'USD', decimals: 2, symbol: '$', name: 'US Dollar' },
  EUR: { code: 'EUR', decimals: 2, symbol: '€', name: 'Euro' },
  GBP: { code: 'GBP', decimals: 2, symbol: '£', name: 'British Pound' },
  JPY: { code: 'JPY', decimals: 0, symbol: '¥', name: 'Japanese Yen' },
  CAD: { code: 'CAD', decimals: 2, symbol: 'CA$', name: 'Canadian Dollar' },
  AUD: { code: 'AUD', decimals: 2, symbol: 'A$', name: 'Australian Dollar' },
  KWD: { code: 'KWD', decimals: 3, symbol: 'KD', name: 'Kuwaiti Dinar' },
  BHD: { code: 'BHD', decimals: 3, symbol: 'BD', name: 'Bahraini Dinar' },
};

/**
 * Returns currency decimal precision. Defaults to 2 decimals for standard fiat currencies.
 */
export function getCurrencyDecimals(currency: string): number {
  const upper = currency.toUpperCase().trim();
  return CURRENCY_REGISTRY[upper]?.decimals ?? 2;
}

export const getCurrencyPrecision = getCurrencyDecimals;

/**
 * Formats an amount in integer minor units into a localized currency string.
 *
 * Example:
 * formatCurrency(12500, 'USD') -> "$125.00"
 * formatCurrency(12500, 'JPY') -> "¥12,500"
 * formatCurrency(12500, 'KWD') -> "KWD 12.500"
 */
export function formatCurrency(
  amountMinor: number | bigint | null | undefined,
  currency = 'USD',
  locale = 'en-US',
): string {
  if (amountMinor === null || amountMinor === undefined) {
    return '—';
  }

  const numAmount = typeof amountMinor === 'bigint' ? Number(amountMinor) : amountMinor;

  if (!Number.isFinite(numAmount)) {
    return 'Invalid Amount';
  }

  const upperCurrency = currency.toUpperCase().trim();
  const decimals = getCurrencyDecimals(upperCurrency);
  const majorUnits = numAmount / Math.pow(10, decimals);

  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: upperCurrency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(majorUnits);
  } catch {
    // Fallback if currency code is unrecognized by Intl
    const formattedNum = majorUnits.toFixed(decimals);
    return `${upperCurrency} ${formattedNum}`;
  }
}

/**
 * Converts unit price and quantity in minor units safely, detecting integer overflow.
 */
export function calculateLineTotalMinor(unitPriceMinor: number, quantity: number): number {
  if (!Number.isInteger(unitPriceMinor) || unitPriceMinor < 0) {
    throw new Error('Unit price in minor units must be a non-negative integer');
  }
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error('Quantity must be a positive integer');
  }

  const total = unitPriceMinor * quantity;
  if (!Number.isSafeInteger(total)) {
    throw new Error('Total calculation exceeded safe integer bounds');
  }
  return total;
}
