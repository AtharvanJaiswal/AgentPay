import { describe, it, expect, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ServiceClient } from '../src/client.js';
import { createMockProposal, createMockPolicyDecision } from '@agentpay/test-utils';
import { ErrorCodes } from '@agentpay/contracts';

describe('API Gateway', () => {
  it('GET /api/status returns mock status and sandbox unconfigured banner info', async () => {
    const mockClient = {
      checkServiceHealth: vi.fn().mockResolvedValue({ status: 'ok' }),
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
    expect(body.providerStatus.paypalSandboxConfigured).toBe(false);
    expect(body.providerStatus.statusLabel).toContain('Sandbox not configured');
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
});
