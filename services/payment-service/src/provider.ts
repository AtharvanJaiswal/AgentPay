import { v4 as uuidv4 } from 'uuid';
import type {
  PaymentProvider,
  PaymentOrder,
  PaymentCaptureResult,
  PurchaseProposal,
  CreateOrderOptions,
  CaptureOrderOptions,
  ReconciliationResult,
} from '@agentpay/contracts';
import type { PaymentOrderRepository, StoredPaymentOrder } from './repository.js';

export class MockPaymentProvider implements PaymentProvider {
  readonly providerName = 'MOCK/DEVELOPMENT';
  readonly isMock = true;

  private orders = new Map<string, PaymentOrder>();
  private orderPolicyDecisions = new Map<string, string>();
  private readonly repository?: PaymentOrderRepository;

  constructor(repository?: PaymentOrderRepository) {
    this.repository = repository;
  }

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
      idempotencyKey: options?.idempotencyKey,
    };

    this.orders.set(orderId, order);
    if (options?.policyDecisionId) {
      this.orderPolicyDecisions.set(orderId, options.policyDecisionId);
    }

    if (this.repository) {
      const stored: StoredPaymentOrder = {
        id: order.id,
        proposalId: order.proposalId,
        policyDecisionId: options?.policyDecisionId ?? '00000000-0000-0000-0000-000000000000',
        provider: 'mock',
        status: order.status,
        currency: order.currency,
        amountMinor: order.amountMinor,
        approvalUrl: order.approvalUrl,
        idempotencyKey: options?.idempotencyKey,
        createdAt: order.createdAt,
        updatedAt: order.createdAt,
      };
      await this.repository.createOrder(stored);
    }

    return order;
  }

  async getOrder(orderId: string, _correlationId: string): Promise<PaymentOrder | null> {
    if (this.repository) {
      const stored = await this.repository.getOrderById(orderId);
      if (stored) {
        return {
          id: stored.id,
          proposalId: stored.proposalId,
          provider: stored.provider,
          status: stored.status,
          amountMinor: stored.amountMinor,
          currency: stored.currency,
          isMock: true,
          approvalUrl: stored.approvalUrl,
          createdAt: stored.createdAt,
          environmentNote: 'MOCK/DEVELOPMENT order (persisted)',
          idempotencyKey: stored.idempotencyKey,
          lastReconciledAt: stored.lastReconciledAt,
          reconciliationStatus: stored.reconciliationStatus,
        };
      }
    }
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

    const existingOrder = await this.getOrder(orderId, _correlationId);
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
    this.orders.set(orderId, existingOrder);

    const captureId = `MOCK-CAPTURE-${uuidv4().substring(0, 8).toUpperCase()}`;
    const capturedAt = new Date().toISOString();

    if (this.repository) {
      await this.repository.updateOrderStatus(orderId, 'COMPLETED', {
        captureId,
        capturedAt,
      });
    }

    const captureResult: PaymentCaptureResult = {
      captureId,
      orderId,
      status: 'COMPLETED',
      capturedAmountMinor: existingOrder.amountMinor,
      currency: existingOrder.currency,
      isMock: true,
      timestamp: capturedAt,
      environmentNote:
        'MOCK/DEVELOPMENT provider only. This was a simulated development capture; no real funds were transferred.',
    };

    return captureResult;
  }

  async verifyWebhook(_payload: unknown, _headers: Record<string, string>): Promise<boolean> {
    // Development mock webhook verification
    return true;
  }

  async reconcileOrder(orderId: string, correlationId: string): Promise<ReconciliationResult> {
    const order = await this.getOrder(orderId, correlationId);
    if (!order) {
      return {
        orderId,
        status: 'NOT_FOUND',
        details: `Mock order ${orderId} not found in repository or memory`,
        timestamp: new Date().toISOString(),
      };
    }

    if (order.status === 'UNKNOWN') {
      // Reconcile mock unknown state to COMPLETED
      order.status = 'COMPLETED';
      this.orders.set(orderId, order);
      if (this.repository) {
        await this.repository.updateOrderStatus(orderId, 'COMPLETED', {
          captureId: `mock-cap-recon-${orderId}`,
          capturedAt: new Date().toISOString(),
          lastReconciledAt: new Date().toISOString(),
          reconciliationStatus: 'UPDATED',
        });
      }
      return {
        orderId,
        status: 'UPDATED',
        previousOrderStatus: 'UNKNOWN',
        currentOrderStatus: 'COMPLETED',
        providerStatus: 'COMPLETED',
        details: 'Mock order reconciled from UNKNOWN to COMPLETED',
        timestamp: new Date().toISOString(),
      };
    }

    if (this.repository) {
      await this.repository.updateOrderStatus(orderId, order.status, {
        lastReconciledAt: new Date().toISOString(),
        reconciliationStatus: 'UNCHANGED',
      });
    }

    return {
      orderId,
      status: 'UNCHANGED',
      previousOrderStatus: order.status,
      currentOrderStatus: order.status,
      providerStatus: order.status,
      details: 'Mock order is in sync with recorded state',
      timestamp: new Date().toISOString(),
    };
  }
}
