import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { buildApp } from '../src/app.js';
import { MockPaymentProvider } from '../src/provider.js';
import { PayPalPaymentProvider } from '../src/paypal/provider.js';
import { type PayPalOrdersClient, PayPalOrderApiError } from '../src/paypal/orders-client.js';
import { InMemoryPaymentOrderRepository, type StoredPaymentOrder } from '../src/repository.js';
import {
  ErrorCodes,
  type PaymentProvider,
  type PaymentOrder,
  type PaymentCaptureResult,
} from '@agentpay/contracts';
import { createMockProposal } from '@agentpay/test-utils';
import { PaymentServiceConfigSchema } from '@agentpay/config';

describe('Sandbox Order-State Retrieval & Capture-Blocking Security Verification', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // =========================================================================
  // Test Group 1: Read-Only Order-State Retrieval (Contract A)
  // =========================================================================
  describe('Test Group 1: Read-Only Order-State Retrieval', () => {
    it('GET an existing repository-backed order while payments are disabled returns 200 without capture/create', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const existingOrderId = 'TEST-ORDER-READONLY-001';
      const proposal = createMockProposal({ totalAmountMinor: 100, currency: 'USD' });

      const initialStoredOrder: StoredPaymentOrder = {
        id: existingOrderId,
        proposalId: proposal.id,
        policyDecisionId: uuidv4(),
        provider: 'paypal_sandbox',
        status: 'APPROVED',
        currency: 'USD',
        amountMinor: 100,
        approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=TEST-ORDER-READONLY-001',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await repository.createOrder(initialStoredOrder);

      // Create spy provider
      const spyProvider: PaymentProvider = {
        providerName: 'PayPal Sandbox Spy',
        isMock: false,
        createOrder: vi.fn(),
        getOrder: vi.fn().mockImplementation(async (id: string) => {
          const stored = await repository.getOrderById(id);
          if (!stored) return null;
          return {
            id: stored.id,
            proposalId: stored.proposalId,
            provider: stored.provider,
            status: stored.status,
            amountMinor: stored.amountMinor,
            currency: stored.currency,
            isMock: false,
            approvalUrl: stored.approvalUrl,
            createdAt: stored.createdAt,
            environmentNote: 'Test read-only retrieval',
          } satisfies PaymentOrder;
        }),
        captureOrder: vi.fn().mockImplementation(async () => {
          throw new Error(
            'FATAL SECURITY VIOLATION: captureOrder must NEVER be called during GET!',
          );
        }),
        verifyWebhook: vi.fn().mockResolvedValue(true),
      };

      const app = buildApp(spyProvider, { paymentsEnabled: false }, repository);

      const res = await app.inject({
        method: 'GET',
        url: `/orders/${existingOrderId}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      // Verification of identity & amounts
      expect(body.id).toBe(existingOrderId);
      expect(body.amountMinor).toBe(100);
      expect(body.currency).toBe('USD');
      expect(body.status).toBe('APPROVED');

      // CRITICAL SECURITY INVARIANTS:
      // Zero createOrder calls
      expect(spyProvider.createOrder).toHaveBeenCalledTimes(0);
      // Zero captureOrder calls
      expect(spyProvider.captureOrder).toHaveBeenCalledTimes(0);

      // Verify no local state transition to COMPLETED/CAPTURED occurred
      const storedAfter = await repository.getOrderById(existingOrderId);
      expect(storedAfter?.status).toBe('APPROVED');
      expect(storedAfter?.captureId).toBeUndefined();
      expect(storedAfter?.capturedAt).toBeUndefined();
    });

    it('GET order not in repository retrieves authoritative state from PayPal Sandbox API without DB mutation', async () => {
      const repository = new InMemoryPaymentOrderRepository();

      const mockOrdersClient = {
        getOrder: vi.fn().mockResolvedValue({
          id: '1MS29453RW109660R',
          status: 'APPROVED',
          purchase_units: [
            {
              reference_id: 'sample-ref-id',
              amount: {
                currency_code: 'USD',
                value: '1.00',
              },
            },
          ],
          links: [
            {
              href: 'https://www.sandbox.paypal.com/checkoutnow?token=1MS29453RW109660R',
              rel: 'approve',
            },
          ],
        }),
        createOrder: vi.fn().mockImplementation(() => {
          throw new Error('FATAL: createOrder called');
        }),
        captureOrder: vi.fn().mockImplementation(() => {
          throw new Error('FATAL: captureOrder called');
        }),
      } as unknown as PayPalOrdersClient;

      const provider = new PayPalPaymentProvider({
        clientId: 'mock_client_id',
        clientSecret: 'mock_client_secret',
        repository,
        ordersClient: mockOrdersClient,
      });

      const app = buildApp(provider, { paymentsEnabled: false }, repository);

      const res = await app.inject({
        method: 'GET',
        url: '/orders/1MS29453RW109660R',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.id).toBe('1MS29453RW109660R');
      expect(body.status).toBe('APPROVED');
      expect(body.amountMinor).toBe(100);
      expect(body.currency).toBe('USD');
      expect(body.environmentNote).toContain(
        'Retrieved directly from PayPal Sandbox Orders v2 API',
      );

      // PayPal getOrder was called
      expect(mockOrdersClient.getOrder).toHaveBeenCalledTimes(1);
      // Capture and create were NEVER called
      expect(mockOrdersClient.captureOrder).toHaveBeenCalledTimes(0);
      expect(mockOrdersClient.createOrder).toHaveBeenCalledTimes(0);

      // Confirm repository remains untouched (no fabricated records inserted)
      const stored = await repository.getOrderById('1MS29453RW109660R');
      expect(stored).toBeNull();
    });

    it('GET non-existent order returns 404 when PayPal returns 404 ORDER_NOT_FOUND', async () => {
      const repository = new InMemoryPaymentOrderRepository();

      const mockOrdersClient = {
        getOrder: vi.fn().mockRejectedValue(
          new PayPalOrderApiError('ORDER_LOOKUP_FAILED', 'PayPal get order returned HTTP 404', {
            statusCode: 404,
          }),
        ),
      } as unknown as PayPalOrdersClient;

      const provider = new PayPalPaymentProvider({
        clientId: 'mock_client_id',
        clientSecret: 'mock_client_secret',
        repository,
        ordersClient: mockOrdersClient,
      });

      const app = buildApp(provider, { paymentsEnabled: false }, repository);

      const res = await app.inject({
        method: 'GET',
        url: '/orders/NON_EXISTENT_ORDER_999',
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(ErrorCodes.NOT_FOUND);
      expect(body.error.message).toContain('Order NON_EXISTENT_ORDER_999 not found');
    });
  });

  // =========================================================================
  // Test Group 2: Capture-Blocking Security Gate (Contracts B & C)
  // =========================================================================
  describe('Test Group 2: Capture-Blocking Security Gate', () => {
    it('POST /orders/:id/capture returns 403 PAYMENTS_DISABLED and never dispatches provider capture', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const existingOrderId = '1MS29453RW109660R';
      const policyDecisionId = uuidv4();

      // Seed repository with an APPROVED order
      const initialStoredOrder: StoredPaymentOrder = {
        id: existingOrderId,
        proposalId: uuidv4(),
        policyDecisionId,
        provider: 'paypal_sandbox',
        status: 'APPROVED',
        currency: 'USD',
        amountMinor: 100,
        approvalUrl: 'https://sandbox.paypal.com/checkoutnow?token=1MS29453RW109660R',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await repository.createOrder(initialStoredOrder);

      // Create spy provider that throws on captureOrder
      const captureSpy = vi.fn().mockImplementation(async () => {
        throw new Error(
          'SECURITY VIOLATION: provider.captureOrder was invoked while PAYMENTS_ENABLED=false!',
        );
      });
      const createSpy = vi.fn().mockImplementation(async () => {
        throw new Error('SECURITY VIOLATION: provider.createOrder was invoked!');
      });

      const spyProvider: PaymentProvider = {
        providerName: 'Spy Provider',
        isMock: false,
        createOrder: createSpy,
        getOrder: vi.fn(),
        captureOrder: captureSpy,
        verifyWebhook: vi.fn(),
      };

      const app = buildApp(spyProvider, { paymentsEnabled: false }, repository);

      const res = await app.inject({
        method: 'POST',
        url: `/orders/${existingOrderId}/capture`,
        payload: {
          policyDecisionId,
        },
      });

      // 1. Assert HTTP 403
      expect(res.statusCode).toBe(403);

      // 2. Assert error code
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(ErrorCodes.PAYMENTS_DISABLED);
      expect(body.error.message).toBe('Payment capture is disabled by configuration');

      // 3. Mathematical Invariant C = 0: provider.captureOrder was never called
      expect(captureSpy).toHaveBeenCalledTimes(0);
      expect(createSpy).toHaveBeenCalledTimes(0);

      // 4. Mathematical Invariant S1 = S0: persisted state is identical
      const storedAfter = await repository.getOrderById(existingOrderId);
      expect(storedAfter).not.toBeNull();
      expect(storedAfter?.status).toBe('APPROVED');
      expect(storedAfter?.captureId).toBeUndefined();
      expect(storedAfter?.capturedAt).toBeUndefined();
      expect(storedAfter?.updatedAt).toBe(initialStoredOrder.updatedAt);
    });

    it('repetition of capture attempts remains deterministically blocked (idempotent rejection)', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const existingOrderId = '1MS29453RW109660R';
      const policyDecisionId = uuidv4();

      const captureSpy = vi.fn();
      const spyProvider: PaymentProvider = {
        providerName: 'Spy Provider',
        isMock: false,
        createOrder: vi.fn(),
        getOrder: vi.fn(),
        captureOrder: captureSpy,
        verifyWebhook: vi.fn(),
      };

      const app = buildApp(spyProvider, { paymentsEnabled: false }, repository);

      for (let i = 0; i < 3; i++) {
        const res = await app.inject({
          method: 'POST',
          url: `/orders/${existingOrderId}/capture`,
          payload: {
            policyDecisionId,
          },
        });
        expect(res.statusCode).toBe(403);
        const body = JSON.parse(res.body);
        expect(body.error.code).toBe(ErrorCodes.PAYMENTS_DISABLED);
      }

      expect(captureSpy).toHaveBeenCalledTimes(0);
    });

    it('capture gate blocks BEFORE request validation or payload parsing', async () => {
      const captureSpy = vi.fn();
      const spyProvider: PaymentProvider = {
        providerName: 'Spy Provider',
        isMock: false,
        createOrder: vi.fn(),
        getOrder: vi.fn(),
        captureOrder: captureSpy,
        verifyWebhook: vi.fn(),
      };

      const app = buildApp(spyProvider, { paymentsEnabled: false });

      // Completely empty / invalid payload (missing policyDecisionId)
      const res = await app.inject({
        method: 'POST',
        url: '/orders/MOCK-ORDER-123/capture',
        payload: {},
      });

      // Still returns 403 PAYMENTS_DISABLED because gate precedes schema validation
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(ErrorCodes.PAYMENTS_DISABLED);
      expect(captureSpy).toHaveBeenCalledTimes(0);
    });
  });

  // =========================================================================
  // Test Group 3: PayPal HTTP Boundary & Transport Isolation
  // =========================================================================
  describe('Test Group 3: PayPal HTTP Boundary & Transport Isolation', () => {
    it('guarantees zero HTTP requests to PayPal capture endpoint (Invariant N = 0)', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const networkSpy = vi.fn();

      // Stub global fetch to monitor any HTTP attempts
      vi.stubGlobal('fetch', async (url: string | URL | Request) => {
        const urlStr = url.toString();
        networkSpy(urlStr);
        if (urlStr.includes('/capture')) {
          throw new Error(
            `SECURITY ALERT: Network request made to PayPal capture endpoint: ${urlStr}`,
          );
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });

      const app = buildApp(
        undefined,
        {
          PAYMENT_PROVIDER: 'paypal_sandbox',
          PAYPAL_CLIENT_ID: 'mock_sandbox_id',
          PAYPAL_CLIENT_SECRET: 'mock_sandbox_secret',
          PAYMENTS_ENABLED: false,
        },
        repository,
      );

      const res = await app.inject({
        method: 'POST',
        url: '/orders/1MS29453RW109660R/capture',
        payload: {
          policyDecisionId: uuidv4(),
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(ErrorCodes.PAYMENTS_DISABLED);

      // Invariant N = 0: Zero calls to PayPal capture endpoint
      const captureHttpCalls = networkSpy.mock.calls.filter((call) =>
        (call[0] as string).includes('/capture'),
      );
      expect(captureHttpCalls.length).toBe(0);

      // In fact, zero network calls to PayPal altogether
      expect(networkSpy).toHaveBeenCalledTimes(0);
    });
  });

  // =========================================================================
  // Test Group 4: Configuration Safeguards & Live Mode Prevention (Contract D)
  // =========================================================================
  describe('Test Group 4: Configuration Safeguards & Live Mode Prevention', () => {
    it('default provider is mock with payments disabled', () => {
      const config = PaymentServiceConfigSchema.parse({});
      expect(config.PAYMENT_PROVIDER).toBe('mock');
      expect(config.PAYMENTS_ENABLED).toBe(false);
    });

    it('prohibits PayPal live environment at configuration schema level', () => {
      expect(() => {
        PaymentServiceConfigSchema.parse({
          PAYMENT_PROVIDER: 'paypal_sandbox',
          PAYPAL_CLIENT_ID: 'live_id',
          PAYPAL_CLIENT_SECRET: 'live_secret',
          PAYPAL_ENVIRONMENT: 'live',
        });
      }).toThrow(/PayPal Live environment is forbidden/);
    });

    it('prohibits PayPal live endpoint URLs at configuration schema level', () => {
      expect(() => {
        PaymentServiceConfigSchema.parse({
          PAYMENT_PROVIDER: 'paypal_sandbox',
          PAYPAL_CLIENT_ID: 'sandbox_id',
          PAYPAL_CLIENT_SECRET: 'sandbox_secret',
          PAYPAL_API_BASE_URL: 'https://api-m.paypal.com',
        });
      }).toThrow(/PayPal Live endpoints are forbidden/);
    });

    it('missing credentials fails schema validation for paypal_sandbox provider', () => {
      expect(() => {
        PaymentServiceConfigSchema.parse({
          PAYMENT_PROVIDER: 'paypal_sandbox',
          PAYPAL_CLIENT_ID: '',
          PAYPAL_CLIENT_SECRET: '',
        });
      }).toThrow(/PAYPAL_CLIENT_ID is required/);
    });
  });

  // =========================================================================
  // Test Group 5: Mathematical Invariants Formally Verified
  // =========================================================================
  describe('Test Group 5: Mathematical Invariants Formally Verified', () => {
    it('Invariant A: ¬E ∧ R ⟹ (HTTP=403) ∧ (code=PAYMENTS_DISABLED) ∧ C=0 ∧ N=0', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const existingOrderId = '1MS29453RW109660R';
      const policyDecisionId = uuidv4();

      let C = 0; // Provider capture invocations
      let N = 0; // PayPal capture HTTP requests

      vi.stubGlobal('fetch', async (url: string | URL | Request) => {
        if (url.toString().includes('/capture')) {
          N++;
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });

      const spyProvider: PaymentProvider = {
        providerName: 'Invariant Verification Provider',
        isMock: false,
        createOrder: vi.fn(),
        getOrder: vi.fn(),
        captureOrder: vi.fn().mockImplementation(async () => {
          C++;
          return {} as unknown as PaymentCaptureResult;
        }),
        verifyWebhook: vi.fn(),
      };

      // ¬E: paymentsEnabled = false
      const app = buildApp(spyProvider, { paymentsEnabled: false }, repository);

      // R: valid capture request
      const res = await app.inject({
        method: 'POST',
        url: `/orders/${existingOrderId}/capture`,
        payload: { policyDecisionId },
      });

      // Proof:
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('PAYMENTS_DISABLED');
      expect(C).toBe(0);
      expect(N).toBe(0);
    });

    it('Invariant B: E = false ⟹ S1 = S0 for all financial state fields', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const orderId = 'STATE-PRESERVE-001';

      const initialOrder: StoredPaymentOrder = {
        id: orderId,
        proposalId: uuidv4(),
        policyDecisionId: uuidv4(),
        provider: 'paypal_sandbox',
        status: 'APPROVED',
        currency: 'USD',
        amountMinor: 100,
        approvalUrl: 'https://sandbox.paypal.com/checkoutnow?token=STATE-PRESERVE-001',
        idempotencyKey: 'idemp-001',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const S0 = await repository.createOrder(initialOrder);

      const app = buildApp(new MockPaymentProvider(), { paymentsEnabled: false }, repository);

      await app.inject({
        method: 'POST',
        url: `/orders/${orderId}/capture`,
        payload: { policyDecisionId: S0.policyDecisionId },
      });

      const S1 = await repository.getOrderById(orderId);
      expect(S1).not.toBeNull();
      expect(S1?.status).toBe(S0.status);
      expect(S1?.captureId).toBe(S0.captureId);
      expect(S1?.capturedAt).toBe(S0.capturedAt);
      expect(S1?.amountMinor).toBe(S0.amountMinor);
      expect(S1?.currency).toBe(S0.currency);
      expect(S1?.updatedAt).toBe(S0.updatedAt);
    });
  });
});
