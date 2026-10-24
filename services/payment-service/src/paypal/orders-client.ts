import type { PurchaseProposal } from '@agentpay/contracts';
import { PayPalOAuthError, type PayPalOAuthClient } from './oauth-client.js';

export interface PayPalOrdersClientOptions {
  oauthClient: PayPalOAuthClient;
  apiBaseUrl?: string;
  appBaseUrl?: string;
  timeoutMs?: number;
}

export interface PayPalOrderResponse {
  id: string;
  status: 'CREATED' | 'SAVED' | 'APPROVED' | 'VOIDED' | 'COMPLETED' | 'PAYER_ACTION_REQUIRED';
  intent?: string;
  purchase_units?: Array<{
    reference_id?: string;
    amount?: {
      currency_code: string;
      value: string;
    };
    payments?: {
      captures?: Array<{
        id: string;
        status: 'COMPLETED' | 'DECLINED' | 'FAILED' | 'PENDING';
        amount?: {
          currency_code: string;
          value: string;
        };
        create_time?: string;
      }>;
    };
  }>;
  links?: Array<{
    href: string;
    rel: string;
    method?: string;
  }>;
}

export interface PayPalCaptureResponse {
  id: string; // Order ID
  status: 'COMPLETED' | 'DECLINED' | 'FAILED' | 'PENDING';
  purchase_units?: Array<{
    reference_id?: string;
    payments?: {
      captures?: Array<{
        id: string;
        status: 'COMPLETED' | 'DECLINED' | 'FAILED' | 'PENDING';
        amount?: {
          currency_code: string;
          value: string;
        };
        create_time?: string;
      }>;
    };
  }>;
}

export class PayPalOrderApiError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: string, message: string, options?: { statusCode?: number; details?: unknown }) {
    super(message);
    this.name = 'PayPalOrderApiError';
    this.code = code;
    this.statusCode = options?.statusCode ?? 500;
    this.details = options?.details;
  }
}

export class PayPalCaptureTimeoutError extends Error {
  readonly code = 'CAPTURE_TIMEOUT';
  readonly orderId: string;
  readonly idempotencyKey?: string;
  readonly correlationId?: string;

  constructor(
    message: string,
    options: { orderId: string; idempotencyKey?: string; correlationId?: string },
  ) {
    super(message);
    this.name = 'PayPalCaptureTimeoutError';
    this.code = 'CAPTURE_TIMEOUT';
    this.orderId = options.orderId;
    this.idempotencyKey = options.idempotencyKey;
    this.correlationId = options.correlationId;
  }
}

export class ProposalValidationError extends Error {
  readonly code = 'INVALID_PROPOSAL';
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = 'ProposalValidationError';
    this.details = details;
  }
}

export interface ValidatedProposalItem {
  id: string;
  name: string;
  quantity: string;
  quantityNum: number;
  unitPriceMinor: number;
  unitAmountValue: string;
  currency: string;
  itemTotalMinor: number;
}

export interface ValidatedProposalData {
  proposalId: string;
  currency: string;
  totalAmountMinor: number;
  totalAmountValue: string;
  itemTotalValue: string;
  items: ValidatedProposalItem[];
}

/**
 * Validates proposal financial integrity: safe integers, non-negative amounts,
 * positive quantities, currency match across all items, and exact sum equality.
 */
