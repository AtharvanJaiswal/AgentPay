import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PurchaseProposal } from '@agentpay/contracts';
import { ErrorCodes } from '@agentpay/contracts';
import { PaymentServiceConfigSchema } from '@agentpay/config';
import { PayPalPaymentProvider } from '../src/paypal/provider.js';
import {
  PayPalOrdersClient,
  PayPalCaptureTimeoutError,
  ProposalValidationError,
  validateProposalAmountsAndCurrency,
} from '../src/paypal/orders-client.js';
import type { PayPalOAuthClient } from '../src/paypal/oauth-client.js';
import { InMemoryPaymentOrderRepository } from '../src/repository.js';
import { buildApp } from '../src/app.js';

describe('PayPal Orders v2 & Lifecycle (Phase 1B)', () => {
  const dummyClientId = 'TEST_MOCK_CLIENT_ID_XYZ';
  const dummyClientSecret = 'TEST_MOCK_CLIENT_SECRET_ABC';

  const sampleProposal: PurchaseProposal = {
    id: '11111111-1111-4111-a111-111111111111',
    intentId: '22222222-2222-4222-a222-222222222222',
    agentId: 'autonomous-agent-01',
    merchant: {
      id: 'merchant-cloud-01',
      name: 'Cloud Computing Infrastructure Inc',
      category: 'cloud_services',
    },
    items: [
      {
        id: 'item-01',
        name: '4-core Compute Node',
        quantity: 1,
        unitPriceMinor: 2500, // $25.00
        currency: 'USD',
      },
    ],
    totalAmountMinor: 2500, // $25.00
    currency: 'USD',
    purpose: 'Automated CI worker node rental',
    createdAt: new Date().toISOString(),
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('Order Creation & Approval URL Extraction', () => {
    it('creates an order using trusted amount and currency from server proposal and extracts approvalUrl', async () => {
      const mockOrdersClient = {
        createOrder: vi.fn().mockResolvedValue({
          id: '5O190127TN364715T',
          status: 'PAYER_ACTION_REQUIRED',
          approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T',
          rawResponse: { id: '5O190127TN364715T', status: 'PAYER_ACTION_REQUIRED' },
        }),
        getOrder: vi.fn(),
        captureOrder: vi.fn(),
        verifyWebhookSignature: vi.fn(),
      } as unknown as PayPalOrdersClient;

      const repository = new InMemoryPaymentOrderRepository();
      const provider = new PayPalPaymentProvider({
        clientId: dummyClientId,
        clientSecret: dummyClientSecret,
        repository,
        ordersClient: mockOrdersClient,
      });

      const order = await provider.createOrder(sampleProposal, 'corr-order-01', {
        policyDecisionId: '33333333-3333-4333-a333-333333333333',
      });

      expect(order.id).toBe('5O190127TN364715T');
      expect(order.amountMinor).toBe(2500);
      expect(order.currency).toBe('USD');
      expect(order.provider).toBe('paypal_sandbox');
      expect(order.isMock).toBe(false);
      expect(order.approvalUrl).toBe(
        'https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T',
      );
      expect(order.status).toBe('PAYER_ACTION_REQUIRED');

      // Verify that the orders client was invoked with proposal and idempotency key
      expect(mockOrdersClient.createOrder).toHaveBeenCalledTimes(1);
      const [calledProposal, idempotencyKey] = vi.mocked(mockOrdersClient.createOrder).mock
        .calls[0];
      expect(calledProposal.totalAmountMinor).toBe(2500);
      expect(calledProposal.currency).toBe('USD');
      expect(idempotencyKey).toContain(sampleProposal.id);
    });

    it('rejects order creation with payments disabled', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const app = buildApp(undefined, { paymentsEnabled: false }, repository);

      const res = await app.inject({
        method: 'POST',
        url: '/orders',
        payload: {
          proposal: sampleProposal,
          policyDecisionId: '33333333-3333-4333-a333-333333333333',
          authorizedOutcome: 'ALLOW',
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('PAYMENTS_DISABLED');
    });

    it('rejects order creation if policy outcome is not ALLOW', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const app = buildApp(undefined, { paymentsEnabled: true }, repository);

      const res = await app.inject({
        method: 'POST',
        url: '/orders',
        payload: {
          proposal: sampleProposal,
          policyDecisionId: '33333333-3333-4333-a333-333333333333',
          authorizedOutcome: 'DENY',
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('POLICY_VIOLATION');
    });
  });

  describe('Idempotency & Replay Protection', () => {
    it('repeated requests with the same idempotency key return the cached order without duplicate PayPal calls', async () => {
      const mockOrdersClient = {
        createOrder: vi.fn().mockResolvedValue({
          id: '5O190127TN364715T',
          status: 'PAYER_ACTION_REQUIRED',
          approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T',
          rawResponse: { id: '5O190127TN364715T', status: 'PAYER_ACTION_REQUIRED' },
        }),
        getOrder: vi.fn(),
        captureOrder: vi.fn(),
        verifyWebhookSignature: vi.fn(),
      } as unknown as PayPalOrdersClient;

      const repository = new InMemoryPaymentOrderRepository();
      const provider = new PayPalPaymentProvider({
        clientId: dummyClientId,
        clientSecret: dummyClientSecret,
        repository,
        ordersClient: mockOrdersClient,
      });

      // Call 1
      const order1 = await provider.createOrder(sampleProposal, 'corr-idemp-1', {
        idempotencyKey: 'idemp-key-stable-01',
      });
      // Call 2 with identical key and payload
      const order2 = await provider.createOrder(sampleProposal, 'corr-idemp-2', {
        idempotencyKey: 'idemp-key-stable-01',
      });

      expect(mockOrdersClient.createOrder).toHaveBeenCalledTimes(1);
      expect(order1.id).toBe(order2.id);
      expect(order2.amountMinor).toBe(2500);
    });

    it('rejects a reused idempotency key when the proposal payload differs (409 Conflict)', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const mockOrdersClient = {
        createOrder: vi.fn().mockResolvedValue({
          id: '5O190127TN364715T',
          status: 'PAYER_ACTION_REQUIRED',
          approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T',
          rawResponse: { id: '5O190127TN364715T', status: 'PAYER_ACTION_REQUIRED' },
        }),
      } as unknown as PayPalOrdersClient;

      const provider = new PayPalPaymentProvider({
        clientId: dummyClientId,
        clientSecret: dummyClientSecret,
        repository,
        ordersClient: mockOrdersClient,
      });

      // Call 1 with $25.00
      await provider.createOrder(sampleProposal, 'corr-1', {
        idempotencyKey: 'idemp-key-conflict-test',
      });

      // Call 2 with same key but different amount $50.00
      const alteredProposal: PurchaseProposal = {
        ...sampleProposal,
        totalAmountMinor: 5000,
        items: [
          {
            ...sampleProposal.items[0]!,
            unitPriceMinor: 5000,
          },
        ],
      };

      await expect(
        provider.createOrder(alteredProposal, 'corr-2', {
          idempotencyKey: 'idemp-key-conflict-test',
        }),
      ).rejects.toThrow(/already used with a different proposal/);
    });
  });

  describe('Order Capture & Buyer Approval Enforcement', () => {
    it('rejects capture if order has not been approved by buyer', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const mockOrdersClient = {
        createOrder: vi.fn().mockResolvedValue({
          id: '5O190127TN364715T',
          status: 'PAYER_ACTION_REQUIRED',
          approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T',
          rawResponse: { id: '5O190127TN364715T', status: 'PAYER_ACTION_REQUIRED' },
        }),
        getOrder: vi.fn().mockResolvedValue({
          id: '5O190127TN364715T',
          status: 'PAYER_ACTION_REQUIRED', // still unapproved
        }),
        captureOrder: vi.fn(),
      } as unknown as PayPalOrdersClient;

      const provider = new PayPalPaymentProvider({
        clientId: dummyClientId,
        clientSecret: dummyClientSecret,
        repository,
        ordersClient: mockOrdersClient,
      });

      await provider.createOrder(sampleProposal, 'corr-1', {
        policyDecisionId: '33333333-3333-4333-a333-333333333333',
      });

      await expect(
        provider.captureOrder(
          '5O190127TN364715T',
          '33333333-3333-4333-a333-333333333333',
          'corr-capture-1',
        ),
      ).rejects.toThrow(/buyer approval is pending/);

      expect(mockOrdersClient.captureOrder).not.toHaveBeenCalled();
    });

    it('captures an approved order and transitions state monotonically to COMPLETED', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const mockOrdersClient = {
        createOrder: vi.fn().mockResolvedValue({
          id: '5O190127TN364715T',
          status: 'PAYER_ACTION_REQUIRED',
          approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T',
          rawResponse: { id: '5O190127TN364715T', status: 'PAYER_ACTION_REQUIRED' },
        }),
        getOrder: vi.fn().mockResolvedValue({
          id: '5O190127TN364715T',
          status: 'APPROVED', // buyer has approved!
        }),
        captureOrder: vi.fn().mockResolvedValue({
          orderId: '5O190127TN364715T',
          captureId: '2GG279541U471931P',
          status: 'COMPLETED',
          capturedAmountMinor: 2500,
          currency: 'USD',
          rawResponse: { id: '5O190127TN364715T', status: 'COMPLETED' },
        }),
      } as unknown as PayPalOrdersClient;

      const provider = new PayPalPaymentProvider({
        clientId: dummyClientId,
        clientSecret: dummyClientSecret,
        repository,
        ordersClient: mockOrdersClient,
      });

      await provider.createOrder(sampleProposal, 'corr-1', {
        policyDecisionId: '33333333-3333-4333-a333-333333333333',
      });

      const captureResult = await provider.captureOrder(
        '5O190127TN364715T',
        '33333333-3333-4333-a333-333333333333',
        'corr-cap-1',
      );

      expect(captureResult.status).toBe('COMPLETED');
      expect(captureResult.captureId).toBe('2GG279541U471931P');
      expect(captureResult.capturedAmountMinor).toBe(2500);
      expect(captureResult.isMock).toBe(false);

      // Verify stored order is now COMPLETED
      const stored = await provider.getOrder('5O190127TN364715T', 'corr-check');
      expect(stored?.status).toBe('COMPLETED');
    });

    it('duplicate capture calls on an already COMPLETED order return cached capture without re-calling PayPal', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const mockOrdersClient = {
        createOrder: vi.fn().mockResolvedValue({
          id: '5O190127TN364715T',
          status: 'PAYER_ACTION_REQUIRED',
          approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T',
        }),
        getOrder: vi.fn().mockResolvedValue({
          id: '5O190127TN364715T',
          status: 'APPROVED',
        }),
        captureOrder: vi.fn().mockResolvedValue({
          orderId: '5O190127TN364715T',
          captureId: '2GG279541U471931P',
          status: 'COMPLETED',
          capturedAmountMinor: 2500,
          currency: 'USD',
        }),
      } as unknown as PayPalOrdersClient;

      const provider = new PayPalPaymentProvider({
        clientId: dummyClientId,
        clientSecret: dummyClientSecret,
        repository,
        ordersClient: mockOrdersClient,
      });

      await provider.createOrder(sampleProposal, 'corr-1', {
        policyDecisionId: '33333333-3333-4333-a333-333333333333',
      });

      // Capture 1
      await provider.captureOrder(
        '5O190127TN364715T',
        '33333333-3333-4333-a333-333333333333',
        'corr-cap-1',
      );

      // Capture 2
      const secondCapture = await provider.captureOrder(
        '5O190127TN364715T',
        '33333333-3333-4333-a333-333333333333',
        'corr-cap-2',
      );

      expect(mockOrdersClient.captureOrder).toHaveBeenCalledTimes(1);
      expect(secondCapture.status).toBe('COMPLETED');
      expect(secondCapture.captureId).toBe('2GG279541U471931P');
    });

    it('capture timeout marks status as UNKNOWN and returns safe non-crashing outcome', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const mockOrdersClient = {
        createOrder: vi.fn().mockResolvedValue({
          id: '5O190127TN364715T',
          status: 'APPROVED',
        }),
        getOrder: vi.fn().mockResolvedValue({
          id: '5O190127TN364715T',
          status: 'APPROVED',
        }),
        captureOrder: vi.fn().mockRejectedValue(
          new PayPalCaptureTimeoutError('PayPal capture timed out', {
            orderId: '5O190127TN364715T',
          }),
        ),
      } as unknown as PayPalOrdersClient;

      const provider = new PayPalPaymentProvider({
        clientId: dummyClientId,
        clientSecret: dummyClientSecret,
        repository,
        ordersClient: mockOrdersClient,
      });

      await provider.createOrder(sampleProposal, 'corr-1', {
        policyDecisionId: '33333333-3333-4333-a333-333333333333',
      });

      const result = await provider.captureOrder(
        '5O190127TN364715T',
        '33333333-3333-4333-a333-333333333333',
        'corr-timeout',
      );

      expect(result.status).toBe('UNKNOWN');
      expect(result.environmentNote).toContain('timed out');

      // Verify order status in repository is now UNKNOWN
      const stored = await repository.getOrderById('5O190127TN364715T');
      expect(stored?.status).toBe('UNKNOWN');
    });

    it('rejects capture if policyDecisionId is missing', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const provider = new PayPalPaymentProvider({
        clientId: dummyClientId,
        clientSecret: dummyClientSecret,
        repository,
      });

      await expect(provider.captureOrder('ord-1', '', 'corr-1')).rejects.toThrow(
        'Valid policyDecisionId is required',
      );
    });
  });

  describe('Webhook Signature Verification & Monotonic Safety', () => {
    it('rejects webhook requests with invalid cryptographic signatures', async () => {
      const mockOrdersClient = {
        verifyWebhookSignature: vi.fn().mockResolvedValue(false),
      } as unknown as PayPalOrdersClient;

      const repository = new InMemoryPaymentOrderRepository();
      const provider = new PayPalPaymentProvider({
        clientId: dummyClientId,
        clientSecret: dummyClientSecret,
        repository,
        ordersClient: mockOrdersClient,
      });

      const verified = await provider.verifyWebhook(
        { id: 'event-1' },
        {
          'paypal-auth-algo': 'SHA256withRSA',
          'paypal-cert-url': 'https://api.sandbox.paypal.com/cert',
          'paypal-transmission-id': 'trans-123',
          'paypal-transmission-sig': 'bad-signature',
          'paypal-transmission-time': new Date().toISOString(),
        },
      );

      expect(verified).toBe(false);
    });

    it('processes valid webhooks and deduplicates transmission IDs so duplicates are only processed once', async () => {
      const mockOrdersClient = {
        verifyWebhookSignature: vi.fn().mockResolvedValue(true),
      } as unknown as PayPalOrdersClient;

      const repository = new InMemoryPaymentOrderRepository();
      const provider = new PayPalPaymentProvider({
        clientId: dummyClientId,
        clientSecret: dummyClientSecret,
        repository,
        ordersClient: mockOrdersClient,
      });

      // Pre-seed an order
      await repository.createOrder({
        id: '5O190127TN364715T',
        proposalId: sampleProposal.id,
        policyDecisionId: '33333333-3333-4333-a333-333333333333',
        provider: 'paypal_sandbox',
        status: 'PAYER_ACTION_REQUIRED',
        currency: 'USD',
        amountMinor: 2500,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const webhookHeaders = {
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-cert-url': 'https://api.sandbox.paypal.com/cert',
        'paypal-transmission-id': 'unique-trans-999',
        'paypal-transmission-sig': 'valid-sig',
        'paypal-transmission-time': new Date().toISOString(),
      };

      const webhookPayload = {
        id: 'WH-EVENT-001',
        event_type: 'CHECKOUT.ORDER.APPROVED',
        resource: { id: '5O190127TN364715T' },
      };

      // Call 1
      const res1 = await provider.verifyWebhook(webhookPayload, webhookHeaders);
      expect(res1).toBe(true);
      const after1 = await repository.getOrderById('5O190127TN364715T');
      expect(after1?.status).toBe('APPROVED');

      // Call 2 with identical transmission ID
      const res2 = await provider.verifyWebhook(webhookPayload, webhookHeaders);
      expect(res2).toBe(true); // Acknowledged duplicate
    });

    it('out-of-order webhooks cannot regress a COMPLETED order to APPROVED', async () => {
      const mockOrdersClient = {
        verifyWebhookSignature: vi.fn().mockResolvedValue(true),
      } as unknown as PayPalOrdersClient;

      const repository = new InMemoryPaymentOrderRepository();
      const provider = new PayPalPaymentProvider({
        clientId: dummyClientId,
        clientSecret: dummyClientSecret,
        repository,
        ordersClient: mockOrdersClient,
      });

      // Order is already COMPLETED
      await repository.createOrder({
        id: '5O190127TN364715T',
        proposalId: sampleProposal.id,
        policyDecisionId: '33333333-3333-4333-a333-333333333333',
        provider: 'paypal_sandbox',
        status: 'COMPLETED',
        captureId: 'CAPTURE-123',
        currency: 'USD',
        amountMinor: 2500,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // An out-of-order CHECKOUT.ORDER.APPROVED webhook arrives later
      const outOfOrderWebhook = {
        id: 'WH-EVENT-OLD',
        event_type: 'CHECKOUT.ORDER.APPROVED',
        resource: { id: '5O190127TN364715T' },
      };

      const webhookHeaders = {
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-cert-url': 'https://api.sandbox.paypal.com/cert',
        'paypal-transmission-id': 'trans-old-123',
        'paypal-transmission-sig': 'valid-sig',
        'paypal-transmission-time': new Date().toISOString(),
      };

      await provider.verifyWebhook(outOfOrderWebhook, webhookHeaders);

      // Order must remain COMPLETED!
      const finalOrder = await repository.getOrderById('5O190127TN364715T');
      expect(finalOrder?.status).toBe('COMPLETED');
    });
  });

  describe('Payment Authorization Boundary & Security Audit (Section 2 & 3)', () => {
    it('rejects a reused idempotency key with different payload returning HTTP 409 IDEMPOTENCY_CONFLICT via the app', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const mockOrdersClient = {
        createOrder: vi.fn().mockResolvedValue({
          id: '5O190127TN364715T',
          status: 'PAYER_ACTION_REQUIRED',
          approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T',
          rawResponse: { id: '5O190127TN364715T', status: 'PAYER_ACTION_REQUIRED' },
        }),
      } as unknown as PayPalOrdersClient;

      const provider = new PayPalPaymentProvider({
        clientId: dummyClientId,
        clientSecret: dummyClientSecret,
        repository,
        ordersClient: mockOrdersClient,
      });

      const app = buildApp(provider, { paymentsEnabled: true }, repository);

      // Call 1
      const res1 = await app.inject({
        method: 'POST',
        url: '/orders',
        headers: { 'x-idempotency-key': 'idemp-conflict-app-test' },
        payload: {
          proposal: sampleProposal,
          policyDecisionId: '33333333-3333-4333-a333-333333333333',
          authorizedOutcome: 'ALLOW',
        },
      });
      expect(res1.statusCode).toBe(201);

      // Call 2 with identical idempotency key but altered amount
      const alteredProposal: PurchaseProposal = {
        ...sampleProposal,
        totalAmountMinor: 5000,
        items: [{ ...sampleProposal.items[0]!, unitPriceMinor: 5000 }],
      };
      const res2 = await app.inject({
        method: 'POST',
        url: '/orders',
        headers: { 'x-idempotency-key': 'idemp-conflict-app-test' },
        payload: {
          proposal: alteredProposal,
          policyDecisionId: '33333333-3333-4333-a333-333333333333',
          authorizedOutcome: 'ALLOW',
        },
      });

      expect(res2.statusCode).toBe(409);
      const body = JSON.parse(res2.body);
      expect(body.error.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(body.error.message).toContain('already used with a different proposal');
    });

    it('rejects capture when policyDecisionId does not match the authorized decision stored with the order (403)', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const mockOrdersClient = {
        getOrder: vi.fn().mockResolvedValue({
          id: '5O190127TN364715T',
          status: 'APPROVED',
        }),
        captureOrder: vi.fn(),
      } as unknown as PayPalOrdersClient;

      const provider = new PayPalPaymentProvider({
        clientId: dummyClientId,
        clientSecret: dummyClientSecret,
        repository,
        ordersClient: mockOrdersClient,
      });

      // Seed order with legitimate policyDecisionId
      const legitimateDecisionId = '33333333-3333-4333-a333-333333333333';
      await repository.createOrder({
        id: '5O190127TN364715T',
        proposalId: sampleProposal.id,
        policyDecisionId: legitimateDecisionId,
        provider: 'paypal_sandbox',
        status: 'PAYER_ACTION_REQUIRED',
        currency: 'USD',
        amountMinor: 2500,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const app = buildApp(provider, { paymentsEnabled: true }, repository);

      // Attempt capture with fabricated/mismatched policyDecisionId
      const res = await app.inject({
        method: 'POST',
        url: '/orders/5O190127TN364715T/capture',
        payload: {
          policyDecisionId: '99999999-9999-4999-b999-999999999999',
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(ErrorCodes.POLICY_VIOLATION);
      expect(body.error.message).toContain('Policy decision ID mismatch');
      expect(mockOrdersClient.captureOrder).not.toHaveBeenCalled();
    });

    it('rejects capture when stored order lacks a valid policy authorization decision (403)', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const mockOrdersClient = {
        getOrder: vi.fn().mockResolvedValue({
          id: 'ORD-UNAUTHORIZED',
          status: 'APPROVED',
        }),
        captureOrder: vi.fn(),
      } as unknown as PayPalOrdersClient;

      const provider = new PayPalPaymentProvider({
        clientId: dummyClientId,
        clientSecret: dummyClientSecret,
        repository,
        ordersClient: mockOrdersClient,
      });

      // Seed order with empty/dummy zero-UUID policyDecisionId
      await repository.createOrder({
        id: 'ORD-UNAUTHORIZED',
        proposalId: sampleProposal.id,
        policyDecisionId: '00000000-0000-0000-0000-000000000000',
        provider: 'paypal_sandbox',
        status: 'PAYER_ACTION_REQUIRED',
        currency: 'USD',
        amountMinor: 2500,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const app = buildApp(provider, { paymentsEnabled: true }, repository);

      const res = await app.inject({
        method: 'POST',
        url: '/orders/ORD-UNAUTHORIZED/capture',
        payload: {
          policyDecisionId: '33333333-3333-4333-a333-333333333333',
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(ErrorCodes.POLICY_VIOLATION);
      expect(body.error.message).toContain(
        'lacks a valid server-side policy authorization decision',
      );
      expect(mockOrdersClient.captureOrder).not.toHaveBeenCalled();
    });

    it('rejects order creation when direct client submits authorizedOutcome: "ALLOW" but policy evaluation returns DENY', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const mockProvider = new PayPalPaymentProvider({
        clientId: dummyClientId,
        clientSecret: dummyClientSecret,
        repository,
      });

      // Simulated policy verifier that evaluates proposal and returns DENY
      const policyVerifierMock = vi.fn().mockResolvedValue({
        outcome: 'DENY',
        reasonMessage: 'Prohibited restricted category',
      });

      const app = buildApp(mockProvider, { paymentsEnabled: true }, repository, policyVerifierMock);

      const res = await app.inject({
        method: 'POST',
        url: '/orders',
        payload: {
          proposal: sampleProposal,
          policyDecisionId: '33333333-3333-4333-a333-333333333333',
          authorizedOutcome: 'ALLOW', // Client claims ALLOW
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(ErrorCodes.POLICY_VIOLATION);
      expect(body.error.message).toContain('Prohibited restricted category');
    });

    it('verifies buyer approval against live PayPal API even if local stored status was forged to APPROVED', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const mockOrdersClient = {
        getOrder: vi.fn().mockResolvedValue({
          id: '5O190127TN364715T',
          status: 'PAYER_ACTION_REQUIRED', // Live PayPal says NOT approved yet
        }),
        captureOrder: vi.fn(),
      } as unknown as PayPalOrdersClient;

      const provider = new PayPalPaymentProvider({
        clientId: dummyClientId,
        clientSecret: dummyClientSecret,
        repository,
        ordersClient: mockOrdersClient,
      });

      const legitimateDecisionId = '33333333-3333-4333-a333-333333333333';
      // Local status forged/set to APPROVED
      await repository.createOrder({
        id: '5O190127TN364715T',
        proposalId: sampleProposal.id,
        policyDecisionId: legitimateDecisionId,
        provider: 'paypal_sandbox',
        status: 'APPROVED',
        currency: 'USD',
        amountMinor: 2500,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await expect(
        provider.captureOrder('5O190127TN364715T', legitimateDecisionId, 'corr-test'),
      ).rejects.toThrow(/buyer approval is pending/);

      expect(mockOrdersClient.getOrder).toHaveBeenCalledTimes(1);
      expect(mockOrdersClient.captureOrder).not.toHaveBeenCalled();
    });

    it('PaymentServiceConfigSchema forbids PAYPAL_ENVIRONMENT=live', () => {
      const parseResult = PaymentServiceConfigSchema.safeParse({
        PAYPAL_ENVIRONMENT: 'live',
        PAYMENT_PROVIDER: 'mock',
      });

      expect(parseResult.success).toBe(false);
      if (!parseResult.success) {
        expect(parseResult.error.issues[0]?.message).toContain(
          'PayPal Live environment is forbidden in Phase 1B',
        );
      }
    });

    it('PaymentServiceConfigSchema forbids PAYPAL_API_BASE_URL pointing to live PayPal domain', () => {
      const parseResult = PaymentServiceConfigSchema.safeParse({
        PAYPAL_ENVIRONMENT: 'sandbox',
        PAYPAL_API_BASE_URL: 'https://api-m.paypal.com',
        PAYMENT_PROVIDER: 'mock',
      });

      expect(parseResult.success).toBe(false);
      if (!parseResult.success) {
        expect(parseResult.error.issues[0]?.message).toContain(
          'PayPal Live endpoints are forbidden in Phase 1B',
        );
      }
    });

    it('PayPalOrdersClient builds return_url and cancel_url targeting /orders/success and /orders/cancelled', async () => {
      const mockOAuthClient = {
        getAccessToken: vi.fn().mockResolvedValue('MOCK_TEST_ACCESS_TOKEN_123'),
      } as unknown as PayPalOAuthClient;

      let capturedPayload: {
        payment_source?: {
          paypal?: {
            experience_context?: { return_url: string; cancel_url: string };
          };
        };
        purchase_units: Array<{ payee?: unknown }>;
      } | null = null;
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((url, init) => {
          if (init?.method === 'POST') {
            capturedPayload = JSON.parse(init.body as string);
            return Promise.resolve({
              ok: true,
              json: () =>
                Promise.resolve({
                  id: 'TEST_ORDER_998877',
                  status: 'CREATED',
                  links: [
                    {
                      rel: 'approve',
                      href: 'https://www.sandbox.paypal.com/checkoutnow?token=TEST_ORDER_998877',
                    },
                  ],
                }),
            });
          }
          return Promise.reject(new Error(`Unhandled fetch: ${url}`));
        }),
      );

      const client = new PayPalOrdersClient({
        oauthClient: mockOAuthClient,
        appBaseUrl: 'http://localhost:3000',
      });

      const res = await client.createOrder(sampleProposal, 'idemp-urls-01');

      expect(res.id).toBe('TEST_ORDER_998877');
      expect(res.approvalUrl).toBe(
        'https://www.sandbox.paypal.com/checkoutnow?token=TEST_ORDER_998877',
      );
      expect(capturedPayload).toBeDefined();
      expect(capturedPayload?.payment_source?.paypal?.experience_context?.return_url).toBe(
        'http://localhost:3000/orders/success',
      );
      expect(capturedPayload?.payment_source?.paypal?.experience_context?.cancel_url).toBe(
        'http://localhost:3000/orders/cancelled',
      );
      // Ensure purchase_units does not set an unverified personal buyer as payee
      expect(capturedPayload?.purchase_units[0].payee).toBeUndefined();
    });
  });

  describe('Proposal Amount & Currency Consistency Validation (Financial Integrity)', () => {
    it('validates a correct multi-item proposal and derives identical amount and item_total values', () => {
      const multiItemProposal: PurchaseProposal = {
        ...sampleProposal,
        totalAmountMinor: 3500, // $35.00
        items: [
          {
            id: 'item-1',
            name: 'Cloud Compute 2-core',
            quantity: 2,
            unitPriceMinor: 1000, // 2 * 1000 = 2000
            currency: 'USD',
          },
          {
            id: 'item-2',
            name: 'Block Storage 100GB',
            quantity: 1,
            unitPriceMinor: 1500, // 1 * 1500 = 1500
            currency: 'USD',
          },
        ],
      };

      const validated = validateProposalAmountsAndCurrency(multiItemProposal);
      expect(validated.totalAmountMinor).toBe(3500);
      expect(validated.totalAmountValue).toBe('35.00');
      expect(validated.itemTotalValue).toBe('35.00');
      expect(validated.currency).toBe('USD');
      expect(validated.items).toHaveLength(2);
      expect(validated.items[0]?.unitAmountValue).toBe('10.00');
      expect(validated.items[1]?.unitAmountValue).toBe('15.00');
    });

    it('rejects a proposal with an empty item list without making any network calls', async () => {
      const mockOAuthClient = {
        getAccessToken: vi.fn(),
      } as unknown as PayPalOAuthClient;
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      const client = new PayPalOrdersClient({ oauthClient: mockOAuthClient });
      const invalidProposal = {
        ...sampleProposal,
        items: [] as unknown as PurchaseProposal['items'],
      };

      await expect(client.createOrder(invalidProposal, 'idemp-empty-items')).rejects.toThrow(
        ProposalValidationError,
      );
      await expect(client.createOrder(invalidProposal, 'idemp-empty-items')).rejects.toThrow(
        'Proposal must contain at least one item',
      );

      // Verify ZERO network calls were made
      expect(mockOAuthClient.getAccessToken).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects non-safe-integer totalAmountMinor without making any network calls', async () => {
      const mockOAuthClient = { getAccessToken: vi.fn() } as unknown as PayPalOAuthClient;
      const client = new PayPalOrdersClient({ oauthClient: mockOAuthClient });

      const floatProposal = {
        ...sampleProposal,
        totalAmountMinor: 2500.5,
      };

      await expect(client.createOrder(floatProposal, 'idemp-float')).rejects.toThrow(
        /must be a positive safe integer/,
      );
      expect(mockOAuthClient.getAccessToken).not.toHaveBeenCalled();
    });

    it('rejects zero or negative totalAmountMinor without making any network calls', async () => {
      const mockOAuthClient = { getAccessToken: vi.fn() } as unknown as PayPalOAuthClient;
      const client = new PayPalOrdersClient({ oauthClient: mockOAuthClient });

      const zeroProposal = {
        ...sampleProposal,
        totalAmountMinor: 0,
      };

      await expect(client.createOrder(zeroProposal, 'idemp-zero')).rejects.toThrow(
        /must be a positive safe integer/,
      );
      expect(mockOAuthClient.getAccessToken).not.toHaveBeenCalled();
    });

    it('rejects non-positive or non-integer item quantities without making any network calls', async () => {
      const mockOAuthClient = { getAccessToken: vi.fn() } as unknown as PayPalOAuthClient;
      const client = new PayPalOrdersClient({ oauthClient: mockOAuthClient });

      const zeroQtyProposal: PurchaseProposal = {
        ...sampleProposal,
        items: [
          {
            id: 'item-1',
            name: 'Item 1',
            quantity: 0,
            unitPriceMinor: 2500,
            currency: 'USD',
          },
        ],
      };

      await expect(client.createOrder(zeroQtyProposal, 'idemp-zero-qty')).rejects.toThrow(
        /quantity must be a positive integer/,
      );

      const floatQtyProposal: PurchaseProposal = {
        ...sampleProposal,
        items: [
          {
            id: 'item-1',
            name: 'Item 1',
            quantity: 1.5,
            unitPriceMinor: 2500,
            currency: 'USD',
          },
        ],
      };

      await expect(client.createOrder(floatQtyProposal, 'idemp-float-qty')).rejects.toThrow(
        /quantity must be a positive integer/,
      );
      expect(mockOAuthClient.getAccessToken).not.toHaveBeenCalled();
    });

    it('rejects negative item prices without making any network calls', async () => {
      const mockOAuthClient = { getAccessToken: vi.fn() } as unknown as PayPalOAuthClient;
      const client = new PayPalOrdersClient({ oauthClient: mockOAuthClient });

      const negativePriceProposal: PurchaseProposal = {
        ...sampleProposal,
        items: [
          {
            id: 'item-1',
            name: 'Item 1',
            quantity: 1,
            unitPriceMinor: -500,
            currency: 'USD',
          },
        ],
      };

      await expect(client.createOrder(negativePriceProposal, 'idemp-neg-price')).rejects.toThrow(
        /unitPriceMinor must be a non-negative safe integer/,
      );
      expect(mockOAuthClient.getAccessToken).not.toHaveBeenCalled();
    });

    it('rejects currency mismatches between items and proposal without making any network calls', async () => {
      const mockOAuthClient = { getAccessToken: vi.fn() } as unknown as PayPalOAuthClient;
      const client = new PayPalOrdersClient({ oauthClient: mockOAuthClient });

      const currencyMismatchProposal: PurchaseProposal = {
        ...sampleProposal,
        currency: 'USD',
        items: [
          {
            id: 'item-1',
            name: 'Item EUR',
            quantity: 1,
            unitPriceMinor: 2500,
            currency: 'EUR', // Mismatched currency
          },
        ],
      };

      await expect(
        client.createOrder(currencyMismatchProposal, 'idemp-curr-mismatch'),
      ).rejects.toThrow(/does not match proposal currency 'USD'/);
      expect(mockOAuthClient.getAccessToken).not.toHaveBeenCalled();
    });

    it('rejects proposals where item line sums do not match totalAmountMinor without making any network calls', async () => {
      const mockOAuthClient = { getAccessToken: vi.fn() } as unknown as PayPalOAuthClient;
      const client = new PayPalOrdersClient({ oauthClient: mockOAuthClient });

      const divergingSumProposal: PurchaseProposal = {
        ...sampleProposal,
        totalAmountMinor: 3000, // Declared $30.00, but item is $25.00
        items: [
          {
            id: 'item-1',
            name: 'Item 1',
            quantity: 1,
            unitPriceMinor: 2500,
            currency: 'USD',
          },
        ],
      };

      await expect(client.createOrder(divergingSumProposal, 'idemp-sum-mismatch')).rejects.toThrow(
        /Sum of item amounts \(2500 minor units\) does not match proposal totalAmountMinor \(3000 minor units\)/,
      );
      expect(mockOAuthClient.getAccessToken).not.toHaveBeenCalled();
    });

    it('rejects multiplication or addition arithmetic overflow safely', () => {
      const overflowProposal: PurchaseProposal = {
        ...sampleProposal,
        totalAmountMinor: Number.MAX_SAFE_INTEGER,
        items: [
          {
            id: 'item-1',
            name: 'Massive item',
            quantity: 2,
            unitPriceMinor: Number.MAX_SAFE_INTEGER,
            currency: 'USD',
          },
        ],
      };

      expect(() => validateProposalAmountsAndCurrency(overflowProposal)).toThrow(
        /Arithmetic overflow/,
      );
    });

    it('PayPalPaymentProvider upfront rejects invalid proposals before idempotency lookup or network calls', async () => {
      const mockOrdersClient = {
        createOrder: vi.fn(),
        getOrder: vi.fn(),
        captureOrder: vi.fn(),
      } as unknown as PayPalOrdersClient;

      const repository = new InMemoryPaymentOrderRepository();
      const provider = new PayPalPaymentProvider({
        clientId: dummyClientId,
        clientSecret: dummyClientSecret,
        repository,
        ordersClient: mockOrdersClient,
      });

      const invalidProposal: PurchaseProposal = {
        ...sampleProposal,
        totalAmountMinor: 9999,
        items: [
          {
            id: 'item-1',
            name: 'Item 1',
            quantity: 1,
            unitPriceMinor: 100, // Sum 100 !== 9999
            currency: 'USD',
          },
        ],
      };

      await expect(provider.createOrder(invalidProposal, 'corr-test-inv')).rejects.toThrow(
        ProposalValidationError,
      );
      expect(mockOrdersClient.createOrder).not.toHaveBeenCalled();
    });
  });
});
