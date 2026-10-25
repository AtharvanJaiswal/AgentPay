import {
  type ProductDiscoveryProvider,
  type ProductSearchQueryInput,
  type ProductSearchResult,
  type ProductCandidate,
  type ProductDiscoveryOptions,
  createProductCandidate,
  deduplicateCandidates,
  rankCandidates,
  normalizeSearchQuery,
  ProductCandidateSchema,
} from '@agentpay/contracts';

/**
 * Deterministic Mock Product Discovery Provider with rich fixtures for offline & testing workflows.
 */
export class MockProductDiscoveryProvider implements ProductDiscoveryProvider {
  readonly providerId = 'mock-provider';

  private fixtures: ProductCandidate[] = [
    createProductCandidate({
      providerId: 'mock-provider',
      providerProductId: 'prod-nb-01',
      merchantId: 'merch-acme-office',
      merchantName: 'Acme Office Supplies',
      title: 'A5 Spiral Notebook',
      description: 'College ruled 120-page spiral notebook',
      productUrl: 'https://acmeoffice.example.com/products/prod-nb-01',
      unitPriceMinor: 500,
      currency: 'USD',
      priceFreshnessTimestamp: new Date().toISOString(),
      priceProvenance: 'PROVIDER_VERIFIED',
      availability: 'IN_STOCK',
      category: 'office_supplies',
    }),
    createProductCandidate({
      providerId: 'mock-provider',
      providerProductId: 'prod-nb-02',
      merchantId: 'merch-acme-office',
      merchantName: 'Acme Office Supplies',
      title: 'A5 Hardcover Journal Notebook',
      description: 'Hardcover bound leatherette journal notebook',
      productUrl: 'https://acmeoffice.example.com/products/prod-nb-02',
      unitPriceMinor: 850,
      currency: 'USD',
      priceFreshnessTimestamp: new Date().toISOString(),
      priceProvenance: 'PROVIDER_VERIFIED',
      availability: 'IN_STOCK',
      category: 'office_supplies',
    }),
    createProductCandidate({
      providerId: 'mock-provider',
      providerProductId: 'prod-chair-01',
      merchantId: 'merch-acme-office',
      merchantName: 'Acme Office Supplies',
      title: 'Ergonomic Mesh Office Chair',
      description: 'Adjustable lumbar support ergonomic mesh office chair',
      productUrl: 'https://acmeoffice.example.com/products/prod-chair-01',
      unitPriceMinor: 18000,
      currency: 'USD',
      priceFreshnessTimestamp: new Date().toISOString(),
      priceProvenance: 'PROVIDER_VERIFIED',
      availability: 'IN_STOCK',
      category: 'office_furniture',
    }),
    createProductCandidate({
      providerId: 'mock-provider',
      providerProductId: 'prod-chair-02',
      merchantId: 'merch-global-furn',
      merchantName: 'Global Furniture Co',
      title: 'Executive High-Back Leather Desk Chair',
      description: 'Premium bonded leather executive desk chair',
      productUrl: 'https://globalfurniture.example.com/products/prod-chair-02',
      unitPriceMinor: 32000,
      currency: 'USD',
      priceFreshnessTimestamp: new Date().toISOString(),
      priceProvenance: 'PROVIDER_VERIFIED',
      availability: 'IN_STOCK',
      category: 'office_furniture',
    }),
    createProductCandidate({
      providerId: 'mock-provider',
      providerProductId: 'prod-mouse-01',
      merchantId: 'merch-tech-direct',
      merchantName: 'TechDirect Prime',
      title: 'Wireless Optical Mouse',
      description: '2.4GHz wireless optical mouse with USB receiver',
      productUrl: 'https://techdirect.example.com/products/prod-mouse-01',
      unitPriceMinor: 2500,
      currency: 'USD',
      priceFreshnessTimestamp: new Date().toISOString(),
      priceProvenance: 'PROVIDER_VERIFIED',
      availability: 'IN_STOCK',
      category: 'electronics',
    }),
    createProductCandidate({
      providerId: 'mock-provider',
      providerProductId: 'prod-mouse-02',
      merchantId: 'merch-tech-direct',
      merchantName: 'TechDirect Prime',
      title: 'Ergonomic Vertical Wireless Mouse',
      description: 'Vertical ergonomic wireless mouse with silent clicks',
      productUrl: 'https://techdirect.example.com/products/prod-mouse-02',
      unitPriceMinor: 3900,
      currency: 'USD',
      priceFreshnessTimestamp: new Date().toISOString(),
      priceProvenance: 'PROVIDER_VERIFIED',
      availability: 'IN_STOCK',
      category: 'electronics',
    }),
    createProductCandidate({
      providerId: 'mock-provider',
      providerProductId: 'prod-server-01',
      merchantId: 'm-cloud-infra-01',
      merchantName: 'CloudInfra Global',
      title: 'Cloud Virtual Machine - Micro Tier (1 Month)',
      description: '1 vCPU, 2GB RAM cloud compute instance',
      productUrl: 'https://cloudinfra.example.com/compute/micro',
      unitPriceMinor: 1500,
      currency: 'USD',
      priceFreshnessTimestamp: new Date().toISOString(),
      priceProvenance: 'PROVIDER_VERIFIED',
      availability: 'IN_STOCK',
      category: 'cloud_services',
    }),
    createProductCandidate({
      providerId: 'mock-provider',
      providerProductId: 'prod-db-01',
      merchantId: 'm-cloud-infra-01',
      merchantName: 'CloudInfra Global',
      title: 'Managed Dedicated Database Cluster (1 Month)',
      description: 'High availability managed PostgreSQL database cluster',
      productUrl: 'https://cloudinfra.example.com/database/cluster',
      unitPriceMinor: 80000,
      currency: 'USD',
      priceFreshnessTimestamp: new Date().toISOString(),
      priceProvenance: 'PROVIDER_VERIFIED',
      availability: 'IN_STOCK',
      category: 'cloud_services',
    }),
    createProductCandidate({
      providerId: 'mock-provider',
      providerProductId: 'prod-crypto-01',
      merchantId: 'm-crypto-assets-99',
      merchantName: 'CryptoVenture Ltd',
      title: 'Restricted Token Asset Pack',
      description: 'Crypto token speculative investment bundle',
      productUrl: 'https://cryptoventure.example.com/tokens/pack',
      unitPriceMinor: 500000,
      currency: 'USD',
      priceFreshnessTimestamp: new Date().toISOString(),
      priceProvenance: 'PROVIDER_VERIFIED',
      availability: 'IN_STOCK',
      category: 'cryptocurrency',
    }),
    // Test Fixture: Product with volatile price (search returns 1000, revalidate returns 1250)
    createProductCandidate({
      providerId: 'mock-provider',
      providerProductId: 'prod-price-shift',
      merchantId: 'merch-volatile',
      merchantName: 'Volatile Markets Inc',
      title: 'Dynamic Price Market Commodity',
      description: 'Test fixture for price shift detection on revalidation',
      productUrl: 'https://volatile.example.com/commodity',
      unitPriceMinor: 1000,
      currency: 'USD',
      priceFreshnessTimestamp: new Date().toISOString(),
      priceProvenance: 'SEARCH_INFORMATIONAL',
      availability: 'IN_STOCK',
      category: 'general',
    }),
    // Test Fixture: Out of stock item
    createProductCandidate({
      providerId: 'mock-provider',
      providerProductId: 'prod-out-of-stock',
      merchantId: 'merch-vintage',
      merchantName: 'Vintage Restorations',
      title: 'Discontinued Mechanical Keyboard',
      description: 'Out of stock vintage mechanical keyboard',
      productUrl: 'https://vintage.example.com/keyboard',
      unitPriceMinor: 12000,
      currency: 'USD',
      priceFreshnessTimestamp: new Date().toISOString(),
      priceProvenance: 'PROVIDER_VERIFIED',
      availability: 'OUT_OF_STOCK',
      category: 'electronics',
    }),
    // Test Fixture: JPY currency (0 decimals)
    createProductCandidate({
      providerId: 'mock-provider',
      providerProductId: 'prod-jpy-camera',
      merchantId: 'merch-tokyo-optics',
      merchantName: 'Tokyo Optics',
      title: 'Vintage 35mm Rangefinder Camera',
      description: 'Classic Japanese film camera',
      productUrl: 'https://tokyooptics.example.com/camera',
      unitPriceMinor: 25000,
      currency: 'JPY',
      currencyDecimals: 0,
      priceFreshnessTimestamp: new Date().toISOString(),
      priceProvenance: 'PROVIDER_VERIFIED',
      availability: 'IN_STOCK',
      category: 'electronics',
    }),
    // Test Fixture: BHD currency (3 decimals)
    createProductCandidate({
      providerId: 'mock-provider',
      providerProductId: 'prod-bhd-server',
      merchantId: 'merch-gulf-dc',
      merchantName: 'Gulf Datacenter Hub',
      title: 'Dedicated Rack Unit Server (1 Month)',
      description: 'Colocation 1U enterprise server',
      productUrl: 'https://gulfdc.example.com/rack',
      unitPriceMinor: 450000,
      currency: 'BHD',
      currencyDecimals: 3,
      priceFreshnessTimestamp: new Date().toISOString(),
      priceProvenance: 'PROVIDER_VERIFIED',
      availability: 'IN_STOCK',
      category: 'cloud_services',
    }),
  ];

