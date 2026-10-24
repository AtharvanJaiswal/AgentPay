import type {
  PaymentProvider,
  PaymentOrder,
  PaymentCaptureResult,
  PurchaseProposal,
  CreateOrderOptions,
  CaptureOrderOptions,
  PaymentOrderStatus,
} from '@agentpay/contracts';
import { PayPalOAuthClient, type PayPalOAuthVerificationResult } from './oauth-client.js';
import {
  PayPalOrdersClient,
  PayPalCaptureTimeoutError,
  validateProposalAmountsAndCurrency,
} from './orders-client.js';
import {
  type PaymentOrderRepository,
  InMemoryPaymentOrderRepository,
  computeProposalHash,
  type StoredPaymentOrder,
  IdempotencyConflictError,
} from '../repository.js';

export interface PayPalPaymentProviderOptions {
  clientId: string;
  clientSecret: string;
  environment?: 'sandbox' | 'live';
  apiBaseUrl?: string;
  appBaseUrl?: string;
  timeoutMs?: number;
  webhookId?: string;
  repository?: PaymentOrderRepository;
  ordersClient?: PayPalOrdersClient;
}

/**
 * Real PayPal payment provider implementation for PayPal Orders v2 Sandbox.
 * Handles OAuth, order creation with approval URL extraction, state retrieval,
 * capture, timeout protection (marking UNKNOWN), and webhook verification.
 */
export class PayPalPaymentProvider implements PaymentProvider {
  readonly providerName = 'PayPal Sandbox';
  readonly isMock = false;

  private readonly oauthClient: PayPalOAuthClient;
  private readonly ordersClient: PayPalOrdersClient;
  private readonly repository: PaymentOrderRepository;
  private readonly webhookId?: string;

  constructor(options: PayPalPaymentProviderOptions) {
    this.oauthClient = new PayPalOAuthClient({
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      environment: options.environment,
      apiBaseUrl: options.apiBaseUrl,
      timeoutMs: options.timeoutMs,
    });

    this.ordersClient =
      options.ordersClient ??
      new PayPalOrdersClient({
        oauthClient: this.oauthClient,
        apiBaseUrl: options.apiBaseUrl,
        appBaseUrl: options.appBaseUrl,
        timeoutMs: options.timeoutMs,
      });

    this.repository = options.repository ?? new InMemoryPaymentOrderRepository();
    this.webhookId = options.webhookId;
  }

  /**
   * Diagnostic verification of PayPal Sandbox OAuth credentials.
   */
  async verifyAuthentication(correlationId?: string): Promise<PayPalOAuthVerificationResult> {
    return this.oauthClient.verifyCredentials(correlationId);
  }

  /**
   * Create an order in PayPal Sandbox.
   * Checks idempotency, sends Orders v2 request, and persists order with approval URL.
   */
  async createOrder(
    proposal: PurchaseProposal,
    correlationId: string,
    options?: CreateOrderOptions,
  ): Promise<PaymentOrder> {
    // Upfront financial consistency check: reject invalid proposal before state checks or downstream calls
    validateProposalAmountsAndCurrency(proposal);

    const idempotencyKey = options?.idempotencyKey || `order-${proposal.id}`;
    const requestHash = computeProposalHash(proposal);

    // 1. Check idempotency repository
    const existing = await this.repository.getOrderByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (existing.requestHash && existing.requestHash !== requestHash) {
        throw new IdempotencyConflictError(
          `Idempotency key '${idempotencyKey}' was already used with a different proposal payload`,
        );
      }
      return this.toPaymentOrder(existing);
    }

    // 2. Call PayPal Sandbox Orders v2 API
    const result = await this.ordersClient.createOrder(proposal, idempotencyKey, correlationId);

    const initialStatus: PaymentOrderStatus =
      result.status === 'APPROVED'
        ? 'APPROVED'
        : result.status === 'PAYER_ACTION_REQUIRED' || result.status === 'CREATED'
          ? 'PAYER_ACTION_REQUIRED'
          : 'CREATED';

