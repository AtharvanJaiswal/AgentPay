import { z } from 'zod';
import { CurrencySchema, MinorUnitsSchema } from './common.js';
import { getCurrencyDecimals } from './purchase-intent.js';

/**
 * Product availability states supported across catalog providers.
 */
export const ProductAvailabilitySchema = z.enum([
  'IN_STOCK',
  'OUT_OF_STOCK',
  'LIMITED',
  'UNKNOWN',
]);
export type ProductAvailability = z.infer<typeof ProductAvailabilitySchema>;

/**
 * Trust and provenance status of product price data.
 */
export const PriceProvenanceSchema = z.enum([
  'PROVIDER_VERIFIED',
  'SEARCH_INFORMATIONAL',
  'REVALIDATED',
]);
export type PriceProvenance = z.infer<typeof PriceProvenanceSchema>;

/**
 * Normalized external product candidate contract.
 * Strictly validated before any internal business logic processing.
 */
export const ProductCandidateSchema = z.object({
  providerId: z.string().min(1).max(64),
  providerProductId: z.string().min(1).max(128),
  merchantId: z.string().min(1).max(64),
  merchantName: z.string().min(1).max(128),
  title: z.string().min(1).max(256),
  description: z.string().max(1024).optional(),
  productUrl: z
    .string()
    .url()
    .refine((url) => /^https?:\/\//i.test(url), {
      message: 'Product URL must have an http or https scheme',
    }),
  imageUrl: z
    .string()
    .url()
    .optional()
    .refine((url) => !url || /^https?:\/\//i.test(url), {
      message: 'Image URL must have an http or https scheme',
    }),
  unitPriceMinor: MinorUnitsSchema,
  currency: CurrencySchema,
  currencyDecimals: z.number().int().min(0).max(3).default(2),
  priceFreshnessTimestamp: z.string().datetime(),
  priceProvenance: PriceProvenanceSchema,
  availability: ProductAvailabilitySchema.default('IN_STOCK'),
  category: z.string().max(64).default('general'),
  dedupeKey: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});
export type ProductCandidate = z.infer<typeof ProductCandidateSchema>;

/**
 * Factory to construct and validate a ProductCandidate, automatically populating
 * currencyDecimals from the currency registry and generating the dedupeKey.
 */
export function createProductCandidate(
  data: Omit<z.input<typeof ProductCandidateSchema>, 'currencyDecimals' | 'dedupeKey'> & {
    currencyDecimals?: number;
    dedupeKey?: string;
  },
): ProductCandidate {
  const currencyDecimals = data.currencyDecimals ?? getCurrencyDecimals(data.currency);
  const dedupeKey = data.dedupeKey ?? createDedupeKey(data.providerId, data.providerProductId);
  return ProductCandidateSchema.parse({
    ...data,
    currencyDecimals,
    dedupeKey,
  });
}


/**
 * Bounded product search query input schema.
 */
export const ProductSearchQuerySchema = z.object({
  query: z.string().min(1).max(120),
  merchantPreference: z.string().max(64).optional(),
  currency: CurrencySchema.optional(),
  maxResults: z.coerce.number().int().min(1).max(50).default(10),
  continuationToken: z.string().max(256).optional(),
});
export type ProductSearchQuery = z.infer<typeof ProductSearchQuerySchema>;
export type ProductSearchQueryInput = z.input<typeof ProductSearchQuerySchema>;

/**
 * Outcome status of a candidate search operation.
 */
export const ProductSearchResultStatusSchema = z.enum([
  'EXACT_MATCH',
  'SELECTION_REQUIRED',
  'NO_MATCHES',
]);
export type ProductSearchResultStatus = z.infer<typeof ProductSearchResultStatusSchema>;

/**
 * Normalized product search result returned to the client.
 */
export const ProductSearchResultSchema = z.object({
  query: z.string(),
  candidates: z.array(ProductCandidateSchema),
  totalFound: z.number().int().nonnegative(),
  status: ProductSearchResultStatusSchema,
  providerId: z.string(),
  executionTimeMs: z.number().nonnegative(),
  continuationToken: z.string().optional(),
});
export type ProductSearchResult = z.infer<typeof ProductSearchResultSchema>;

/**
 * Candidate selection payload for authoritative purchase workflow revalidation.
 */
export const SelectCandidateInputSchema = z.object({
  providerId: z.string().min(1).max(64),
  providerProductId: z.string().min(1).max(128),
  expectedUnitPriceMinor: MinorUnitsSchema.optional(),
  expectedCurrency: CurrencySchema.optional(),
  quantity: z.number().int().min(1).max(100).default(1),
  idempotencyKey: z.string().min(1).max(128).optional(),
  requestId: z.string().uuid().optional(),
});
export type SelectCandidateInput = z.infer<typeof SelectCandidateInputSchema>;

/**
 * Revalidation result after checking external catalog item details.
 */
export interface RevalidationResult {
  status: 'VALID' | 'PRICE_CHANGED' | 'OUT_OF_STOCK' | 'NOT_FOUND';
  candidate: ProductCandidate | null;
  previousPriceMinor?: number;
  currentPriceMinor?: number;
  currency?: string;
  message: string;
}

