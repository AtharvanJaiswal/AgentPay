import pg from 'pg';
import type {
  ProposalRepository,
  StoredPurchaseProposal,
  ProposalLifecycleStatus,
} from '@agentpay/contracts';
import {
  ProposalIdempotencyConflictError,
  InvalidProposalStateTransitionError,
  ForbiddenProposalAccessError,
  isValidProposalStatusTransition,
} from '@agentpay/contracts';

/**
 * In-Memory Proposal Repository for unit testing and local offline execution.
 */
export class InMemoryProposalRepository implements ProposalRepository {
  private proposals = new Map<string, StoredPurchaseProposal>();
  private idempotencyIndex = new Map<string, string>(); // scopedKey -> proposalId

  private getScopedKey(scope: string, key: string): string {
    return `${scope}:${key}`;
  }

  async createProposal(proposal: StoredPurchaseProposal): Promise<StoredPurchaseProposal> {
    const scopedKey = this.getScopedKey(proposal.idempotencyScope, proposal.idempotencyKey);
    const existingId = this.idempotencyIndex.get(scopedKey);

    if (existingId) {
      const existing = this.proposals.get(existingId);
      if (existing) {
        if (existing.requestHash !== proposal.requestHash) {
          throw new ProposalIdempotencyConflictError(
            `Idempotency key '${proposal.idempotencyKey}' was already used with a different intent payload in scope '${proposal.idempotencyScope}'`,
          );
        }
        return existing;
      }
    }

    const saved: StoredPurchaseProposal = {
      ...proposal,
      metadata: proposal.metadata ?? {},
      createdAt: proposal.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.proposals.set(saved.id, saved);
    this.idempotencyIndex.set(scopedKey, saved.id);
    return saved;
  }

  async getProposalById(id: string): Promise<StoredPurchaseProposal | null> {
    return this.proposals.get(id) ?? null;
  }

  async getProposalByIdempotencyKey(
    scope: string,
    key: string,
  ): Promise<StoredPurchaseProposal | null> {
    const scopedKey = this.getScopedKey(scope, key);
    const id = this.idempotencyIndex.get(scopedKey);
    return id ? (this.proposals.get(id) ?? null) : null;
  }

  async updateProposalStatus(
    id: string,
    status: ProposalLifecycleStatus,
    updates?: {
      expectedPrincipalId?: string;
      policyDecisionId?: string;
      policyOutcome?: 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';
      policyReasonCode?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<StoredPurchaseProposal> {
    const existing = this.proposals.get(id);
    if (!existing) {
      throw new Error(`Proposal ${id} not found`);
    }

    // Ownership check
    if (
      updates?.expectedPrincipalId &&
      existing.principalId &&
      existing.principalId !== updates.expectedPrincipalId
    ) {
      throw new ForbiddenProposalAccessError(
        `Principal '${updates.expectedPrincipalId}' is not authorized to update proposal '${id}'`,
      );
    }

    // State machine lifecycle validation
    if (!isValidProposalStatusTransition(existing.status, status)) {
      throw new InvalidProposalStateTransitionError(existing.status, status);
    }

    const updated: StoredPurchaseProposal = {
      ...existing,
      status,
      policyDecisionId: updates?.policyDecisionId ?? existing.policyDecisionId,
      policyOutcome: updates?.policyOutcome ?? existing.policyOutcome,
      policyReasonCode: updates?.policyReasonCode ?? existing.policyReasonCode,
      metadata: updates?.metadata
        ? { ...existing.metadata, ...updates.metadata }
        : existing.metadata,
      updatedAt: new Date().toISOString(),
    };

    this.proposals.set(id, updated);
    return updated;
  }
}

/**
 * PostgreSQL Implementation of the Proposal Repository.
 * Enforces transactional concurrency, idempotency scope uniqueness, and durable persistence.
 */
export class PostgresProposalRepository implements ProposalRepository {
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

  async checkHealth(): Promise<boolean> {
    try {
      const res = await this.pool.query('SELECT 1');
      return res.rowCount === 1;
    } catch {
      return false;
    }
  }

  async createProposal(proposal: StoredPurchaseProposal): Promise<StoredPurchaseProposal> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Check existing scoped idempotency key with SELECT FOR UPDATE
      const existingRes = await client.query(
        `SELECT * FROM purchase_proposals
         WHERE idempotency_scope = $1 AND idempotency_key = $2
         FOR UPDATE`,
        [proposal.idempotencyScope, proposal.idempotencyKey],
      );

      if (existingRes.rowCount && existingRes.rowCount > 0) {
        const existing = this.mapRow(existingRes.rows[0]);
        if (existing.requestHash !== proposal.requestHash) {
          await client.query('ROLLBACK');
          throw new ProposalIdempotencyConflictError(
            `Idempotency key '${proposal.idempotencyKey}' was already used with a different intent payload in scope '${proposal.idempotencyScope}'`,
          );
        }
        await client.query('COMMIT');
        return existing;
      }

      // Atomically insert proposal with ON CONFLICT DO NOTHING
      const insertRes = await client.query(
        `INSERT INTO purchase_proposals (
           id, request_id, idempotency_key, idempotency_scope, request_hash, status,
           product_query, product_id, product_name, merchant_id, merchant_name, merchant_category,
           quantity, currency, unit_price_minor, subtotal_minor, tax_minor, shipping_minor, total_amount_minor,
           policy_decision_id, policy_outcome, policy_reason_code, principal_id, correlation_id, metadata,
           created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, NOW(), NOW())
         ON CONFLICT (idempotency_scope, idempotency_key) DO NOTHING
         RETURNING *`,
        [
          proposal.id,
          proposal.requestId,
          proposal.idempotencyKey,
          proposal.idempotencyScope,
          proposal.requestHash,
          proposal.status,
          proposal.productQuery,
          proposal.productId ?? null,
          proposal.productName ?? null,
          proposal.merchantId ?? null,
          proposal.merchantName ?? null,
          proposal.merchantCategory ?? null,
          proposal.quantity,
          proposal.currency,
          proposal.unitPriceMinor ?? null,
          proposal.subtotalMinor ?? null,
          proposal.taxMinor ?? 0,
          proposal.shippingMinor ?? 0,
          proposal.totalAmountMinor ?? null,
          proposal.policyDecisionId ?? null,
          proposal.policyOutcome ?? null,
          proposal.policyReasonCode ?? null,
          proposal.principalId ?? null,
          proposal.correlationId,
          JSON.stringify(proposal.metadata ?? {}),
        ],
      );

      if (!insertRes.rowCount || insertRes.rowCount === 0) {
        // Concurrent race condition: another transaction committed between check and insert
        const raceRes = await client.query(
          `SELECT * FROM purchase_proposals
           WHERE idempotency_scope = $1 AND idempotency_key = $2
           FOR UPDATE`,
          [proposal.idempotencyScope, proposal.idempotencyKey],
        );
        const existing = this.mapRow(raceRes.rows[0]);
        if (existing.requestHash !== proposal.requestHash) {
          await client.query('ROLLBACK');
          throw new ProposalIdempotencyConflictError(
            `Idempotency key '${proposal.idempotencyKey}' was already used with a different intent payload in scope '${proposal.idempotencyScope}'`,
          );
        }
        await client.query('COMMIT');
        return existing;
      }

      await client.query('COMMIT');
      return this.mapRow(insertRes.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getProposalById(id: string): Promise<StoredPurchaseProposal | null> {
    const res = await this.pool.query('SELECT * FROM purchase_proposals WHERE id = $1', [id]);
    if (res.rowCount === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async getProposalByIdempotencyKey(
    scope: string,
    key: string,
  ): Promise<StoredPurchaseProposal | null> {
    const res = await this.pool.query(
      'SELECT * FROM purchase_proposals WHERE idempotency_scope = $1 AND idempotency_key = $2',
      [scope, key],
    );
    if (res.rowCount === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async updateProposalStatus(
    id: string,
    status: ProposalLifecycleStatus,
    updates?: {
      expectedPrincipalId?: string;
      policyDecisionId?: string;
      policyOutcome?: 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';
      policyReasonCode?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<StoredPurchaseProposal> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const existingRes = await client.query(
        'SELECT * FROM purchase_proposals WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (existingRes.rowCount === 0) {
        await client.query('ROLLBACK');
        throw new Error(`Proposal ${id} not found`);
      }

      const existing = this.mapRow(existingRes.rows[0]);

      // Ownership check
      if (
        updates?.expectedPrincipalId &&
        existing.principalId &&
        existing.principalId !== updates.expectedPrincipalId
      ) {
        await client.query('ROLLBACK');
        throw new ForbiddenProposalAccessError(
          `Principal '${updates.expectedPrincipalId}' is not authorized to update proposal '${id}'`,
        );
      }

      // State machine lifecycle validation
      if (!isValidProposalStatusTransition(existing.status, status)) {
        await client.query('ROLLBACK');
        throw new InvalidProposalStateTransitionError(existing.status, status);
      }

      const mergedMetadata = updates?.metadata
        ? { ...existing.metadata, ...updates.metadata }
        : existing.metadata;

      const updateRes = await client.query(
        `UPDATE purchase_proposals
         SET
           status = $2,
           policy_decision_id = COALESCE($3, policy_decision_id),
           policy_outcome = COALESCE($4, policy_outcome),
           policy_reason_code = COALESCE($5, policy_reason_code),
           metadata = $6,
           updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          id,
          status,
          updates?.policyDecisionId ?? null,
          updates?.policyOutcome ?? null,
          updates?.policyReasonCode ?? null,
          JSON.stringify(mergedMetadata ?? {}),
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

  private mapRow(row: Record<string, unknown>): StoredPurchaseProposal {
    return {
      id: String(row.id),
      requestId: String(row.request_id),
      idempotencyKey: String(row.idempotency_key),
      idempotencyScope: String(row.idempotency_scope),
      requestHash: String(row.request_hash),
      status: String(row.status) as ProposalLifecycleStatus,
      productQuery: String(row.product_query),
      productId: row.product_id ? String(row.product_id) : undefined,
      productName: row.product_name ? String(row.product_name) : undefined,
      merchantId: row.merchant_id ? String(row.merchant_id) : undefined,
      merchantName: row.merchant_name ? String(row.merchant_name) : undefined,
      merchantCategory: row.merchant_category ? String(row.merchant_category) : undefined,
      quantity: Number(row.quantity),
      currency: String(row.currency),
      unitPriceMinor: row.unit_price_minor !== null ? Number(row.unit_price_minor) : undefined,
      subtotalMinor: row.subtotal_minor !== null ? Number(row.subtotal_minor) : undefined,
      taxMinor: row.tax_minor !== null ? Number(row.tax_minor) : undefined,
      shippingMinor: row.shipping_minor !== null ? Number(row.shipping_minor) : undefined,
      totalAmountMinor:
        row.total_amount_minor !== null ? Number(row.total_amount_minor) : undefined,
      policyDecisionId: row.policy_decision_id ? String(row.policy_decision_id) : undefined,
      policyOutcome: row.policy_outcome
        ? (String(row.policy_outcome) as 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL')
        : undefined,
      policyReasonCode: row.policy_reason_code ? String(row.policy_reason_code) : undefined,
      principalId: row.principal_id ? String(row.principal_id) : undefined,
      correlationId: String(row.correlation_id),
      metadata:
        typeof row.metadata === 'string'
          ? JSON.parse(row.metadata)
          : (row.metadata as Record<string, unknown>) || {},
      createdAt: new Date(String(row.created_at)).toISOString(),
      updatedAt: new Date(String(row.updated_at)).toISOString(),
    };
  }
}
