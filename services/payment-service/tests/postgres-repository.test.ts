import { describe, it, expect, vi, beforeEach } from 'vitest';
import type pg from 'pg';
import {
  PostgresPaymentOrderRepository,
  type StoredPaymentOrder,
  IdempotencyConflictError,
  StateTransitionError,
} from '../src/repository.js';

describe('PostgresPaymentOrderRepository - Transactional Correctness & Idempotency', () => {
  let mockClient: {
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
  let mockPool: {
    connect: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  };
  let repo: PostgresPaymentOrderRepository;

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

    repo = new PostgresPaymentOrderRepository(mockPool as unknown as pg.Pool);
  });

  describe('createOrder Transactional Atomicity & Conflict Handling', () => {
    it('creates an order inside a transaction with BEGIN and COMMIT', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // SELECT FOR UPDATE
        .mockResolvedValueOnce({
          // INSERT
          rows: [
            {
              id: 'ORD-PG-001',
              proposal_id: '11111111-1111-4111-a111-111111111111',
              policy_decision_id: '22222222-2222-4222-b222-222222222222',
              provider: 'paypal_sandbox',
              status: 'CREATED',
              currency: 'USD',
              amount_minor: '100',
              metadata: '{}',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      const order: StoredPaymentOrder = {
        id: 'ORD-PG-001',
        proposalId: '11111111-1111-4111-a111-111111111111',
        policyDecisionId: '22222222-2222-4222-b222-222222222222',
        provider: 'paypal_sandbox',
        status: 'CREATED',
        currency: 'USD',
        amountMinor: 100,
        idempotencyKey: 'idemp-001',
        requestHash: 'hash-001',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const result = await repo.createOrder(order);

      expect(result.id).toBe('ORD-PG-001');
      expect(mockClient.query).toHaveBeenNthCalledWith(1, 'BEGIN');
      expect(mockClient.query).toHaveBeenLastCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('rolls back and raises IdempotencyConflictError if idempotency key payload conflicts', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({
          // SELECT FOR UPDATE returns existing order with different hash
          rowCount: 1,
          rows: [
            {
              id: 'ORD-PG-EXISTING',
              proposal_id: '11111111-1111-4111-a111-111111111111',
              policy_decision_id: '22222222-2222-4222-b222-222222222222',
              provider: 'paypal_sandbox',
              status: 'CREATED',
              currency: 'USD',
              amount_minor: '100',
              request_hash: 'original-hash',
              metadata: '{}',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

      const conflictingOrder: StoredPaymentOrder = {
        id: 'ORD-PG-NEW',
        proposalId: '11111111-1111-4111-a111-111111111111',
        policyDecisionId: '22222222-2222-4222-b222-222222222222',
        provider: 'paypal_sandbox',
        status: 'CREATED',
        currency: 'USD',
        amountMinor: 500, // Different amount/hash!
        idempotencyKey: 'idemp-conflict-test',
        requestHash: 'different-hash',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await expect(repo.createOrder(conflictingOrder)).rejects.toThrow(IdempotencyConflictError);
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('updateOrderStatus Transactional Atomicity & Invariants', () => {
    it('locks row with SELECT FOR UPDATE and checks monotonic status before UPDATE', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({
          // SELECT FOR UPDATE
          rowCount: 1,
          rows: [
            {
              id: 'ORD-PG-UPDATE',
              proposal_id: '11111111-1111-4111-a111-111111111111',
              policy_decision_id: '22222222-2222-4222-b222-222222222222',
              provider: 'paypal_sandbox',
              status: 'CREATED',
              currency: 'USD',
              amount_minor: '100',
              metadata: '{}',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
        })
        .mockResolvedValueOnce({
          // UPDATE
          rows: [
            {
              id: 'ORD-PG-UPDATE',
              proposal_id: '11111111-1111-4111-a111-111111111111',
              policy_decision_id: '22222222-2222-4222-b222-222222222222',
              provider: 'paypal_sandbox',
              status: 'APPROVED',
              currency: 'USD',
              amount_minor: '100',
              metadata: '{}',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      const result = await repo.updateOrderStatus('ORD-PG-UPDATE', 'APPROVED');

      expect(result.status).toBe('APPROVED');
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith(
        'SELECT * FROM payment_orders WHERE id = $1 FOR UPDATE',
        ['ORD-PG-UPDATE'],
      );
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });

    it('rolls back and raises StateTransitionError when regressing from terminal state', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({
          // SELECT FOR UPDATE returns COMPLETED order
          rowCount: 1,
          rows: [
            {
              id: 'ORD-PG-TERMINAL',
              proposal_id: '11111111-1111-4111-a111-111111111111',
              policy_decision_id: '22222222-2222-4222-b222-222222222222',
              provider: 'paypal_sandbox',
              status: 'COMPLETED',
              currency: 'USD',
              amount_minor: '100',
              metadata: '{}',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

      await expect(repo.updateOrderStatus('ORD-PG-TERMINAL', 'APPROVED')).rejects.toThrow(
        StateTransitionError,
      );
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });
  });

  describe('processWebhookEvent Atomic Claim & Transition', () => {
    it('atomically claims event and updates order status within a single transaction', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({
          // INSERT INTO webhook_events ON CONFLICT DO NOTHING RETURNING *
          rowCount: 1,
          rows: [{ id: 'WH-EVENT-001' }],
        })
        .mockResolvedValueOnce({
          // SELECT * FROM payment_orders WHERE id = $1 FOR UPDATE
          rowCount: 1,
          rows: [
            {
              id: 'ORD-WH-001',
              proposal_id: '11111111-1111-4111-a111-111111111111',
              policy_decision_id: '22222222-2222-4222-b222-222222222222',
              provider: 'paypal_sandbox',
              status: 'CREATED',
              currency: 'USD',
              amount_minor: '100',
              metadata: '{}',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
        })
        .mockResolvedValueOnce({
          // UPDATE payment_orders
          rows: [
            {
              id: 'ORD-WH-001',
              proposal_id: '11111111-1111-4111-a111-111111111111',
              policy_decision_id: '22222222-2222-4222-b222-222222222222',
              provider: 'paypal_sandbox',
              status: 'APPROVED',
              currency: 'USD',
              amount_minor: '100',
              metadata: '{}',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      const res = await repo.processWebhookEvent({
        event: {
          id: 'WH-EVENT-001',
          eventType: 'CHECKOUT.ORDER.APPROVED',
          resourceId: 'ORD-WH-001',
          processedAt: new Date().toISOString(),
          payload: {},
        },
        targetOrderId: 'ORD-WH-001',
        expectedCurrency: 'USD',
        expectedAmountMinor: 100,
        transition: {
          targetStatus: 'APPROVED',
        },
      });

      expect(res.recorded).toBe(true);
      expect(res.duplicate).toBe(false);
      expect(res.orderUpdated).toBe(true);
      expect(res.order?.status).toBe('APPROVED');
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });

    it('safely handles duplicate event delivery without repeating side effects', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({
          // INSERT INTO webhook_events ON CONFLICT DO NOTHING returns 0 rows (duplicate)
          rowCount: 0,
          rows: [],
        })
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      const res = await repo.processWebhookEvent({
        event: {
          id: 'WH-EVENT-DUPLICATE',
          eventType: 'CHECKOUT.ORDER.APPROVED',
          resourceId: 'ORD-WH-001',
          processedAt: new Date().toISOString(),
          payload: {},
        },
        targetOrderId: 'ORD-WH-001',
        transition: {
          targetStatus: 'APPROVED',
        },
      });

      expect(res.recorded).toBe(false);
      expect(res.duplicate).toBe(true);
      expect(res.orderUpdated).toBe(false);
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      // Did NOT attempt to query or lock payment_orders
      expect(mockClient.query).not.toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM payment_orders'),
        expect.anything(),
      );
    });

    it('rolls back event claim if database error occurs during order update (resolves failure window)', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({
          // INSERT webhook_events succeeds
          rowCount: 1,
          rows: [{ id: 'WH-EVENT-FAIL-MIDWAY' }],
        })
        .mockRejectedValueOnce(new Error('PG_CONNECTION_TERMINATED')); // SELECT FOR UPDATE throws

      await expect(
        repo.processWebhookEvent({
          event: {
            id: 'WH-EVENT-FAIL-MIDWAY',
            eventType: 'CHECKOUT.ORDER.APPROVED',
            resourceId: 'ORD-WH-001',
            processedAt: new Date().toISOString(),
            payload: {},
          },
          targetOrderId: 'ORD-WH-001',
          transition: { targetStatus: 'APPROVED' },
        }),
      ).rejects.toThrow('PG_CONNECTION_TERMINATED');

      // Crucial: Rollback was called so webhook event ID is NOT claimed permanently!
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });
});
