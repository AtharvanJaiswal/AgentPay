import {
  type ProductDiscoveryProvider,
  type ProductSearchQueryInput,
  type ProductSearchResult,
  type RevalidationResult,
  type CatalogItem,
  resolveCatalogItem,
  normalizeSearchQuery,
} from '@agentpay/contracts';

export class CatalogResolver {
  constructor(private readonly provider: ProductDiscoveryProvider) {}

  /**
   * Discovers product candidates using the configured discovery provider.
   */
  async search(
    queryInput: ProductSearchQueryInput,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ProductSearchResult> {
    const normalizedQueryString = normalizeSearchQuery(queryInput.query);
    const sanitizedQuery: ProductSearchQueryInput = {
      ...queryInput,
      query: normalizedQueryString,
    };

    const timeoutMs = options?.timeoutMs ?? 4000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await this.provider.searchProducts(sanitizedQuery, {
        timeoutMs,
        signal: options?.signal ?? controller.signal,
      });
    } catch (err: unknown) {
      if (controller.signal.aborted || (options?.signal && options.signal.aborted)) {
        throw new Error('Product discovery search request timed out');
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Authoritatively revalidates a selected candidate before policy evaluation.
   * Checks current existence, stock availability, and detects price shifts.
   */
  async revalidateCandidate(
    providerProductId: string,
    options?: {
      expectedPriceMinor?: number;
      expectedCurrency?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<RevalidationResult> {
    const timeoutMs = options?.timeoutMs ?? 4000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let candidate;
    try {
      candidate = await this.provider.revalidateProduct(providerProductId, {
        timeoutMs,
        signal: options?.signal ?? controller.signal,
      });
    } catch (err: unknown) {
      if (controller.signal.aborted || (options?.signal && options.signal.aborted)) {
        throw new Error('Product revalidation request timed out');
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!candidate) {
      return {
        status: 'NOT_FOUND',
        candidate: null,
        message: `Product candidate '${providerProductId}' was not found in catalog`,
      };
    }

    if (candidate.availability === 'OUT_OF_STOCK') {
      return {
        status: 'OUT_OF_STOCK',
        candidate,
        message: `Product candidate '${candidate.title}' is currently out of stock`,
      };
    }

    // Check for price changes between search and selection
    if (
      options?.expectedPriceMinor !== undefined &&
      candidate.unitPriceMinor !== options.expectedPriceMinor
    ) {
      return {
        status: 'PRICE_CHANGED',
        candidate,
        previousPriceMinor: options.expectedPriceMinor,
        currentPriceMinor: candidate.unitPriceMinor,
        currency: candidate.currency,
        message: `Product price has changed from ${options.expectedPriceMinor} to ${candidate.unitPriceMinor} ${candidate.currency}. Reconfirmation is required.`,
      };
    }

    return {
      status: 'VALID',
      candidate,
      currentPriceMinor: candidate.unitPriceMinor,
      currency: candidate.currency,
      message: 'Product successfully revalidated against catalog provider',
    };
  }

  /**
   * Legacy resolution against the Phase 3A deterministic development catalog.
   */
  resolveLegacyItem(query: string, merchantPreference?: string): CatalogItem | null {
    return resolveCatalogItem(query, merchantPreference);
  }
}
