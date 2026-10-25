import { describe, it, expect } from 'vitest';
import {
  normalizeSearchQuery,
  createDedupeKey,
  deduplicateCandidates,
  rankCandidates,
  createProductCandidate,
  ProductCandidateSchema,
  ProductSearchQuerySchema,
  type ProductCandidate,
} from '../src/product-discovery.js';

describe('Product Discovery Contracts and Algorithms', () => {
  describe('normalizeSearchQuery', () => {
    it('normalizes whitespace and trims', () => {
      const raw = '   Ergonomic   Office   Chair   ';
      expect(normalizeSearchQuery(raw)).toBe('Ergonomic Office Chair');
    });

    it('strips ASCII and Unicode control characters', () => {
      const raw = 'A5\u0000 Spiral\u001F Notebook\u007F';
      expect(normalizeSearchQuery(raw)).toBe('A5 Spiral Notebook');
    });

    it('applies Unicode NFKC normalization', () => {
      // Combining accent e + acute vs precomposed e with acute
      const decomposed = 'caf\u0065\u0301';
      const precomposed = 'café';
      expect(normalizeSearchQuery(decomposed)).toBe(precomposed);
    });

    it('preserves model numbers, SKUs, and hyphenated names', () => {
      const query = 'Dell XPS 15 9520 Core i7-12700H RTX-3050';
      expect(normalizeSearchQuery(query)).toBe(query);
    });

    it('enforces maximum length of 120 characters', () => {
      const longQuery = 'A'.repeat(200);
      const normalized = normalizeSearchQuery(longQuery);
      expect(normalized.length).toBe(120);
    });

    it('throws when query is empty or whitespace-only', () => {
      expect(() => normalizeSearchQuery('')).toThrow(
        /cannot be empty or contain only whitespace/,
      );
      expect(() => normalizeSearchQuery('   \t\n  ')).toThrow(
        /cannot be empty or contain only whitespace/,
      );
      expect(() => normalizeSearchQuery('\u0000\u001F')).toThrow(
        /cannot be empty or contain only whitespace/,
      );
    });
  });

  describe('ProductCandidateSchema and createProductCandidate', () => {
    it('creates and validates a standard USD candidate with 2 decimals', () => {
      const candidate = createProductCandidate({
        providerId: 'prov-mock',
        providerProductId: 'prod-001',
        merchantId: 'merch-acme',
        merchantName: 'Acme Corp',
        title: 'Ergonomic Keyboard',
        productUrl: 'https://example.com/products/keyboard',
        unitPriceMinor: 8900,
        currency: 'USD',
        priceFreshnessTimestamp: new Date().toISOString(),
        priceProvenance: 'PROVIDER_VERIFIED',
        availability: 'IN_STOCK',
      });

      expect(candidate.currencyDecimals).toBe(2);
      expect(candidate.dedupeKey).toBe('prov-mock:prod-001');
      expect(candidate.unitPriceMinor).toBe(8900);
    });

    it('automatically assigns 0 decimals for JPY and 3 decimals for BHD/KWD', () => {
      const jpyCandidate = createProductCandidate({
        providerId: 'prov-mock',
        providerProductId: 'prod-jpy',
        merchantId: 'merch-tokyo',
        merchantName: 'Tokyo Tech',
        title: 'Sony Headphones',
        productUrl: 'https://example.com/headphones',
        unitPriceMinor: 15000,
        currency: 'JPY',
        priceFreshnessTimestamp: new Date().toISOString(),
        priceProvenance: 'PROVIDER_VERIFIED',
      });
      expect(jpyCandidate.currencyDecimals).toBe(0);

      const bhdCandidate = createProductCandidate({
        providerId: 'prov-mock',
        providerProductId: 'prod-bhd',
        merchantId: 'merch-gulf',
        merchantName: 'Gulf Supplies',
        title: 'Enterprise Server',
        productUrl: 'https://example.com/server',
        unitPriceMinor: 500000,
        currency: 'BHD',
        priceFreshnessTimestamp: new Date().toISOString(),
        priceProvenance: 'PROVIDER_VERIFIED',
      });
      expect(bhdCandidate.currencyDecimals).toBe(3);
    });

    it('rejects floating-point minor units or negative prices', () => {
      expect(() =>
        ProductCandidateSchema.parse({
          providerId: 'prov-mock',
          providerProductId: 'p1',
          merchantId: 'm1',
          merchantName: 'Acme',
          title: 'Item',
          productUrl: 'https://example.com/p1',
          unitPriceMinor: 19.99, // Float!
          currency: 'USD',
          currencyDecimals: 2,
          priceFreshnessTimestamp: new Date().toISOString(),
          priceProvenance: 'PROVIDER_VERIFIED',
          availability: 'IN_STOCK',
          dedupeKey: 'prov-mock:p1',
        }),
      ).toThrow();

      expect(() =>
        ProductCandidateSchema.parse({
          providerId: 'prov-mock',
          providerProductId: 'p1',
          merchantId: 'm1',
          merchantName: 'Acme',
          title: 'Item',
          productUrl: 'https://example.com/p1',
          unitPriceMinor: -500, // Negative!
          currency: 'USD',
          currencyDecimals: 2,
          priceFreshnessTimestamp: new Date().toISOString(),
          priceProvenance: 'PROVIDER_VERIFIED',
          availability: 'IN_STOCK',
          dedupeKey: 'prov-mock:p1',
        }),
      ).toThrow();
    });

    it('rejects unsafe URL schemes like javascript: or file:', () => {
      expect(() =>
        createProductCandidate({
          providerId: 'prov-mock',
          providerProductId: 'p1',
          merchantId: 'm1',
          merchantName: 'Acme',
          title: 'Item',
          productUrl: 'javascript:alert(1)',
          unitPriceMinor: 1000,
          currency: 'USD',
          priceFreshnessTimestamp: new Date().toISOString(),
          priceProvenance: 'PROVIDER_VERIFIED',
        }),
      ).toThrow();

      expect(() =>
        createProductCandidate({
          providerId: 'prov-mock',
          providerProductId: 'p1',
          merchantId: 'm1',
          merchantName: 'Acme',
          title: 'Item',
          productUrl: 'file:///etc/passwd',
          unitPriceMinor: 1000,
          currency: 'USD',
          priceFreshnessTimestamp: new Date().toISOString(),
          priceProvenance: 'PROVIDER_VERIFIED',
        }),
      ).toThrow();
    });
  });

  describe('Deduplication and Ranking', () => {
    const makeCandidate = (
      providerId: string,
      productId: string,
      title: string,
      priceMinor: number,
      merchantName: string = 'Acme Supplies',
    ): ProductCandidate =>
      createProductCandidate({
        providerId,
        providerProductId: productId,
        merchantId: 'merch-01',
        merchantName,
        title,
        productUrl: `https://example.com/products/${productId}`,
        unitPriceMinor: priceMinor,
        currency: 'USD',
        priceFreshnessTimestamp: new Date().toISOString(),
        priceProvenance: 'PROVIDER_VERIFIED',
        availability: 'IN_STOCK',
      });

    it('deduplicates identical provider/product IDs in O(n) time', () => {
      const c1 = makeCandidate('prov-1', 'item-101', 'A5 Spiral Notebook', 500);
      const c2 = makeCandidate('prov-1', 'item-101', 'A5 Spiral Notebook (Duplicate)', 500);
      const c3 = makeCandidate('prov-1', 'item-102', 'A5 Hardcover Notebook', 800);

      const deduplicated = deduplicateCandidates([c1, c2, c3]);
      expect(deduplicated).toHaveLength(2);
      expect(deduplicated[0]?.providerProductId).toBe('item-101');
      expect(deduplicated[1]?.providerProductId).toBe('item-102');
    });

    it('generates consistent dedupe keys', () => {
      expect(createDedupeKey('prov-mock', 'prod-123')).toBe('prov-mock:prod-123');
    });

    it('returns EXACT_MATCH when exactly 1 candidate matches', () => {
      const c1 = makeCandidate('prov-1', 'item-chair-01', 'Ergonomic Office Chair', 18000);
      const { ranked, status } = rankCandidates([c1], 'chair');

      expect(status).toBe('EXACT_MATCH');
      expect(ranked).toHaveLength(1);
      expect(ranked[0]?.providerProductId).toBe('item-chair-01');
    });

    it('returns SELECTION_REQUIRED when multiple plausible candidates match', () => {
      const c1 = makeCandidate('prov-1', 'nb-01', 'A5 Spiral Notebook College Ruled', 500);
      const c2 = makeCandidate('prov-1', 'nb-02', 'A5 Grid Journal Notebook Leather', 900);
      const { ranked, status } = rankCandidates([c1, c2], 'notebook');

      expect(status).toBe('SELECTION_REQUIRED');
      expect(ranked).toHaveLength(2);
    });

    it('returns NO_MATCHES when candidate list is empty', () => {
      const { ranked, status } = rankCandidates([], 'nonexistent product');
      expect(status).toBe('NO_MATCHES');
      expect(ranked).toHaveLength(0);
    });

    it('boosts candidate matching merchant preference', () => {
      const c1 = makeCandidate('prov-1', 'm-01', 'Wireless Mouse', 2500, 'Generic Electronics');
      const c2 = makeCandidate('prov-1', 'm-02', 'Wireless Mouse', 2800, 'TechDirect Prime');

      const { ranked } = rankCandidates([c1, c2], 'mouse', 'TechDirect');
      expect(ranked[0]?.merchantName).toBe('TechDirect Prime');
    });
  });

  describe('ProductSearchQuerySchema bounds', () => {
    it('accepts valid bounded query', () => {
      const parsed = ProductSearchQuerySchema.parse({
        query: 'ThinkPad X1',
        maxResults: 15,
        currency: 'USD',
      });
      expect(parsed.maxResults).toBe(15);
      expect(parsed.query).toBe('ThinkPad X1');
    });

    it('defaults maxResults to 10 and clamps upper bound at 50', () => {
      const defaultParsed = ProductSearchQuerySchema.parse({ query: 'Laptop' });
      expect(defaultParsed.maxResults).toBe(10);

      expect(() =>
        ProductSearchQuerySchema.parse({ query: 'Laptop', maxResults: 100 }),
      ).toThrow();
    });
  });
});
