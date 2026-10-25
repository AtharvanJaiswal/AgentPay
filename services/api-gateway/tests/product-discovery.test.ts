import { describe, it, expect, beforeEach } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ServiceClient } from '../src/client.js';
import { TestAuthenticationProvider, ProductionPendingAuthenticationProvider } from '../src/auth.js';
import { CatalogResolver } from '../src/catalog/resolver.js';
import { MockProductDiscoveryProvider, HttpProductDiscoveryProvider } from '../src/catalog/provider.js';
import {
  ErrorCodes,
  type PurchaseProposal,
  type PolicyDecision,
  type StoredPurchaseProposal,
  type CreateAuditEventInput,
} from '@agentpay/contracts';
import { getApiGatewayConfig } from '@agentpay/config';

describe('Phase 3B — Product Discovery & Catalog Integration', () => {
  let mockClient: ServiceClient;
  let recordedAuditEvents: CreateAuditEventInput[];
  let inMemoryProposals: Map<string, StoredPurchaseProposal>;
  let mockDiscoveryProvider: MockProductDiscoveryProvider;
  let catalogResolver: CatalogResolver;

  beforeEach(() => {
    recordedAuditEvents = [];
    inMemoryProposals = new Map();
    mockDiscoveryProvider = new MockProductDiscoveryProvider();
    catalogResolver = new CatalogResolver(mockDiscoveryProvider);

    mockClient = {
      recordAuditEvent: async (event: CreateAuditEventInput) => {
        recordedAuditEvents.push(event);
        return {
          id: 'aud-uuid-1',
          timestamp: new Date().toISOString(),
          ...event,
        };
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
              principalId: 'test-user-principal-01',
            },
          },
        };
      },
      evaluatePolicy: async (proposal: PurchaseProposal) => {
        if (proposal.merchant.category === 'cryptocurrency') {
          return {
            decisionId: 'pol-deny-01',
            outcome: 'DENY',
            reasonCode: 'RESTRICTED_CATEGORY',
            reasonMessage: 'Category cryptocurrency is strictly prohibited by spending rules',
            evaluatedAt: new Date().toISOString(),
            violations: [{ rule: 'RESTRICTED_CATEGORY', message: 'Category blocked' }],
          } as PolicyDecision;
        }

        return {
          decisionId: 'pol-allow-01',
          outcome: 'ALLOW',
          reasonCode: 'WITHIN_LIMITS',
          reasonMessage: 'Transaction meets spending guidelines',
          evaluatedAt: new Date().toISOString(),
          violations: [],
        } as PolicyDecision;
      },
      persistProposal: async (proposal: StoredPurchaseProposal) => {
        const scopedKey = `${proposal.idempotencyScope}:${proposal.idempotencyKey}`;
        const existing = inMemoryProposals.get(scopedKey);
        if (existing) {
          if (existing.requestHash !== proposal.requestHash) {
            const err = new Error('Idempotency conflict');
            (err as unknown as { statusCode: number; code: string }).statusCode = 409;
            (err as unknown as { statusCode: number; code: string }).code = 'IDEMPOTENCY_CONFLICT';
            throw err;
          }
          return existing;
        }
        inMemoryProposals.set(scopedKey, proposal);
        return proposal;
      },
      getProposal: async (id: string) => {
        for (const p of inMemoryProposals.values()) {
          if (p.id === id) return p;
        }
        return null;
      },
      checkServiceHealth: async () => ({ status: 'ok', service: 'test-svc', version: '0.1.0', uptimeSeconds: 10, timestamp: new Date().toISOString() }),
    } as unknown as ServiceClient;
  });

  describe('1. Product Search Endpoint (POST /api/products/search)', () => {
    it('returns normalized candidates with bounded pagination and deduplication', async () => {
      const app = buildApp(
        mockClient,
        undefined,
        new TestAuthenticationProvider(),
        catalogResolver,
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/products/search',
        headers: { 'x-correlation-id': 'test-corr-search-01' },
        payload: {
          query: 'chair',
          maxResults: 5,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.query).toBe('chair');
      expect(body.status).toBe('SELECTION_REQUIRED');
      expect(body.totalFound).toBeGreaterThanOrEqual(2);
      expect(body.candidates.length).toBeLessThanOrEqual(5);

      // Verify normalized candidate schema fields
      const candidate = body.candidates[0];
      expect(candidate).toHaveProperty('providerId');
      expect(candidate).toHaveProperty('providerProductId');
      expect(candidate).toHaveProperty('merchantName');
      expect(candidate).toHaveProperty('unitPriceMinor');
      expect(candidate).toHaveProperty('currency');
      expect(candidate).toHaveProperty('priceProvenance');
      expect(candidate).toHaveProperty('dedupeKey');
      expect(candidate.unitPriceMinor).toBeGreaterThan(0);
      expect(Number.isInteger(candidate.unitPriceMinor)).toBe(true);

      // Verify audit events
      const searchRequested = recordedAuditEvents.find((e) => e.eventType === 'PRODUCT_SEARCH_REQUESTED');
      const searchSucceeded = recordedAuditEvents.find((e) => e.eventType === 'PRODUCT_SEARCH_SUCCEEDED');
      expect(searchRequested).toBeDefined();
      expect(searchSucceeded).toBeDefined();
      expect(searchSucceeded?.outcome).toBe('SELECTION_REQUIRED');
    });

    it('returns EXACT_MATCH when a single candidate uniquely matches query', async () => {
      const app = buildApp(
        mockClient,
        undefined,
        new TestAuthenticationProvider(),
        catalogResolver,
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/products/search',
        headers: { 'x-correlation-id': 'test-corr-exact-01' },
        payload: {
          query: 'prod-chair-01',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('EXACT_MATCH');
      expect(body.candidates).toHaveLength(1);
      expect(body.candidates[0].providerProductId).toBe('prod-chair-01');
    });

    it('returns NO_MATCHES when query yields no candidates', async () => {
      const app = buildApp(
        mockClient,
        undefined,
        new TestAuthenticationProvider(),
        catalogResolver,
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/products/search',
        headers: { 'x-correlation-id': 'test-corr-empty-01' },
        payload: {
          query: 'nonexistent-quantum-widget-xyz',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('NO_MATCHES');
      expect(body.candidates).toHaveLength(0);
      expect(body.totalFound).toBe(0);
    });

    it('supports currency filtering (e.g. JPY with 0 decimals, BHD with 3 decimals)', async () => {
      const app = buildApp(
        mockClient,
        undefined,
        new TestAuthenticationProvider(),
        catalogResolver,
      );

      // Search JPY camera
      const jpyRes = await app.inject({
        method: 'POST',
        url: '/api/products/search',
        headers: { 'x-correlation-id': 'test-corr-jpy' },
        payload: { query: 'camera', currency: 'JPY' },
      });
      expect(jpyRes.statusCode).toBe(200);
      const jpyBody = JSON.parse(jpyRes.body);
      expect(jpyBody.candidates).toHaveLength(1);
      expect(jpyBody.candidates[0].currency).toBe('JPY');
      expect(jpyBody.candidates[0].currencyDecimals).toBe(0);

      // Search BHD server
      const bhdRes = await app.inject({
        method: 'POST',
        url: '/api/products/search',
        headers: { 'x-correlation-id': 'test-corr-bhd' },
        payload: { query: 'server', currency: 'BHD' },
      });
      expect(bhdRes.statusCode).toBe(200);
      const bhdBody = JSON.parse(bhdRes.body);
      expect(bhdBody.candidates).toHaveLength(1);
      expect(bhdBody.candidates[0].currency).toBe('BHD');
      expect(bhdBody.candidates[0].currencyDecimals).toBe(3);
    });

    it('fails closed with HTTP 401 in production when unauthenticated', async () => {
      const app = buildApp(
        mockClient,
        undefined,
        new ProductionPendingAuthenticationProvider(),
        catalogResolver,
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/products/search',
        headers: {
          'x-correlation-id': 'test-corr-prod-auth',
          'x-principal-id': 'untrusted-spoofed-principal-99',
        },
        payload: { query: 'chair' },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(ErrorCodes.UNAUTHORIZED);
    });

    it('rejects invalid search payloads with 400 VALIDATION_ERROR', async () => {
      const app = buildApp(
        mockClient,
        undefined,
        new TestAuthenticationProvider(),
        catalogResolver,
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/products/search',
        headers: { 'x-correlation-id': 'test-corr-inv-01' },
        payload: {
          query: '', // Empty query!
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
    });

    it('handles simulated timeout with controlled 504 TIMEOUT response', async () => {
      const config = getApiGatewayConfig({
        ...process.env,
        PRODUCT_DISCOVERY_TIMEOUT_MS: '50',
      });
      const app = buildApp(
        mockClient,
        config,
        new TestAuthenticationProvider(),
        catalogResolver,
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/products/search',
        headers: { 'x-correlation-id': 'test-corr-timeout' },
        payload: { query: 'simulatetimeout chair' },
      });

      expect([502, 504]).toContain(res.statusCode);
      const body = JSON.parse(res.body);
      expect([ErrorCodes.TIMEOUT, ErrorCodes.SERVICE_UNAVAILABLE]).toContain(body.error.code);

      const failedAudit = recordedAuditEvents.find((e) => e.eventType === 'PRODUCT_SEARCH_FAILED');
      expect(failedAudit).toBeDefined();
    });
  });

  describe('2. User Selection & Authoritative Revalidation Flow', () => {
    it('executes purchase intent with selectedCandidate: revalidates, evaluates policy, and persists proposal', async () => {
      const app = buildApp(
        mockClient,
        undefined,
        new TestAuthenticationProvider(),
        catalogResolver,
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/purchase-intents',
        headers: { 'x-correlation-id': 'test-corr-select-01' },
        payload: {
          rawIntent: 'I want to purchase the ergonomic mesh chair',
          idempotencyKey: 'idem-select-chair-01',
          selectedCandidate: {
            providerId: 'mock-provider',
            providerProductId: 'prod-chair-01',
            expectedUnitPriceMinor: 18000,
            expectedCurrency: 'USD',
          },
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.outcome).toBe('PROPOSAL_CREATED');
      expect(body.proposal.productId).toBe('prod-chair-01');
      expect(body.proposal.unitPriceMinor).toBe(18000);
      expect(body.proposal.totalAmountMinor).toBe(18000);
      expect(body.proposal.metadata.priceProvenance).toBe('REVALIDATED');
      expect(body.proposal.metadata.providerProductId).toBe('prod-chair-01');

      // Verify audit trail for candidate selection & revalidation
      const selectionEvent = recordedAuditEvents.find((e) => e.eventType === 'PRODUCT_SELECTION_REQUESTED');
      const revalidationEvent = recordedAuditEvents.find((e) => e.eventType === 'PRODUCT_REVALIDATED');
      expect(selectionEvent).toBeDefined();
      expect(revalidationEvent).toBeDefined();
      expect(revalidationEvent?.outcome).toBe('VALID');
    });

    it('detects price shifts on revalidation and returns 409 PRICE_CHANGED_RECONFIRMATION_REQUIRED', async () => {
      const app = buildApp(
        mockClient,
        undefined,
        new TestAuthenticationProvider(),
        catalogResolver,
      );

      // prod-price-shift fixture returns 1000 on search, but 1250 on revalidation
      const res = await app.inject({
        method: 'POST',
        url: '/api/purchase-intents',
        headers: { 'x-correlation-id': 'test-corr-price-shift' },
        payload: {
          rawIntent: 'I want to buy dynamic price testing widget',
          idempotencyKey: 'idem-shift-01',
          selectedCandidate: {
            providerId: 'mock-provider',
            providerProductId: 'prod-price-shift',
            expectedUnitPriceMinor: 1000, // Client saw 1000
            expectedCurrency: 'USD',
          },
        },
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.outcome).toBe('PRICE_CHANGED_RECONFIRMATION_REQUIRED');
      expect(body.error.code).toBe(ErrorCodes.PRICE_CHANGED);
      expect(body.error.previousPriceMinor).toBe(1000);
      expect(body.error.currentPriceMinor).toBe(1250);

      // Verify audit event
      const priceShiftAudit = recordedAuditEvents.find((e) => e.eventType === 'PRODUCT_PRICE_CHANGED');
      expect(priceShiftAudit).toBeDefined();

      // Ensure no proposal was created
      expect(inMemoryProposals.size).toBe(0);
    });

    it('rejects selection of out-of-stock product with 422 OUT_OF_STOCK', async () => {
      const app = buildApp(
        mockClient,
        undefined,
        new TestAuthenticationProvider(),
        catalogResolver,
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/purchase-intents',
        headers: { 'x-correlation-id': 'test-corr-oos' },
        payload: {
          rawIntent: 'Buy discontinued mechanical keyboard',
          idempotencyKey: 'idem-oos-01',
          selectedCandidate: {
            providerId: 'mock-provider',
            providerProductId: 'prod-out-of-stock',
            expectedUnitPriceMinor: 12000,
            expectedCurrency: 'USD',
          },
        },
      });

      expect(res.statusCode).toBe(422);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(ErrorCodes.OUT_OF_STOCK);
      expect(inMemoryProposals.size).toBe(0);
    });

    it('returns 404 PRODUCT_NOT_FOUND when candidate does not exist in catalog provider', async () => {
      const app = buildApp(
        mockClient,
        undefined,
        new TestAuthenticationProvider(),
        catalogResolver,
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/purchase-intents',
        headers: { 'x-correlation-id': 'test-corr-nf' },
        payload: {
          rawIntent: 'Buy phantom product',
          idempotencyKey: 'idem-nf-01',
          selectedCandidate: {
            providerId: 'mock-provider',
            providerProductId: 'prod-phantom-999',
            expectedUnitPriceMinor: 500,
            expectedCurrency: 'USD',
          },
        },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(ErrorCodes.PRODUCT_NOT_FOUND);

      const failedAudit = recordedAuditEvents.find((e) => e.eventType === 'PRODUCT_REVALIDATION_FAILED');
      expect(failedAudit).toBeDefined();
    });

    it('enforces idempotency conflict (409) when same idempotency key is reused with different candidate', async () => {
      const app = buildApp(
        mockClient,
        undefined,
        new TestAuthenticationProvider(),
        catalogResolver,
      );

      // First request: Candidate A (chair 01)
      const res1 = await app.inject({
        method: 'POST',
        url: '/api/purchase-intents',
        headers: { 'x-correlation-id': 'test-corr-idem-1' },
        payload: {
          rawIntent: 'I need an office chair',
          idempotencyKey: 'idem-conflict-candidate-test',
          selectedCandidate: {
            providerId: 'mock-provider',
            providerProductId: 'prod-chair-01',
            expectedUnitPriceMinor: 18000,
          },
        },
      });
      expect(res1.statusCode).toBe(201);

      // Replay with identical candidate succeeds idempotently
      const resReplay = await app.inject({
        method: 'POST',
        url: '/api/purchase-intents',
        headers: { 'x-correlation-id': 'test-corr-idem-2' },
        payload: {
          rawIntent: 'I need an office chair',
          idempotencyKey: 'idem-conflict-candidate-test',
          selectedCandidate: {
            providerId: 'mock-provider',
            providerProductId: 'prod-chair-01',
            expectedUnitPriceMinor: 18000,
          },
        },
      });
      expect(resReplay.statusCode).toBe(201);

      // Conflict request: Reusing same key with Candidate B (chair 02)
      const resConflict = await app.inject({
        method: 'POST',
        url: '/api/purchase-intents',
        headers: { 'x-correlation-id': 'test-corr-idem-3' },
        payload: {
          rawIntent: 'I need an office chair',
          idempotencyKey: 'idem-conflict-candidate-test',
          selectedCandidate: {
            providerId: 'mock-provider',
            providerProductId: 'prod-chair-02',
            expectedUnitPriceMinor: 32000,
          },
        },
      });
      expect(resConflict.statusCode).toBe(409);
      const conflictBody = JSON.parse(resConflict.body);
      expect(conflictBody.error.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('enforces cross-principal isolation on proposal retrieval', async () => {
      const principalAApp = buildApp(
        mockClient,
        undefined,
        new TestAuthenticationProvider({ id: 'user-principal-A', authSource: 'test_adapter' }),
        catalogResolver,
      );

      const principalBApp = buildApp(
        mockClient,
        undefined,
        new TestAuthenticationProvider({ id: 'user-principal-B', authSource: 'test_adapter' }),
        catalogResolver,
      );

      // Principal A creates proposal
      const createRes = await principalAApp.inject({
        method: 'POST',
        url: '/api/purchase-intents',
        headers: { 'x-correlation-id': 'corr-iso-create' },
        payload: {
          rawIntent: 'I need an office chair',
          idempotencyKey: 'idem-iso-01',
          selectedCandidate: {
            providerId: 'mock-provider',
            providerProductId: 'prod-chair-01',
          },
        },
      });
      expect(createRes.statusCode).toBe(201);
      const proposal = JSON.parse(createRes.body).proposal;

      // Principal A can retrieve their own proposal
      const retrieveResA = await principalAApp.inject({
        method: 'GET',
        url: `/api/purchase-intents/${proposal.id}`,
        headers: { 'x-correlation-id': 'corr-iso-get-a' },
      });
      expect(retrieveResA.statusCode).toBe(200);

      // Principal B receives 403 Forbidden attempting to retrieve Principal A's proposal
      const retrieveResB = await principalBApp.inject({
        method: 'GET',
        url: `/api/purchase-intents/${proposal.id}`,
        headers: { 'x-correlation-id': 'corr-iso-get-b' },
      });
      expect(retrieveResB.statusCode).toBe(403);
      const forbiddenBody = JSON.parse(retrieveResB.body);
      expect(forbiddenBody.error.code).toBe(ErrorCodes.FORBIDDEN);
    });

    it('strictly prevents client from overriding authoritative price or merchant category', async () => {
      const app = buildApp(
        mockClient,
        undefined,
        new TestAuthenticationProvider(),
        catalogResolver,
      );

      // 1. Attempt top-level body field injection (price forgery)
      const resForgery = await app.inject({
        method: 'POST',
        url: '/api/purchase-intents',
        headers: { 'x-correlation-id': 'test-corr-forgery-01' },
        payload: {
          rawIntent: 'Buy executive desk chair',
          idempotencyKey: 'idem-forge-01',
          selectedCandidate: {
            providerId: 'mock-provider',
            providerProductId: 'prod-chair-02',
            expectedUnitPriceMinor: 32000,
          },
          // Attempted client forgery of authoritative fields
          unitPriceMinor: 100,
          totalAmountMinor: 100,
          category: 'super_safe_allowed',
        },
      });

      // Strict schema rejects injected unauthorized keys
      expect(resForgery.statusCode).toBe(400);
      const forgeryBody = JSON.parse(resForgery.body);
      expect(forgeryBody.error.code).toBe(ErrorCodes.VALIDATION_ERROR);

      // 2. Attempt client-fabricated expected price mismatch inside selectedCandidate
      const resPriceMismatch = await app.inject({
        method: 'POST',
        url: '/api/purchase-intents',
        headers: { 'x-correlation-id': 'test-corr-forgery-02' },
        payload: {
          rawIntent: 'Buy executive desk chair',
          idempotencyKey: 'idem-forge-02',
          selectedCandidate: {
            providerId: 'mock-provider',
            providerProductId: 'prod-chair-02',
            expectedUnitPriceMinor: 100, // Fabricated: real price is 32000
          },
        },
      });

      // Server-side revalidation rejects price difference with 409
      expect(resPriceMismatch.statusCode).toBe(409);
      const mismatchBody = JSON.parse(resPriceMismatch.body);
      expect(mismatchBody.error.code).toBe(ErrorCodes.PRICE_CHANGED);
      expect(mismatchBody.error.currentPriceMinor).toBe(32000);
    });
  });

  describe('3. SSRF and Adapter Resilience', () => {
    it('HttpProductDiscoveryProvider rejects internal loopback URLs in production', () => {
      const oldEnv = process.env['NODE_ENV'];
      try {
        process.env['NODE_ENV'] = 'production';
        expect(() => new HttpProductDiscoveryProvider('http://127.0.0.1:8080')).toThrow(
          /Internal and loopback base URLs are forbidden/,
        );
        expect(() => new HttpProductDiscoveryProvider('http://169.254.169.254/metadata')).toThrow(
          /Internal and loopback base URLs are forbidden/,
        );
      } finally {
        process.env['NODE_ENV'] = oldEnv;
      }
    });

    it('HttpProductDiscoveryProvider rejects non-HTTP/HTTPS URLs', () => {
      expect(() => new HttpProductDiscoveryProvider('file:///etc/passwd')).toThrow(
        /requires a valid HTTP\/HTTPS baseUrl/,
      );
      expect(() => new HttpProductDiscoveryProvider('ftp://external.server.com')).toThrow(
        /requires a valid HTTP\/HTTPS baseUrl/,
      );
    });
  });
});