export function validateProposalAmountsAndCurrency(
  proposal: PurchaseProposal,
): ValidatedProposalData {
  if (!proposal) {
    throw new ProposalValidationError('Purchase proposal is required');
  }

  // 1. Currency validation (must be 3-letter ISO string)
  if (
    !proposal.currency ||
    typeof proposal.currency !== 'string' ||
    !/^[A-Z]{3}$/.test(proposal.currency)
  ) {
    throw new ProposalValidationError(
      `Invalid proposal currency: '${proposal.currency}'. Must be a 3-letter uppercase ISO currency code.`,
    );
  }

  // 2. Safe integer totalAmountMinor validation (must be positive safe integer)
  if (
    typeof proposal.totalAmountMinor !== 'number' ||
    !Number.isSafeInteger(proposal.totalAmountMinor) ||
    proposal.totalAmountMinor <= 0
  ) {
    throw new ProposalValidationError(
      `Proposal totalAmountMinor must be a positive safe integer, received: ${proposal.totalAmountMinor}`,
    );
  }

  // 3. Item list validation (must contain at least one item)
  if (!proposal.items || !Array.isArray(proposal.items) || proposal.items.length === 0) {
    throw new ProposalValidationError('Proposal must contain at least one item');
  }

  let calculatedSumMinor = 0;
  const validatedItems: ValidatedProposalItem[] = [];

  for (let i = 0; i < proposal.items.length; i++) {
    const item = proposal.items[i];
    if (!item) {
      throw new ProposalValidationError(`Item at index ${i} is missing`);
    }

    const itemName =
      typeof item.name === 'string' && item.name.trim().length > 0 ? item.name : `Item-${i + 1}`;

    // Item currency must match proposal currency
    if (item.currency !== proposal.currency) {
      throw new ProposalValidationError(
        `Item '${itemName}' currency '${item.currency}' does not match proposal currency '${proposal.currency}'`,
      );
    }

    // Item quantity must be a positive integer
    if (
      typeof item.quantity !== 'number' ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity <= 0
    ) {
      throw new ProposalValidationError(
        `Item '${itemName}' quantity must be a positive integer, received: ${item.quantity}`,
      );
    }

    // Item unitPriceMinor must be a non-negative safe integer
    if (
      typeof item.unitPriceMinor !== 'number' ||
      !Number.isSafeInteger(item.unitPriceMinor) ||
      item.unitPriceMinor < 0
    ) {
      throw new ProposalValidationError(
        `Item '${itemName}' unitPriceMinor must be a non-negative safe integer, received: ${item.unitPriceMinor}`,
      );
    }

    // Overflow protection on item multiplication
    if (
      item.unitPriceMinor > 0 &&
      item.quantity > Math.floor(Number.MAX_SAFE_INTEGER / item.unitPriceMinor)
    ) {
      throw new ProposalValidationError(
        `Arithmetic overflow computing item total for '${itemName}'`,
      );
    }

    const itemTotalMinor = item.unitPriceMinor * item.quantity;
    if (!Number.isSafeInteger(itemTotalMinor)) {
      throw new ProposalValidationError(
        `Arithmetic overflow computing item total for '${itemName}'`,
      );
    }

    // Overflow protection on running sum addition
    if (calculatedSumMinor > Number.MAX_SAFE_INTEGER - itemTotalMinor) {
      throw new ProposalValidationError(
        'Arithmetic overflow computing total sum of proposal items',
      );
    }

    calculatedSumMinor += itemTotalMinor;
    if (!Number.isSafeInteger(calculatedSumMinor)) {
      throw new ProposalValidationError(
        'Arithmetic overflow computing total sum of proposal items',
      );
    }

    validatedItems.push({
      id: item.id || `item-${i + 1}`,
      name: itemName.slice(0, 127),
      quantity: String(item.quantity),
      quantityNum: item.quantity,
      unitPriceMinor: item.unitPriceMinor,
      unitAmountValue: (item.unitPriceMinor / 100).toFixed(2),
      currency: item.currency,
      itemTotalMinor,
    });
  }

  // Sum check: sum(item.unitPriceMinor * item.quantity) === totalAmountMinor
  if (calculatedSumMinor !== proposal.totalAmountMinor) {
    throw new ProposalValidationError(
      `Sum of item amounts (${calculatedSumMinor} minor units) does not match proposal totalAmountMinor (${proposal.totalAmountMinor} minor units)`,
    );
  }

  const totalAmountValue = (proposal.totalAmountMinor / 100).toFixed(2);
  const itemTotalValue = (calculatedSumMinor / 100).toFixed(2);

  return {
    proposalId: proposal.id,
    currency: proposal.currency,
    totalAmountMinor: proposal.totalAmountMinor,
    totalAmountValue,
    itemTotalValue,
    items: validatedItems,
  };
}

