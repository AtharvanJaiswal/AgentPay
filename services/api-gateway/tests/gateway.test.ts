import { describe, it, expect, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ServiceClient } from '../src/client.js';
import { createMockProposal, createMockPolicyDecision } from '@agentpay/test-utils';
import { ErrorCodes } from '@agentpay/contracts';

describe('API Gateway', () => {
  it('GET /api/status returns mock status and sandbox unconfigured banner info', async () => {
    const mockClient = {
      checkServiceHealth: vi.fn().mockResolvedValue({
        status: 'ok',
        details: {
          provider: 'MOCK/DEVELOPMENT',
          isMock: true,
          paymentsEnabled: false,
          oauthConfigured: false,
        },
      }),
    } as unknown as ServiceClient;

    const app = buildApp(mockClient);
    const res = await app.inject({
      method: 'GET',
      url: '/api/status',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.platform).toBe('AgentPay');
    expect(body.providerStatus.activeProvider).toBe('MOCK/DEVELOPMENT');
    expect(body.providerStatus.isMock).toBe(true);
    expect(body.providerStatus.paypalSandboxConfigured).toBe(false);
    expect(body.providerStatus.statusLabel).toContain('Sandbox not configured');
    expect(body.providerStatus.paymentsEnabled).toBe(false);
  });

  it('GET /api/status dynamically reflects PayPal Sandbox provider when active', async () => {
    const mockClient = {
      checkServiceHealth: vi.fn().mockResolvedValue({
        status: 'ok',
        details: {
          provider: 'PayPal Sandbox',
          isMock: false,
          paymentsEnabled: false,
          oauthConfigured: true,
        },
      }),
    } as unknown as ServiceClient;

    const app = buildApp(mockClient);
    const res = await app.inject({
      method: 'GET',
      url: '/api/status',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.providerStatus.activeProvider).toBe('PayPal Sandbox');
    expect(body.providerStatus.isMock).toBe(false);
    expect(body.providerStatus.paypalSandboxConfigured).toBe(true);
    expect(body.providerStatus.statusLabel).toBe('PayPal Sandbox Active (Capture Disabled)');
    expect(body.providerStatus.paymentsEnabled).toBe(false);
    expect(body.providerStatus.warning).toContain('Real payment capture is disabled by default');
  });

  it('GET /api/health reports gateway status and downstream checks', async () => {
    const mockClient = {
      checkServiceHealth: vi.fn().mockResolvedValue({ status: 'ok' }),
    } as unknown as ServiceClient;

    const app = buildApp(mockClient);
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.service).toBe('api-gateway');
    expect(body.status).toBe('ok');
    expect(body.details.downstream.agentService).toBe('ok');
  });

  it('rejects invalid proposal input with 400 validation error', async () => {
    const mockClient = {} as unknown as ServiceClient;
    const app = buildApp(mockClient);

    const res = await app.inject({
      method: 'POST',
      url: '/api/proposals',
      payload: {
        rawIntent: '', // invalid empty
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
  });

  it('PROVABLY ensures a denied policy decision causes ZERO payment-provider calls', async () => {
    const deniedDecision = createMockPolicyDecision({
      outcome: 'DENY',
      reasonCode: 'DENY_EXCEEDS_HARD_LIMIT',
      reasonMessage: 'Purchase amount exceeds hard limit',
    });

    const mockEvaluatePolicy = vi.fn().mockResolvedValue(deniedDecision);
    const mockCreatePaymentOrder = vi.fn(); // Spy to prove zero calls
    const mockRecordAuditEvent = vi.fn().mockResolvedValue(null);

    const mockClient = {
      evaluatePolicy: mockEvaluatePolicy,
      createPaymentOrder: mockCreatePaymentOrder,
      recordAuditEvent: mockRecordAuditEvent,
    } as unknown as ServiceClient;

    const app = buildApp(mockClient);
    const proposal = createMockProposal({ totalAmountMinor: 500000 });

    const res = await app.inject({
      method: 'POST',
      url: '/api/payments/orders',
      payload: {
        proposal,
        policyDecisionId: deniedDecision.decisionId,
      },
    });

    // Gateway must reject with 403 POLICY_VIOLATION
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(ErrorCodes.POLICY_VIOLATION);

    // CRITICAL SECURITY ASSERTION:
    // Policy was evaluated once
    expect(mockEvaluatePolicy).toHaveBeenCalledTimes(1);
    // Payment provider was NEVER called!
    expect(mockCreatePaymentOrder).toHaveBeenCalledTimes(0);

    // Audit event was recorded with PAYMENT_BLOCKED
    expect(mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'PAYMENT_BLOCKED',
        outcome: 'BLOCKED',
        reasonCode: 'DENY_EXCEEDS_HARD_LIMIT',
      }),
      expect.any(String),
    );
  });

  it('GET /api/payments/orders/:id returns order from client', async () => {
    const mockOrder = {
      id: 'ORDER-123',
      proposalId: '11111111-1111-4111-a111-111111111111',
      provider: 'paypal_sandbox' as const,
      status: 'PAYER_ACTION_REQUIRED' as const,
      amountMinor: 2500,
      currency: 'USD' as const,
      isMock: false,
      approvalUrl: 'https://sandbox.paypal.com/checkout?token=123',
      createdAt: new Date().toISOString(),
      environmentNote: 'Sandbox',
    };

    const mockClient = {
      getPaymentOrder: vi.fn().mockResolvedValue(mockOrder),
    } as unknown as ServiceClient;

    const app = buildApp(mockClient);
    const res = await app.inject({
      method: 'GET',
      url: '/api/payments/orders/ORDER-123',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe('ORDER-123');
    expect(body.approvalUrl).toBe('https://sandbox.paypal.com/checkout?token=123');
  });

  it('POST /api/payments/orders/:id/capture captures order and records audit event', async () => {
    const mockCaptureResult = {
      captureId: 'CAPTURE-456',
      orderId: 'ORDER-123',
      status: 'COMPLETED' as const,
      capturedAmountMinor: 2500,
      currency: 'USD' as const,
      isMock: false,
      timestamp: new Date().toISOString(),
      environmentNote: 'Sandbox capture',
    };

    const mockCapturePaymentOrder = vi.fn().mockResolvedValue(mockCaptureResult);
    const mockRecordAuditEvent = vi.fn().mockResolvedValue(null);

    const mockClient = {
      capturePaymentOrder: mockCapturePaymentOrder,
      recordAuditEvent: mockRecordAuditEvent,
    } as unknown as ServiceClient;

    const app = buildApp(mockClient);
    const res = await app.inject({
      method: 'POST',
      url: '/api/payments/orders/ORDER-123/capture',
      payload: {
        policyDecisionId: '33333333-3333-4333-a333-333333333333',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('COMPLETED');
    expect(body.captureId).toBe('CAPTURE-456');
    expect(mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ORDER_CAPTURED',
        resourceId: 'CAPTURE-456',
      }),
      expect.any(String),
    );
  });

  describe('Capture Forwarding & PAYMENTS_DISABLED Propagation (Test Group 4)', () => {
    it('propagates downstream 403 PAYMENTS_DISABLED without converting to success or fallback', async () => {
      const paymentsDisabledError = Object.assign(
        new Error('Payment capture is disabled by configuration'),
        {
          code: ErrorCodes.PAYMENTS_DISABLED,
          statusCode: 403,
        },
      );

      const mockCapturePaymentOrder = vi.fn().mockRejectedValue(paymentsDisabledError);
      const mockRecordAuditEvent = vi.fn();

      const mockClient = {
        capturePaymentOrder: mockCapturePaymentOrder,
        recordAuditEvent: mockRecordAuditEvent,
      } as unknown as ServiceClient;

      const app = buildApp(mockClient);
      const correlationId = 'test-corr-cap-403';

      const res = await app.inject({
        method: 'POST',
        url: '/api/payments/orders/1MS29453RW109660R/capture',
        headers: {
          'x-correlation-id': correlationId,
        },
        payload: {
          policyDecisionId: '33333333-3333-4333-a333-333333333333',
        },
      });

      // Assert status 403
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);

      // Assert error code
      expect(body.error.code).toBe(ErrorCodes.PAYMENTS_DISABLED);
      expect(body.error.message).toBe('Payment capture is disabled by configuration');

      // Assert correlation ID propagation
      expect(body.error.correlationId).toBe(correlationId);
      expect(res.headers['x-correlation-id']).toBe(correlationId);

      // Assert captureOrder was forwarded
      expect(mockCapturePaymentOrder).toHaveBeenCalledWith(
        '1MS29453RW109660R',
        '33333333-3333-4333-a333-333333333333',
        correlationId,
        expect.any(String),
      );

      // CRITICAL: Zero ORDER_CAPTURED audit events recorded
      expect(mockRecordAuditEvent).toHaveBeenCalledTimes(0);

      // Secret leakage prevention check
      const responseText = res.body;
      expect(responseText).not.toContain('secret');
      expect(responseText).not.toContain('Bearer');
      expect(responseText).not.toContain('token');
    });

    it('rejects capture request with 400 when policyDecisionId is missing', async () => {
      const mockCapturePaymentOrder = vi.fn();
      const mockClient = {
        capturePaymentOrder: mockCapturePaymentOrder,
      } as unknown as ServiceClient;

      const app = buildApp(mockClient);
      const res = await app.inject({
        method: 'POST',
        url: '/api/payments/orders/ORDER-123/capture',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
      expect(mockCapturePaymentOrder).toHaveBeenCalledTimes(0);
    });
  });
});
