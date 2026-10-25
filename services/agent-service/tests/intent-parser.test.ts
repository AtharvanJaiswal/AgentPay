import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { DeterministicPurchaseIntentParser } from '../src/parser.js';

describe('Increment 2: Deterministic Purchase Intent Parser', () => {
  const parser = new DeterministicPurchaseIntentParser();
  const app = buildApp(undefined, parser);

  describe('Deterministic Parsing Unit Tests', () => {
    it('parses valid purchase request with word quantity ("buy two notebooks")', async () => {
      const result = await parser.parse('buy two notebooks');
      expect(result.status).toBe('PARSED');
      if (result.status === 'PARSED') {
        expect(result.intent.intent.action).toBe('purchase');
        expect(result.intent.intent.quantity).toBe(2);
        expect(result.intent.intent.productQuery).toBe('notebooks');
      }
    });

    it('parses budget constraint as upper bound, not permission ("buy a laptop for no more than 80000 INR")', async () => {
      const result = await parser.parse('buy a laptop for no more than 80000 INR');
      expect(result.status).toBe('PARSED');
      if (result.status === 'PARSED') {
        expect(result.intent.intent.productQuery).toBe('laptop');
        expect(result.intent.intent.constraints?.currency).toBe('INR');
        expect(result.intent.intent.constraints?.maxTotalMinor).toBe(8000000); // 80,000 INR in paise (minor units)
        expect(Number.isInteger(result.intent.intent.constraints?.maxTotalMinor)).toBe(true);
      }
    });

    it('parses merchant preference correctly ("buy cloud server from CloudInfra")', async () => {
      const result = await parser.parse('buy cloud server from CloudInfra under $100');
      expect(result.status).toBe('PARSED');
      if (result.status === 'PARSED') {
        expect(result.intent.intent.productQuery).toBe('cloud server');
        expect(result.intent.intent.merchantPreference).toBe('CloudInfra');
        expect(result.intent.intent.constraints?.currency).toBe('USD');
        expect(result.intent.intent.constraints?.maxTotalMinor).toBe(10000); // $100.00
      }
    });

    it('parses unit price with decimal conversion at boundary ("buy 3 units at 999.99 INR each")', async () => {
      const result = await parser.parse('buy 3 units at 999.99 INR each');
      expect(result.status).toBe('PARSED');
      if (result.status === 'PARSED') {
        expect(result.intent.intent.quantity).toBe(3);
        expect(result.intent.intent.constraints?.maxUnitPriceMinor).toBe(99999);
        expect(result.intent.intent.constraints?.currency).toBe('INR');
      }
    });

    it('requests clarification for vague pronoun referent ("buy it")', async () => {
      const result = await parser.parse('buy it');
      expect(result.status).toBe('NEEDS_CLARIFICATION');
      if (result.status === 'NEEDS_CLARIFICATION') {
        expect(result.reason).toContain('ambiguous');
        expect(result.question).toBeDefined();
      }
    });

    it('requests clarification for vague referent ("purchase something")', async () => {
      const result = await parser.parse('purchase something');
      expect(result.status).toBe('NEEDS_CLARIFICATION');
    });

    it('requests clarification for superlative query without category ("buy the cheapest")', async () => {
      const result = await parser.parse('buy the cheapest');
      expect(result.status).toBe('NEEDS_CLARIFICATION');
    });

    it('requests clarification for budget without product referent ("spend up to 5000 INR")', async () => {
      const result = await parser.parse('spend up to 5000 INR');
      expect(result.status).toBe('NEEDS_CLARIFICATION');
      if (result.status === 'NEEDS_CLARIFICATION') {
        expect(result.question).toContain('What product or service');
      }
    });

    it('identifies unsupported intent for non-purchase action ("check my balance")', async () => {
      const result = await parser.parse('check my balance');
      expect(result.status).toBe('UNSUPPORTED_INTENT');
    });

    it('identifies unsupported intent for money transfer ("transfer 100 dollars to Alice")', async () => {
      const result = await parser.parse('transfer 100 dollars to Alice');
      expect(result.status).toBe('UNSUPPORTED_INTENT');
    });

    it('rejects zero quantity ("buy 0 laptops")', async () => {
      const result = await parser.parse('buy 0 laptops');
      expect(result.status).toBe('INVALID_INPUT');
      if (result.status === 'INVALID_INPUT') {
        expect(result.reason).toContain('Quantity must be greater than zero');
      }
    });

    it('rejects negative quantity or amount ("buy -2 items")', async () => {
      const result = await parser.parse('buy -2 items');
      expect(result.status).toBe('INVALID_INPUT');
    });

    it('rejects empty or whitespace-only input', async () => {
      const result = await parser.parse('    ');
      expect(result.status).toBe('INVALID_INPUT');
    });
  });

  describe('HTTP POST /intents/parse Integration Tests', () => {
    it('returns 200 with PARSED status for valid intent', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/intents/parse',
        headers: {
          'x-correlation-id': 'corr-intent-01',
        },
        payload: {
          rawIntent: 'buy two developer notebooks under $50',
          principalId: 'user-auth-123',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('PARSED');
      expect(body.intent.schemaVersion).toBe(1);
      expect(body.intent.intent.productQuery).toBe('developer notebooks');
      expect(body.intent.intent.quantity).toBe(2);
      expect(body.intent.intent.constraints.maxTotalMinor).toBe(5000);
      expect(body.intent.context.principalId).toBe('user-auth-123');
      expect(res.headers['x-correlation-id']).toBe('corr-intent-01');
    });

    it('returns 200 with NEEDS_CLARIFICATION for ambiguous request', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/intents/parse',
        payload: {
          rawIntent: 'order it please',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('NEEDS_CLARIFICATION');
      expect(body.question).toBeDefined();
    });

    it('returns 200 with UNSUPPORTED_INTENT for non-purchase action', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/intents/parse',
        payload: {
          rawIntent: 'send money to bob',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('UNSUPPORTED_INTENT');
    });

    it('returns 400 with VALIDATION_ERROR for empty input payload', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/intents/parse',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});
