import { request } from 'undici';
import type { ApiGatewayConfig } from '@agentpay/config';
import type {
  ApiHealthResponse,
  PurchaseProposal,
  PolicyDecision,
  PaymentOrder,
  PaymentCaptureResult,
  AuditEvent,
  CreateAuditEventInput,
  ReconciliationResult,
  PurchaseIntentParseResult,
  StoredPurchaseProposal,
  ProposalLifecycleStatus,
} from '@agentpay/contracts';

export class ServiceClient {
  private config: ApiGatewayConfig;

  constructor(config: ApiGatewayConfig) {
    this.config = config;
  }

  async checkServiceHealth(serviceUrl: string): Promise<ApiHealthResponse | null> {
    try {
      const res = await request(`${serviceUrl}/health`, {
        method: 'GET',
        headersTimeout: 3000,
        bodyTimeout: 3000,
      });

      if (res.statusCode >= 200 && res.statusCode < 300) {
        return (await res.body.json()) as ApiHealthResponse;
      }
      return null;
    } catch {
      return null;
    }
  }

  async createProposal(
    rawIntent: string,
    agentId: string,
    correlationId: string,
  ): Promise<PurchaseProposal> {
    const res = await request(`${this.config.AGENT_SERVICE_URL}/proposals/parse`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': correlationId,
      },
      body: JSON.stringify({ rawIntent, agentId }),
      headersTimeout: this.config.REQUEST_TIMEOUT_MS,
    });

    const body = await res.body.json();
    if (res.statusCode !== 201) {
      throw new Error(
        (body as { error?: { message?: string } })?.error?.message ?? 'Agent service error',
      );
    }
    return body as PurchaseProposal;
  }

  async evaluatePolicy(proposal: PurchaseProposal, correlationId: string): Promise<PolicyDecision> {
    const res = await request(`${this.config.POLICY_SERVICE_URL}/policies/evaluate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': correlationId,
      },
      body: JSON.stringify(proposal),
      headersTimeout: this.config.REQUEST_TIMEOUT_MS,
    });

    const body = await res.body.json();
    if (res.statusCode !== 200) {
      throw new Error(
        (body as { error?: { message?: string } })?.error?.message ?? 'Policy service error',
      );
    }
    return body as PolicyDecision;
  }

  async createPaymentOrder(
    proposal: PurchaseProposal,
    policyDecisionId: string,
    authorizedOutcome: 'ALLOW',
    correlationId: string,
  ): Promise<PaymentOrder> {
    const res = await request(`${this.config.PAYMENT_SERVICE_URL}/orders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': correlationId,
      },
      body: JSON.stringify({ proposal, policyDecisionId, authorizedOutcome }),
      headersTimeout: this.config.REQUEST_TIMEOUT_MS,
    });

    const body = (await res.body.json()) as { error?: { code?: string; message?: string } };
    if (res.statusCode !== 201) {
      const err = new Error(body?.error?.message ?? 'Payment service error');
      (err as unknown as { code?: string; statusCode?: number }).code = body?.error?.code;
      (err as unknown as { code?: string; statusCode?: number }).statusCode = res.statusCode;
      throw err;
    }
    return body as unknown as PaymentOrder;
  }

  async getPaymentOrder(orderId: string, correlationId: string): Promise<PaymentOrder | null> {
    try {
      const res = await request(
        `${this.config.PAYMENT_SERVICE_URL}/orders/${encodeURIComponent(orderId)}`,
        {
          method: 'GET',
          headers: {
            'x-correlation-id': correlationId,
          },
          headersTimeout: this.config.REQUEST_TIMEOUT_MS,
        },
      );

      if (res.statusCode === 200) {
        return (await res.body.json()) as PaymentOrder;
      }
      return null;
    } catch {
      return null;
    }
  }

  async capturePaymentOrder(
    orderId: string,
    policyDecisionId: string,
    correlationId: string,
    idempotencyKey?: string,
  ): Promise<PaymentCaptureResult> {
    const res = await request(
      `${this.config.PAYMENT_SERVICE_URL}/orders/${encodeURIComponent(orderId)}/capture`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-correlation-id': correlationId,
          ...(idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : {}),
        },
        body: JSON.stringify({ policyDecisionId, idempotencyKey }),
        headersTimeout: this.config.REQUEST_TIMEOUT_MS,
      },
    );

    const body = (await res.body.json()) as { error?: { code?: string; message?: string } };
    if (res.statusCode !== 200 && res.statusCode !== 202) {
      const err = new Error(body?.error?.message ?? 'Payment capture error');
      (err as unknown as { code?: string; statusCode?: number }).code = body?.error?.code;
      (err as unknown as { code?: string; statusCode?: number }).statusCode = res.statusCode;
      throw err;
    }
    return body as unknown as PaymentCaptureResult;
  }

  async reconcilePaymentOrder(
    orderId: string,
    correlationId: string,
  ): Promise<ReconciliationResult> {
    const res = await request(
      `${this.config.PAYMENT_SERVICE_URL}/orders/${encodeURIComponent(orderId)}/reconcile`,
      {
        method: 'POST',
        headers: {
          'x-correlation-id': correlationId,
        },
        headersTimeout: this.config.REQUEST_TIMEOUT_MS,
      },
    );

    const body = (await res.body.json()) as
      | ReconciliationResult
      | { error?: { code?: string; message?: string } };

    if (res.statusCode !== 200) {
      const err = new Error(
        (body as { error?: { message?: string } })?.error?.message ??
          'Payment reconciliation error',
      );
      (err as unknown as { code?: string; statusCode?: number }).code = (
        body as { error?: { code?: string } }
      )?.error?.code;
      (err as unknown as { code?: string; statusCode?: number }).statusCode = res.statusCode;
      throw err;
    }
    return body as ReconciliationResult;
  }

  async recordAuditEvent(
    event: CreateAuditEventInput,
    correlationId: string,
  ): Promise<AuditEvent | null> {
    try {
      const res = await request(`${this.config.AUDIT_SERVICE_URL}/events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-correlation-id': correlationId,
        },
        body: JSON.stringify(event),
        headersTimeout: this.config.REQUEST_TIMEOUT_MS,
      });

      if (res.statusCode === 201) {
        return (await res.body.json()) as AuditEvent;
      }
      return null;
    } catch {
      return null;
    }
  }

  async listAuditEvents(limit = 50, correlationId?: string): Promise<AuditEvent[]> {
    try {
      let url = `${this.config.AUDIT_SERVICE_URL}/events?limit=${limit}`;
      if (correlationId) {
        url += `&correlationId=${encodeURIComponent(correlationId)}`;
      }
      const res = await request(url, {
        method: 'GET',
        headersTimeout: this.config.REQUEST_TIMEOUT_MS,
      });

      if (res.statusCode === 200) {
        return (await res.body.json()) as AuditEvent[];
      }
      return [];
    } catch {
      return [];
    }
  }

  async parseIntent(
    rawIntent: string,
    correlationId: string,
    options?: {
      requestId?: string;
      idempotencyKey?: string;
      principalId?: string;
      locale?: string;
    },
  ): Promise<PurchaseIntentParseResult> {
    const res = await request(`${this.config.AGENT_SERVICE_URL}/intents/parse`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': correlationId,
      },
      body: JSON.stringify({
        rawIntent,
        requestId: options?.requestId,
        idempotencyKey: options?.idempotencyKey,
        principalId: options?.principalId,
        locale: options?.locale,
      }),
      headersTimeout: this.config.REQUEST_TIMEOUT_MS,
    });

    const body = (await res.body.json()) as
      | PurchaseIntentParseResult
      | { error?: { message?: string; code?: string } };

    if (res.statusCode >= 400 && (body as { error?: { message?: string } })?.error) {
      const err = new Error(
        (body as { error?: { message?: string } })?.error?.message ?? 'Intent parsing error',
      );
      (err as unknown as { code?: string; statusCode?: number }).code = (
        body as { error?: { code?: string } }
      )?.error?.code;
      (err as unknown as { code?: string; statusCode?: number }).statusCode = res.statusCode;
      throw err;
    }

    return body as PurchaseIntentParseResult;
  }

  async persistProposal(
    proposal: StoredPurchaseProposal,
    correlationId: string,
  ): Promise<StoredPurchaseProposal> {
    const res = await request(`${this.config.AGENT_SERVICE_URL}/proposals`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': correlationId,
      },
      body: JSON.stringify(proposal),
      headersTimeout: this.config.REQUEST_TIMEOUT_MS,
    });

    const body = (await res.body.json()) as
      | StoredPurchaseProposal
      | { error?: { message?: string; code?: string } };

    if (res.statusCode >= 400) {
      const err = new Error(
        (body as { error?: { message?: string } })?.error?.message ??
          'Failed to persist purchase proposal',
      );
      (err as unknown as { code?: string; statusCode?: number }).code = (
        body as { error?: { code?: string } }
      )?.error?.code;
      (err as unknown as { code?: string; statusCode?: number }).statusCode = res.statusCode;
      throw err;
    }

    return body as StoredPurchaseProposal;
  }

  async getProposal(id: string, correlationId: string): Promise<StoredPurchaseProposal | null> {
    const res = await request(
      `${this.config.AGENT_SERVICE_URL}/proposals/${encodeURIComponent(id)}`,
      {
        method: 'GET',
        headers: {
          'x-correlation-id': correlationId,
        },
        headersTimeout: this.config.REQUEST_TIMEOUT_MS,
      },
    );

    if (res.statusCode === 404) {
      return null;
    }

    const body = (await res.body.json()) as
      | StoredPurchaseProposal
      | { error?: { message?: string; code?: string } };

    if (res.statusCode >= 400) {
      const err = new Error(
        (body as { error?: { message?: string } })?.error?.message ??
          'Failed to retrieve purchase proposal',
      );
      (err as unknown as { code?: string; statusCode?: number }).code = (
        body as { error?: { code?: string } }
      )?.error?.code;
      (err as unknown as { code?: string; statusCode?: number }).statusCode = res.statusCode;
      throw err;
    }

    return body as StoredPurchaseProposal;
  }

  async updateProposalStatus(
    id: string,
    status: ProposalLifecycleStatus,
    correlationId: string,
    updates?: {
      policyDecisionId?: string;
      policyOutcome?: 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';
      policyReasonCode?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<StoredPurchaseProposal> {
    const res = await request(
      `${this.config.AGENT_SERVICE_URL}/proposals/${encodeURIComponent(id)}/status`,
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-correlation-id': correlationId,
        },
        body: JSON.stringify({ status, ...updates }),
        headersTimeout: this.config.REQUEST_TIMEOUT_MS,
      },
    );

    const body = (await res.body.json()) as
      | StoredPurchaseProposal
      | { error?: { message?: string; code?: string } };

    if (res.statusCode >= 400) {
      const err = new Error(
        (body as { error?: { message?: string } })?.error?.message ??
          'Failed to update purchase proposal status',
      );
      (err as unknown as { code?: string; statusCode?: number }).code = (
        body as { error?: { code?: string } }
      )?.error?.code;
      (err as unknown as { code?: string; statusCode?: number }).statusCode = res.statusCode;
      throw err;
    }

    return body as StoredPurchaseProposal;
  }
}
