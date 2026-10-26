import { describe, it, expect } from 'vitest';
import {
  formatCurrency,
  getCurrencyPrecision,
  calculateLineTotalMinor,
} from './currency';

describe('Currency Formatting and Calculations', () => {
  it('correctly resolves currency precision for 0, 2, and 3 decimal currencies', () => {
    expect(getCurrencyPrecision('JPY')).toBe(0);
    expect(getCurrencyPrecision('USD')).toBe(2);
    expect(getCurrencyPrecision('EUR')).toBe(2);
    expect(getCurrencyPrecision('GBP')).toBe(2);
    expect(getCurrencyPrecision('KWD')).toBe(3);
    expect(getCurrencyPrecision('BHD')).toBe(3);
    expect(getCurrencyPrecision('UNKNOWN')).toBe(2); // fallback
  });

  it('formats zero-decimal currencies (JPY) without decimal digits', () => {
    const formatted = formatCurrency(5000, 'JPY');
    expect(formatted).toMatch(/(¥|JPY)\s?5,000/);
    expect(formatted).not.toContain('.00');
  });

  it('formats two-decimal currencies (USD) with two decimal places', () => {
    const formatted = formatCurrency(1999, 'USD');
    expect(formatted).toMatch(/\$19\.99/);

    const zero = formatCurrency(0, 'USD');
    expect(zero).toMatch(/\$0\.00/);
  });

  it('formats three-decimal currencies (KWD) with three decimal places', () => {
    const formatted = formatCurrency(12345, 'KWD');
    expect(formatted).toMatch(/12\.345/);
  });

  it('calculates line item total in minor units correctly', () => {
    expect(calculateLineTotalMinor(1999, 3)).toBe(5997);
    expect(calculateLineTotalMinor(0, 1)).toBe(0);
    expect(calculateLineTotalMinor(100, 1)).toBe(100);
  });

  it('rejects invalid quantities or unit prices in calculateLineTotalMinor', () => {
    expect(() => calculateLineTotalMinor(-10, 1)).toThrow('Unit price in minor units must be a non-negative integer');
    expect(() => calculateLineTotalMinor(100, 0)).toThrow('Quantity must be a positive integer');
    expect(() => calculateLineTotalMinor(100, -2)).toThrow('Quantity must be a positive integer');
    expect(() => calculateLineTotalMinor(100, 1.5)).toThrow('Quantity must be a positive integer');
  });

  it('detects integer multiplication overflow', () => {
    expect(() => calculateLineTotalMinor(Number.MAX_SAFE_INTEGER, 2)).toThrow('Total calculation exceeded safe integer bounds');
  });
});
