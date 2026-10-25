import { describe, it, expect, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ServiceClient } from '../src/client.js';
import type { ApiGatewayConfig } from '@agentpay/config';
import {
  ErrorCodes,
  type StoredPurchaseProposal,
  type PurchaseIntentParseResult,
  type PolicyDecision,
} from '@agentpay/contracts';
import {
  ProductionPendingAuthenticationProvider,
  DevelopmentAuthenticationProvider,
} from '../src/auth.js';

describe('Purchase Intent Orchestration (Phase 3A - Increments 5 & 6)', () => {
  const defaultCorrelationId = 'corr-p3a-test-001';
  const principalId = 'dev-user-principal-01';

  it('valid intent executes end-to-end: agent parse -> catalog resolution -> policy ALLOW -> durable proposal READY_FOR_REVIEW', async () => {
    const mockParsedResult: PurchaseIntentParseResult = {
      status: 'PARSED',
      intent: {
        schemaVersion: 1,
        requestId: 'req-12345',
        idempotencyKey: 'idem-valid-001',
        intent: {
          action: 'purchase',
          productQuery: 'notebook',
          merchantPreference: undefined,
          quantity: 2,
          constraints: {
            maxUnitPriceMinor: 1000,
            maxTotalMinor: 2000,
            currency: 'USD',
          },
        },
        context: {
          source: 'user',
          locale: 'en-US',
        },
      },
    };

    const mockPolicyDecision: PolicyDecision = {
      decisionId: 'dec-allow-001',
      proposalId: 'prop-temp-id',
      outcome: 'ALLOW',
      reasonCode: 'ALLOW_WITHIN_LIMITS',
      reasonMessage: 'Purchase within allowed limits',
      timestamp: new Date().toISOString(),
    };

    const mockPersistProposal = vi
      .fn()
      .mockImplementation(async (proposal: StoredPurchaseProposal) => ({
        ...proposal,
      }));

    const mockParseIntent = vi.fn().mockResolvedValue(mockParsedResult);
    const mockEvaluatePolicy = vi.fn().mockResolvedValue(mockPolicyDecision);
    const mockRecordAuditEvent = vi.fn().mockResolvedValue(null);
    const mockCreatePaymentOrder = vi.fn();
    const mockCapturePaymentOrder = vi.fn();

    const mockClient = {
      parseIntent: mockParseIntent,
      evaluatePolicy: mockEvaluatePolicy,
      persistProposal: mockPersistProposal,
      recordAuditEvent: mockRecordAuditEvent,
      createPaymentOrder: mockCreatePaymentOrder,
      capturePaymentOrder: mockCapturePaymentOrder,
    } as unknown as ServiceClient;

    const app = buildApp(mockClient);

    const res = await app.inject({
      method: 'POST',
      url: '/api/purchase-intents',
      headers: {
        'x-correlation-id': defaultCorrelationId,
        'x-principal-id': principalId,
      },
      payload: {
        rawIntent: 'Buy 2 notebooks',
        idempotencyKey: 'idem-valid-001',
      },
    });

    // HTTP 201 Created
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.outcome).toBe('PROPOSAL_CREATED');
    expect(body.message).toContain('ready for user review');
    expect(body.proposal.status).toBe('READY_FOR_REVIEW');
    expect(body.proposal.productName).toBe('A5 Spiral Notebook');
    expect(body.proposal.quantity).toBe(2);
    expect(body.proposal.unitPriceMinor).toBe(500);
    expect(body.proposal.subtotalMinor).toBe(1000);
    expect(body.proposal.totalAmountMinor).toBe(1000);
    expect(body.proposal.currency).toBe('USD');
    expect(body.policyDecision.outcome).toBe('ALLOW');

    // Downstream service assertions
    expect(mockParseIntent).toHaveBeenCalledWith(
      'Buy 2 notebooks',
      defaultCorrelationId,
      expect.objectContaining({
        idempotencyKey: 'idem-valid-001',
        principalId,
      }),
    );
    expect(mockEvaluatePolicy).toHaveBeenCalledTimes(1);
    expect(mockPersistProposal).toHaveBeenCalledTimes(1);

    // Audit assertions: INTENT_RECEIVED and PROPOSAL_READY_FOR_REVIEW
    expect(mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'INTENT_RECEIVED',
        outcome: 'RECEIVED',
      }),
      defaultCorrelationId,
    );
    expect(mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'PROPOSAL_READY_FOR_REVIEW',
        outcome: 'READY_FOR_REVIEW',
      }),
      defaultCorrelationId,
    );

    // CRITICAL SECURITY INVARIANT: Zero payment provider interactions
    expect(mockCreatePaymentOrder).toHaveBeenCalledTimes(0);
    expect(mockCapturePaymentOrder).toHaveBeenCalledTimes(0);
  });

  it('ambiguous intent stops at agent stage and returns CLARIFICATION_REQUIRED with zero policy or proposal calls', async () => {
    const mockParsedResult: PurchaseIntentParseResult = {
      status: 'NEEDS_CLARIFICATION',
      reason: 'Product query is ambiguous or missing',
      question: 'What product would you like to purchase?',
      rawInput: 'Buy it',
    };

    const mockParseIntent = vi.fn().mockResolvedValue(mockParsedResult);
    const mockEvaluatePolicy = vi.fn();
    const mockPersistProposal = vi.fn();
    const mockRecordAuditEvent = vi.fn().mockResolvedValue(null);

    const mockClient = {
      parseIntent: mockParseIntent,
      evaluatePolicy: mockEvaluatePolicy,
      persistProposal: mockPersistProposal,
      recordAuditEvent: mockRecordAuditEvent,
    } as unknown as ServiceClient;

    const app = buildApp(mockClient);

    const res = await app.inject({
      method: 'POST',
      url: '/api/purchase-intents',
      payload: {
        rawIntent: 'Buy it',
        idempotencyKey: 'idem-ambig-001',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.outcome).toBe('CLARIFICATION_REQUIRED');
    expect(body.question).toBe('What product would you like to purchase?');

    expect(mockParseIntent).toHaveBeenCalledTimes(1);
    expect(mockEvaluatePolicy).toHaveBeenCalledTimes(0);
    expect(mockPersistProposal).toHaveBeenCalledTimes(0);
    expect(mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'INTENT_CLARIFICATION_REQUIRED',
        outcome: 'CLARIFICATION_REQUIRED',
      }),
      expect.any(String),
    );
  });

  it('unsupported intent stops at agent stage and returns UNSUPPORTED_INTENT', async () => {
    const mockParsedResult: PurchaseIntentParseResult = {
      status: 'UNSUPPORTED_INTENT',
      reason: 'Action not supported: cancel',
      rawInput: 'Cancel my subscription',
    };

    const mockParseIntent = vi.fn().mockResolvedValue(mockParsedResult);
    const mockEvaluatePolicy = vi.fn();
    const mockPersistProposal = vi.fn();
    const mockRecordAuditEvent = vi.fn().mockResolvedValue(null);

    const mockClient = {
      parseIntent: mockParseIntent,
      evaluatePolicy: mockEvaluatePolicy,
      persistProposal: mockPersistProposal,
      recordAuditEvent: mockRecordAuditEvent,
    } as unknown as ServiceClient;

    const app = buildApp(mockClient);

    const res = await app.inject({
      method: 'POST',
      url: '/api/purchase-intents',
      payload: {
        rawIntent: 'Cancel my subscription',
        idempotencyKey: 'idem-unsupported-001',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.outcome).toBe('UNSUPPORTED_INTENT');
    expect(mockEvaluatePolicy).toHaveBeenCalledTimes(0);
    expect(mockPersistProposal).toHaveBeenCalledTimes(0);
  });

  it('unresolved catalog item returns SELECTION_REQUIRED without policy or proposal creation', async () => {
    const mockParsedResult: PurchaseIntentParseResult = {
      status: 'PARSED',
      intent: {
        schemaVersion: 1,
        requestId: 'req-unresolved-1',
        idempotencyKey: 'idem-unres-001',
        intent: {
          action: 'purchase',
          productQuery: 'quantum flux capacitor 9000',
          quantity: 1,
        },
        context: { source: 'user' },
      },
    };

    const mockParseIntent = vi.fn().mockResolvedValue(mockParsedResult);
    const mockEvaluatePolicy = vi.fn();
    const mockPersistProposal = vi.fn();
    const mockRecordAuditEvent = vi.fn().mockResolvedValue(null);

    const mockClient = {
      parseIntent: mockParseIntent,
      evaluatePolicy: mockEvaluatePolicy,
      persistProposal: mockPersistProposal,
      recordAuditEvent: mockRecordAuditEvent,
    } as unknown as ServiceClient;

    const app = buildApp(mockClient);

    const res = await app.inject({
      method: 'POST',
      url: '/api/purchase-intents',
      payload: {
        rawIntent: 'Buy a quantum flux capacitor 9000',
        idempotencyKey: 'idem-unres-001',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.outcome).toBe('SELECTION_REQUIRED');
    expect(body.reason).toContain('could not be resolved from authoritative catalog');
    expect(mockEvaluatePolicy).toHaveBeenCalledTimes(0);
    expect(mockPersistProposal).toHaveBeenCalledTimes(0);
  });

  it('policy DENY rejects request with 403 and never persists proposal as executable', async () => {
    const mockParsedResult: PurchaseIntentParseResult = {
      status: 'PARSED',
      intent: {
        schemaVersion: 1,
        requestId: 'req-denied-1',
        idempotencyKey: 'idem-deny-001',
        intent: {
          action: 'purchase',
          productQuery: 'notebook',
          quantity: 500, // Large quantity exceeding limits
        },
        context: { source: 'user' },
      },
    };

    const mockDeniedDecision: PolicyDecision = {
      decisionId: 'dec-deny-001',
      proposalId: 'prop-temp-deny',
      outcome: 'DENY',
      reasonCode: 'DENY_EXCEEDS_HARD_LIMIT',
      reasonMessage: 'Purchase amount exceeds hard limit of $2000.00',
      timestamp: new Date().toISOString(),
    };

    const mockParseIntent = vi.fn().mockResolvedValue(mockParsedResult);
    const mockEvaluatePolicy = vi.fn().mockResolvedValue(mockDeniedDecision);
    const mockPersistProposal = vi.fn();
    const mockRecordAuditEvent = vi.fn().mockResolvedValue(null);

    const mockClient = {
      parseIntent: mockParseIntent,
      evaluatePolicy: mockEvaluatePolicy,
      persistProposal: mockPersistProposal,
      recordAuditEvent: mockRecordAuditEvent,
    } as unknown as ServiceClient;

    const app = buildApp(mockClient);

    const res = await app.inject({
      method: 'POST',
      url: '/api/purchase-intents',
      payload: {
        rawIntent: 'Buy 500 notebooks',
        idempotencyKey: 'idem-deny-001',
      },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.outcome).toBe('POLICY_DENIED');
    expect(body.policyDecision.outcome).toBe('DENY');
    expect(mockPersistProposal).toHaveBeenCalledTimes(0);
    expect(mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'PROPOSAL_POLICY_DENIED',
        outcome: 'DENY',
        reasonCode: 'DENY_EXCEEDS_HARD_LIMIT',
      }),
      expect.any(String),
    );
  });

  it('policy REQUIRE_APPROVAL persists proposal with POLICY_REVIEW_REQUIRED status (200 OK)', async () => {
    // Ergonomic Chair is $180 (18000 minor units). 4 chairs = $720, which is > $500 approval threshold
    const mockParsedResult: PurchaseIntentParseResult = {
      status: 'PARSED',
      intent: {
        schemaVersion: 1,
        requestId: 'req-review-1',
        idempotencyKey: 'idem-review-001',
        intent: {
          action: 'purchase',
          productQuery: 'ergonomic chair',
          quantity: 4,
        },
        context: { source: 'user' },
      },
    };

    const mockReviewDecision: PolicyDecision = {
      decisionId: 'dec-review-001',
      proposalId: 'prop-temp-review',
      outcome: 'REQUIRE_APPROVAL',
      reasonCode: 'REQUIRE_APPROVAL_AMOUNT_THRESHOLD',
      reasonMessage: 'Amount exceeds automatic approval threshold of $500.00',
      timestamp: new Date().toISOString(),
    };

    const mockPersistProposal = vi
      .fn()
      .mockImplementation(async (proposal: StoredPurchaseProposal) => ({
        ...proposal,
      }));

    const mockParseIntent = vi.fn().mockResolvedValue(mockParsedResult);
    const mockEvaluatePolicy = vi.fn().mockResolvedValue(mockReviewDecision);
    const mockRecordAuditEvent = vi.fn().mockResolvedValue(null);

    const mockClient = {
      parseIntent: mockParseIntent,
      evaluatePolicy: mockEvaluatePolicy,
      persistProposal: mockPersistProposal,
      recordAuditEvent: mockRecordAuditEvent,
    } as unknown as ServiceClient;

    const app = buildApp(mockClient);

    const res = await app.inject({
      method: 'POST',
      url: '/api/purchase-intents',
      payload: {
        rawIntent: 'Buy 4 ergonomic chairs',
        idempotencyKey: 'idem-review-001',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.outcome).toBe('POLICY_REVIEW_REQUIRED');
    expect(body.proposal.status).toBe('POLICY_REVIEW_REQUIRED');
    expect(body.policyDecision.outcome).toBe('REQUIRE_APPROVAL');
    expect(mockPersistProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'POLICY_REVIEW_REQUIRED',
      }),
      expect.any(String),
    );
  });

  it('idempotency conflict is returned when same key is reused with different canonical request', async () => {
    const mockParsedResult: PurchaseIntentParseResult = {
      status: 'PARSED',
      intent: {
        schemaVersion: 1,
        requestId: 'req-conflict-1',
        idempotencyKey: 'idem-reused-key',
        intent: {
          action: 'purchase',
          productQuery: 'mouse',
          quantity: 1,
        },
        context: { source: 'user' },
      },
    };

    const mockPolicyDecision: PolicyDecision = {
      decisionId: 'dec-allow-conflict',
      proposalId: 'prop-conflict-temp',
      outcome: 'ALLOW',
      reasonCode: 'ALLOW_WITHIN_LIMITS',
      reasonMessage: 'OK',
      timestamp: new Date().toISOString(),
    };

    const conflictErr = Object.assign(
      new Error('Idempotency conflict: key was previously used with different intent payload'),
      {
        code: 'IDEMPOTENCY_CONFLICT',
        statusCode: 409,
      },
    );

    const mockParseIntent = vi.fn().mockResolvedValue(mockParsedResult);
    const mockEvaluatePolicy = vi.fn().mockResolvedValue(mockPolicyDecision);
    const mockPersistProposal = vi.fn().mockRejectedValue(conflictErr);
    const mockRecordAuditEvent = vi.fn().mockResolvedValue(null);

    const mockClient = {
      parseIntent: mockParseIntent,
      evaluatePolicy: mockEvaluatePolicy,
      persistProposal: mockPersistProposal,
      recordAuditEvent: mockRecordAuditEvent,
    } as unknown as ServiceClient;

    const app = buildApp(mockClient);

    const res = await app.inject({
      method: 'POST',
      url: '/api/purchase-intents',
      payload: {
        rawIntent: 'Buy 1 mouse',
        idempotencyKey: 'idem-reused-key',
      },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('downstream agent service failure returns 502 with structured error and correlation ID', async () => {
    const mockParseIntent = vi
      .fn()
      .mockRejectedValue(new Error('Agent service connection timed out'));
    const mockClient = {
      parseIntent: mockParseIntent,
      recordAuditEvent: vi.fn().mockResolvedValue(null),
    } as unknown as ServiceClient;

    const app = buildApp(mockClient);

    const res = await app.inject({
      method: 'POST',
      url: '/api/purchase-intents',
      headers: {
        'x-correlation-id': 'corr-downstream-timeout',
      },
      payload: {
        rawIntent: 'Buy 1 notebook',
        idempotencyKey: 'idem-timeout-1',
      },
    });

    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(ErrorCodes.SERVICE_UNAVAILABLE);
    expect(body.error.correlationId).toBe('corr-downstream-timeout');
  });

  it('GET /api/purchase-intents/:id enforces principal ownership', async () => {
    const mockProposal: StoredPurchaseProposal = {
      id: 'prop-secure-001',
      requestId: 'req-001',
      idempotencyKey: 'idem-sec-001',
      idempotencyScope: 'user:alice',
      requestHash: 'hash123',
      status: 'READY_FOR_REVIEW',
      productQuery: 'notebook',
      productId: 'prod-notebook-01',
      productName: 'A5 Spiral Notebook',
      merchantId: 'merch-acme-office',
      merchantName: 'Acme Office Supplies',
      merchantCategory: 'office_supplies',
      quantity: 1,
      currency: 'USD',
      unitPriceMinor: 500,
      subtotalMinor: 500,
      taxMinor: 0,
      shippingMinor: 0,
      totalAmountMinor: 500,
      policyDecisionId: 'dec-sec-001',
      policyOutcome: 'ALLOW',
      policyReasonCode: 'ALLOW_WITHIN_LIMITS',
      principalId: 'user:alice',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const mockGetProposal = vi.fn().mockResolvedValue(mockProposal);
    const mockClient = {
      getProposal: mockGetProposal,
    } as unknown as ServiceClient;

    const app = buildApp(mockClient);

    // Request from alice -> 200 OK
    const resAlice = await app.inject({
      method: 'GET',
      url: '/api/purchase-intents/prop-secure-001',
      headers: {
        'x-principal-id': 'user:alice',
      },
    });
    expect(resAlice.statusCode).toBe(200);
    expect(JSON.parse(resAlice.body).id).toBe('prop-secure-001');

    // Request from bob -> 403 Forbidden
    const resBob = await app.inject({
      method: 'GET',
      url: '/api/purchase-intents/prop-secure-001',
      headers: {
        'x-principal-id': 'user:bob',
      },
    });
    expect(resBob.statusCode).toBe(403);
    const bobBody = JSON.parse(resBob.body);
    expect(bobBody.error.code).toBe(ErrorCodes.FORBIDDEN);
    expect(bobBody.error.message).toContain('Access to purchase proposal denied for principal');
  });

  it('idempotent replay returns existing proposal seamlessly when identical request is submitted', async () => {
    const existingProposal: StoredPurchaseProposal = {
      id: 'prop-original-001',
      requestId: 'req-original-1',
      idempotencyKey: 'idem-replay-001',
      idempotencyScope: 'principal:dev-user-principal-01',
      requestHash: 'hash-replay-001',
      status: 'READY_FOR_REVIEW',
      productQuery: 'notebook',
      productId: 'sku-office-notebook',
      productName: 'A5 Spiral Notebook',
      merchantId: 'merch-acme-office',
      merchantName: 'Acme Office Supplies',
      merchantCategory: 'office_supplies',
      quantity: 1,
      currency: 'USD',
      unitPriceMinor: 500,
      subtotalMinor: 500,
      taxMinor: 0,
      shippingMinor: 0,
      totalAmountMinor: 500,
      policyDecisionId: 'dec-allow-001',
      policyOutcome: 'ALLOW',
      policyReasonCode: 'ALLOW_WITHIN_LIMITS',
      principalId: 'dev-user-principal-01',
      createdAt: '2026-10-25T07:00:00.000Z',
      updatedAt: '2026-10-25T07:00:00.000Z',
    };

    const mockParsedResult: PurchaseIntentParseResult = {
      status: 'PARSED',
      intent: {
        schemaVersion: 1,
        requestId: 'req-retry-1',
        idempotencyKey: 'idem-replay-001',
        intent: {
          action: 'purchase',
          productQuery: 'notebook',
          quantity: 1,
        },
        context: { source: 'user' },
      },
    };

    const mockPolicyDecision: PolicyDecision = {
      decisionId: 'dec-allow-retry',
      proposalId: 'prop-temp-retry',
      outcome: 'ALLOW',
      reasonCode: 'ALLOW_WITHIN_LIMITS',
      reasonMessage: 'OK',
      timestamp: new Date().toISOString(),
    };

    // The proposal repository returns the original existingProposal
    const mockPersistProposal = vi.fn().mockResolvedValue(existingProposal);
    const mockParseIntent = vi.fn().mockResolvedValue(mockParsedResult);
    const mockEvaluatePolicy = vi.fn().mockResolvedValue(mockPolicyDecision);
    const mockRecordAuditEvent = vi.fn().mockResolvedValue(null);

    const mockClient = {
      parseIntent: mockParseIntent,
      evaluatePolicy: mockEvaluatePolicy,
      persistProposal: mockPersistProposal,
      recordAuditEvent: mockRecordAuditEvent,
    } as unknown as ServiceClient;

    const app = buildApp(mockClient);

    const res = await app.inject({
      method: 'POST',
      url: '/api/purchase-intents',
      payload: {
        rawIntent: 'Buy 1 notebook',
        idempotencyKey: 'idem-replay-001',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.proposal.id).toBe('prop-original-001');
    expect(body.proposal.createdAt).toBe('2026-10-25T07:00:00.000Z');
  });

  describe('Security Boundaries, Authentication & Identity Invariants (SEC-FINDING-01 & SEC-FINDING-05)', () => {
    const prodConfig = {
      NODE_ENV: 'production' as const,
      LOG_LEVEL: 'info' as const,
      PORT: 4000,
      HOST: '0.0.0.0',
      AGENT_SERVICE_URL: 'http://agent-service:4001',
      POLICY_SERVICE_URL: 'http://policy-service:4002',
      PAYMENT_SERVICE_URL: 'http://payment-service:4003',
      AUDIT_SERVICE_URL: 'http://audit-service:4004',
      APP_BASE_URL: 'https://agentpay.example.com',
      RATE_LIMIT_MAX: 100,
      RATE_LIMIT_WINDOW_MS: 60000,
      REQUEST_TIMEOUT_MS: 10000,
      ALLOW_DEV_IDENTITY: false,
    } as ApiGatewayConfig;

    it('PROVABLY ensures production mode fails closed with 401 UNAUTHORIZED when no credentials provided', async () => {
      const mockClient = {
        parseIntent: vi.fn(),
      } as unknown as ServiceClient;

      // Production app with ProductionPendingAuthenticationProvider
      const app = buildApp(mockClient, prodConfig, new ProductionPendingAuthenticationProvider());

      const res = await app.inject({
        method: 'POST',
        url: '/api/purchase-intents',
        payload: {
          rawIntent: 'Buy 1 notebook',
          idempotencyKey: 'idem-prod-unauth-01',
        },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(ErrorCodes.UNAUTHORIZED);
      expect(body.error.message).toContain('Authentication required');
      // Downstream agent service was NEVER called
      expect(mockClient.parseIntent).toHaveBeenCalledTimes(0);
    });

    it('PROVABLY ensures production mode REJECTS caller-supplied x-principal-id as unauthenticated', async () => {
      const mockClient = {
        parseIntent: vi.fn(),
      } as unknown as ServiceClient;

      const app = buildApp(mockClient, prodConfig, new ProductionPendingAuthenticationProvider());

      // Attacker attempts to spoof identity by sending x-principal-id
      const res = await app.inject({
        method: 'POST',
        url: '/api/purchase-intents',
        headers: {
          'x-principal-id': 'victim-user-alice',
        },
        payload: {
          rawIntent: 'Buy 1 notebook',
          idempotencyKey: 'idem-spoof-01',
        },
      });

      // Must be rejected with 401 UNAUTHORIZED, NOT accepted!
      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(ErrorCodes.UNAUTHORIZED);
      expect(mockClient.parseIntent).toHaveBeenCalledTimes(0);
    });

    it('production mode GET /api/purchase-intents/:id fails closed with 401 UNAUTHORIZED', async () => {
      const mockClient = {
        getProposal: vi.fn(),
      } as unknown as ServiceClient;

      const app = buildApp(mockClient, prodConfig, new ProductionPendingAuthenticationProvider());

      const res = await app.inject({
        method: 'GET',
        url: '/api/purchase-intents/some-proposal-id',
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(ErrorCodes.UNAUTHORIZED);
      expect(mockClient.getProposal).toHaveBeenCalledTimes(0);
    });

    it('strictly rejects request body attempting to inject principalId with 400 VALIDATION_ERROR', async () => {
      const mockClient = {
        parseIntent: vi.fn(),
      } as unknown as ServiceClient;

      const app = buildApp(mockClient);

      const res = await app.inject({
        method: 'POST',
        url: '/api/purchase-intents',
        payload: {
          rawIntent: 'Buy 1 notebook',
          idempotencyKey: 'idem-body-injection-01',
          principalId: 'injected-attacker-id', // Prohibited by strict schema
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
      expect(mockClient.parseIntent).toHaveBeenCalledTimes(0);
    });

    it('development adapter rejects requests when ALLOW_DEV_IDENTITY is false', async () => {
      const devDisabledConfig = {
        ...prodConfig,
        NODE_ENV: 'development' as const,
        ALLOW_DEV_IDENTITY: false,
      };

      const mockClient = {
        parseIntent: vi.fn(),
      } as unknown as ServiceClient;

      const app = buildApp(
        mockClient,
        devDisabledConfig,
        new DevelopmentAuthenticationProvider(devDisabledConfig),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/purchase-intents',
        payload: {
          rawIntent: 'Buy 1 notebook',
          idempotencyKey: 'idem-dev-disabled-01',
        },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(ErrorCodes.UNAUTHORIZED);
    });

    it('development adapter accepts development identity when ALLOW_DEV_IDENTITY is true', async () => {
      const devEnabledConfig = {
        ...prodConfig,
        NODE_ENV: 'development' as const,
        ALLOW_DEV_IDENTITY: true,
      };

      const mockClient = {
        parseIntent: vi.fn().mockResolvedValue({
          status: 'PARSED',
          intent: {
            schemaVersion: 1,
            requestId: 'req-dev-01',
            idempotencyKey: 'idem-dev-01',
            intent: { action: 'purchase', productQuery: 'notebook', quantity: 1 },
            context: { source: 'user' },
          },
        }),
        evaluatePolicy: vi.fn().mockResolvedValue({
          decisionId: 'dec-dev-01',
          outcome: 'ALLOW',
          reasonCode: 'ALLOW_WITHIN_LIMITS',
          reasonMessage: 'OK',
          timestamp: new Date().toISOString(),
        }),
        persistProposal: vi.fn().mockImplementation(async (p) => p),
        recordAuditEvent: vi.fn().mockResolvedValue(null),
      } as unknown as ServiceClient;

      const app = buildApp(
        mockClient,
        devEnabledConfig,
        new DevelopmentAuthenticationProvider(devEnabledConfig),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/purchase-intents',
        headers: {
          'x-principal-id': 'custom-dev-user-42',
        },
        payload: {
          rawIntent: 'Buy 1 notebook',
          idempotencyKey: 'idem-dev-01',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.proposal.principalId).toBe('custom-dev-user-42');
    });

    it('safely rejects numeric arithmetic overflow with 400 VALIDATION_ERROR without integer corruption', async () => {
      const mockClient = {
        parseIntent: vi.fn().mockResolvedValue({
          status: 'PARSED',
          intent: {
            schemaVersion: 1,
            requestId: 'req-overflow-01',
            idempotencyKey: 'idem-overflow-01',
            intent: {
              action: 'purchase',
              productQuery: 'notebook',
              // Force unsafe integer quantity beyond safe representation
              quantity: Number.MAX_SAFE_INTEGER,
            },
            context: { source: 'user' },
          },
        }),
        recordAuditEvent: vi.fn().mockResolvedValue(null),
      } as unknown as ServiceClient;

      const app = buildApp(mockClient);

      const res = await app.inject({
        method: 'POST',
        url: '/api/purchase-intents',
        payload: {
          rawIntent: 'Buy 9007199254740991 notebooks',
          idempotencyKey: 'idem-overflow-01',
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
      expect(body.error.message).toContain('overflow');
    });
  });
});
