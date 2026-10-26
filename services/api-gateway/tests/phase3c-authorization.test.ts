import { describe, it, expect, beforeEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { buildApp } from '../src/app.js';
import type { ServiceClient } from '../src/client.js';
import { TestAuthenticationProvider, ProductionPendingAuthenticationProvider } from '../src/auth.js';
import { CatalogResolver } from '../src/catalog/resolver.js';
import { MockProductDiscoveryProvider } from '../src/catalog/provider.js';
import {
  ErrorCodes,
  type PurchaseProposal,
  type StoredPurchaseProposal,
  type CreateAuditEventInput,
  type AuditEvent,
  type ProposalLifecycleStatus,
  isValidProposalStatusTransition,
  InvalidProposalStateTransitionError,
  ForbiddenProposalAccessError,
} from '@agentpay/contracts';
import { getApiGatewayConfig } from '@agentpay/config';

describe('Phase 3C — Human-in-the-Loop Purchase Authorization & Dashboard APIs', () => {
  let mockClient: ServiceClient;
  let recordedAuditEvents: CreateAuditEventInput[];
  let inMemoryProposals: Map<string, StoredPurchaseProposal>;
  let mockDiscoveryProvider: MockProductDiscoveryProvider;
  let catalogResolver: CatalogResolver;
  let paymentSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    recordedAuditEvents = [];
    inMemoryProposals = new Map();
    mockDiscoveryProvider = new MockProductDiscoveryProvider();
    catalogResolver = new CatalogResolver(mockDiscoveryProvider);
    paymentSpy = vi.fn();

    mockClient = {
      recordAuditEvent: async (event: CreateAuditEventInput) => {
        recordedAuditEvents.push(event);
        return {
          id: `aud-${uuidv4()}`,
          timestamp: new Date().toISOString(),
          ...event,
        };
      },
      listAuditEvents: async (limit = 50, correlationId?: string, resourceId?: string) => {
        let events = recordedAuditEvents.map((e) => ({
          id: `aud-${uuidv4()}`,
          timestamp: new Date().toISOString(),
          ...e,
        })) as AuditEvent[];
        if (correlationId) {
          events = events.filter((e) => e.correlationId === correlationId);
        }
        if (resourceId) {
          events = events.filter((e) => e.resourceId === resourceId);
        }
        return events.slice(0, limit);
      },
      parseIntent: async (rawIntent: string, _corrId: string, opts?: { requestId?: string; idempotencyKey?: string }) => {
        return {
          status: 'PARSED',
          rawInput: rawIntent,
          confidence: 0.95,
          intent: {
            schemaVersion: 1,
            requestId: opts?.requestId || 'req-test-uuid',
            idempotencyKey: opts?.idempotencyKey || 'idem-test-key',
            intent: {
              action: 'purchase',
              productQuery: rawIntent.replace(/^(i need to buy|buy|purchase)\s+/i, '').trim(),
              quantity: 1,
            },
            context: {
              source: 'user',
              principalId: 'user-principal-A',
            },
          },
        };
      },
      evaluatePolicy: async (proposal: PurchaseProposal) => {
        if (proposal.totalAmountMinor > 50000) {
          return {
            decisionId: uuidv4(),
            proposalId: proposal.id,
            outcome: 'REQUIRE_APPROVAL',
            reasonCode: 'REQUIRE_APPROVAL_HIGH_VALUE',
            reasonMessage: 'Purchase amount exceeds automatic limit and requires human authorization',
            policyVersion: '1.0.0',
            decisionTimestamp: new Date().toISOString(),
            rulesEvaluated: [],
          };
        }
        return {
          decisionId: uuidv4(),
          proposalId: proposal.id,
          outcome: 'ALLOW',
          reasonCode: 'ALLOW_WITHIN_LIMITS',
          reasonMessage: 'Proposal satisfies spending policies',
          policyVersion: '1.0.0',
          decisionTimestamp: new Date().toISOString(),
          rulesEvaluated: [],
        };
      },
      persistProposal: async (proposal: StoredPurchaseProposal) => {
        inMemoryProposals.set(proposal.id, proposal);
        return proposal;
      },
      getProposal: async (id: string) => {
        return inMemoryProposals.get(id) ?? null;
      },
      listProposals: async (options: { principalId?: string; status?: ProposalLifecycleStatus; limit?: number }) => {
        let list = Array.from(inMemoryProposals.values());
        if (options.principalId) {
          list = list.filter((p) => p.principalId === options.principalId);
        }
        if (options.status) {
          list = list.filter((p) => p.status === options.status);
        }
        list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        if (options.limit) {
          list = list.slice(0, options.limit);
        }
        return list;
      },
      updateProposalStatus: async (
        id: string,
        status: ProposalLifecycleStatus,
        _corrId: string,
        updates?: { expectedPrincipalId?: string; metadata?: Record<string, unknown> },
      ) => {
        const existing = inMemoryProposals.get(id);
        if (!existing) throw new Error(`Proposal ${id} not found`);

        if (updates?.expectedPrincipalId && existing.principalId && existing.principalId !== updates.expectedPrincipalId) {
          throw new ForbiddenProposalAccessError(`Principal not authorized to update proposal`);
        }

        if (!isValidProposalStatusTransition(existing.status, status)) {
          throw new InvalidProposalStateTransitionError(existing.status, status);
        }

        const updated: StoredPurchaseProposal = {
          ...existing,
          status,
          metadata: { ...existing.metadata, ...updates?.metadata },
          updatedAt: new Date().toISOString(),
        };
        inMemoryProposals.set(id, updated);
        return updated;
      },
      createPaymentOrder: async (...args: unknown[]) => {
        paymentSpy(...args);
        throw new Error('PAYMENT EXECUTION VIOLATION: Zero payment executions allowed in Phase 3C');
      },
      capturePaymentOrder: async (...args: unknown[]) => {
        paymentSpy(...args);
        throw new Error('PAYMENT EXECUTION VIOLATION: Zero capture executions allowed in Phase 3C');
      },
    } as unknown as ServiceClient;
  });

  describe('1. Proposal Listing & Principal Ownership Isolation', () => {
    it('rejects unauthenticated requests to list proposals', async () => {
      const app = buildApp(mockClient, getApiGatewayConfig(), new ProductionPendingAuthenticationProvider(), catalogResolver);

      const res = await app.inject({
        method: 'GET',
        url: '/api/purchase-intents',
      });

      expect(res.statusCode).toBe(401);
      const data = JSON.parse(res.payload);
      expect(data.error.code).toBe(ErrorCodes.UNAUTHORIZED);
    });

    it('enforces isolation: Principal A cannot view Principal B proposals', async () => {
      const propA: StoredPurchaseProposal = {
        id: 'prop-A-01',
        requestId: 'req-01',
        idempotencyKey: 'idem-A',
        idempotencyScope: 'principal:user-principal-A',
        requestHash: 'hash-A',
        status: 'READY_FOR_REVIEW',
        productQuery: 'Office Ergonomic Chair',
        productId: 'prod-chair-01',
        productName: 'Ergonomic Task Chair',
        quantity: 1,
        currency: 'USD',
        unitPriceMinor: 25000,
        totalAmountMinor: 25000,
        principalId: 'user-principal-A',
        correlationId: 'corr-A',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const propB: StoredPurchaseProposal = {
        id: 'prop-B-01',
        requestId: 'req-02',
        idempotencyKey: 'idem-B',
        idempotencyScope: 'principal:user-principal-B',
        requestHash: 'hash-B',
        status: 'POLICY_REVIEW_REQUIRED',
        productQuery: 'Developer Laptop',
        productId: 'prod-laptop-01',
        productName: 'Ultra Developer Workstation',
        quantity: 1,
        currency: 'USD',
        unitPriceMinor: 150000,
        totalAmountMinor: 150000,
        principalId: 'user-principal-B',
        correlationId: 'corr-B',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      inMemoryProposals.set(propA.id, propA);
      inMemoryProposals.set(propB.id, propB);

      const app = buildApp(
        mockClient,
        getApiGatewayConfig(),
        new TestAuthenticationProvider(),
        catalogResolver,
      );

      // Request as Principal A
      const resA = await app.inject({
        method: 'GET',
        url: '/api/purchase-intents',
        headers: { 'x-principal-id': 'user-principal-A' },
      });

      expect(resA.statusCode).toBe(200);
      const listA = JSON.parse(resA.payload);
      expect(listA).toHaveLength(1);
      expect(listA[0].id).toBe('prop-A-01');
      expect(listA[0].principalId).toBe('user-principal-A');

      // Request as Principal B
      const resB = await app.inject({
        method: 'GET',
        url: '/api/purchase-intents',
        headers: { 'x-principal-id': 'user-principal-B' },
      });

      expect(resB.statusCode).toBe(200);
      const listB = JSON.parse(resB.payload);
      expect(listB).toHaveLength(1);
      expect(listB[0].id).toBe('prop-B-01');
      expect(listB[0].principalId).toBe('user-principal-B');

      // Principal A attempting to access Principal B proposal by direct ID -> 403 Forbidden
      const resDetailAtoB = await app.inject({
        method: 'GET',
        url: '/api/purchase-intents/prop-B-01',
        headers: { 'x-principal-id': 'user-principal-A' },
      });
      expect(resDetailAtoB.statusCode).toBe(403);
      expect(JSON.parse(resDetailAtoB.payload).error.code).toBe(ErrorCodes.FORBIDDEN);
    });

    it('filters proposals by lifecycle status', async () => {
      const prop1: StoredPurchaseProposal = {
        id: 'prop-review-01',
        requestId: 'req-01',
        idempotencyKey: 'idem-1',
        idempotencyScope: 'principal:user-principal-A',
        requestHash: 'hash-1',
        status: 'READY_FOR_REVIEW',
        productQuery: 'Keyboard',
        quantity: 1,
        currency: 'USD',
        unitPriceMinor: 5000,
        totalAmountMinor: 5000,
        principalId: 'user-principal-A',
        correlationId: 'corr-1',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const prop2: StoredPurchaseProposal = {
        id: 'prop-approved-01',
        requestId: 'req-02',
        idempotencyKey: 'idem-2',
        idempotencyScope: 'principal:user-principal-A',
        requestHash: 'hash-2',
        status: 'APPROVED',
        productQuery: 'Monitor',
        quantity: 1,
        currency: 'USD',
        unitPriceMinor: 30000,
        totalAmountMinor: 30000,
        principalId: 'user-principal-A',
        correlationId: 'corr-2',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      inMemoryProposals.set(prop1.id, prop1);
      inMemoryProposals.set(prop2.id, prop2);

      const app = buildApp(mockClient, getApiGatewayConfig(), new TestAuthenticationProvider(), catalogResolver);

      const res = await app.inject({
        method: 'GET',
        url: '/api/purchase-intents?status=READY_FOR_REVIEW',
        headers: { 'x-principal-id': 'user-principal-A' },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload);
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('prop-review-01');
    });
  });

  describe('2. Explicit Human Approval Lifecycle & Invariants', () => {
    it('approves an eligible proposal in READY_FOR_REVIEW and records audit event', async () => {
      const prop: StoredPurchaseProposal = {
        id: 'prop-to-approve-01',
        requestId: 'req-app-01',
        idempotencyKey: 'idem-app-01',
        idempotencyScope: 'principal:user-principal-A',
        requestHash: 'hash-app-01',
        status: 'READY_FOR_REVIEW',
        productQuery: 'Ergonomic Mouse',
        quantity: 1,
        currency: 'USD',
        unitPriceMinor: 8000,
        totalAmountMinor: 8000,
        principalId: 'user-principal-A',
        correlationId: 'corr-app-01',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      inMemoryProposals.set(prop.id, prop);

      const app = buildApp(mockClient, getApiGatewayConfig(), new TestAuthenticationProvider(), catalogResolver);

      const res = await app.inject({
        method: 'POST',
        url: '/api/purchase-intents/prop-to-approve-01/approve',
        headers: {
          'x-principal-id': 'user-principal-A',
          'content-type': 'application/json',
        },
        payload: { note: 'Approved for Q4 hardware budget' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.outcome).toBe('APPROVED');
      expect(body.proposal.status).toBe('APPROVED');
      expect(body.proposal.metadata.approvedByPrincipal).toBe('user-principal-A');

      // Verify audit event persisted
      const approveEvent = recordedAuditEvents.find((e) => e.eventType === 'PROPOSAL_APPROVED');
      expect(approveEvent).toBeDefined();
      expect(approveEvent?.actor).toBe('user-principal-A');
      expect(approveEvent?.resourceId).toBe('prop-to-approve-01');
      expect(approveEvent?.outcome).toBe('APPROVED');

      // CRITICAL PAYMENT SAFETY ASSERTION: Zero payment calls invoked!
      expect(paymentSpy).not.toHaveBeenCalled();
    });

    it('approves an eligible proposal in POLICY_REVIEW_REQUIRED', async () => {
      const prop: StoredPurchaseProposal = {
        id: 'prop-high-val-01',
        requestId: 'req-hv-01',
        idempotencyKey: 'idem-hv-01',
        idempotencyScope: 'principal:user-principal-A',
        requestHash: 'hash-hv-01',
        status: 'POLICY_REVIEW_REQUIRED',
        productQuery: 'Developer Server Node',
        quantity: 1,
        currency: 'USD',
        unitPriceMinor: 120000,
        totalAmountMinor: 120000,
        policyReasonCode: 'REQUIRE_APPROVAL_HIGH_VALUE',
        principalId: 'user-principal-A',
        correlationId: 'corr-hv-01',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      inMemoryProposals.set(prop.id, prop);

      const app = buildApp(mockClient, getApiGatewayConfig(), new TestAuthenticationProvider(), catalogResolver);

      const res = await app.inject({
        method: 'POST',
        url: '/api/purchase-intents/prop-high-val-01/approve',
        headers: { 'x-principal-id': 'user-principal-A' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.outcome).toBe('APPROVED');
      expect(body.proposal.status).toBe('APPROVED');

      // Verify zero payment execution
      expect(paymentSpy).not.toHaveBeenCalled();
    });

    it('rejects approval from non-owner principal (403 Forbidden)', async () => {
      const prop: StoredPurchaseProposal = {
        id: 'prop-owner-A',
        requestId: 'req-01',
        idempotencyKey: 'idem-01',
        idempotencyScope: 'principal:user-principal-A',
        requestHash: 'hash-01',
        status: 'READY_FOR_REVIEW',
        productQuery: 'Desk Lamp',
        quantity: 1,
        currency: 'USD',
        unitPriceMinor: 3500,
        totalAmountMinor: 3500,
        principalId: 'user-principal-A',
        correlationId: 'corr-01',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      inMemoryProposals.set(prop.id, prop);

      const app = buildApp(mockClient, getApiGatewayConfig(), new TestAuthenticationProvider(), catalogResolver);

      // Principal B attempts approval
      const res = await app.inject({
        method: 'POST',
        url: '/api/purchase-intents/prop-owner-A/approve',
        headers: { 'x-principal-id': 'user-principal-B' },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.payload).error.code).toBe(ErrorCodes.FORBIDDEN);
      expect(inMemoryProposals.get('prop-owner-A')?.status).toBe('READY_FOR_REVIEW');
    });

    it('rejects approval of non-reviewable proposals (e.g. CANCELLED or POLICY_DENIED)', async () => {
      const propDenied: StoredPurchaseProposal = {
        id: 'prop-denied-01',
        requestId: 'req-d-01',
        idempotencyKey: 'idem-d-01',
        idempotencyScope: 'principal:user-principal-A',
        requestHash: 'hash-d-01',
        status: 'POLICY_DENIED',
        productQuery: 'Casino Chips',
        quantity: 1,
        currency: 'USD',
        unitPriceMinor: 50000,
        totalAmountMinor: 50000,
        principalId: 'user-principal-A',
        correlationId: 'corr-d-01',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      inMemoryProposals.set(propDenied.id, propDenied);

      const app = buildApp(mockClient, getApiGatewayConfig(), new TestAuthenticationProvider(), catalogResolver);

      const res = await app.inject({
        method: 'POST',
        url: '/api/purchase-intents/prop-denied-01/approve',
        headers: { 'x-principal-id': 'user-principal-A' },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('handles idempotent repeated approval smoothly without duplicate audit events', async () => {
      const prop: StoredPurchaseProposal = {
        id: 'prop-already-approved',
        requestId: 'req-aa-01',
        idempotencyKey: 'idem-aa-01',
        idempotencyScope: 'principal:user-principal-A',
        requestHash: 'hash-aa-01',
        status: 'APPROVED',
        productQuery: 'Mechanical Keyboard',
        quantity: 1,
        currency: 'USD',
        unitPriceMinor: 12000,
        totalAmountMinor: 12000,
        principalId: 'user-principal-A',
        correlationId: 'corr-aa-01',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      inMemoryProposals.set(prop.id, prop);

      const app = buildApp(mockClient, getApiGatewayConfig(), new TestAuthenticationProvider(), catalogResolver);

      const res = await app.inject({
        method: 'POST',
        url: '/api/purchase-intents/prop-already-approved/approve',
        headers: { 'x-principal-id': 'user-principal-A' },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload);
      expect(data.outcome).toBe('ALREADY_APPROVED');
      expect(data.proposal.status).toBe('APPROVED');
      expect(recordedAuditEvents.filter((e) => e.eventType === 'PROPOSAL_APPROVED')).toHaveLength(0);
    });
  });

  describe('3. Explicit Human Rejection Lifecycle & Invariants', () => {
    it('rejects an eligible proposal and records reason in audit trail', async () => {
      const prop: StoredPurchaseProposal = {
        id: 'prop-to-reject-01',
        requestId: 'req-rej-01',
        idempotencyKey: 'idem-rej-01',
        idempotencyScope: 'principal:user-principal-A',
        requestHash: 'hash-rej-01',
        status: 'READY_FOR_REVIEW',
        productQuery: 'Excessive Cloud GPU',
        quantity: 1,
        currency: 'USD',
        unitPriceMinor: 40000,
        totalAmountMinor: 40000,
        principalId: 'user-principal-A',
        correlationId: 'corr-rej-01',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      inMemoryProposals.set(prop.id, prop);

      const app = buildApp(mockClient, getApiGatewayConfig(), new TestAuthenticationProvider(), catalogResolver);

      const res = await app.inject({
        method: 'POST',
        url: '/api/purchase-intents/prop-to-reject-01/reject',
        headers: {
          'x-principal-id': 'user-principal-A',
          'content-type': 'application/json',
        },
        payload: { reason: 'Alternative vendor selected with lower pricing' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.outcome).toBe('REJECTED');
      expect(body.proposal.status).toBe('CANCELLED');
      expect(body.proposal.metadata.rejectionReason).toBe('Alternative vendor selected with lower pricing');

      // Verify audit event
      const rejEvent = recordedAuditEvents.find((e) => e.eventType === 'PROPOSAL_REJECTED');
      expect(rejEvent).toBeDefined();
      expect(rejEvent?.actor).toBe('user-principal-A');
      expect(rejEvent?.outcome).toBe('REJECTED');
      expect(paymentSpy).not.toHaveBeenCalled();
    });

    it('prohibits rejecting an already approved proposal', async () => {
      const prop: StoredPurchaseProposal = {
        id: 'prop-approved-cant-reject',
        requestId: 'req-01',
        idempotencyKey: 'idem-01',
        idempotencyScope: 'principal:user-principal-A',
        requestHash: 'hash-01',
        status: 'APPROVED',
        productQuery: 'Cloud Node',
        quantity: 1,
        currency: 'USD',
        unitPriceMinor: 1000,
        totalAmountMinor: 1000,
        principalId: 'user-principal-A',
        correlationId: 'corr-01',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      inMemoryProposals.set(prop.id, prop);

      const app = buildApp(mockClient, getApiGatewayConfig(), new TestAuthenticationProvider(), catalogResolver);

      const res = await app.inject({
        method: 'POST',
        url: '/api/purchase-intents/prop-approved-cant-reject/reject',
        headers: { 'x-principal-id': 'user-principal-A' },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('rejects rejection request from non-owner principal (403 Forbidden)', async () => {
      const prop: StoredPurchaseProposal = {
        id: 'prop-owner-A-rej',
        requestId: 'req-01',
        idempotencyKey: 'idem-01',
        idempotencyScope: 'principal:user-principal-A',
        requestHash: 'hash-01',
        status: 'POLICY_REVIEW_REQUIRED',
        productQuery: 'Storage Volume',
        quantity: 1,
        currency: 'USD',
        unitPriceMinor: 60000,
        totalAmountMinor: 60000,
        principalId: 'user-principal-A',
        correlationId: 'corr-01',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      inMemoryProposals.set(prop.id, prop);

      const app = buildApp(mockClient, getApiGatewayConfig(), new TestAuthenticationProvider(), catalogResolver);

      const res = await app.inject({
        method: 'POST',
        url: '/api/purchase-intents/prop-owner-A-rej/reject',
        headers: { 'x-principal-id': 'user-principal-B' },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.payload).error.code).toBe(ErrorCodes.FORBIDDEN);
      expect(inMemoryProposals.get('prop-owner-A-rej')?.status).toBe('POLICY_REVIEW_REQUIRED');
    });
  });

  describe('4. Proposal-Scoped Audit Trail & Isolation', () => {
    it('fetches audit trail for a proposal owned by the principal', async () => {
      const prop: StoredPurchaseProposal = {
        id: 'prop-audit-test-01',
        requestId: 'req-aud-01',
        idempotencyKey: 'idem-aud-01',
        idempotencyScope: 'principal:user-principal-A',
        requestHash: 'hash-aud-01',
        status: 'READY_FOR_REVIEW',
        productQuery: 'Ergonomic Desk',
        quantity: 1,
        currency: 'USD',
        unitPriceMinor: 45000,
        totalAmountMinor: 45000,
        principalId: 'user-principal-A',
        correlationId: 'corr-audit-01',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      inMemoryProposals.set(prop.id, prop);

      recordedAuditEvents.push(
        {
          correlationId: 'corr-audit-01',
          eventType: 'PROPOSAL_READY_FOR_REVIEW',
          actor: 'api-gateway',
          resourceId: 'prop-audit-test-01',
          outcome: 'READY_FOR_REVIEW',
          metadata: { amount: 45000 },
        },
        {
          correlationId: 'corr-audit-01',
          eventType: 'PROPOSAL_APPROVED',
          actor: 'user-principal-A',
          resourceId: 'prop-audit-test-01',
          outcome: 'APPROVED',
          metadata: { note: 'OK' },
        },
      );

      const app = buildApp(mockClient, getApiGatewayConfig(), new TestAuthenticationProvider(), catalogResolver);

      const res = await app.inject({
        method: 'GET',
        url: '/api/purchase-intents/prop-audit-test-01/audit-events',
        headers: { 'x-principal-id': 'user-principal-A' },
      });

      expect(res.statusCode).toBe(200);
      const events = JSON.parse(res.payload);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events.some((e: AuditEvent) => e.eventType === 'PROPOSAL_READY_FOR_REVIEW')).toBe(true);
    });

    it('denies audit trail access to non-owner principal (403 Forbidden)', async () => {
      const prop: StoredPurchaseProposal = {
        id: 'prop-audit-secret-01',
        requestId: 'req-aud-02',
        idempotencyKey: 'idem-aud-02',
        idempotencyScope: 'principal:user-principal-A',
        requestHash: 'hash-aud-02',
        status: 'READY_FOR_REVIEW',
        productQuery: 'Secret Research Rig',
        quantity: 1,
        currency: 'USD',
        unitPriceMinor: 30000,
        totalAmountMinor: 30000,
        principalId: 'user-principal-A',
        correlationId: 'corr-secret-01',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      inMemoryProposals.set(prop.id, prop);

      const app = buildApp(mockClient, getApiGatewayConfig(), new TestAuthenticationProvider(), catalogResolver);

      const res = await app.inject({
        method: 'GET',
        url: '/api/purchase-intents/prop-audit-secret-01/audit-events',
        headers: { 'x-principal-id': 'user-principal-B' },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.payload).error.code).toBe(ErrorCodes.FORBIDDEN);
    });
  });

  describe('5. Payment Safety Verification in Phase 3C', () => {
    it('verifies that no approval or rejection flow ever touches payment service', async () => {
      const prop: StoredPurchaseProposal = {
        id: 'prop-safety-check',
        requestId: 'req-safe-01',
        idempotencyKey: 'idem-safe-01',
        idempotencyScope: 'principal:user-principal-A',
        requestHash: 'hash-safe-01',
        status: 'READY_FOR_REVIEW',
        productQuery: 'Office Display',
        quantity: 1,
        currency: 'USD',
        unitPriceMinor: 25000,
        totalAmountMinor: 25000,
        principalId: 'user-principal-A',
        correlationId: 'corr-safe-01',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      inMemoryProposals.set(prop.id, prop);

      const app = buildApp(mockClient, getApiGatewayConfig(), new TestAuthenticationProvider(), catalogResolver);

      // Approve
      await app.inject({
        method: 'POST',
        url: '/api/purchase-intents/prop-safety-check/approve',
        headers: { 'x-principal-id': 'user-principal-A' },
      });

      // Assert payment spy was never invoked
      expect(paymentSpy).not.toHaveBeenCalled();
      expect(inMemoryProposals.get('prop-safety-check')?.status).toBe('APPROVED');
    });
  });
});
