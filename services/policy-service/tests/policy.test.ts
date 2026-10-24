import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { createMockProposal } from '@agentpay/test-utils';
import { PolicyReasonCodes } from '@agentpay/contracts';

describe('Policy Service', () => {
  const app = buildApp();

  it('GET /health returns status ok with policy configuration details', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.service).toBe('policy-service');
    expect(body.details.maxLimitMinor).toBe(200000); // $2000
    expect(body.details.approvalThresholdMinor).toBe(50000); // $500
  });

  it('evaluates ALLOW for valid low-value purchase under approval threshold', async () => {
    const proposal = createMockProposal({
      totalAmountMinor: 3500, // $35.00
      currency: 'USD',
      items: [
        {
          id: 'item-1',
          name: 'Developer Tooling License',
          quantity: 1,
          unitPriceMinor: 3500,
          currency: 'USD',
        },
      ],
      merchant: {
        id: 'm-saas-01',
        name: 'DevTool Corp',
        category: 'developer_tools',
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/policies/evaluate',
      payload: proposal,
    });

    expect(res.statusCode).toBe(200);
    const decision = JSON.parse(res.body);
    expect(decision.outcome).toBe('ALLOW');
    expect(decision.reasonCode).toBe(PolicyReasonCodes.ALLOW_WITHIN_LIMITS);
    expect(decision.proposalId).toBe(proposal.id);
    expect(decision.policyVersion).toBe('1.0.0-foundation');
  });

  it('evaluates REQUIRE_APPROVAL for purchases above threshold but below hard limit', async () => {
    const proposal = createMockProposal({
      totalAmountMinor: 75000, // $750.00
      currency: 'USD',
      items: [
        {
          id: 'item-1',
          name: 'Enterprise Cloud Instance',
          quantity: 1,
          unitPriceMinor: 75000,
          currency: 'USD',
        },
      ],
      merchant: {
        id: 'm-cloud-01',
        name: 'Cloud Services',
        category: 'cloud_hosting',
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/policies/evaluate',
      payload: proposal,
    });

    expect(res.statusCode).toBe(200);
    const decision = JSON.parse(res.body);
    expect(decision.outcome).toBe('REQUIRE_APPROVAL');
    expect(decision.reasonCode).toBe(PolicyReasonCodes.REQUIRE_APPROVAL_HIGH_VALUE);
  });

  it('evaluates DENY for purchases exceeding hard maximum ceiling', async () => {
    const proposal = createMockProposal({
      totalAmountMinor: 300000, // $3,000.00 (> $2,000 hard limit)
      currency: 'USD',
      items: [
        {
          id: 'item-1',
          name: 'High End Dedicated Hardware',
          quantity: 1,
          unitPriceMinor: 300000,
          currency: 'USD',
        },
      ],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/policies/evaluate',
      payload: proposal,
    });

    expect(res.statusCode).toBe(200);
    const decision = JSON.parse(res.body);
    expect(decision.outcome).toBe('DENY');
    expect(decision.reasonCode).toBe(PolicyReasonCodes.DENY_EXCEEDS_HARD_LIMIT);
  });

  it('evaluates DENY for restricted merchant category', async () => {
    const proposal = createMockProposal({
      totalAmountMinor: 5000,
      currency: 'USD',
      items: [
        {
          id: 'item-1',
          name: 'Crypto Lottery Voucher',
          quantity: 1,
          unitPriceMinor: 5000,
          currency: 'USD',
        },
      ],
      merchant: {
        id: 'm-gambling-01',
        name: 'Lucky Token Stakes',
        category: 'gambling',
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/policies/evaluate',
      payload: proposal,
    });

    expect(res.statusCode).toBe(200);
    const decision = JSON.parse(res.body);
    expect(decision.outcome).toBe('DENY');
    expect(decision.reasonCode).toBe(PolicyReasonCodes.DENY_RESTRICTED_CATEGORY);
  });

  it('evaluates DENY for unsupported currency', async () => {
    const proposal = createMockProposal({
      totalAmountMinor: 2500,
      currency: 'EUR',
      items: [
        {
          id: 'item-1',
          name: 'EU Server',
          quantity: 1,
          unitPriceMinor: 2500,
          currency: 'EUR',
        },
      ],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/policies/evaluate',
      payload: proposal,
    });

    expect(res.statusCode).toBe(200);
    const decision = JSON.parse(res.body);
    expect(decision.outcome).toBe('DENY');
    expect(decision.reasonCode).toBe(PolicyReasonCodes.DENY_UNSUPPORTED_CURRENCY);
  });

  it('rejects invalid proposal payload with 400 validation error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/policies/evaluate',
      payload: {
        badField: 'invalid',
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});
