import type {
  ProductSearchResult,
  ProductCandidate,
  StoredPurchaseProposal,
  PolicyDecision,
  AuditEvent,
} from '@agentpay/contracts';

export interface ApiClientOptions {
  activePrincipalId?: string;
}

export interface ApiErrorResponse {
  code: string;
  message: string;
  statusCode: number;
  details?: unknown;
  previousPriceMinor?: number;
  currentPriceMinor?: number;
  currency?: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;
  readonly previousPriceMinor?: number;
  readonly currentPriceMinor?: number;
  readonly currency?: string;

  constructor(res: ApiErrorResponse) {
    super(res.message);
    this.name = 'ApiError';
    this.code = res.code;
    this.statusCode = res.statusCode;
    this.details = res.details;
    this.previousPriceMinor = res.previousPriceMinor;
    this.currentPriceMinor = res.currentPriceMinor;
    this.currency = res.currency;
  }

  isPriceChangeConflict(): boolean {
    return this.code === 'PRICE_CHANGED_RECONFIRMATION_REQUIRED' || this.statusCode === 409;
  }
}

export type ProposalCreationResponse =
  | {
      outcome: 'PROPOSAL_CREATED' | 'POLICY_REVIEW_REQUIRED';
      proposal: StoredPurchaseProposal;
      policyDecision: PolicyDecision;
      message: string;
    }
  | {
      outcome: 'SELECTION_REQUIRED';
      status: 'SELECTION_REQUIRED';
      reason: string;
      candidates: ProductCandidate[];
      query: string;
    }
  | {
      outcome: 'CLARIFICATION_REQUIRED';
      reason: string;
      question?: string;
    }
  | {
      outcome: 'UNSUPPORTED_INTENT';
      reason: string;
    };

export class ApiClient {
  private activePrincipalId: string;

  constructor(options?: ApiClientOptions) {
    this.activePrincipalId = options?.activePrincipalId ?? 'dev-user-principal-01';
  }

  setPrincipalId(principalId: string): void {
    this.activePrincipalId = principalId;
  }

  getPrincipalId(): string {
    return this.activePrincipalId;
  }

  private async request<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const headers = new Headers(options?.headers);
    if (!headers.has('Content-Type') && options?.method && options.method !== 'GET') {
      headers.set('Content-Type', 'application/json');
    }
    if (this.activePrincipalId) {
      headers.set('x-principal-id', this.activePrincipalId);
    }

    const response = await fetch(`/api${endpoint}`, {
      ...options,
      headers,
    });

    const isJson = response.headers.get('content-type')?.includes('application/json');
    const data = isJson ? await response.json() : await response.text();

    if (!response.ok) {
      const errPayload = typeof data === 'object' && data !== null ? data : {};
      const errorObj = (errPayload as { error?: Record<string, unknown> }).error || errPayload;

      throw new ApiError({
        statusCode: response.status,
        code: (errorObj as { code?: string })?.code || `HTTP_${response.status}`,
        message:
          (errorObj as { message?: string })?.message ||
          (typeof data === 'string' ? data : `Request failed with status ${response.status}`),
        details: (errorObj as { details?: unknown })?.details,
        previousPriceMinor: (errorObj as { previousPriceMinor?: number })?.previousPriceMinor,
        currentPriceMinor: (errorObj as { currentPriceMinor?: number })?.currentPriceMinor,
        currency: (errorObj as { currency?: string })?.currency,
      });
    }

    return data as T;
  }

  /**
   * Product Discovery Search: POST /api/products/search
   */
  async searchProducts(
    query: string,
    merchantPreference?: string,
    maxResults = 10,
  ): Promise<ProductSearchResult> {
    const trimmed = query.trim();
    if (!trimmed) {
      throw new ApiError({
        code: 'VALIDATION_ERROR',
        message: 'Search query cannot be empty',
        statusCode: 400,
      });
    }

    return this.request<ProductSearchResult>('/products/search', {
      method: 'POST',
      body: JSON.stringify({
        query: trimmed,
        merchantPreference: merchantPreference?.trim() || undefined,
        maxResults,
      }),
    });
  }

  /**
   * Orchestrated Purchase Intent / Selection Revalidation: POST /api/purchase-intents
   */
  async createPurchaseIntent(input: {
    rawIntent: string;
    selectedCandidate?: {
      providerId: string;
      providerProductId: string;
      expectedUnitPriceMinor?: number;
      expectedCurrency?: string;
      quantity?: number;
    };
    idempotencyKey?: string;
  }): Promise<ProposalCreationResponse> {
    return this.request<ProposalCreationResponse>('/purchase-intents', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  /**
   * List purchase proposals owned by authenticated principal: GET /api/purchase-intents
   */
  async listProposals(status?: string, limit = 50): Promise<StoredPurchaseProposal[]> {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (limit) params.set('limit', String(limit));

    const qs = params.toString();
    return this.request<StoredPurchaseProposal[]>(`/purchase-intents${qs ? `?${qs}` : ''}`, {
      method: 'GET',
    });
  }

  /**
   * Retrieve purchase proposal detail: GET /api/purchase-intents/:id
   */
  async getProposal(id: string): Promise<StoredPurchaseProposal> {
    return this.request<StoredPurchaseProposal>(`/purchase-intents/${encodeURIComponent(id)}`, {
      method: 'GET',
    });
  }

  /**
   * Explicit Human Authorization: POST /api/purchase-intents/:id/approve
   * CRITICAL: Records authorization only; never executes payments.
   */
  async approveProposal(
    id: string,
    note?: string,
  ): Promise<{ outcome: string; proposal: StoredPurchaseProposal; message: string }> {
    return this.request<{ outcome: string; proposal: StoredPurchaseProposal; message: string }>(
      `/purchase-intents/${encodeURIComponent(id)}/approve`,
      {
        method: 'POST',
        body: JSON.stringify({ note }),
      },
    );
  }

  /**
   * Explicit Human Rejection: POST /api/purchase-intents/:id/reject
   */
  async rejectProposal(
    id: string,
    reason?: string,
  ): Promise<{ outcome: string; proposal: StoredPurchaseProposal; message: string }> {
    return this.request<{ outcome: string; proposal: StoredPurchaseProposal; message: string }>(
      `/purchase-intents/${encodeURIComponent(id)}/reject`,
      {
        method: 'POST',
        body: JSON.stringify({ reason }),
      },
    );
  }

  /**
   * Proposal-scoped Audit Trail: GET /api/purchase-intents/:id/audit-events
   */
  async getProposalAuditEvents(id: string): Promise<AuditEvent[]> {
    return this.request<AuditEvent[]>(
      `/purchase-intents/${encodeURIComponent(id)}/audit-events`,
      {
        method: 'GET',
      },
    );
  }

  /**
   * Platform & Gateway Status: GET /api/status
   */
  async getPlatformStatus(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('/status', {
      method: 'GET',
    });
  }

  /**
   * Global Recent Audit Events: GET /api/audit-events
   */
  async getAuditEvents(limit = 20): Promise<AuditEvent[]> {
    return this.request<AuditEvent[]>(`/audit-events?limit=${limit}`, {
      method: 'GET',
    });
  }
}

export const defaultApiClient = new ApiClient();
