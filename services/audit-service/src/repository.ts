import { v4 as uuidv4 } from 'uuid';
import pg from 'pg';
import type { AuditRepository, AuditEvent, CreateAuditEventInput } from '@agentpay/contracts';

const SENSITIVE_KEY_PATTERN =
  /(password|token|secret|authorization|credit_?card|card_?number|cvv|api_?key)/i;

export function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      sanitized[key] = '[REDACTED_AUDIT_DATA]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      sanitized[key] = sanitizeMetadata(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

export class InMemoryAuditRepository implements AuditRepository {
  private events: AuditEvent[] = [];

  async recordEvent(input: CreateAuditEventInput): Promise<AuditEvent> {
    const event: AuditEvent = {
      id: input.id ?? uuidv4(),
      correlationId: input.correlationId,
      eventType: input.eventType,
      actor: input.actor,
      resourceId: input.resourceId,
      timestamp: input.timestamp ?? new Date().toISOString(),
      metadata: sanitizeMetadata(input.metadata),
      outcome: input.outcome,
      reasonCode: input.reasonCode,
    };

    this.events.unshift(event);
    return event;
  }

  async listEvents(limit = 50, correlationId?: string): Promise<AuditEvent[]> {
    let filtered = this.events;
    if (correlationId) {
      filtered = filtered.filter((e) => e.correlationId === correlationId);
    }
    return filtered.slice(0, limit);
  }
}

/**
 * PostgreSQL Implementation of the Audit Repository.
 * Note: While persistent and indexed, relational database storage alone is NOT cryptographically
 * immutable or tamper-proof. A future phase may incorporate cryptographic chaining or external notarization.
 */
export class PostgresAuditRepository implements AuditRepository {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      connectionTimeoutMillis: 5000,
      max: 10,
    });
  }

  async checkHealth(): Promise<boolean> {
    try {
      const client = await this.pool.connect();
      await client.query('SELECT 1');
      client.release();
      return true;
    } catch {
      return false;
    }
  }

  async recordEvent(input: CreateAuditEventInput): Promise<AuditEvent> {
    const id = input.id ?? uuidv4();
    const timestamp = input.timestamp ?? new Date().toISOString();
    const sanitizedMeta = sanitizeMetadata(input.metadata);

    const query = `
      INSERT INTO audit_events (
        id,
        correlation_id,
        event_type,
        actor,
        resource_id,
        timestamp,
        metadata,
        outcome,
        reason_code
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, correlation_id, event_type, actor, resource_id, timestamp, metadata, outcome, reason_code;
    `;

    const values = [
      id,
      input.correlationId,
      input.eventType,
      input.actor,
      input.resourceId,
      timestamp,
      JSON.stringify(sanitizedMeta),
      input.outcome ?? null,
      input.reasonCode ?? null,
    ];

    const result = await this.pool.query(query, values);
    const row = result.rows[0];

    return {
      id: row.id,
      correlationId: row.correlation_id,
      eventType: row.event_type,
      actor: row.actor,
      resourceId: row.resource_id,
      timestamp: new Date(row.timestamp).toISOString(),
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
      outcome: row.outcome ?? undefined,
      reasonCode: row.reason_code ?? undefined,
    };
  }

  async listEvents(limit = 50, correlationId?: string): Promise<AuditEvent[]> {
    let query = `
      SELECT id, correlation_id, event_type, actor, resource_id, timestamp, metadata, outcome, reason_code
      FROM audit_events
    `;
    const values: (string | number)[] = [];

    if (correlationId) {
      query += ` WHERE correlation_id = $1 ORDER BY timestamp DESC LIMIT $2`;
      values.push(correlationId, limit);
    } else {
      query += ` ORDER BY timestamp DESC LIMIT $1`;
      values.push(limit);
    }

    const result = await this.pool.query(query, values);
    return result.rows.map((row) => ({
      id: row.id,
      correlationId: row.correlation_id,
      eventType: row.event_type,
      actor: row.actor,
      resourceId: row.resource_id,
      timestamp: new Date(row.timestamp).toISOString(),
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
      outcome: row.outcome ?? undefined,
      reasonCode: row.reason_code ?? undefined,
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