    // 3. Persist order in PostgreSQL / Repository
    const stored: StoredPaymentOrder = {
      id: result.id,
      proposalId: proposal.id,
      policyDecisionId: options?.policyDecisionId ?? '00000000-0000-0000-0000-000000000000',
      provider: 'paypal_sandbox',
      status: initialStatus,
      currency: proposal.currency,
      amountMinor: proposal.totalAmountMinor,
      approvalUrl: result.approvalUrl,
      idempotencyKey,
      requestHash,
      metadata: {
        rawStatus: result.status,
        merchantId: proposal.merchant.id,
        merchantName: proposal.merchant.name,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const saved = await this.repository.createOrder(stored);
    return this.toPaymentOrder(saved);
  }

  /**
   * Retrieve order details and validate current status from Sandbox.
   */
  async getOrder(orderId: string, correlationId: string): Promise<PaymentOrder | null> {
    const stored = await this.repository.getOrderById(orderId);

    // If order is in progress, poll PayPal to check if buyer approved
    if (stored && stored.status !== 'COMPLETED' && stored.status !== 'FAILED') {
      try {
        const paypalOrder = await this.ordersClient.getOrder(orderId, correlationId);
        if (paypalOrder.status === 'APPROVED' && stored.status !== 'APPROVED') {
          const updated = await this.repository.updateOrderStatus(orderId, 'APPROVED');
          return this.toPaymentOrder(updated);
        } else if (paypalOrder.status === 'COMPLETED') {
          const captureId = paypalOrder.purchase_units?.[0]?.payments?.captures?.[0]?.id;
          const updated = await this.repository.updateOrderStatus(orderId, 'COMPLETED', {
            captureId,
          });
          return this.toPaymentOrder(updated);
        }
      } catch {
        // Fall back to stored state if PayPal API is unreachable
      }
      return this.toPaymentOrder(stored);
    }

    if (stored) {
      return this.toPaymentOrder(stored);
    }

    // If not in repository, attempt to fetch directly from PayPal Sandbox
    try {
      const paypalOrder = await this.ordersClient.getOrder(orderId, correlationId);
      const approveLink = paypalOrder.links?.find(
        (l) => l.rel === 'approve' || l.rel === 'payer-action',
      );
      const amountDecimal = paypalOrder.purchase_units?.[0]?.amount?.value
        ? parseFloat(paypalOrder.purchase_units[0].amount.value)
        : 0;

      return {
        id: paypalOrder.id,
        proposalId:
          paypalOrder.purchase_units?.[0]?.reference_id ?? '00000000-0000-0000-0000-000000000000',
        provider: 'paypal_sandbox',
        status: (paypalOrder.status as PaymentOrderStatus) || 'CREATED',
        amountMinor: Math.round(amountDecimal * 100),
        currency: paypalOrder.purchase_units?.[0]?.amount?.currency_code || 'USD',
        isMock: false,
        approvalUrl: approveLink?.href,
        createdAt: new Date().toISOString(),
        environmentNote: 'Retrieved directly from PayPal Sandbox Orders v2 API',
      };
    } catch {
      return null;
    }
  }

  /**
   * Capture an approved PayPal order.
   * Enforces buyer approval verification, monotonic status transitions, and timeout protection.
   */
  async captureOrder(
    orderId: string,
    policyDecisionId: string,
    correlationId: string,
    options?: CaptureOrderOptions,
  ): Promise<PaymentCaptureResult> {
    if (!policyDecisionId || policyDecisionId.trim().length === 0) {
      throw new Error('Valid policyDecisionId is required to capture an order');
    }

    const stored = await this.repository.getOrderById(orderId);
    if (!stored) {
      throw new Error(`Order ${orderId} not found in payment repository`);
    }

    // Verify valid server-side policy authorization binding
    if (
      !stored.policyDecisionId ||
      stored.policyDecisionId === '00000000-0000-0000-0000-000000000000'
    ) {
      throw new Error(`Order ${orderId} lacks a valid server-side policy authorization decision`);
    }

    if (stored.policyDecisionId !== policyDecisionId) {
      throw new Error(
        `Policy decision ID mismatch: provided '${policyDecisionId}' does not match order authorization '${stored.policyDecisionId}'`,
      );
    }

    // 1. Prevent duplicate capture if already completed
    if (stored.status === 'COMPLETED') {
      return {
        captureId: stored.captureId ?? stored.id,
        orderId: stored.id,
        status: 'COMPLETED',
        capturedAmountMinor: stored.amountMinor,
        currency: stored.currency,
        isMock: false,
        timestamp: stored.capturedAt ?? stored.updatedAt,
        environmentNote: 'Order is already captured in PayPal Sandbox',
      };
    }

    // 2. Validate buyer approval state independently against PayPal's server-side order status
    try {
      const liveOrder = await this.ordersClient.getOrder(orderId, correlationId);
      if (liveOrder.status !== 'APPROVED') {
        throw new Error(
          `Order ${orderId} cannot be captured because buyer approval is pending (current PayPal status: ${liveOrder.status}). Please approve via PayPal URL first.`,
        );
      }
      await this.repository.updateOrderStatus(orderId, 'APPROVED');
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('buyer approval is pending')) {
        throw err;
      }
      throw new Error(
        `Failed to verify buyer approval with PayPal Sandbox: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 3. Execute PayPal Sandbox capture with stable idempotency key
    const captureKey = options?.idempotencyKey || `cap-${orderId}`;

    try {
      const result = await this.ordersClient.captureOrder(orderId, captureKey, correlationId);

      const updated = await this.repository.updateOrderStatus(orderId, 'COMPLETED', {
        captureId: result.captureId,
        capturedAt: new Date().toISOString(),
      });

      return {
        captureId: result.captureId,
        orderId,
        status: 'COMPLETED',
        capturedAmountMinor: result.capturedAmountMinor,
        currency: result.currency,
        isMock: false,
        timestamp: updated.capturedAt ?? new Date().toISOString(),
        environmentNote: 'Captured via official PayPal Sandbox Orders v2 API',
      };
    } catch (err: unknown) {
      if (err instanceof PayPalCaptureTimeoutError) {
        // Mark status as UNKNOWN in repository to prevent unsafe replay and require reconciliation
        await this.repository.updateOrderStatus(orderId, 'UNKNOWN', {
          metadata: {
            timeoutNotice:
              'Capture request timed out. Status marked UNKNOWN pending reconciliation.',
            timeoutTimestamp: new Date().toISOString(),
          },
        });

        return {
          captureId: 'UNKNOWN',
          orderId,
          status: 'UNKNOWN',
          capturedAmountMinor: stored.amountMinor,
          currency: stored.currency,
          isMock: false,
          timestamp: new Date().toISOString(),
          environmentNote:
            'PayPal capture request timed out. Outcome is UNKNOWN; manual or automated reconciliation with PayPal is required before releasing budget.',
        };
      }
      throw err;
    }
  }

  /**
   * Verify Webhook Signature and process order lifecycle transitions monotonically.
   */
  async verifyWebhook(payload: unknown, headers: Record<string, string>): Promise<boolean> {
    const authAlgo = headers['paypal-auth-algo'];
    const certUrl = headers['paypal-cert-url'];
    const transmissionId = headers['paypal-transmission-id'];
    const transmissionSig = headers['paypal-transmission-sig'];
    const transmissionTime = headers['paypal-transmission-time'];

    if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime) {
      return false;
    }

    const webhookId = this.webhookId || 'SANDBOX_WEBHOOK_VERIFICATION';

    // Verify cryptographic signature via PayPal REST API
    const isValid = await this.ordersClient.verifyWebhookSignature({
      webhookId,
      authAlgo,
      certUrl,
      transmissionId,
      transmissionSig,
      transmissionTime,
      webhookEvent: payload,
    });

    if (!isValid) {
      return false;
    }

    // Deduplicate webhook event transmission ID
    const eventObj = payload as { id?: string; event_type?: string; resource?: { id?: string } };
    const eventType = eventObj?.event_type ?? 'UNKNOWN';
    const resourceId = eventObj?.resource?.id ?? 'UNKNOWN';

    const { recorded } = await this.repository.recordWebhookEvent({
      id: transmissionId,
      eventType,
      resourceId,
      processedAt: new Date().toISOString(),
      payload: (payload as Record<string, unknown>) || {},
    });

    // If duplicate event, return true (acknowledged) without reprocessing
    if (!recorded) {
      return true;
    }

    // Monotonic state update based on event type
    try {
      if (eventType === 'PAYMENT.CAPTURE.COMPLETED' && resourceId) {
        await this.repository.updateOrderStatus(resourceId, 'COMPLETED');
      } else if (eventType === 'CHECKOUT.ORDER.APPROVED' && resourceId) {
        // Will not regress if order is already COMPLETED
        await this.repository.updateOrderStatus(resourceId, 'APPROVED');
      } else if (eventType === 'CHECKOUT.ORDER.VOIDED' && resourceId) {
        await this.repository.updateOrderStatus(resourceId, 'VOIDED');
      }
    } catch {
      // Ignored if regression was safely rejected by monotonic validator
    }

    return true;
  }

  private toPaymentOrder(stored: StoredPaymentOrder): PaymentOrder {
    return {
      id: stored.id,
      proposalId: stored.proposalId,
      provider: stored.provider,
      status: stored.status,
      amountMinor: stored.amountMinor,
      currency: stored.currency,
      isMock: false,
      approvalUrl: stored.approvalUrl,
      createdAt: stored.createdAt,
      environmentNote: 'Official PayPal Sandbox Order',
      idempotencyKey: stored.idempotencyKey,
    };
  }
}
