import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { buildApp } from '../src/app.js';
import { MockPaymentProvider } from '../src/provider.js';
import { PayPalPaymentProvider } from '../src/paypal/provider.js';
import { type PayPalOrdersClient, PayPalOrderApiError } from '../src/paypal/orders-client.js';
import {
  InMemoryPaymentOrderRepository,
  canTransitionStatus,
  StateTransitionError,
  IdempotencyConflictError,
  type StoredPaymentOrder,
} from '../src/repository.js';
import { createMockProposal } from '@agentpay/test-utils';

describe('Phase 2: Durable Payment Lifecycle, Webhook Integrity & Reconciliation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // =========================================================================
  // 1. Payment Persistence & Restart Durability
  // =========================================================================
  describe('Durable Payment Persistence & Restart Durability', () => {
    it('persists newly created order to repository and survives service restart', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const proposal = createMockProposal({ totalAmountMinor: 100, currency: 'USD' });
      const policyDecisionId = uuidv4();

      // Instance 1: Create order with payments enabled
      const app1 = buildApp(
        new MockPaymentProvider(repository),
        { paymentsEnabled: true },
        repository,
      );

      const createRes = await app1.inject({
        method: 'POST',
        url: '/orders',
        payload: {
          proposal,
          policyDecisionId,
          authorizedOutcome: 'ALLOW',
          idempotencyKey: `idemp-durable-${proposal.id}`,
        },
      });

      expect(createRes.statusCode).toBe(201);
      const createdOrder = JSON.parse(createRes.body);
      expect(createdOrder.id).toBeDefined();

      // Verify order is persisted in repository
      const stored = await repository.getOrderById(createdOrder.id);
      expect(stored).not.toBeNull();
      expect(stored?.id).toBe(createdOrder.id);
      expect(stored?.proposalId).toBe(proposal.id);
      expect(stored?.amountMinor).toBe(100);
      expect(stored?.currency).toBe('USD');

      // Instance 2: Simulate complete process restart by instantiating new Fastify app
      const app2 = buildApp(
        new MockPaymentProvider(repository),
        { paymentsEnabled: false },
        repository,
      );

      const getRes = await app2.inject({
        method: 'GET',
        url: `/orders/${createdOrder.id}`,
      });

      expect(getRes.statusCode).toBe(200);
      const fetchedOrder = JSON.parse(getRes.body);
      expect(fetchedOrder.id).toBe(createdOrder.id);
      expect(fetchedOrder.amountMinor).toBe(100);
      expect(fetchedOrder.status).toBe('CREATED');
    });

    it('enforces scoped idempotency key and rejects conflicting proposal payloads (409 Conflict)', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const proposal1 = createMockProposal({ totalAmountMinor: 100, currency: 'USD' });
      const idempotencyKey = 'idemp-conflict-test-01';

      const initialStored: StoredPaymentOrder = {
        id: 'ORDER-IDEMP-01',
        proposalId: proposal1.id,
        policyDecisionId: uuidv4(),
        provider: 'mock',
        status: 'CREATED',
        currency: 'USD',
        amountMinor: 100,
        idempotencyKey,
        requestHash: 'hash-proposal-1',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await repository.createOrder(initialStored);

      // Attempt creating conflicting order with same idempotency key but different hash
      await expect(
        repository.createOrder({
          ...initialStored,
          id: 'ORDER-IDEMP-02',
          amountMinor: 500,
          requestHash: 'hash-proposal-2-conflict',
        }),
      ).rejects.toThrow(IdempotencyConflictError);
    });
  });

  // =========================================================================
  // 2. Canonical State Machine & Transition Rules
  // =========================================================================
  describe('Canonical State Machine & Monotonic Integrity', () => {
    it('allows valid monotonic forward transitions', () => {
      // Forward progression
      expect(canTransitionStatus('CREATED', 'PAYER_ACTION_REQUIRED')).toBe(true);
      expect(canTransitionStatus('CREATED', 'APPROVED')).toBe(true);
      expect(canTransitionStatus('PAYER_ACTION_REQUIRED', 'APPROVED')).toBe(true);
      expect(canTransitionStatus('APPROVED', 'COMPLETED')).toBe(true);
      expect(canTransitionStatus('CREATED', 'VOIDED')).toBe(true);
      expect(canTransitionStatus('APPROVED', 'VOIDED')).toBe(true);

      // Timeout / ambiguous state reconciliation
      expect(canTransitionStatus('APPROVED', 'UNKNOWN')).toBe(true);
      expect(canTransitionStatus('UNKNOWN', 'COMPLETED')).toBe(true);
      expect(canTransitionStatus('UNKNOWN', 'FAILED')).toBe(true);

      // Self-transitions (idempotent no-op)
      expect(canTransitionStatus('APPROVED', 'APPROVED')).toBe(true);
      expect(canTransitionStatus('COMPLETED', 'COMPLETED')).toBe(true);
    });

    it('strictly prohibits backwards or regressive transitions from terminal states', () => {
      // COMPLETED is immutable terminal state
      expect(canTransitionStatus('COMPLETED', 'APPROVED')).toBe(false);
      expect(canTransitionStatus('COMPLETED', 'PAYER_ACTION_REQUIRED')).toBe(false);
      expect(canTransitionStatus('COMPLETED', 'CREATED')).toBe(false);
      expect(canTransitionStatus('COMPLETED', 'VOIDED')).toBe(false);
      expect(canTransitionStatus('COMPLETED', 'FAILED')).toBe(false);

      // Terminal VOIDED and FAILED cannot resurrect
      expect(canTransitionStatus('VOIDED', 'APPROVED')).toBe(false);
      expect(canTransitionStatus('FAILED', 'APPROVED')).toBe(false);
      expect(canTransitionStatus('VOIDED', 'COMPLETED')).toBe(false);
    });

    it('repository throws StateTransitionError when invalid transition is attempted', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const orderId = 'ORD-TERMINAL-01';

      await repository.createOrder({
        id: orderId,
        proposalId: uuidv4(),
        policyDecisionId: uuidv4(),
        provider: 'mock',
        status: 'COMPLETED',
        currency: 'USD',
        amountMinor: 2500,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Attempt regressing from COMPLETED to APPROVED
      await expect(repository.updateOrderStatus(orderId, 'APPROVED')).rejects.toThrow(
        StateTransitionError,
      );

      // State is preserved unchanged (Invariant B)
      const after = await repository.getOrderById(orderId);
      expect(after?.status).toBe('COMPLETED');
    });

    it('enforces that COMPLETED strictly requires authoritative capture identifier evidence (Invariant 3)', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const orderId = 'ORD-CAPTURE-REQ-01';

      await repository.createOrder({
        id: orderId,
        proposalId: uuidv4(),
        policyDecisionId: uuidv4(),
        provider: 'mock',
        status: 'APPROVED',
        currency: 'USD',
        amountMinor: 1000,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Topological evaluator rejects COMPLETED when captureId is empty/missing in context
      expect(canTransitionStatus('APPROVED', 'COMPLETED', { captureId: undefined })).toBe(false);
      expect(canTransitionStatus('APPROVED', 'COMPLETED', { captureId: '' })).toBe(false);
      expect(canTransitionStatus('APPROVED', 'COMPLETED', { captureId: 'CAP-VALID-123' })).toBe(
        true,
      );

      // Attempt transitioning to COMPLETED without captureId fails
      await expect(repository.updateOrderStatus(orderId, 'COMPLETED')).rejects.toThrow(
        StateTransitionError,
      );

      // Order state remains APPROVED, untouched ($S_1 = S_0$)
      const afterFailed = await repository.getOrderById(orderId);
      expect(afterFailed?.status).toBe('APPROVED');
      expect(afterFailed?.captureId).toBeUndefined();

      // With valid captureId, transition succeeds
      const completed = await repository.updateOrderStatus(orderId, 'COMPLETED', {
        captureId: 'CAP-AUTHORITATIVE-01',
        capturedAt: new Date().toISOString(),
      });
      expect(completed.status).toBe('COMPLETED');
      expect(completed.captureId).toBe('CAP-AUTHORITATIVE-01');
    });

    it('verifies that duplicate transitions are idempotent no-ops (Invariant 6)', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const orderId = 'ORD-IDEMPOTENT-01';

      await repository.createOrder({
        id: orderId,
        proposalId: uuidv4(),
        policyDecisionId: uuidv4(),
        provider: 'mock',
        status: 'APPROVED',
        currency: 'USD',
        amountMinor: 500,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Self-transition to APPROVED is allowed
      const result = await repository.updateOrderStatus(orderId, 'APPROVED', {
        metadata: { retryCount: 1 },
      });
      expect(result.status).toBe('APPROVED');
      expect(result.metadata?.retryCount).toBe(1);
    });
  });

  // =========================================================================
  // 3. Webhook Signature Verification & Deduplication
  // =========================================================================
  describe('Webhook Signature Verification & Deduplication', () => {
    const dummyHeaders = {
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123',
      'paypal-transmission-id': 'trans-uuid-001',
      'paypal-transmission-sig': 'mock_signature_bytes_base64',
      'paypal-transmission-time': '2026-10-25T11:00:00Z',
    };

    it('rejects webhooks with missing signature headers with 400', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const provider = new PayPalPaymentProvider({
        clientId: 'id',
        clientSecret: 'secret',
        repository,
      });

      const app = buildApp(provider, { paymentsEnabled: false }, repository);

      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/paypal',
        headers: {}, // missing headers
        payload: { event_type: 'CHECKOUT.ORDER.APPROVED' },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Invalid webhook signature');
    });

    it('rejects webhooks when signature verification fails without mutating state (Invariant F)', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const orderId = 'ORD-WH-SIG-FAIL';

      await repository.createOrder({
        id: orderId,
        proposalId: uuidv4(),
        policyDecisionId: uuidv4(),
        provider: 'paypal_sandbox',
        status: 'CREATED',
        currency: 'USD',
        amountMinor: 100,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const mockOrdersClient = {
        verifyWebhookSignature: vi.fn().mockResolvedValue(false), // Signature invalid
      } as unknown as PayPalOrdersClient;

      const provider = new PayPalPaymentProvider({
        clientId: 'id',
        clientSecret: 'secret',
        repository,
        ordersClient: mockOrdersClient,
      });

      const app = buildApp(provider, { paymentsEnabled: false }, repository);

      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/paypal',
        headers: dummyHeaders,
        payload: {
          id: 'WH-EVENT-001',
          event_type: 'CHECKOUT.ORDER.APPROVED',
          resource: { id: orderId },
        },
      });

      expect(res.statusCode).toBe(400);

      // Verify order status did NOT change
      const stored = await repository.getOrderById(orderId);
      expect(stored?.status).toBe('CREATED');
    });

    it('durably deduplicates webhooks using stable PayPal event ID (Invariant C & D)', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const orderId = 'ORD-WH-DEDUP';

      await repository.createOrder({
        id: orderId,
        proposalId: uuidv4(),
        policyDecisionId: uuidv4(),
        provider: 'paypal_sandbox',
        status: 'CREATED',
        currency: 'USD',
        amountMinor: 100,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const mockOrdersClient = {
        verifyWebhookSignature: vi.fn().mockResolvedValue(true),
      } as unknown as PayPalOrdersClient;

      const provider = new PayPalPaymentProvider({
        clientId: 'id',
        clientSecret: 'secret',
        repository,
        ordersClient: mockOrdersClient,
      });

      const webhookPayload = {
        id: 'WH-STABLE-EVENT-999',
        event_type: 'CHECKOUT.ORDER.APPROVED',
        resource: { id: orderId },
      };

      // Delivery 1
      const res1 = await provider.verifyWebhook(webhookPayload, dummyHeaders);
      expect(res1).toBe(true);

      const afterFirst = await repository.getOrderById(orderId);
      expect(afterFirst?.status).toBe('APPROVED');

      // Delivery 2 with same event ID (simulating PayPal retry with different transmission ID)
      const retryHeaders = { ...dummyHeaders, 'paypal-transmission-id': 'trans-uuid-002-retry' };
      const res2 = await provider.verifyWebhook(webhookPayload, retryHeaders);
      expect(res2).toBe(true); // Acknowledged without error

      // Verify status is still APPROVED and no duplicate side effects
      const afterSecond = await repository.getOrderById(orderId);
      expect(afterSecond?.status).toBe('APPROVED');
    });

    it('safely handles unknown order in webhook without fabricating local state', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const mockOrdersClient = {
        verifyWebhookSignature: vi.fn().mockResolvedValue(true),
      } as unknown as PayPalOrdersClient;

      const provider = new PayPalPaymentProvider({
        clientId: 'id',
        clientSecret: 'secret',
        repository,
        ordersClient: mockOrdersClient,
      });

      const res = await provider.verifyWebhook(
        {
          id: 'WH-UNKNOWN-ORD',
          event_type: 'CHECKOUT.ORDER.APPROVED',
          resource: { id: 'ORD-NOT-IN-REPO' },
        },
        dummyHeaders,
      );

      expect(res).toBe(true);
      // Confirm no record was inserted
      const stored = await repository.getOrderById('ORD-NOT-IN-REPO');
      expect(stored).toBeNull();
    });

    it('rejects state transition if webhook amount/currency conflicts with order', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const orderId = 'ORD-WH-CURRENCY-MISMATCH';

      await repository.createOrder({
        id: orderId,
        proposalId: uuidv4(),
        policyDecisionId: uuidv4(),
        provider: 'paypal_sandbox',
        status: 'CREATED',
        currency: 'USD',
        amountMinor: 100, // $1.00 USD
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const mockOrdersClient = {
        verifyWebhookSignature: vi.fn().mockResolvedValue(true),
      } as unknown as PayPalOrdersClient;

      const provider = new PayPalPaymentProvider({
        clientId: 'id',
        clientSecret: 'secret',
        repository,
        ordersClient: mockOrdersClient,
      });

      // Webhook payload claims EUR 100.00 instead of USD 1.00
      await provider.verifyWebhook(
        {
          id: 'WH-MISMATCH-01',
          event_type: 'CHECKOUT.ORDER.APPROVED',
          resource: {
            id: orderId,
            amount: { currency_code: 'EUR', value: '100.00' },
          },
        },
        dummyHeaders,
      );

      // Status remains CREATED, not approved
      const stored = await repository.getOrderById(orderId);
      expect(stored?.status).toBe('CREATED');
    });

    it('recovers from failure during webhook event processing without silent loss (Stage C)', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const orderId = 'ORD-WH-FAILURE-RECOVERY';

      await repository.createOrder({
        id: orderId,
        proposalId: uuidv4(),
        policyDecisionId: uuidv4(),
        provider: 'paypal_sandbox',
        status: 'CREATED',
        currency: 'USD',
        amountMinor: 100,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const mockOrdersClient = {
        verifyWebhookSignature: vi.fn().mockResolvedValue(true),
      } as unknown as PayPalOrdersClient;

      const provider = new PayPalPaymentProvider({
        clientId: 'id',
        clientSecret: 'secret',
        repository,
        ordersClient: mockOrdersClient,
      });

      const webhookPayload = {
        id: 'WH-RETRYABLE-EVENT-001',
        event_type: 'CHECKOUT.ORDER.APPROVED',
        resource: { id: orderId },
      };

      // Delivery 1: Simulate process/database failure during order transition
      let simulatedCrashHappened = false;
      vi.spyOn(repository, 'processWebhookEvent').mockImplementationOnce(async () => {
        simulatedCrashHappened = true;
        throw new Error('SIMULATED CRASH: Database connection dropped during transaction');
      });

      await expect(provider.verifyWebhook(webhookPayload, dummyHeaders)).rejects.toThrow(
        'SIMULATED CRASH',
      );
      expect(simulatedCrashHappened).toBe(true);

      // Verify that due to rollback, the order status is NOT mutated
      const orderAfterCrash = await repository.getOrderById(orderId);
      expect(orderAfterCrash?.status).toBe('CREATED');

      // Delivery 2: PayPal retries the same event ID after failure
      // The event must NOT be falsely deduplicated, and must successfully transition!
      const retryHeaders = { ...dummyHeaders, 'paypal-transmission-id': 'trans-retry-999' };
      const retryResult = await provider.verifyWebhook(webhookPayload, retryHeaders);
      expect(retryResult).toBe(true);

      // Verify transition was safely recovered and applied!
      const orderAfterRetry = await repository.getOrderById(orderId);
      expect(orderAfterRetry?.status).toBe('APPROVED');
    });

    it('safely handles concurrent simultaneous webhook deliveries for the same event (Stage D)', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const orderId = 'ORD-WH-CONCURRENT';

      await repository.createOrder({
        id: orderId,
        proposalId: uuidv4(),
        policyDecisionId: uuidv4(),
        provider: 'paypal_sandbox',
        status: 'CREATED',
        currency: 'USD',
        amountMinor: 100,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const mockOrdersClient = {
        verifyWebhookSignature: vi.fn().mockResolvedValue(true),
      } as unknown as PayPalOrdersClient;

      const provider = new PayPalPaymentProvider({
        clientId: 'id',
        clientSecret: 'secret',
        repository,
        ordersClient: mockOrdersClient,
      });

      const webhookPayload = {
        id: 'WH-CONCURRENT-001',
        event_type: 'CHECKOUT.ORDER.APPROVED',
        resource: { id: orderId },
      };

      // Simultaneous delivery of the same event
      const [resA, resB] = await Promise.all([
        provider.verifyWebhook(webhookPayload, dummyHeaders),
        provider.verifyWebhook(webhookPayload, {
          ...dummyHeaders,
          'paypal-transmission-id': 'trans-concurrent-b',
        }),
      ]);

      expect(resA).toBe(true);
      expect(resB).toBe(true);

      const finalOrder = await repository.getOrderById(orderId);
      expect(finalOrder?.status).toBe('APPROVED');
    });

    it('rejects stale approval event arriving after terminal COMPLETED state without mutating state', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const orderId = 'ORD-WH-STALE-AFTER-COMPLETED';

      await repository.createOrder({
        id: orderId,
        proposalId: uuidv4(),
        policyDecisionId: uuidv4(),
        provider: 'paypal_sandbox',
        status: 'COMPLETED',
        currency: 'USD',
        amountMinor: 100,
        captureId: 'CAP-PREV-COMPLETED',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const mockOrdersClient = {
        verifyWebhookSignature: vi.fn().mockResolvedValue(true),
      } as unknown as PayPalOrdersClient;

      const provider = new PayPalPaymentProvider({
        clientId: 'id',
        clientSecret: 'secret',
        repository,
        ordersClient: mockOrdersClient,
      });

      // Stale approval event arrives
      const res = await provider.verifyWebhook(
        {
          id: 'WH-STALE-001',
          event_type: 'CHECKOUT.ORDER.APPROVED',
          resource: { id: orderId },
        },
        dummyHeaders,
      );

      expect(res).toBe(true);

      // Order status remains COMPLETED, immutable (Invariant 4 & 5)
      const stored = await repository.getOrderById(orderId);
      expect(stored?.status).toBe('COMPLETED');
      expect(stored?.captureId).toBe('CAP-PREV-COMPLETED');
    });
  });

  // =========================================================================
  // 4. Reconciliation for Uncertain Outcomes
  // =========================================================================
  describe('Reconciliation Engine & Uncertain Outcomes', () => {
    it('returns UNCHANGED when local order state matches authoritative PayPal state', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const orderId = 'ORD-RECON-SYNC';

      await repository.createOrder({
        id: orderId,
        proposalId: uuidv4(),
        policyDecisionId: uuidv4(),
        provider: 'paypal_sandbox',
        status: 'APPROVED',
        currency: 'USD',
        amountMinor: 100,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const mockOrdersClient = {
        getOrder: vi.fn().mockResolvedValue({
          id: orderId,
          status: 'APPROVED',
          purchase_units: [{ amount: { currency_code: 'USD', value: '1.00' } }],
        }),
      } as unknown as PayPalOrdersClient;

      const provider = new PayPalPaymentProvider({
        clientId: 'id',
        clientSecret: 'secret',
        repository,
        ordersClient: mockOrdersClient,
      });

      const result = await provider.reconcileOrder(orderId, 'corr-recon-01');

      expect(result.status).toBe('UNCHANGED');
      expect(result.previousOrderStatus).toBe('APPROVED');
      expect(result.currentOrderStatus).toBe('APPROVED');
    });

    it('advances local state to APPROVED when PayPal reports APPROVED and local state is CREATED (UPDATED)', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const orderId = 'ORD-RECON-ADVANCE';

      await repository.createOrder({
        id: orderId,
        proposalId: uuidv4(),
        policyDecisionId: uuidv4(),
        provider: 'paypal_sandbox',
        status: 'CREATED',
        currency: 'USD',
        amountMinor: 100,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const mockOrdersClient = {
        getOrder: vi.fn().mockResolvedValue({
          id: orderId,
          status: 'APPROVED',
          purchase_units: [{ amount: { currency_code: 'USD', value: '1.00' } }],
        }),
      } as unknown as PayPalOrdersClient;

      const provider = new PayPalPaymentProvider({
        clientId: 'id',
        clientSecret: 'secret',
        repository,
        ordersClient: mockOrdersClient,
      });

      const result = await provider.reconcileOrder(orderId, 'corr-recon-02');

      expect(result.status).toBe('UPDATED');
      expect(result.previousOrderStatus).toBe('CREATED');
      expect(result.currentOrderStatus).toBe('APPROVED');

      const stored = await repository.getOrderById(orderId);
      expect(stored?.status).toBe('APPROVED');
      expect(stored?.reconciliationStatus).toBe('UPDATED');
      expect(stored?.lastReconciledAt).toBeDefined();
    });

    it('resolves UNKNOWN timeout state to COMPLETED when PayPal confirms capture occurred', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const orderId = 'ORD-RECON-TIMEOUT-RESOLVE';

      // Order was marked UNKNOWN after a network timeout during capture
      await repository.createOrder({
        id: orderId,
        proposalId: uuidv4(),
        policyDecisionId: uuidv4(),
        provider: 'paypal_sandbox',
        status: 'UNKNOWN',
        currency: 'USD',
        amountMinor: 100,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const mockOrdersClient = {
        getOrder: vi.fn().mockResolvedValue({
          id: orderId,
          status: 'COMPLETED',
          purchase_units: [
            {
              amount: { currency_code: 'USD', value: '1.00' },
              payments: {
                captures: [
                  {
                    id: 'CAP-RESOLVED-123',
                    create_time: '2026-10-25T11:15:00Z',
                  },
                ],
              },
            },
          ],
        }),
      } as unknown as PayPalOrdersClient;

      const provider = new PayPalPaymentProvider({
        clientId: 'id',
        clientSecret: 'secret',
        repository,
        ordersClient: mockOrdersClient,
      });

      const result = await provider.reconcileOrder(orderId, 'corr-recon-timeout');

      expect(result.status).toBe('UPDATED');
      expect(result.previousOrderStatus).toBe('UNKNOWN');
      expect(result.currentOrderStatus).toBe('COMPLETED');

      const stored = await repository.getOrderById(orderId);
      expect(stored?.status).toBe('COMPLETED');
      expect(stored?.captureId).toBe('CAP-RESOLVED-123');
    });

    it('returns REQUIRES_REVIEW when order exists on PayPal but has no local authorization record', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const orderId = '1MS29453RW109660R'; // Exists on PayPal, not in repo

      const mockOrdersClient = {
        getOrder: vi.fn().mockResolvedValue({
          id: orderId,
          status: 'APPROVED',
          purchase_units: [{ amount: { currency_code: 'USD', value: '1.00' } }],
        }),
      } as unknown as PayPalOrdersClient;

      const provider = new PayPalPaymentProvider({
        clientId: 'id',
        clientSecret: 'secret',
        repository,
        ordersClient: mockOrdersClient,
      });

      const result = await provider.reconcileOrder(orderId, 'corr-missing-local');

      expect(result.status).toBe('REQUIRES_REVIEW');
      expect(result.providerStatus).toBe('APPROVED');
      expect(result.details).toContain('no corresponding AgentPay repository record');

      // Crucial: No order was fabricated into local repository
      const stored = await repository.getOrderById(orderId);
      expect(stored).toBeNull();
    });

    it('returns NOT_FOUND when order does not exist locally or in PayPal', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const orderId = 'NON-EXISTENT-ORDER-888';

      const mockOrdersClient = {
        getOrder: vi
          .fn()
          .mockRejectedValue(
            new PayPalOrderApiError('ORDER_NOT_FOUND', 'PayPal 404', { statusCode: 404 }),
          ),
      } as unknown as PayPalOrdersClient;

      const provider = new PayPalPaymentProvider({
        clientId: 'id',
        clientSecret: 'secret',
        repository,
        ordersClient: mockOrdersClient,
      });

      const result = await provider.reconcileOrder(orderId, 'corr-not-found');
      expect(result.status).toBe('NOT_FOUND');
    });

    it('returns RETRYABLE_ERROR and preserves local financial state when PayPal API times out during reconciliation', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const orderId = 'ORD-RECON-API-TIMEOUT';

      await repository.createOrder({
        id: orderId,
        proposalId: uuidv4(),
        policyDecisionId: uuidv4(),
        provider: 'paypal_sandbox',
        status: 'APPROVED',
        currency: 'USD',
        amountMinor: 100,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const mockOrdersClient = {
        getOrder: vi
          .fn()
          .mockRejectedValue(
            new PayPalOrderApiError('TIMEOUT', 'PayPal get order timed out', { statusCode: 504 }),
          ),
      } as unknown as PayPalOrdersClient;

      const provider = new PayPalPaymentProvider({
        clientId: 'id',
        clientSecret: 'secret',
        repository,
        ordersClient: mockOrdersClient,
      });

      const result = await provider.reconcileOrder(orderId, 'corr-timeout');

      expect(result.status).toBe('RETRYABLE_ERROR');
      expect(result.details).toContain('PayPal get order timed out');

      // Financial state remains APPROVED, not failed or altered
      const stored = await repository.getOrderById(orderId);
      expect(stored?.status).toBe('APPROVED');
    });

    it('returns RETRYABLE_ERROR and preserves local state when PayPal API returns 500 internal server error', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const orderId = 'ORD-RECON-500-ERROR';

      await repository.createOrder({
        id: orderId,
        proposalId: uuidv4(),
        policyDecisionId: uuidv4(),
        provider: 'paypal_sandbox',
        status: 'APPROVED',
        currency: 'USD',
        amountMinor: 100,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const mockOrdersClient = {
        getOrder: vi
          .fn()
          .mockRejectedValue(
            new PayPalOrderApiError('INTERNAL_ERROR', 'PayPal 500 error', { statusCode: 500 }),
          ),
      } as unknown as PayPalOrdersClient;

      const provider = new PayPalPaymentProvider({
        clientId: 'id',
        clientSecret: 'secret',
        repository,
        ordersClient: mockOrdersClient,
      });

      const result = await provider.reconcileOrder(orderId, 'corr-500');

      expect(result.status).toBe('RETRYABLE_ERROR');
      expect(result.details).toContain('Financial state preserved');

      // Order status remains APPROVED
      const stored = await repository.getOrderById(orderId);
      expect(stored?.status).toBe('APPROVED');
    });

    it('returns CONFLICT when PayPal returns 404 for an existing local order', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const orderId = 'ORD-RECON-LOCAL-EXISTS-PAYPAL-404';

      await repository.createOrder({
        id: orderId,
        proposalId: uuidv4(),
        policyDecisionId: uuidv4(),
        provider: 'paypal_sandbox',
        status: 'APPROVED',
        currency: 'USD',
        amountMinor: 100,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const mockOrdersClient = {
        getOrder: vi
          .fn()
          .mockRejectedValue(
            new PayPalOrderApiError('RESOURCE_NOT_FOUND', 'PayPal 404', { statusCode: 404 }),
          ),
      } as unknown as PayPalOrdersClient;

      const provider = new PayPalPaymentProvider({
        clientId: 'id',
        clientSecret: 'secret',
        repository,
        ordersClient: mockOrdersClient,
      });

      const result = await provider.reconcileOrder(orderId, 'corr-404-conflict');

      expect(result.status).toBe('CONFLICT');
      expect(result.details).toContain('PayPal returned 404 NOT_FOUND');

      const stored = await repository.getOrderById(orderId);
      expect(stored?.status).toBe('APPROVED');
    });

    it('returns REQUIRES_REVIEW when PayPal reports COMPLETED without capture evidence', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const orderId = 'ORD-RECON-COMPLETED-NO-CAPTURE';

      await repository.createOrder({
        id: orderId,
        proposalId: uuidv4(),
        policyDecisionId: uuidv4(),
        provider: 'paypal_sandbox',
        status: 'APPROVED',
        currency: 'USD',
        amountMinor: 100,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const mockOrdersClient = {
        getOrder: vi.fn().mockResolvedValue({
          id: orderId,
          status: 'COMPLETED',
          purchase_units: [
            {
              amount: { currency_code: 'USD', value: '1.00' },
              payments: { captures: [] }, // No captures provided!
            },
          ],
        }),
      } as unknown as PayPalOrdersClient;

      const provider = new PayPalPaymentProvider({
        clientId: 'id',
        clientSecret: 'secret',
        repository,
        ordersClient: mockOrdersClient,
      });

      const result = await provider.reconcileOrder(orderId, 'corr-no-capture-evidence');

      expect(result.status).toBe('REQUIRES_REVIEW');
      expect(result.details).toContain(
        'Order cannot transition to COMPLETED without capture evidence',
      );

      // Local state is preserved as APPROVED
      const stored = await repository.getOrderById(orderId);
      expect(stored?.status).toBe('APPROVED');
    });

    it('authoritative completed capture with valid capture details transitions to COMPLETED', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const orderId = 'ORD-RECON-VALID-CAPTURE';

      await repository.createOrder({
        id: orderId,
        proposalId: uuidv4(),
        policyDecisionId: uuidv4(),
        provider: 'paypal_sandbox',
        status: 'APPROVED',
        currency: 'USD',
        amountMinor: 100,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const mockOrdersClient = {
        getOrder: vi.fn().mockResolvedValue({
          id: orderId,
          status: 'COMPLETED',
          purchase_units: [
            {
              amount: { currency_code: 'USD', value: '1.00' },
              payments: {
                captures: [
                  {
                    id: 'CAP-AUTHORITATIVE-999',
                    create_time: '2026-10-25T11:30:00Z',
                  },
                ],
              },
            },
          ],
        }),
      } as unknown as PayPalOrdersClient;

      const provider = new PayPalPaymentProvider({
        clientId: 'id',
        clientSecret: 'secret',
        repository,
        ordersClient: mockOrdersClient,
      });

      const result = await provider.reconcileOrder(orderId, 'corr-valid-capture');

      expect(result.status).toBe('UPDATED');
      expect(result.previousOrderStatus).toBe('APPROVED');
      expect(result.currentOrderStatus).toBe('COMPLETED');

      // Local order updated to COMPLETED with captureId
      const stored = await repository.getOrderById(orderId);
      expect(stored?.status).toBe('COMPLETED');
      expect(stored?.captureId).toBe('CAP-AUTHORITATIVE-999');
    });

    it('Invariant G: reconciliation NEVER invokes captureOrder or creates orders', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const orderId = 'ORD-INVARIANT-G';

      await repository.createOrder({
        id: orderId,
        proposalId: uuidv4(),
        policyDecisionId: uuidv4(),
        provider: 'paypal_sandbox',
        status: 'APPROVED',
        currency: 'USD',
        amountMinor: 100,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const captureSpy = vi.fn().mockImplementation(() => {
        throw new Error(
          'FATAL INVARIANT G VIOLATION: captureOrder must NEVER be called by reconciliation!',
        );
      });
      const createSpy = vi.fn().mockImplementation(() => {
        throw new Error(
          'FATAL INVARIANT G VIOLATION: createOrder must NEVER be called by reconciliation!',
        );
      });

      const mockOrdersClient = {
        getOrder: vi.fn().mockResolvedValue({
          id: orderId,
          status: 'APPROVED',
          purchase_units: [{ amount: { currency_code: 'USD', value: '1.00' } }],
        }),
        captureOrder: captureSpy,
        createOrder: createSpy,
      } as unknown as PayPalOrdersClient;

      const provider = new PayPalPaymentProvider({
        clientId: 'id',
        clientSecret: 'secret',
        repository,
        ordersClient: mockOrdersClient,
      });

      const result = await provider.reconcileOrder(orderId, 'corr-invariant-g');
      expect(result.status).toBe('UNCHANGED');

      expect(captureSpy).toHaveBeenCalledTimes(0);
      expect(createSpy).toHaveBeenCalledTimes(0);
    });
  });

  // =========================================================================
  // 5. HTTP Reconciliation Endpoint Verification
  // =========================================================================
  describe('HTTP POST /orders/:id/reconcile Endpoint', () => {
    it('successfully exposes order reconciliation via Fastify route', async () => {
      const repository = new InMemoryPaymentOrderRepository();
      const orderId = 'ORD-HTTP-RECON';

      await repository.createOrder({
        id: orderId,
        proposalId: uuidv4(),
        policyDecisionId: uuidv4(),
        provider: 'mock',
        status: 'UNKNOWN',
        currency: 'USD',
        amountMinor: 100,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const app = buildApp(
        new MockPaymentProvider(repository),
        { paymentsEnabled: false },
        repository,
      );

      const res = await app.inject({
        method: 'POST',
        url: `/orders/${orderId}/reconcile`,
        headers: {
          'x-correlation-id': 'corr-http-recon-01',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.orderId).toBe(orderId);
      expect(body.status).toBe('UPDATED');
      expect(body.currentOrderStatus).toBe('COMPLETED');
    });
  });
});