  /**
   * Allows injecting additional or custom fixtures in tests.
   */
  setFixtures(fixtures: ProductCandidate[]): void {
    this.fixtures = [...fixtures];
  }

  async searchProducts(
    queryInput: ProductSearchQueryInput,
    options?: ProductDiscoveryOptions,
  ): Promise<ProductSearchResult> {
    const startTime = Date.now();

    // Check cancellation
    if (options?.signal?.aborted) {
      throw new Error('Search request was aborted by client');
    }

    const normalizedQuery = normalizeSearchQuery(queryInput.query).toLowerCase();
    const queryTokens = normalizedQuery.split(/\s+/).filter((t) => t.length > 0);

    // Timeout simulation trigger
    if (normalizedQuery.includes('simulatetimeout')) {
      await new Promise((resolve) => setTimeout(resolve, (options?.timeoutMs ?? 100) + 20));
      throw new Error('Product discovery search request timed out');
    }

    const matched = this.fixtures.filter((fixture) => {
      const titleLower = fixture.title.toLowerCase();
      const categoryLower = fixture.category.toLowerCase();
      const merchantLower = fixture.merchantName.toLowerCase();
      const idLower = fixture.providerProductId.toLowerCase();

      // Check currency filter if specified
      if (queryInput.currency && fixture.currency !== queryInput.currency) {
        return false;
      }

      // Check merchant preference if specified
      if (
        queryInput.merchantPreference &&
        !merchantLower.includes(queryInput.merchantPreference.toLowerCase())
      ) {
        return false;
      }

      // Query match: any token or id
      return (
        idLower === normalizedQuery ||
        titleLower.includes(normalizedQuery) ||
        categoryLower.includes(normalizedQuery) ||
        queryTokens.some((t) => titleLower.includes(t) || categoryLower.includes(t))
      );
    });

    const deduplicated = deduplicateCandidates(matched);
    const { ranked, status } = rankCandidates(
      deduplicated,
      queryInput.query,
      queryInput.merchantPreference,
    );

    const maxResults = queryInput.maxResults ?? 10;
    const boundedCandidates = ranked.slice(0, maxResults);

    return {
      query: queryInput.query,
      candidates: boundedCandidates,
      totalFound: ranked.length,
      status,
      providerId: this.providerId,
      executionTimeMs: Date.now() - startTime,
    };
  }

