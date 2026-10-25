import crypto from 'node:crypto';
import pg from 'pg';
import type { PaymentOrderStatus, PaymentProviderType } from '@agentpay/contracts';

export interface StoredPaymentOrder {
  id: string;
  proposalId: string;
  policyDecisionId: string;
  provider: PaymentProviderType;
  status: PaymentOrderStatus;
  currency: string;
  amountMinor: number;
  approvalUrl?: string;
  captureId?: string;
  capturedAt?: string;
  idempotencyKey?: string;
  requestHash?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastReconciledAt?: string;
  reconciliationStatus?: string;
}

export interface StoredWebhookEvent {
  id: string;
  eventType: string;
  resourceId: string;
  processedAt: string;
  payload: Record<string, unknown>;
}

export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

export class StateTransitionError extends Error {
  readonly code = 'INVALID_STATE_TRANSITION';
  readonly statusCode = 422;
  constructor(message: string) {
    super(message);
    this.name = 'StateTransitionError';
  }
}

export function computeProposalHash(proposal: {
  id: string;
  totalAmountMinor: number;
  currency: string;
  merchant?: { id?: string };
}): string {
  const content = JSON.stringify({
    proposalId: proposal.id,
    amount: proposal.totalAmountMinor,
    currency: proposal.currency,
    merchantId: proposal.merchant?.id ?? '',
  });
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Monotonic state rank validator.
 * Ensures orders cannot regress once they reach final or advanced lifecycle states.
 */
const STATUS_RANK: Record<PaymentOrderStatus, number> = {
  CREATED: 1,
  PAYER_ACTION_REQUIRED: 2,
  SAVED: 2,
  APPROVED: 3,
  UNKNOWN: 3, // capture timeout: ambiguous state waiting for reconciliation
  COMPLETED: 4,
  VOIDED: 4,
  FAILED: 4,
};

export interface TransitionContext {
  captureId?: string;
  currency?: string;
  amountMinor?: number;
}

export type StateTransitionDecision =
  | { allowed: true; reason: string }
  | { allowed: false; reason: string };

export function evaluateStateTransition(
  current: PaymentOrderStatus,
  next: PaymentOrderStatus,
  context?: TransitionContext,
): StateTransitionDecision {
  if (current === next) {
    return { allowed: true, reason: 'No-op transition (idempotent)' };
  }

  // COMPLETED is an immutable terminal state
  if (current === 'COMPLETED') {
    return { allowed: false, reason: 'COMPLETED is an immutable terminal state' };
  }

  // Terminal states VOIDED/FAILED cannot transition to active states
  if ((current === 'VOIDED' || current === 'FAILED') && next !== current) {
    return { allowed: false, reason: `Terminal state ${current} cannot transition to ${next}` };
  }

  // Invariant 3: COMPLETED requires authoritative capture evidence
  if (next === 'COMPLETED') {
    if (
      context &&
      'captureId' in context &&
      (!context.captureId || context.captureId.trim().length === 0)
    ) {
      return {
        allowed: false,
        reason: 'Transition to COMPLETED requires valid capture identifier evidence',
      };
    }
  }

  // UNKNOWN can be reconciled to COMPLETED or FAILED
  if (current === 'UNKNOWN') {
    if (next === 'COMPLETED' || next === 'FAILED') {
      return { allowed: true, reason: `Reconciled from UNKNOWN to ${next}` };
    }
    return { allowed: false, reason: 'UNKNOWN state can only transition to COMPLETED or FAILED' };
  }

  // Monotonic progression check
  if (STATUS_RANK[next] < STATUS_RANK[current]) {
    return {
      allowed: false,
      reason: `Monotonic regression rejected: cannot regress from ${current} to ${next}`,
    };
  }

  return { allowed: true, reason: `Valid transition from ${current} to ${next}` };
}

export function canTransitionStatus(
  current: PaymentOrderStatus,
  next: PaymentOrderStatus,
  context?: TransitionContext,
): boolean {
  return evaluateStateTransition(current, next, context).allowed;
}

export interface ProcessWebhookEventOptions {
  event: StoredWebhookEvent;
  targetOrderId?: string;
  expectedCurrency?: string;
  expectedAmountMinor?: number;
  transition?: {
    targetStatus: PaymentOrderStatus;
    captureId?: string;
    capturedAt?: string;
    approvalUrl?: string;
    metadata?: Record<string, unknown>;
  };
}

export interface ProcessWebhookEventResult {
  recorded: boolean;
  duplicate: boolean;
  orderUpdated: boolean;
  order?: StoredPaymentOrder;
  reason?: string;
}

export interface PaymentOrderRepository {
  createOrder(order: StoredPaymentOrder): Promise<StoredPaymentOrder>;
  getOrderById(id: string): Promise<StoredPaymentOrder | null>;
  getOrderByProposalId(proposalId: string): Promise<StoredPaymentOrder | null>;
  getOrderByIdempotencyKey(key: string): Promise<StoredPaymentOrder | null>;
  updateOrderStatus(
    id: string,
    newStatus: PaymentOrderStatus,
    updates?: {
      captureId?: string;
      capturedAt?: string;
      approvalUrl?: string;
      metadata?: Record<string, unknown>;
      lastReconciledAt?: string;
      reconciliationStatus?: string;
    },
  ): Promise<StoredPaymentOrder>;
  recordWebhookEvent(
    event: StoredWebhookEvent,
  ): Promise<{ recorded: boolean; event: StoredWebhookEvent }>;
  processWebhookEvent(options: ProcessWebhookEventOptions): Promise<ProcessWebhookEventResult>;
}

/**
 * In-Memory repository implementation used in unit tests and when database is offline.
 */
export class InMemoryPaymentOrderRepository implements PaymentOrderRepository {
  private orders = new Map<string, StoredPaymentOrder>();
  private idempotencyIndex = new Map<string, string>();
  private proposalIndex = new Map<string, string>();
  private webhooks = new Map<string, StoredWebhookEvent>();

  async createOrder(order: StoredPaymentOrder): Promise<StoredPaymentOrder> {
    if (order.idempotencyKey) {
      const existingId = this.idempotencyIndex.get(order.idempotencyKey);
      if (existingId) {
        const existing = this.orders.get(existingId);
        if (existing) {
          if (
            existing.requestHash &&
            order.requestHash &&
            existing.requestHash !== order.requestHash
          ) {
            throw new IdempotencyConflictError(
              `Idempotency key '${order.idempotencyKey}' was already used with a different proposal payload`,
            );
          }
          return existing;
        }
      }
    }

    const saved: StoredPaymentOrder = {
      ...order,
      metadata: order.metadata ?? {},
      createdAt: order.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.orders.set(saved.id, saved);
    this.proposalIndex.set(saved.proposalId, saved.id);
    if (saved.idempotencyKey) {
      this.idempotencyIndex.set(saved.idempotencyKey, saved.id);
    }
    return saved;
  }

  async getOrderById(id: string): Promise<StoredPaymentOrder | null> {
    return this.orders.get(id) ?? null;
  }

  async getOrderByProposalId(proposalId: string): Promise<StoredPaymentOrder | null> {
    const id = this.proposalIndex.get(proposalId);
    return id ? (this.orders.get(id) ?? null) : null;
  }

  async getOrderByIdempotencyKey(key: string): Promise<StoredPaymentOrder | null> {
    const id = this.idempotencyIndex.get(key);
    return id ? (this.orders.get(id) ?? null) : null;
  }

  async updateOrderStatus(
    id: string,
    newStatus: PaymentOrderStatus,
    updates?: {
      captureId?: string;
      capturedAt?: string;
      approvalUrl?: string;
      metadata?: Record<string, unknown>;
      lastReconciledAt?: string;
      reconciliationStatus?: string;
    },
  ): Promise<StoredPaymentOrder> {
    const order = this.orders.get(id);
    if (!order) {
      throw new Error(`Order ${id} not found`);
    }

    const targetCaptureId = updates?.captureId ?? order.captureId;
    const decision = evaluateStateTransition(order.status, newStatus, {
      captureId: targetCaptureId,
    });
    if (!decision.allowed) {
      throw new StateTransitionError(
        `Invalid monotonic transition: Cannot transition order ${id} from ${order.status} to ${newStatus}: ${decision.reason}`,
      );
    }

    const updated: StoredPaymentOrder = {
      ...order,
      status: newStatus,
      captureId: updates?.captureId ?? order.captureId,
      capturedAt: updates?.capturedAt ?? order.capturedAt,
      approvalUrl: updates?.approvalUrl ?? order.approvalUrl,
      lastReconciledAt: updates?.lastReconciledAt ?? order.lastReconciledAt,
      reconciliationStatus: updates?.reconciliationStatus ?? order.reconciliationStatus,
      metadata: updates?.metadata ? { ...order.metadata, ...updates.metadata } : order.metadata,
      updatedAt: new Date().toISOString(),
    };

    this.orders.set(id, updated);
    return updated;
  }

  async recordWebhookEvent(
    event: StoredWebhookEvent,
  ): Promise<{ recorded: boolean; event: StoredWebhookEvent }> {
    if (this.webhooks.has(event.id)) {
      return { recorded: false, event: this.webhooks.get(event.id)! };
    }
    this.webhooks.set(event.id, event);
    return { recorded: true, event };
  }

  async processWebhookEvent(
    options: ProcessWebhookEventOptions,
  ): Promise<ProcessWebhookEventResult> {
    if (this.webhooks.has(options.event.id)) {
      return {
        recorded: false,
        duplicate: true,
        orderUpdated: false,
        reason: 'Duplicate webhook event already processed',
      };
    }

    if (!options.targetOrderId) {
      this.webhooks.set(options.event.id, options.event);
      return {
        recorded: true,
        duplicate: false,
        orderUpdated: false,
        reason: 'Webhook event recorded; no target order specified',
      };
    }

    const existingOrder = this.orders.get(options.targetOrderId);
    if (!existingOrder) {
      this.webhooks.set(options.event.id, options.event);
      return {
        recorded: true,
        duplicate: false,
        orderUpdated: false,
        reason: `Target order ${options.targetOrderId} not found in repository; no state mutated`,
      };
    }

    if (options.expectedCurrency && options.expectedAmountMinor !== undefined) {
      if (
        options.expectedCurrency !== existingOrder.currency ||
        options.expectedAmountMinor !== existingOrder.amountMinor
      ) {
        this.webhooks.set(options.event.id, options.event);
        return {
          recorded: true,
          duplicate: false,
          orderUpdated: false,
          order: existingOrder,
          reason: `Monetary mismatch: order=${existingOrder.currency} ${existingOrder.amountMinor} vs event=${options.expectedCurrency} ${options.expectedAmountMinor}`,
        };
      }
    }

    if (options.transition) {
      const targetStatus = options.transition.targetStatus;
      const targetCaptureId = options.transition.captureId ?? existingOrder.captureId;

      const decision = evaluateStateTransition(existingOrder.status, targetStatus, {
        captureId: targetCaptureId,
      });

      if (!decision.allowed) {
        this.webhooks.set(options.event.id, options.event);
        return {
          recorded: true,
          duplicate: false,
          orderUpdated: false,
          order: existingOrder,
          reason: `Transition rejected: ${decision.reason}`,
        };
      }

      const updated: StoredPaymentOrder = {
        ...existingOrder,
        status: targetStatus,
        captureId: options.transition.captureId ?? existingOrder.captureId,
        capturedAt: options.transition.capturedAt ?? existingOrder.capturedAt,
        approvalUrl: options.transition.approvalUrl ?? existingOrder.approvalUrl,
        metadata: options.transition.metadata
          ? { ...existingOrder.metadata, ...options.transition.metadata }
          : existingOrder.metadata,
        updatedAt: new Date().toISOString(),
      };

      this.orders.set(options.targetOrderId, updated);
      this.webhooks.set(options.event.id, options.event);

      return {
        recorded: true,
        duplicate: false,
        orderUpdated: true,
        order: updated,
        reason: decision.reason,
      };
    }

    this.webhooks.set(options.event.id, options.event);
    return {
      recorded: true,
      duplicate: false,
      orderUpdated: false,
      order: existingOrder,
    };
  }
}

/**
 * PostgreSQL Implementation of the Payment Order Repository.
 */
export class PostgresPaymentOrderRepository implements PaymentOrderRepository {
  private pool: pg.Pool;

  constructor(poolOrConnectionString: pg.Pool | string) {
    if (typeof poolOrConnectionString === 'string') {
      this.pool = new pg.Pool({
        connectionString: poolOrConnectionString,
        connectionTimeoutMillis: 5000,
        max: 10,
      });
    } else {
      this.pool = poolOrConnectionString;
    }
  }

  async createOrder(order: StoredPaymentOrder): Promise<StoredPaymentOrder> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      if (order.idempotencyKey) {
        const existingRes = await client.query(
          'SELECT * FROM payment_orders WHERE idempotency_key = $1 FOR UPDATE',
          [order.idempotencyKey],
        );

        if (existingRes.rowCount && existingRes.rowCount > 0) {
          const existing = this.mapRow(existingRes.rows[0]);
          if (
            existing.requestHash &&
            order.requestHash &&
            existing.requestHash !== order.requestHash
          ) {
            await client.query('ROLLBACK');
            throw new IdempotencyConflictError(
              `Idempotency key '${order.idempotencyKey}' was already used with a different proposal payload`,
            );
          }
          await client.query('COMMIT');
          return existing;
        }
      }

      const insertRes = await client.query(
        `INSERT INTO payment_orders (
          id, proposal_id, policy_decision_id, provider, status, currency, amount_minor,
          approval_url, capture_id, captured_at, idempotency_key, request_hash, metadata, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING *`,
        [
          order.id,
          order.proposalId,
          order.policyDecisionId,
          order.provider,
          order.status,
          order.currency,
          order.amountMinor,
          order.approvalUrl ?? null,
          order.captureId ?? null,
          order.capturedAt ?? null,
          order.idempotencyKey ?? null,
          order.requestHash ?? null,
          JSON.stringify(order.metadata ?? {}),
          order.createdAt || new Date().toISOString(),
          new Date().toISOString(),
        ],
      );

      await client.query('COMMIT');
      return this.mapRow(insertRes.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getOrderById(id: string): Promise<StoredPaymentOrder | null> {
    const res = await this.pool.query('SELECT * FROM payment_orders WHERE id = $1', [id]);
    if (res.rowCount === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async getOrderByProposalId(proposalId: string): Promise<StoredPaymentOrder | null> {
    const res = await this.pool.query('SELECT * FROM payment_orders WHERE proposal_id = $1', [
      proposalId,
    ]);
    if (res.rowCount === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async getOrderByIdempotencyKey(key: string): Promise<StoredPaymentOrder | null> {
    const res = await this.pool.query('SELECT * FROM payment_orders WHERE idempotency_key = $1', [
      key,
    ]);
    if (res.rowCount === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async updateOrderStatus(
    id: string,
    newStatus: PaymentOrderStatus,
    updates?: {
      captureId?: string;
      capturedAt?: string;
      approvalUrl?: string;
      metadata?: Record<string, unknown>;
      lastReconciledAt?: string;
      reconciliationStatus?: string;
    },
  ): Promise<StoredPaymentOrder> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const existingRes = await client.query(
        'SELECT * FROM payment_orders WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (existingRes.rowCount === 0) {
        await client.query('ROLLBACK');
        throw new Error(`Order ${id} not found`);
      }

      const existing = this.mapRow(existingRes.rows[0]);
      const targetCaptureId = updates?.captureId ?? existing.captureId;
      const decision = evaluateStateTransition(existing.status, newStatus, {
        captureId: targetCaptureId,
      });
      if (!decision.allowed) {
        await client.query('ROLLBACK');
        throw new StateTransitionError(
          `Invalid monotonic transition: Cannot transition order ${id} from ${existing.status} to ${newStatus}: ${decision.reason}`,
        );
      }

      const mergedMetadata = updates?.metadata
        ? { ...existing.metadata, ...updates.metadata }
        : existing.metadata;

      const updateRes = await client.query(
        `UPDATE payment_orders
         SET
           status = $2,
           capture_id = COALESCE($3, capture_id),
           captured_at = COALESCE($4, captured_at),
           approval_url = COALESCE($5, approval_url),
           metadata = $6,
           last_reconciled_at = COALESCE($7, last_reconciled_at),
           reconciliation_status = COALESCE($8, reconciliation_status),
           updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          id,
          newStatus,
          updates?.captureId ?? null,
          updates?.capturedAt ?? null,
          updates?.approvalUrl ?? null,
          JSON.stringify(mergedMetadata ?? {}),
          updates?.lastReconciledAt ?? null,
          updates?.reconciliationStatus ?? null,
        ],
      );

      await client.query('COMMIT');
      return this.mapRow(updateRes.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async recordWebhookEvent(
    event: StoredWebhookEvent,
  ): Promise<{ recorded: boolean; event: StoredWebhookEvent }> {
    const res = await this.pool.query(
      `INSERT INTO webhook_events (id, event_type, resource_id, processed_at, payload)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING
       RETURNING *`,
      [
        event.id,
        event.eventType,
        event.resourceId,
        event.processedAt,
        JSON.stringify(event.payload),
      ],
    );

    if (res.rowCount && res.rowCount > 0) {
      return { recorded: true, event };
    }
    return { recorded: false, event };
  }

  async processWebhookEvent(
    options: ProcessWebhookEventOptions,
  ): Promise<ProcessWebhookEventResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Atomically claim webhook event ID with ON CONFLICT DO NOTHING
      const insertEventRes = await client.query(
        `INSERT INTO webhook_events (id, event_type, resource_id, processed_at, payload)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING
         RETURNING *`,
        [
          options.event.id,
          options.event.eventType,
          options.event.resourceId,
          options.event.processedAt,
          JSON.stringify(options.event.payload),
        ],
      );

      // Duplicate delivery check: if rowCount is 0, event was already durably recorded & committed
      if (!insertEventRes.rowCount || insertEventRes.rowCount === 0) {
        await client.query('COMMIT');
        return {
          recorded: false,
          duplicate: true,
          orderUpdated: false,
          reason: 'Duplicate webhook event already processed',
        };
      }

      // 2. If no target order ID provided, commit the recorded event and return
      if (!options.targetOrderId) {
        await client.query('COMMIT');
        return {
          recorded: true,
          duplicate: false,
          orderUpdated: false,
          reason: 'Webhook event recorded; no target order specified',
        };
      }

      // 3. Lock target order row with SELECT ... FOR UPDATE
      const orderRes = await client.query('SELECT * FROM payment_orders WHERE id = $1 FOR UPDATE', [
        options.targetOrderId,
      ]);

      if (orderRes.rowCount === 0) {
        // Unknown order: safe acknowledgement, do not invent local order
        await client.query('COMMIT');
        return {
          recorded: true,
          duplicate: false,
          orderUpdated: false,
          reason: `Target order ${options.targetOrderId} not found in repository; no state mutated`,
        };
      }

      const existingOrder = this.mapRow(orderRes.rows[0]);

      // 4. Verify monetary integrity if expected amount/currency provided
      if (options.expectedCurrency && options.expectedAmountMinor !== undefined) {
        if (
          options.expectedCurrency !== existingOrder.currency ||
          options.expectedAmountMinor !== existingOrder.amountMinor
        ) {
          // Monetary mismatch: do not mutate order, commit event claim to avoid repetitive invalid transitions
          await client.query('COMMIT');
          return {
            recorded: true,
            duplicate: false,
            orderUpdated: false,
            order: existingOrder,
            reason: `Monetary mismatch: order=${existingOrder.currency} ${existingOrder.amountMinor} vs event=${options.expectedCurrency} ${options.expectedAmountMinor}`,
          };
        }
      }

      // 5. Evaluate state transition if transition requested
      if (options.transition) {
        const targetStatus = options.transition.targetStatus;
        const targetCaptureId = options.transition.captureId ?? existingOrder.captureId;

        const decision = evaluateStateTransition(existingOrder.status, targetStatus, {
          captureId: targetCaptureId,
        });

        if (!decision.allowed) {
          // Monotonic regression or invalid transition rejected: order state preserved (S_1 = S_0)
          await client.query('COMMIT');
          return {
            recorded: true,
            duplicate: false,
            orderUpdated: false,
            order: existingOrder,
            reason: `Transition rejected: ${decision.reason}`,
          };
        }

        // Apply permitted transition
        const mergedMetadata = options.transition.metadata
          ? { ...existingOrder.metadata, ...options.transition.metadata }
          : existingOrder.metadata;

        const updateRes = await client.query(
          `UPDATE payment_orders
           SET
             status = $2,
             capture_id = COALESCE($3, capture_id),
             captured_at = COALESCE($4, captured_at),
             approval_url = COALESCE($5, approval_url),
             metadata = $6,
             updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [
            options.targetOrderId,
            targetStatus,
            options.transition.captureId ?? null,
            options.transition.capturedAt ?? null,
            options.transition.approvalUrl ?? null,
            JSON.stringify(mergedMetadata ?? {}),
          ],
        );

        await client.query('COMMIT');
        return {
          recorded: true,
          duplicate: false,
          orderUpdated: true,
          order: this.mapRow(updateRes.rows[0]),
          reason: decision.reason,
        };
      }

      await client.query('COMMIT');
      return {
        recorded: true,
        duplicate: false,
        orderUpdated: false,
        order: existingOrder,
      };
    } catch (err) {
      // ATOMIC ROLLBACK: If order update or DB fails, roll back event claim so retry can succeed!
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private mapRow(row: Record<string, unknown>): StoredPaymentOrder {
    return {
      id: String(row.id),
      proposalId: String(row.proposal_id),
      policyDecisionId: row.policy_decision_id ? String(row.policy_decision_id) : '',
      provider: (row.provider as 'mock' | 'paypal_sandbox') || 'mock',
      status: (row.status as PaymentOrderStatus) || 'CREATED',
      currency: String(row.currency),
      amountMinor: Number(row.amount_minor),
      approvalUrl: row.approval_url ? String(row.approval_url) : undefined,
      captureId: row.capture_id ? String(row.capture_id) : undefined,
      capturedAt: row.captured_at ? new Date(String(row.captured_at)).toISOString() : undefined,
      idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : undefined,
      requestHash: row.request_hash ? String(row.request_hash) : undefined,
      metadata:
        typeof row.metadata === 'string'
          ? (JSON.parse(row.metadata) as Record<string, unknown>)
          : (row.metadata as Record<string, unknown>) || {},
      createdAt: new Date(String(row.created_at)).toISOString(),
      updatedAt: new Date(String(row.updated_at)).toISOString(),
      lastReconciledAt: row.last_reconciled_at
        ? new Date(String(row.last_reconciled_at)).toISOString()
        : undefined,
      reconciliationStatus: row.reconciliation_status
        ? String(row.reconciliation_status)
        : undefined,
    };
  }
}
