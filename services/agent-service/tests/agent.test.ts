import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { FixtureAIProvider } from '../src/provider.js';

describe('Agent Service', () => {
  const app = buildApp(new FixtureAIProvider());

  it('GET /health returns status ok with version and service name', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.service).toBe('agent-service');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(body.details.provider).toContain('FixtureAIProvider');
  });

  it('POST /proposals/parse returns validated proposal with integer minor units', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/proposals/parse',
      headers: {
        'x-correlation-id': 'test-corr-123',
      },
      payload: {
        rawIntent: 'I need to register domain mycoolagent.com',
        agentId: 'autonomous-agent-77',
      },
    });

    expect(res.statusCode).toBe(201);
    const proposal = JSON.parse(res.body);
    expect(proposal.id).toBeDefined();
    expect(proposal.agentId).toBe('autonomous-agent-77');
    expect(proposal.currency).toBe('USD');
    expect(Number.isInteger(proposal.totalAmountMinor)).toBe(true);
    expect(proposal.totalAmountMinor).toBe(2000); // $20.00 in cents
    expect(proposal.items[0].unitPriceMinor).toBe(2000);
    expect(res.headers['x-correlation-id']).toBe('test-corr-123');
  });

  it('POST /proposals/parse rejects invalid input payload with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/proposals/parse',
      payload: {
        // missing rawIntent
        agentId: 'agent-x',
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});