/**
 * Provider interface options for timeouts and cancellation.
 */
export interface ProductDiscoveryOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Standard interface that all product discovery providers must implement.
 */
export interface ProductDiscoveryProvider {
  readonly providerId: string;

  searchProducts(
    query: ProductSearchQueryInput,
    options?: ProductDiscoveryOptions,
  ): Promise<ProductSearchResult>;

  revalidateProduct(
    providerProductId: string,
    options?: ProductDiscoveryOptions,
  ): Promise<ProductCandidate | null>;
}


/**
 * Deterministically normalizes a raw search query.
 * - Strips ASCII and Unicode control characters.
 * - Normalizes via Unicode NFKC.
 * - Collapses repeated whitespace.
 * - Enforces minimum and maximum length bounds.
 * - Preserves model numbers, SKUs, and currency signs.
 */
export function normalizeSearchQuery(rawQuery: string): string {
  if (typeof rawQuery !== 'string') {
    throw new Error('Search query must be a string');
  }

  // 1. Unicode NFKC normalization
  let normalized = rawQuery.normalize('NFKC');

  // 2. Strip control characters (C0, C1, and delete)
  // eslint-disable-next-line no-control-regex
  normalized = normalized.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');

  // 3. Collapse multiple spaces and trim
  normalized = normalized.replace(/\s+/g, ' ').trim();

  // 4. Validate bounds
  if (normalized.length === 0) {
    throw new Error('Search query cannot be empty or contain only whitespace/control characters');
  }

  if (normalized.length > 120) {
    normalized = normalized.slice(0, 120).trim();
  }

  return normalized;
}

/**
 * Generates a stable deduplication key for a product candidate.
 */
export function createDedupeKey(providerId: string, providerProductId: string): string {
  return `${providerId.trim().toLowerCase()}:${providerProductId.trim()}`;
}

/**
 * Bounded O(n) deduplication of candidates using hash-based index.
 */
export function deduplicateCandidates(candidates: ProductCandidate[]): ProductCandidate[] {
  const seen = new Set<string>();
  const deduplicated: ProductCandidate[] = [];

  for (const candidate of candidates) {
    const key = candidate.dedupeKey || createDedupeKey(candidate.providerId, candidate.providerProductId);
    if (!seen.has(key)) {
      seen.add(key);
      deduplicated.push(candidate);
    }
  }

  return deduplicated;
}

/**
 * Deterministic scoring and ranking engine for search candidates.
 *
 * Scoring signals:
 * - Model / SKU exact match: +40
 * - Title token overlap: up to +30
 * - Brand / Merchant match: +20
 * - In-stock and verified: +10
 *
 * Tie-breaker: Lexicographical sort on providerProductId.
 */
export function rankCandidates(
  candidates: ProductCandidate[],
  rawQuery: string,
  merchantPreference?: string,
): {
  ranked: ProductCandidate[];
  status: ProductSearchResultStatus;
} {
  if (!candidates || candidates.length === 0) {
    return { ranked: [], status: 'NO_MATCHES' };
  }

  const normalizedQuery = normalizeSearchQuery(rawQuery).toLowerCase();
  const queryTokens = normalizedQuery.split(/\s+/).filter((t) => t.length > 0);
  const normalizedMerchant = merchantPreference?.toLowerCase().trim();

  const scored = candidates.map((candidate) => {
    let score = 0;
    const titleLower = candidate.title.toLowerCase();
    const merchantLower = candidate.merchantName.toLowerCase();
    const productIdLower = candidate.providerProductId.toLowerCase();

    // 1. Model / SKU match
    if (productIdLower === normalizedQuery || titleLower.includes(normalizedQuery)) {
      score += 40;
    }

    // 2. Title token matching (up to 30 points)
    if (queryTokens.length > 0) {
      let matchedTokens = 0;
      for (const token of queryTokens) {
        if (titleLower.includes(token)) {
          matchedTokens++;
        }
      }
      score += Math.round((matchedTokens / queryTokens.length) * 30);
    }

    // 3. Merchant preference match
    if (normalizedMerchant) {
      if (
        merchantLower.includes(normalizedMerchant) ||
        candidate.merchantId.toLowerCase().includes(normalizedMerchant)
      ) {
        score += 20;
      }
    }

    // 4. Data completeness and availability
    if (candidate.availability === 'IN_STOCK') {
      score += 10;
    }
    if (candidate.priceProvenance === 'PROVIDER_VERIFIED') {
      score += 5;
    }

    return { candidate, score };
  });

  // Sort descending by score; tie-breaker: providerProductId
  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.candidate.providerProductId.localeCompare(b.candidate.providerProductId);
  });

  const ranked = scored.map((s) => s.candidate);

  // Determine search outcome status:
  // Invariant: If there are multiple candidates, never silently pick the first candidate.
  // Return SELECTION_REQUIRED unless exactly 1 candidate exists or only 1 exact match exists.
  let status: ProductSearchResultStatus = 'SELECTION_REQUIRED';

  if (ranked.length === 1) {
    status = 'EXACT_MATCH';
  } else if (ranked.length > 1) {
    // If multiple candidates exist, user selection is required
    status = 'SELECTION_REQUIRED';
  }

  return { ranked, status };
}
