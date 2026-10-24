import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { buildApp } from '../src/app.js';
import { InMemoryAuditRepository } from '../src/repository.js';

describe('Audit Service', () => {
  const repo = new InMemoryAuditRepository();
  const app = buildApp(repo);

  it('GET /health returns status ok with storage metadata', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.service).toBe('audit-service');
    expect(body.details.tamperEvidenceNote).toBeDefined();
  });

  it('POST /events records event and redacts sensitive credentials from metadata', async () => {
    const correlationId = uuidv4();
    const res = await app.inject({
      method: 'POST',
      url: '/events',
      payload: {
        correlationId,
        eventType: 'POLICY_EVALUATED_ALLOW',
        actor: 'policy-service',
        resourceId: uuidv4(),
        outcome: 'ALLOW',
        reasonCode: 'ALLOW_WITHIN_LIMITS',
        metadata: {
          decisionId: 'dec-123',
          normalKey: 'regularValue',
          password: 'superSecretPassword',
          api_key: 'sk_live_123456789',
          creditCard: '4111111111111111',
          nested: {
            token: 'bearer_token_xyz',
            safeNested: 'hello',
          },
        },
      },
    });

    expect(res.statusCode).toBe(201);
    const event = JSON.parse(res.body);
    expect(event.id).toBeDefined();
    expect(event.correlationId).toBe(correlationId);
    expect(event.metadata.normalKey).toBe('regularValue');
    expect(event.metadata.password).toBe('[REDACTED_AUDIT_DATA]');
    expect(event.metadata.api_key).toBe('[REDACTED_AUDIT_DATA]');
    expect(event.metadata.creditCard).toBe('[REDACTED_AUDIT_DATA]');
    expect(event.metadata.nested.token).toBe('[REDACTED_AUDIT_DATA]');
    expect(event.metadata.nested.safeNested).toBe('hello');

    // Retrieve events
    const listRes = await app.inject({
      method: 'GET',
      url: `/events?correlationId=${correlationId}`,
    });
    expect(listRes.statusCode).toBe(200);
    const list = JSON.parse(listRes.body);
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(event.id);
  });

  it('POST /events rejects payload without required fields with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/events',
      payload: {
        // missing eventType, correlationId, etc.
        actor: 'unknown',
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});