export class PayPalOrdersClient {
  private readonly oauthClient: PayPalOAuthClient;
  private readonly apiBaseUrl: string;
  private readonly appBaseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: PayPalOrdersClientOptions) {
    this.oauthClient = options.oauthClient;
    this.apiBaseUrl = (options.apiBaseUrl ?? 'https://api-m.sandbox.paypal.com').replace(/\/$/, '');
    this.appBaseUrl = (
      options.appBaseUrl ??
      process.env['APP_BASE_URL'] ??
      'http://localhost:3000'
    ).replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 10000;
  }

  /**
   * Create order in PayPal Sandbox using Orders v2 API.
   * Authoritative amounts and currencies are validated upfront and derived to guarantee consistency.
   */
  async createOrder(
    proposal: PurchaseProposal,
    idempotencyKey: string,
    correlationId?: string,
  ): Promise<{
    id: string;
    status: PayPalOrderResponse['status'];
    approvalUrl?: string;
    rawResponse: PayPalOrderResponse;
  }> {
    // 1. Financial integrity check: reject invalid proposals before any network request
    const validated = validateProposalAmountsAndCurrency(proposal);

    // 2. Obtain access token
    const token = await this.oauthClient.getAccessToken(correlationId);
    const endpoint = `${this.apiBaseUrl}/v2/checkout/orders`;

    const payload = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: proposal.id,
          description: proposal.purpose.slice(0, 127),
          amount: {
            currency_code: validated.currency,
            value: validated.totalAmountValue,
            breakdown: {
              item_total: {
                currency_code: validated.currency,
                value: validated.itemTotalValue,
              },
            },
          },
          items: validated.items.map((item) => ({
            name: item.name,
            quantity: item.quantity,
            unit_amount: {
              currency_code: item.currency,
              value: item.unitAmountValue,
            },
          })),
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: 'AgentPay',
            landing_page: 'NO_PREFERENCE',
            user_action: 'PAY_NOW',
            return_url: `${this.appBaseUrl}/orders/success`,
            cancel_url: `${this.appBaseUrl}/orders/cancelled`,
          },
        },
      },
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'PayPal-Request-Id': idempotencyKey,
          Prefer: 'return=representation',
          ...(correlationId ? { 'X-Correlation-Id': correlationId } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const data = (await response.json().catch(() => null)) as PayPalOrderResponse | null;

      if (!response.ok) {
        const errorDetail = (data as unknown as { message?: string; name?: string })?.message;
        throw new PayPalOrderApiError(
          'ORDER_CREATION_FAILED',
          `PayPal Orders API returned HTTP ${response.status}: ${errorDetail ?? 'Unknown error'}`,
          { statusCode: response.status, details: data },
        );
      }

      if (!data || !data.id) {
        throw new PayPalOrderApiError(
          'MALFORMED_RESPONSE',
          'PayPal Orders API response missing order id',
          { statusCode: response.status },
        );
      }

      // Extract buyer approval URL
      const approveLink = data.links?.find((l) => l.rel === 'approve' || l.rel === 'payer-action');

      return {
        id: data.id,
        status: data.status,
        approvalUrl: approveLink?.href,
        rawResponse: data,
      };
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof PayPalOrderApiError) throw err;
      if (err instanceof PayPalOAuthError) throw err;

      if (err instanceof Error && err.name === 'AbortError') {
        throw new PayPalOrderApiError(
          'TIMEOUT',
          `PayPal create order timed out after ${this.timeoutMs}ms`,
          { statusCode: 504 },
        );
      }

      const msg = err instanceof Error ? err.message : String(err);
      throw new PayPalOrderApiError('NETWORK_ERROR', `PayPal create order network error: ${msg}`, {
        statusCode: 502,
      });
    }
  }

  /**
   * Retrieve order details from PayPal Sandbox.
   */
  async getOrder(orderId: string, correlationId?: string): Promise<PayPalOrderResponse> {
    const token = await this.oauthClient.getAccessToken(correlationId);
    const endpoint = `${this.apiBaseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(correlationId ? { 'X-Correlation-Id': correlationId } : {}),
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const data = (await response.json().catch(() => null)) as PayPalOrderResponse | null;

      if (!response.ok) {
        throw new PayPalOrderApiError(
          'ORDER_LOOKUP_FAILED',
          `PayPal get order returned HTTP ${response.status}`,
          { statusCode: response.status, details: data },
        );
      }

      if (!data || !data.id) {
        throw new PayPalOrderApiError(
          'MALFORMED_RESPONSE',
          'PayPal get order response missing id',
          { statusCode: response.status },
        );
      }

      return data;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof PayPalOrderApiError) throw err;
      if (err instanceof PayPalOAuthError) throw err;

      if (err instanceof Error && err.name === 'AbortError') {
        throw new PayPalOrderApiError(
          'TIMEOUT',
          `PayPal get order timed out after ${this.timeoutMs}ms`,
          { statusCode: 504 },
        );
      }

      const msg = err instanceof Error ? err.message : String(err);
      throw new PayPalOrderApiError('NETWORK_ERROR', `PayPal get order error: ${msg}`, {
        statusCode: 502,
      });
    }
  }

  /**
   * Capture an authorized/approved PayPal order.
   * If a timeout occurs, throws PayPalCaptureTimeoutError to enable marking status as UNKNOWN.
   */
  async captureOrder(
    orderId: string,
    idempotencyKey: string,
    correlationId?: string,
  ): Promise<{
    orderId: string;
    captureId: string;
    status: 'COMPLETED' | 'DECLINED' | 'FAILED' | 'PENDING';
    capturedAmountMinor: number;
    currency: string;
    rawResponse: PayPalCaptureResponse;
  }> {
    const token = await this.oauthClient.getAccessToken(correlationId);
    const endpoint = `${this.apiBaseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'PayPal-Request-Id': idempotencyKey,
          Prefer: 'return=representation',
          ...(correlationId ? { 'X-Correlation-Id': correlationId } : {}),
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const data = (await response.json().catch(() => null)) as PayPalCaptureResponse | null;

      if (!response.ok) {
        const errorDetail = (data as unknown as { message?: string })?.message;
        throw new PayPalOrderApiError(
          'CAPTURE_FAILED',
          `PayPal capture endpoint returned HTTP ${response.status}: ${errorDetail ?? 'Capture failed'}`,
          { statusCode: response.status, details: data },
        );
      }

      if (!data || !data.id) {
        throw new PayPalOrderApiError(
          'MALFORMED_RESPONSE',
          'PayPal capture response missing order id',
          { statusCode: response.status },
        );
      }

      const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
      const captureId = capture?.id ?? data.id;
      const status = capture?.status ?? data.status ?? 'COMPLETED';

      // Convert captured amount to minor units (cents)
      const valueDecimal = capture?.amount?.value ? parseFloat(capture.amount.value) : 0;
      const capturedAmountMinor = Math.round(valueDecimal * 100);
      const currency = capture?.amount?.currency_code ?? 'USD';

      return {
        orderId: data.id,
        captureId,
        status,
        capturedAmountMinor,
        currency,
        rawResponse: data,
      };
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof PayPalOrderApiError) throw err;
      if (err instanceof PayPalOAuthError) throw err;

      if (err instanceof Error && err.name === 'AbortError') {
        throw new PayPalCaptureTimeoutError(
          `PayPal capture order timed out after ${this.timeoutMs}ms. Status is UNKNOWN.`,
          { orderId, idempotencyKey, correlationId },
        );
      }

      const msg = err instanceof Error ? err.message : String(err);
      throw new PayPalOrderApiError('NETWORK_ERROR', `PayPal capture network error: ${msg}`, {
        statusCode: 502,
      });
    }
  }

  /**
   * Verify Webhook Signature via PayPal REST API.
   * Returns true if PayPal confirms the signature is valid.
   */
  async verifyWebhookSignature(params: {
    webhookId: string;
    authAlgo: string;
    certUrl: string;
    transmissionId: string;
    transmissionSig: string;
    transmissionTime: string;
    webhookEvent: unknown;
    correlationId?: string;
  }): Promise<boolean> {
    const token = await this.oauthClient.getAccessToken(params.correlationId);
    const endpoint = `${this.apiBaseUrl}/v1/notifications/verify-webhook-signature`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(params.correlationId ? { 'X-Correlation-Id': params.correlationId } : {}),
        },
        body: JSON.stringify({
          auth_algo: params.authAlgo,
          cert_url: params.certUrl,
          transmission_id: params.transmissionId,
          transmission_sig: params.transmissionSig,
          transmission_time: params.transmissionTime,
          webhook_id: params.webhookId,
          webhook_event: params.webhookEvent,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return false;
      }

      const data = (await response.json().catch(() => null)) as {
        verification_status?: string;
      } | null;

      return data?.verification_status === 'SUCCESS';
    } catch {
      clearTimeout(timeoutId);
      return false;
    }
  }
}
