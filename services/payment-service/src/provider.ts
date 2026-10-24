import { v4 as uuidv4 } from 'uuid';
import type {
  PaymentProvider,
  PaymentOrder,
  PaymentCaptureResult,
  PurchaseProposal,
  CreateOrderOptions,
  CaptureOrderOptions,
} from '@agentpay/contracts';

export class MockPaymentProvider implements PaymentProvider {
  readonly providerName = 'MOCK/DEVELOPMENT';
  readonly isMock = true;

  private orders = new Map<string, PaymentOrder>();
  private orderPolicyDecisions = new Map<string, string>();

  async createOrder(
    proposal: PurchaseProposal,
    _correlationId: string,
    options?: CreateOrderOptions,
  ): Promise<PaymentOrder> {
    const orderId = `MOCK-ORDER-${uuidv4().substring(0, 8).toUpperCase()}`;
    const order: PaymentOrder = {
      id: orderId,
      proposalId: proposal.id,
      provider: 'mock',
      status: 'CREATED',
      amountMinor: proposal.totalAmountMinor,
      currency: proposal.currency,
      isMock: true,
      approvalUrl: `http://localhost:3000/mock-paypal-approval?orderId=${orderId}`,
      createdAt: new Date().toISOString(),
      environmentNote:
        'MOCK/DEVELOPMENT provider only. No real PayPal transaction executed. PayPal Sandbox disabled.',
    };

    this.orders.set(orderId, order);
    if (options?.policyDecisionId) {
      this.orderPolicyDecisions.set(orderId, options.policyDecisionId);
    }
    return order;
  }

  async getOrder(orderId: string, _correlationId: string): Promise<PaymentOrder | null> {
    return this.orders.get(orderId) ?? null;
  }

  async captureOrder(
    orderId: string,
    policyDecisionId: string,
    _correlationId: string,
    _options?: CaptureOrderOptions,
  ): Promise<PaymentCaptureResult> {
    if (!policyDecisionId || policyDecisionId.trim().length === 0) {
      throw new Error('Valid policyDecisionId is required');
    }

    const existingOrder = this.orders.get(orderId);
    if (!existingOrder) {
      throw new Error(`Order ${orderId} not found`);
    }

    const authorizedDecisionId = this.orderPolicyDecisions.get(orderId);
    if (authorizedDecisionId && authorizedDecisionId !== policyDecisionId) {
      throw new Error(
        `Policy decision ID mismatch: provided '${policyDecisionId}' does not match order authorization '${authorizedDecisionId}'`,
      );
    }

    if (existingOrder.status === 'COMPLETED') {
      throw new Error(`Order ${orderId} is already captured`);
    }

    existingOrder.status = 'COMPLETED';

    const captureResult: PaymentCaptureResult = {
      captureId: `MOCK-CAPTURE-${uuidv4().substring(0, 8).toUpperCase()}`,
      orderId,
      status: 'COMPLETED',
      capturedAmountMinor: existingOrder.amountMinor,
      currency: existingOrder.currency,
      isMock: true,
      timestamp: new Date().toISOString(),
      environmentNote:
        'MOCK/DEVELOPMENT provider only. This was a simulated development capture; no real funds were transferred.',
    };

    return captureResult;
  }

  async verifyWebhook(_payload: unknown, _headers: Record<string, string>): Promise<boolean> {
    // Development mock webhook verification
    return true;
  }
}