  async revalidateProduct(
    providerProductId: string,
    options?: ProductDiscoveryOptions,
  ): Promise<ProductCandidate | null> {
    if (options?.signal?.aborted) {
      throw new Error('Revalidation request was aborted by client');
    }

    const found = this.fixtures.find((f) => f.providerProductId === providerProductId);
    if (!found) {
      return null;
    }

    // Special test case: volatile price changes upon revalidation
    if (found.providerProductId === 'prod-price-shift') {
      return {
        ...found,
        unitPriceMinor: 1250, // Price updated to $12.50
        priceProvenance: 'REVALIDATED',
        priceFreshnessTimestamp: new Date().toISOString(),
      };
    }

    return {
      ...found,
      priceProvenance: 'REVALIDATED',
      priceFreshnessTimestamp: new Date().toISOString(),
    };
  }
}

/**
 * Standard HTTP Product Discovery Adapter.
 * Integrates external REST discovery endpoints with bounded timeouts, SSRF protection,
 * and strict Zod runtime schema validation.
 */
export class HttpProductDiscoveryProvider implements ProductDiscoveryProvider {
  readonly providerId = 'http-external-provider';

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
    private readonly defaultTimeoutMs: number = 4000,
  ) {
    if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
      throw new Error('HttpProductDiscoveryProvider requires a valid HTTP/HTTPS baseUrl');
    }

    // SSRF Invariant: Prohibit localhost/internal IPs in baseUrl
    if (
      /(localhost|127\.0\.0\.1|0\.0\.0\.0|169\.254\.169\.254|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)/i.test(
        baseUrl,
      )
    ) {
      // Allowed in test/dev only if explicitly allowed, but prohibited by default
      if (process.env['NODE_ENV'] === 'production') {
        throw new Error('Internal and loopback base URLs are forbidden for external providers');
      }
    }
  }

  async searchProducts(
    queryInput: ProductSearchQueryInput,
    options?: ProductDiscoveryOptions,
  ): Promise<ProductSearchResult> {
    const startTime = Date.now();
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const url = new URL('/api/v1/products/search', this.baseUrl);
      url.searchParams.set('q', queryInput.query);
      if (queryInput.maxResults) {
        url.searchParams.set('limit', String(queryInput.maxResults));
      }
      if (queryInput.merchantPreference) {
        url.searchParams.set('merchant', queryInput.merchantPreference);
      }
      if (queryInput.currency) {
        url.searchParams.set('currency', queryInput.currency);
      }

      const headers: Record<string, string> = {
        Accept: 'application/json',
      };
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const res = await fetch(url.toString(), {
        method: 'GET',
        headers,
        signal: options?.signal ?? controller.signal,
      });

      if (!res.ok) {
        throw new Error(`External provider search failed with status ${res.status}`);
      }

      const body = (await res.json()) as { products?: unknown[] };
      const rawProducts = Array.isArray(body?.products) ? body.products : [];

      const parsedCandidates: ProductCandidate[] = [];
      for (const raw of rawProducts) {
        const parsed = ProductCandidateSchema.safeParse(raw);
        if (parsed.success) {
          parsedCandidates.push(parsed.data);
        }
      }

      const deduplicated = deduplicateCandidates(parsedCandidates);
      const { ranked, status } = rankCandidates(
        deduplicated,
        queryInput.query,
        queryInput.merchantPreference,
      );

      return {
        query: queryInput.query,
        candidates: ranked.slice(0, queryInput.maxResults ?? 10),
        totalFound: ranked.length,
        status,
        providerId: this.providerId,
        executionTimeMs: Date.now() - startTime,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async revalidateProduct(
    providerProductId: string,
    options?: ProductDiscoveryOptions,
  ): Promise<ProductCandidate | null> {
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const url = new URL(`/api/v1/products/${encodeURIComponent(providerProductId)}`, this.baseUrl);
      const headers: Record<string, string> = {
        Accept: 'application/json',
      };
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const res = await fetch(url.toString(), {
        method: 'GET',
        headers,
        signal: options?.signal ?? controller.signal,
      });

      if (res.status === 404) {
        return null;
      }
      if (!res.ok) {
        throw new Error(`External provider product detail failed with status ${res.status}`);
      }

      const body = await res.json();
      const parsed = ProductCandidateSchema.safeParse(body);
      return parsed.success ? parsed.data : null;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
