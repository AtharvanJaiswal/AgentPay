import { describe, it, expect, vi, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import type pg from 'pg';
import {
  type StoredPurchaseProposal,
  ProposalIdempotencyConflictError,
  computeIntentFingerprint,
} from '@agentpay/contracts';
import { InMemoryProposalRepository, PostgresProposalRepository } from '../src/repository.js';
import { buildApp } from '../src/app.js';

describe('Increment 4: Durable Purchase Proposal Repository & Idempotency', () => {
  const baseProposal: StoredPurchaseProposal = {
    id: uuidv4(),
    requestId: 'req-prop-001',
    idempotencyKey: 'idemp-prop-key-01',
    idempotencyScope: 'user-principal-A',
    requestHash: computeIntentFingerprint({
      action: 'purchase',
      productQuery: 'Developer Cloud VM',
      quantity: 1,
      constraints: {
        maxUnitPriceMinor: 2500,
        currency: 'USD',
      },
    }),
    status: 'READY_FOR_REVIEW',
    productQuery: 'Developer Cloud VM',
    productId: 'sku-cloud-compute-micro',
    productName: 'Cloud Virtual Machine - Micro Tier',
    merchantId: 'm-cloud-infra-01',
    merchantName: 'CloudInfra Global',
    merchantCategory: 'cloud_services',
    quantity: 1,
    currency: 'USD',
    unitPriceMinor: 1500,
    subtotalMinor: 1500,
    taxMinor: 0,
    shippingMinor: 0,
    totalAmountMinor: 1500,
    policyDecisionId: uuidv4(),
    policyOutcome: 'ALLOW',
    policyReasonCode: 'ALLOW_WITHIN_LIMITS',
    principalId: 'user-principal-A',
    correlationId: 'corr-prop-001',
    metadata: { env: 'test' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  describe('InMemoryProposalRepository', () => {
    it('persists a new proposal and retrieves it by id', async () => {
      const repo = new InMemoryProposalRepository();
      const saved = await repo.createProposal(baseProposal);

      expect(saved.id).toBe(baseProposal.id);
      expect(saved.status).toBe('READY_FOR_REVIEW');

      const retrieved = await repo.getProposalById(baseProposal.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(baseProposal.id);
      expect(retrieved?.productQuery).toBe('Developer Cloud VM');
    });

    it('returns existing proposal on identical retry with same idempotency key', async () => {
      const repo = new InMemoryProposalRepository();
      const first = await repo.createProposal(baseProposal);

      // Retry with new ID but identical idempotency key, scope, and requestHash
      const retryProposal: StoredPurchaseProposal = {
        ...baseProposal,
        id: uuidv4(),
      };

      const second = await repo.createProposal(retryProposal);
      expect(second.id).toBe(first.id); // Returns the original proposal!
    });

    it('rejects conflicting proposal using same idempotency key with different payload (409 Conflict)', async () => {
      const repo = new InMemoryProposalRepository();
      await repo.createProposal(baseProposal);

      const conflictingProposal: StoredPurchaseProposal = {
        ...baseProposal,
        id: uuidv4(),
        requestHash: 'different-conflicting-hash-999',
        productQuery: 'Malicious Divergent Product',
      };

      await expect(repo.createProposal(conflictingProposal)).rejects.toThrow(
        ProposalIdempotencyConflictError,
      );
    });

    it('allows same idempotency key under different principal scopes', async () => {
      const repo = new InMemoryProposalRepository();
      const propA = await repo.createProposal({
        ...baseProposal,
        idempotencyScope: 'user-principal-A',
      });

      const propB = await repo.createProposal({
        ...baseProposal,
        id: uuidv4(),
        idempotencyScope: 'user-principal-B', // Different scope
      });

      expect(propA.id).not.toBe(propB.id);
    });

    it('updates proposal lifecycle status (e.g. READY_FOR_REVIEW -> APPROVED)', async () => {
      const repo = new InMemoryProposalRepository();
      await repo.createProposal(baseProposal);

      const updated = await repo.updateProposalStatus(baseProposal.id, 'APPROVED', {
        metadata: { approvedBy: 'user-principal-A', approvalTimestamp: new Date().toISOString() },
      });

      expect(updated.status).toBe('APPROVED');
      expect(updated.metadata?.approvedBy).toBe('user-principal-A');
    });
  });

  describe('PostgresProposalRepository Transactional Idempotency', () => {
    let mockClient: {
      query: ReturnType<typeof vi.fn>;
      release: ReturnType<typeof vi.fn>;
    };
    let mockPool: {
      connect: ReturnType<typeof vi.fn>;
      query: ReturnType<typeof vi.fn>;
    };
    let pgRepo: PostgresProposalRepository;

    beforeEach(() => {
      vi.restoreAllMocks();
      mockClient = {
        query: vi.fn(),
        release: vi.fn(),
      };
      mockPool = {
        connect: vi.fn().mockResolvedValue(mockClient),
        query: vi.fn(),
      };
      pgRepo = new PostgresProposalRepository(mockPool as unknown as pg.Pool);
    });

    it('creates proposal inside a transaction with BEGIN and COMMIT', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // SELECT FOR UPDATE
        .mockResolvedValueOnce({
          // INSERT RETURNING *
          rowCount: 1,
          rows: [
            {
              id: baseProposal.id,
              request_id: baseProposal.requestId,
              idempotency_key: baseProposal.idempotencyKey,
              idempotency_scope: baseProposal.idempotencyScope,
              request_hash: baseProposal.requestHash,
              status: baseProposal.status,
              product_query: baseProposal.productQuery,
              quantity: 1,
              currency: 'USD',
              total_amount_minor: 1500,
              correlation_id: baseProposal.correlationId,
              metadata: '{}',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      const result = await pgRepo.createProposal(baseProposal);
      expect(result.id).toBe(baseProposal.id);
      expect(mockClient.query).toHaveBeenNthCalledWith(1, 'BEGIN');
      expect(mockClient.query).toHaveBeenLastCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('rolls back and raises ProposalIdempotencyConflictError on hash conflict', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({
          // SELECT FOR UPDATE returns existing with different hash
          rowCount: 1,
          rows: [
            {
              id: 'existing-prop-id',
              request_id: baseProposal.requestId,
              idempotency_key: baseProposal.idempotencyKey,
              idempotency_scope: baseProposal.idempotencyScope,
              request_hash: 'different-existing-hash',
              status: 'READY_FOR_REVIEW',
              product_query: 'Developer Cloud VM',
              quantity: 1,
              currency: 'USD',
              total_amount_minor: 1500,
              correlation_id: baseProposal.correlationId,
              metadata: '{}',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

      await expect(pgRepo.createProposal(baseProposal)).rejects.toThrow(
        ProposalIdempotencyConflictError,
      );
      expect(mockClient.query).toHaveBeenLastCalledWith('ROLLBACK');
    });
  });

  describe('Agent Service HTTP Integration (/proposals)', () => {
    const repo = new InMemoryProposalRepository();
    const app = buildApp(undefined, undefined, repo);

    it('POST /proposals creates and returns durable proposal', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/proposals',
        headers: {
          'x-correlation-id': 'corr-http-prop-01',
        },
        payload: baseProposal,
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.id).toBe(baseProposal.id);
      expect(body.status).toBe('READY_FOR_REVIEW');
    });

    it('POST /proposals returns 409 conflict when idempotency key payload conflicts', async () => {
      const conflicting = {
        ...baseProposal,
        id: uuidv4(),
        requestHash: 'divergent-hash-1111',
      };

      const res = await app.inject({
        method: 'POST',
        url: '/proposals',
        payload: conflicting,
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('GET /proposals/:id returns 200 with persisted proposal', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/proposals/${baseProposal.id}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe(baseProposal.id);
    });

    it('GET /proposals/:id returns 404 for unknown proposal', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/proposals/${uuidv4()}`,
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('PATCH /proposals/:id/status updates status to APPROVED', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/proposals/${baseProposal.id}/status`,
        payload: {
          status: 'APPROVED',
          metadata: { note: 'User explicitly confirmed purchase proposal' },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('APPROVED');
      expect(body.metadata?.note).toBe('User explicitly confirmed purchase proposal');
    });

    it('PATCH /proposals/:id/status rejects invalid state transitions with 400 INVALID_STATE_TRANSITION', async () => {
      // First create a proposal with POLICY_DENIED
      const deniedProposal: StoredPurchaseProposal = {
        ...baseProposal,
        id: uuidv4(),
        idempotencyKey: 'idemp-denied-001',
        status: 'POLICY_DENIED',
      };
      await app.inject({
        method: 'POST',
        url: '/proposals',
        payload: deniedProposal,
      });

      // Attempt prohibited transition: POLICY_DENIED -> APPROVED
      const res = await app.inject({
        method: 'PATCH',
        url: `/proposals/${deniedProposal.id}/status`,
        payload: {
          status: 'APPROVED',
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('INVALID_STATE_TRANSITION');
      expect(body.error.message).toContain('prohibited by lifecycle rules');
    });

    it('PATCH /proposals/:id/status rejects status update from unauthorized principal with 403 FORBIDDEN', async () => {
      const ownedProposal: StoredPurchaseProposal = {
        ...baseProposal,
        id: uuidv4(),
        idempotencyKey: 'idemp-owned-001',
        principalId: 'user-principal-A',
        status: 'READY_FOR_REVIEW',
      };
      await app.inject({
        method: 'POST',
        url: '/proposals',
        payload: ownedProposal,
      });

      // Caller impersonating user-principal-B attempts to update user-principal-A's proposal
      const res = await app.inject({
        method: 'PATCH',
        url: `/proposals/${ownedProposal.id}/status`,
        headers: {
          'x-principal-id': 'user-principal-B',
        },
        payload: {
          status: 'APPROVED',
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('FORBIDDEN');
      expect(body.error.message).toContain('not authorized to update proposal');
    });
  });
});
