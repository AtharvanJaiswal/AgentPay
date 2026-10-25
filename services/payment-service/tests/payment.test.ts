import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { buildApp } from '../src/app.js';
import { MockPaymentProvider } from '../src/provider.js';
import { createMockProposal } from '@agentpay/test-utils';
import { ErrorCodes } from '@agentpay/contracts';

describe('Payment Service', () => {
  it('GET /health reports status, mock provider name, and paymentsEnabled false by default', async () => {
    const app = buildApp(new MockPaymentProvider(), { paymentsEnabled: false });
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.service).toBe('payment-service');
    expect(body.details.provider).toBe('MOCK/DEVELOPMENT');
    expect(body.details.isMock).toBe(true);
    expect(body.details.paymentsEnabled).toBe(false);
  });

  it('rejects order creation with 403 when PAYMENTS_ENABLED is false', async () => {
    const app = buildApp(new MockPaymentProvider(), { paymentsEnabled: false });
    const proposal = createMockProposal();

    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      payload: {
        proposal,
        policyDecisionId: uuidv4(),
        authorizedOutcome: 'ALLOW',
      },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(ErrorCodes.PAYMENTS_DISABLED);
  });

  it('rejects order creation if policy outcome is not ALLOW', async () => {
    const app = buildApp(new MockPaymentProvider(), { paymentsEnabled: true });
    const proposal = createMockProposal();

    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      payload: {
        proposal,
        policyDecisionId: uuidv4(),
        authorizedOutcome: 'DENY',
      },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(ErrorCodes.POLICY_VIOLATION);
  });

  it('creates order when payments are enabled and policy decision is ALLOW', async () => {
    const provider = new MockPaymentProvider();
    const app = buildApp(provider, { paymentsEnabled: true });
    const proposal = createMockProposal();
    const decisionId = uuidv4();

    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      payload: {
        proposal,
        policyDecisionId: decisionId,
        authorizedOutcome: 'ALLOW',
      },
    });

    expect(res.statusCode).toBe(201);
    const order = JSON.parse(res.body);
    expect(order.id).toMatch(/^MOCK-ORDER-/);
    expect(order.provider).toBe('mock');
    expect(order.isMock).toBe(true);
    expect(order.amountMinor).toBe(proposal.totalAmountMinor);
    expect(order.environmentNote).toContain('MOCK/DEVELOPMENT');

    // Retrieve order
    const getRes = await app.inject({
      method: 'GET',
      url: `/orders/${order.id}`,
    });
    expect(getRes.statusCode).toBe(200);
    const fetched = JSON.parse(getRes.body);
    expect(fetched.id).toBe(order.id);

    // Capture order
    const capRes = await app.inject({
      method: 'POST',
      url: `/orders/${order.id}/capture`,
      payload: {
        policyDecisionId: decisionId,
      },
    });
    expect(capRes.statusCode).toBe(200);
    const capture = JSON.parse(capRes.body);
    expect(capture.captureId).toMatch(/^MOCK-CAPTURE-/);
    expect(capture.status).toBe('COMPLETED');
    expect(capture.isMock).toBe(true);
    expect(capture.environmentNote).toContain('MOCK/DEVELOPMENT');

    // Double capture fails
    const doubleCap = await app.inject({
      method: 'POST',
      url: `/orders/${order.id}/capture`,
      payload: {
        policyDecisionId: decisionId,
      },
    });
    expect(doubleCap.statusCode).toBe(422);
  });

  describe('Provider Selection & Safety Safeguards', () => {
    it('defaults to MockPaymentProvider when PAYMENT_PROVIDER is mock without override', async () => {
      const app = buildApp(undefined, {
        PAYMENT_PROVIDER: 'mock',
        PAYMENTS_ENABLED: false,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.details.provider).toBe('MOCK/DEVELOPMENT');
      expect(body.details.isMock).toBe(true);
      expect(body.details.paymentsEnabled).toBe(false);
    });

    it('falls back to MockPaymentProvider when credentials are missing for paypal_sandbox', async () => {
      const app = buildApp(undefined, {
        PAYMENT_PROVIDER: 'paypal_sandbox',
        PAYPAL_CLIENT_ID: undefined,
        PAYPAL_CLIENT_SECRET: undefined,
        PAYMENTS_ENABLED: false,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.details.provider).toBe('MOCK/DEVELOPMENT');
      expect(body.details.isMock).toBe(true);
      expect(body.details.oauthConfigured).toBe(false);
    });

    it('initializes PayPalPaymentProvider when PAYMENT_PROVIDER is paypal_sandbox with credentials', async () => {
      const app = buildApp(undefined, {
        PAYMENT_PROVIDER: 'paypal_sandbox',
        PAYPAL_CLIENT_ID: 'mock_sandbox_id_123',
        PAYPAL_CLIENT_SECRET: 'mock_sandbox_secret_456',
        PAYPAL_ENVIRONMENT: 'sandbox',
        PAYPAL_API_BASE_URL: 'https://api-m.sandbox.paypal.com',
        APP_BASE_URL: 'http://localhost:3000',
        PAYMENTS_ENABLED: false,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.details.provider).toBe('PayPal Sandbox');
      expect(body.details.isMock).toBe(false);
      expect(body.details.oauthConfigured).toBe(true);
      expect(body.details.paymentsEnabled).toBe(false);
    });

    it('blocks order capture with 403 PAYMENTS_DISABLED when PAYMENTS_ENABLED is false on PayPal provider', async () => {
      const app = buildApp(undefined, {
        PAYMENT_PROVIDER: 'paypal_sandbox',
        PAYPAL_CLIENT_ID: 'mock_sandbox_id_123',
        PAYPAL_CLIENT_SECRET: 'mock_sandbox_secret_456',
        PAYMENTS_ENABLED: false,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/orders/MOCK-ORDER-123/capture',
        payload: {
          policyDecisionId: uuidv4(),
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(ErrorCodes.PAYMENTS_DISABLED);
      expect(body.error.message).toContain('Payment capture is disabled');
    });
  });
});
