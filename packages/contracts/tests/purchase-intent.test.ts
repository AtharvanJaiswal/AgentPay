import { describe, it, expect } from 'vitest';
import {
  PurchaseIntentSchema,
  type PurchaseIntent,
  convertDecimalToMinorUnits,
  isSupportedCurrency,
  getCurrencyDecimals,
  PurchaseIntentParseResultSchema,
} from '../src/purchase-intent.js';

describe('Increment 1: Purchase-Intent Contract & Validation', () => {
  const validBaseIntent: PurchaseIntent = {
    schemaVersion: 1,
    requestId: 'req-test-1234',
    idempotencyKey: 'idemp-test-abcd',
    intent: {
      action: 'purchase',
      productQuery: 'Developer Cloud VM Tier 1',
      quantity: 1,
    },
    context: {
      source: 'user',
    },
  };

  it('validates a valid minimum request successfully', () => {
    const result = PurchaseIntentSchema.safeParse(validBaseIntent);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schemaVersion).toBe(1);
      expect(result.data.intent.action).toBe('purchase');
      expect(result.data.intent.productQuery).toBe('Developer Cloud VM Tier 1');
      expect(result.data.intent.quantity).toBe(1);
      expect(result.data.context.source).toBe('user');
    }
  });

  it('validates a valid request with all optional constraints and context', () => {
    const fullIntent: PurchaseIntent = {
      schemaVersion: 1,
      requestId: 'req-full-5678',
      idempotencyKey: 'idemp-full-efgh',
      intent: {
        action: 'purchase',
        productQuery: 'Domain Registration Services',
        merchantPreference: 'SecureName Registrars',
        quantity: 3,
        constraints: {
          maxUnitPriceMinor: 2000,
          maxTotalMinor: 6000,
          currency: 'USD',
        },
      },
      context: {
        source: 'user',
        locale: 'en-US',
        principalId: 'user-principal-999',
      },
    };

    const result = PurchaseIntentSchema.safeParse(fullIntent);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.intent.merchantPreference).toBe('SecureName Registrars');
      expect(result.data.intent.quantity).toBe(3);
      expect(result.data.intent.constraints?.maxUnitPriceMinor).toBe(2000);
      expect(result.data.intent.constraints?.maxTotalMinor).toBe(6000);
      expect(result.data.intent.constraints?.currency).toBe('USD');
      expect(result.data.context.locale).toBe('en-US');
      expect(result.data.context.principalId).toBe('user-principal-999');
    }
  });

  it('rejects an empty product query', () => {
    const invalid = {
      ...validBaseIntent,
      intent: { ...validBaseIntent.intent, productQuery: '   ' },
    };
    const result = PurchaseIntentSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects a negative quantity', () => {
    const invalid = {
      ...validBaseIntent,
      intent: { ...validBaseIntent.intent, quantity: -1 },
    };
    const result = PurchaseIntentSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects zero quantity', () => {
    const invalid = {
      ...validBaseIntent,
      intent: { ...validBaseIntent.intent, quantity: 0 },
    };
    const result = PurchaseIntentSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects fractional quantity', () => {
    const invalid = {
      ...validBaseIntent,
      intent: { ...validBaseIntent.intent, quantity: 2.5 },
    };
    const result = PurchaseIntentSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects excessive quantity (> 1000)', () => {
    const invalid = {
      ...validBaseIntent,
      intent: { ...validBaseIntent.intent, quantity: 1001 },
    };
    const result = PurchaseIntentSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects negative monetary constraints', () => {
    const invalid = {
      ...validBaseIntent,
      intent: {
        ...validBaseIntent.intent,
        constraints: {
          maxUnitPriceMinor: -500,
          currency: 'USD',
        },
      },
    };
    const result = PurchaseIntentSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects zero monetary constraint where positive minor unit is required', () => {
    const invalid = {
      ...validBaseIntent,
      intent: {
        ...validBaseIntent.intent,
        constraints: {
          maxUnitPriceMinor: 0,
          currency: 'USD',
        },
      },
    };
    const result = PurchaseIntentSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects unsafe integer values for monetary amounts', () => {
    const invalid = {
      ...validBaseIntent,
      intent: {
        ...validBaseIntent.intent,
        constraints: {
          maxTotalMinor: Number.MAX_SAFE_INTEGER + 10,
          currency: 'USD',
        },
      },
    };
    const result = PurchaseIntentSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects floating-point internal amounts in constraints', () => {
    const invalid = {
      ...validBaseIntent,
      intent: {
        ...validBaseIntent.intent,
        constraints: {
          maxUnitPriceMinor: 19.99, // Should be integer cents, not float!
          currency: 'USD',
        },
      },
    };
    const result = PurchaseIntentSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects invalid or unsupported currency code', () => {
    const invalid = {
      ...validBaseIntent,
      intent: {
        ...validBaseIntent.intent,
        constraints: {
          currency: 'XYZ',
        },
      },
    };
    const result = PurchaseIntentSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects unsupported schema version', () => {
    const invalid = {
      ...validBaseIntent,
      schemaVersion: 2,
    };
    const result = PurchaseIntentSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects missing or empty idempotency key', () => {
    const invalid = {
      ...validBaseIntent,
      idempotencyKey: '   ',
    };
    const result = PurchaseIntentSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects unknown or unsupported action', () => {
    const invalid = {
      ...validBaseIntent,
      intent: {
        ...validBaseIntent.intent,
        action: 'refund',
      },
    };
    const result = PurchaseIntentSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects excessively long product queries (> 500 chars)', () => {
    const invalid = {
      ...validBaseIntent,
      intent: {
        ...validBaseIntent.intent,
        productQuery: 'a'.repeat(501),
      },
    };
    const result = PurchaseIntentSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('strictly rejects unexpected fields in the schema', () => {
    const invalid = {
      ...validBaseIntent,
      maliciousPayload: true,
    };
    const result = PurchaseIntentSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  describe('Currency Metadata & Minor Unit Conversions', () => {
    it('provides metadata for supported currencies without hardcoding universal 100x', () => {
      expect(isSupportedCurrency('USD')).toBe(true);
      expect(isSupportedCurrency('INR')).toBe(true);
      expect(isSupportedCurrency('JPY')).toBe(true);
      expect(isSupportedCurrency('EUR')).toBe(true);
      expect(isSupportedCurrency('FAKE')).toBe(false);

      expect(getCurrencyDecimals('USD')).toBe(2);
      expect(getCurrencyDecimals('INR')).toBe(2);
      expect(getCurrencyDecimals('JPY')).toBe(0); // Zero decimals for Yen!
    });

    it('safely converts decimal amounts to integer minor units', () => {
      expect(convertDecimalToMinorUnits(15.5, 'USD')).toBe(1550);
      expect(convertDecimalToMinorUnits(999.99, 'INR')).toBe(99999);
      expect(convertDecimalToMinorUnits(5000, 'JPY')).toBe(5000);
    });

    it('rejects excessive precision for the given currency', () => {
      // USD only allows 2 decimal places: 15.555 has 3 decimal places
      expect(() => convertDecimalToMinorUnits(15.555, 'USD')).toThrow(/excessive precision/);
      // JPY only allows 0 decimal places: 5000.5 has 1 decimal place
      expect(() => convertDecimalToMinorUnits(5000.5, 'JPY')).toThrow(/excessive precision/);
    });
  });

  describe('PurchaseIntentParseResultSchema Discriminated Union', () => {
    it('validates PARSED result', () => {
      const res = PurchaseIntentParseResultSchema.safeParse({
        status: 'PARSED',
        intent: validBaseIntent,
        rawInput: 'buy one developer cloud vm',
      });
      expect(res.success).toBe(true);
    });

    it('validates NEEDS_CLARIFICATION result', () => {
      const res = PurchaseIntentParseResultSchema.safeParse({
        status: 'NEEDS_CLARIFICATION',
        reason: 'Ambiguous product query',
        question: 'Which tier of cloud VM would you like to purchase?',
        rawInput: 'buy cloud vm',
      });
      expect(res.success).toBe(true);
    });

    it('validates UNSUPPORTED_INTENT result', () => {
      const res = PurchaseIntentParseResultSchema.safeParse({
        status: 'UNSUPPORTED_INTENT',
        reason: 'Requested action is not a purchase',
        rawInput: 'check my account balance',
      });
      expect(res.success).toBe(true);
    });

    it('validates INVALID_INPUT result', () => {
      const res = PurchaseIntentParseResultSchema.safeParse({
        status: 'INVALID_INPUT',
        reason: 'Input contains invalid characters or empty query',
        rawInput: '   ',
      });
      expect(res.success).toBe(true);
    });
  });
});
