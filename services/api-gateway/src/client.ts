import { request } from 'undici';
import type { ApiGatewayConfig } from '@agentpay/config';
import type {
  ApiHealthResponse,
  PurchaseProposal,
  PolicyDecision,
  PaymentOrder,
  AuditEvent,
  CreateAuditEventInput,
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
}
