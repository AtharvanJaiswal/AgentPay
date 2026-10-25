import type {
  PaymentProvider,
  PaymentOrder,
  PaymentCaptureResult,
  PurchaseProposal,
  CreateOrderOptions,
  CaptureOrderOptions,
  PaymentOrderStatus,
  ReconciliationResult,
} from '@agentpay/contracts';
import { PayPalOAuthClient, type PayPalOAuthVerificationResult } from './oauth-client.js';
import {
  PayPalOrdersClient,
  PayPalCaptureTimeoutError,
  PayPalOrderApiError,
  validateProposalAmountsAndCurrency,
} from './orders-client.js';
import {
  type PaymentOrderRepository,
  InMemoryPaymentOrderRepository,
  computeProposalHash,
  type StoredPaymentOrder,
  IdempotencyConflictError,
  canTransitionStatus,
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
   * Deduplicates using stable PayPal event ID and ensures monotonic, race-safe transitions.
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

    // Deduplicate and process webhook event atomically
    const eventObj = payload as {
      id?: string;
      event_type?: string;
      resource_type?: string;
      resource?: {
        id?: string;
        amount?: { value?: string; currency_code?: string };
        supplementary_data?: {
          related_ids?: {
            order_id?: string;
            capture_id?: string;
          };
        };
        custom_id?: string;
      };
    };
    const eventId = eventObj?.id || transmissionId;
    const eventType = eventObj?.event_type ?? 'UNKNOWN';

    // In PayPal webhooks, resource.id can be order ID (for CHECKOUT.ORDER.*)
    // or capture ID (for PAYMENT.CAPTURE.* with related order_id in supplementary_data)
    const targetOrderId =
      eventObj?.resource?.supplementary_data?.related_ids?.order_id ||
      eventObj?.resource?.custom_id ||
      eventObj?.resource?.id ||
      'UNKNOWN';

    const captureId =
      eventType === 'PAYMENT.CAPTURE.COMPLETED'
        ? eventObj?.resource?.id ||
          eventObj?.resource?.supplementary_data?.related_ids?.capture_id ||
          `CAP-${eventId}`
        : undefined;

    let targetTransition:
      | {
          targetStatus: PaymentOrderStatus;
          captureId?: string;
          capturedAt?: string;
          metadata?: Record<string, unknown>;
        }
      | undefined;

    if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
      targetTransition = {
        targetStatus: 'COMPLETED',
        captureId,
        capturedAt: new Date().toISOString(),
        metadata: {
          webhookEventId: eventId,
          webhookCaptureId: captureId,
        },
      };
    } else if (eventType === 'CHECKOUT.ORDER.APPROVED') {
      targetTransition = {
        targetStatus: 'APPROVED',
        metadata: {
          webhookEventId: eventId,
        },
      };
    } else if (eventType === 'CHECKOUT.ORDER.VOIDED') {
      targetTransition = {
        targetStatus: 'VOIDED',
        metadata: {
          webhookEventId: eventId,
        },
      };
    }

    let expectedCurrency: string | undefined;
    let expectedAmountMinor: number | undefined;

    if (eventObj?.resource?.amount) {
      expectedCurrency = eventObj.resource.amount.currency_code;
      if (eventObj.resource.amount.value) {
        expectedAmountMinor = Math.round(parseFloat(eventObj.resource.amount.value) * 100);
      }
    }

    await this.repository.processWebhookEvent({
      event: {
        id: eventId,
        eventType,
        resourceId: targetOrderId,
        processedAt: new Date().toISOString(),
        payload: (payload as Record<string, unknown>) || {},
      },
      targetOrderId,
      expectedCurrency,
      expectedAmountMinor,
      transition: targetTransition,
    });

    return true;
  }

  /**
   * Reconcile local order state against authoritative PayPal Sandbox Orders v2 API.
   * Guarantees Invariant G: zero capture requests are ever made during reconciliation.
   */
  async reconcileOrder(orderId: string, correlationId: string): Promise<ReconciliationResult> {
    const stored = await this.repository.getOrderById(orderId);

    if (!stored) {
      // Missing local record: check if order exists in PayPal Sandbox
      try {
        const paypalOrder = await this.ordersClient.getOrder(orderId, correlationId);
        return {
          orderId,
          status: 'REQUIRES_REVIEW',
          providerStatus: paypalOrder.status,
          details: `Order exists in PayPal Sandbox as ${paypalOrder.status} but has no corresponding AgentPay repository record. Server-side policy authorization is missing; cannot fabricate local order.`,
          timestamp: new Date().toISOString(),
        };
      } catch (err: unknown) {
        if (err instanceof PayPalOrderApiError && err.statusCode === 404) {
          return {
            orderId,
            status: 'NOT_FOUND',
            details: `Order ${orderId} does not exist in AgentPay repository or PayPal Sandbox.`,
            timestamp: new Date().toISOString(),
          };
        }
        return {
          orderId,
          status: 'RETRYABLE_ERROR',
          details: `Order not found locally and PayPal lookup failed: ${err instanceof Error ? err.message : String(err)}`,
          timestamp: new Date().toISOString(),
        };
      }
    }

    // Local order exists: query authoritative PayPal Sandbox state
    let liveOrder: {
      id: string;
      status: string;
      purchase_units?: Array<{
        amount?: { currency_code: string; value: string };
        payments?: {
          captures?: Array<{ id: string; create_time?: string }>;
        };
      }>;
    };

    try {
      liveOrder = await this.ordersClient.getOrder(orderId, correlationId);
    } catch (err: unknown) {
      if (err instanceof PayPalOrderApiError && err.statusCode === 404) {
        return {
          orderId,
          status: 'CONFLICT',
          previousOrderStatus: stored.status,
          currentOrderStatus: stored.status,
          details: `Order ${orderId} exists in AgentPay repository as ${stored.status} but PayPal returned 404 NOT_FOUND.`,
          timestamp: new Date().toISOString(),
        };
      }
      return {
        orderId,
        status: 'RETRYABLE_ERROR',
        previousOrderStatus: stored.status,
        currentOrderStatus: stored.status,
        details: `Failed to retrieve authoritative PayPal state: ${err instanceof Error ? err.message : String(err)}. Financial state preserved.`,
        timestamp: new Date().toISOString(),
      };
    }

    // Verify monetary and currency consistency
    const providerCurrency = liveOrder.purchase_units?.[0]?.amount?.currency_code;
    const providerValue = parseFloat(liveOrder.purchase_units?.[0]?.amount?.value || '0');
    const providerMinor = Math.round(providerValue * 100);

    if (
      providerCurrency &&
      (providerCurrency !== stored.currency || providerMinor !== stored.amountMinor)
    ) {
      return {
        orderId,
        status: 'CONFLICT',
        previousOrderStatus: stored.status,
        currentOrderStatus: stored.status,
        providerStatus: liveOrder.status,
        details: `Financial discrepancy detected: local=${stored.currency} ${stored.amountMinor} vs provider=${providerCurrency} ${providerMinor}. Reconciliation blocked.`,
        timestamp: new Date().toISOString(),
      };
    }

    // Monotonic state progression
    const previousStatus = stored.status;
    let targetStatus: PaymentOrderStatus | null = null;
    let captureId: string | undefined = undefined;
    let capturedAt: string | undefined = undefined;

    if (liveOrder.status === 'COMPLETED') {
      const foundCaptureId =
        liveOrder.purchase_units?.[0]?.payments?.captures?.[0]?.id ?? stored.captureId;
      if (!foundCaptureId) {
        return {
          orderId,
          status: 'REQUIRES_REVIEW',
          previousOrderStatus: stored.status,
          currentOrderStatus: stored.status,
          providerStatus: liveOrder.status,
          details: `PayPal reported COMPLETED but no authoritative capture evidence/ID was present in provider response. Order cannot transition to COMPLETED without capture evidence.`,
          timestamp: new Date().toISOString(),
        };
      }
      targetStatus = 'COMPLETED';
      captureId = foundCaptureId;
      capturedAt =
        liveOrder.purchase_units?.[0]?.payments?.captures?.[0]?.create_time ??
        new Date().toISOString();
    } else if (
      liveOrder.status === 'APPROVED' &&
      stored.status !== 'APPROVED' &&
      stored.status !== 'COMPLETED'
    ) {
      targetStatus = 'APPROVED';
    } else if (
      liveOrder.status === 'VOIDED' &&
      stored.status !== 'VOIDED' &&
      stored.status !== 'COMPLETED'
    ) {
      targetStatus = 'VOIDED';
    }

    if (
      targetStatus &&
      targetStatus !== previousStatus &&
      canTransitionStatus(previousStatus, targetStatus, { captureId })
    ) {
      const updated = await this.repository.updateOrderStatus(orderId, targetStatus, {
        captureId,
        capturedAt,
        lastReconciledAt: new Date().toISOString(),
        reconciliationStatus: 'UPDATED',
        metadata: {
          lastReconciledProviderStatus: liveOrder.status,
        },
      });

      return {
        orderId,
        status: 'UPDATED',
        previousOrderStatus: previousStatus,
        currentOrderStatus: updated.status,
        providerStatus: liveOrder.status,
        details: `State reconciled from ${previousStatus} to ${updated.status} based on authoritative PayPal response.`,
        timestamp: new Date().toISOString(),
      };
    }

    // Update reconciliation timestamp when state is unchanged
    await this.repository.updateOrderStatus(orderId, previousStatus, {
      lastReconciledAt: new Date().toISOString(),
      reconciliationStatus: 'UNCHANGED',
    });

    return {
      orderId,
      status: 'UNCHANGED',
      previousOrderStatus: previousStatus,
      currentOrderStatus: previousStatus,
      providerStatus: liveOrder.status,
      details: 'Local state is already in sync with authoritative PayPal state.',
      timestamp: new Date().toISOString(),
    };
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
      lastReconciledAt: stored.lastReconciledAt,
      reconciliationStatus: stored.reconciliationStatus,
    };
  }
}
