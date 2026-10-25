import Fastify from 'fastify';
import cors from '@fastify/cors';
import { v4 as uuidv4 } from 'uuid';
import {
  CreateOrderRequestSchema,
  CaptureOrderRequestSchema,
  PurchaseProposalSchema,
  ErrorCodes,
  type ApiHealthResponse,
  type PaymentProvider,
  type PurchaseProposal,
} from '@agentpay/contracts';
import { createLogger, getChildLogger } from '@agentpay/logger';
import { MockPaymentProvider } from './provider.js';
import { PayPalPaymentProvider } from './paypal/provider.js';
import { PayPalOAuthClient, PayPalOAuthError } from './paypal/oauth-client.js';
import { ProposalValidationError } from './paypal/orders-client.js';
import {
  type PaymentOrderRepository,
  InMemoryPaymentOrderRepository,
  PostgresPaymentOrderRepository,
  IdempotencyConflictError,
} from './repository.js';
import { getPaymentServiceConfig, type PaymentServiceConfig } from '@agentpay/config';

export type PolicyVerifier = (
  proposal: PurchaseProposal,
  correlationId: string,
) => Promise<{ outcome: string; reasonMessage?: string; decisionId?: string }>;

export function buildApp(
  providerOverride?: PaymentProvider,
  configOverride?: Partial<PaymentServiceConfig> & { paymentsEnabled?: boolean },
  repositoryOverride?: PaymentOrderRepository,
  policyVerifierOverride?: PolicyVerifier,
) {
  const baseConfig = getPaymentServiceConfig();
  const config: PaymentServiceConfig = {
    ...baseConfig,
    ...configOverride,
    PAYMENTS_ENABLED:
      configOverride?.paymentsEnabled ??
      configOverride?.PAYMENTS_ENABLED ??
      baseConfig.PAYMENTS_ENABLED,
  };
  const paymentsEnabled = config.PAYMENTS_ENABLED;

  const repository =
    repositoryOverride ??
    (config.DATABASE_URL
      ? new PostgresPaymentOrderRepository(config.DATABASE_URL)
      : new InMemoryPaymentOrderRepository());

  // Resolve payment provider: use override, PayPal if configured, or default Mock
  let provider: PaymentProvider;
  if (providerOverride) {
    provider = providerOverride;
  } else if (
    config.PAYMENT_PROVIDER === 'paypal_sandbox' &&
    config.PAYPAL_CLIENT_ID &&
    config.PAYPAL_CLIENT_SECRET
  ) {
    provider = new PayPalPaymentProvider({
      clientId: config.PAYPAL_CLIENT_ID,
      clientSecret: config.PAYPAL_CLIENT_SECRET,
      environment: config.PAYPAL_ENVIRONMENT,
      apiBaseUrl: config.PAYPAL_API_BASE_URL,
      appBaseUrl: config.APP_BASE_URL,
      webhookId: config.PAYPAL_WEBHOOK_ID,
      repository,
    });
  } else {
    provider = new MockPaymentProvider(repository);
  }

  const startTime = Date.now();
  const logger = createLogger({ serviceName: 'payment-service', level: config.LOG_LEVEL });

  const app = Fastify({
    logger: false,
    requestTimeout: 10000,
  });

  app.register(cors, { origin: true });

  app.addHook('onRequest', async (req, reply) => {
    const correlationId = (req.headers['x-correlation-id'] as string) || uuidv4();
    req.headers['x-correlation-id'] = correlationId;
    reply.header('x-correlation-id', correlationId);
  });

  app.get('/health', async (_req, reply) => {
    const health: ApiHealthResponse = {
      status: 'ok',
      service: 'payment-service',
      version: '0.1.0',
      uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
      details: {
        provider: provider.providerName,
        isMock: provider.isMock,
        paymentsEnabled,
        oauthConfigured: Boolean(config.PAYPAL_CLIENT_ID && config.PAYPAL_CLIENT_SECRET),
        statusNote: paymentsEnabled
          ? 'Payments enabled'
          : 'Payment operations disabled by default configuration',
      },
    };
    return reply.status(200).send(health);
  });

  // Safe PayPal OAuth diagnostic endpoint
  app.get('/paypal/verify-auth', async (req, reply) => {
    const correlationId = req.headers['x-correlation-id'] as string;
    const reqLogger = getChildLogger(logger, correlationId);

    if (!config.PAYPAL_CLIENT_ID || !config.PAYPAL_CLIENT_SECRET) {
      reqLogger.info('PayPal auth verification requested but credentials not configured');
      return reply.status(200).send({
        authenticated: false,
        configured: false,
        environment: config.PAYPAL_ENVIRONMENT,
        message:
          'PayPal Sandbox credentials (PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET) are not configured in environment.',
      });
    }

    const oauthClient = new PayPalOAuthClient({
      clientId: config.PAYPAL_CLIENT_ID,
      clientSecret: config.PAYPAL_CLIENT_SECRET,
      environment: config.PAYPAL_ENVIRONMENT,
      apiBaseUrl: config.PAYPAL_API_BASE_URL,
      timeoutMs: 10000,
    });

    try {
      const result = await oauthClient.verifyCredentials(correlationId);
      reqLogger.info(
        { environment: result.environment, expiresInSeconds: result.expiresInSeconds },
        'PayPal Sandbox OAuth authentication verified successfully',
      );
      return reply.status(200).send({
        authenticated: true,
        configured: true,
        environment: result.environment,
        tokenType: result.tokenType,
        expiresInSeconds: result.expiresInSeconds,
        expiresAt: result.expiresAt,
        ...(result.appId ? { appId: result.appId } : {}),
        message: 'PayPal Sandbox OAuth authentication verified successfully',
      });
    } catch (err: unknown) {
      if (err instanceof PayPalOAuthError) {
        reqLogger.warn(
          { code: err.code, statusCode: err.statusCode },
          'PayPal OAuth verification failed',
        );
        return reply.status(err.statusCode === 401 ? 401 : 502).send({
          authenticated: false,
          configured: true,
          error: {
            code: err.code,
            message: err.message,
            correlationId,
          },
        });
      }

      reqLogger.error({ err }, 'Unexpected error during PayPal OAuth verification');
      return reply.status(500).send({
        authenticated: false,
        configured: true,
        error: {
          code: ErrorCodes.INTERNAL_ERROR,
          message: 'Internal error verifying PayPal OAuth credentials',
          correlationId,
        },
      });
    }
  });

  // Create payment order
  app.post('/orders', async (req, reply) => {
    const correlationId = req.headers['x-correlation-id'] as string;
    const reqLogger = getChildLogger(logger, correlationId);

    if (!paymentsEnabled) {
      reqLogger.warn('Order creation rejected: PAYMENTS_ENABLED is false');
      return reply.status(403).send({
        error: {
          code: ErrorCodes.PAYMENTS_DISABLED,
          message:
            'Payment operations are currently disabled. Set PAYMENTS_ENABLED=true in environment to enable development mock payments.',
          correlationId,
        },
      });
    }

    const parseResult = CreateOrderRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      reqLogger.warn({ issues: parseResult.error.issues }, 'Invalid order creation request');
      return reply.status(400).send({
        error: {
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Invalid order creation payload',
          correlationId,
          details: parseResult.error.issues,
        },
      });
    }

    const { proposal: rawProposal, policyDecisionId, authorizedOutcome } = parseResult.data;

    if (authorizedOutcome !== 'ALLOW') {
      reqLogger.warn({ authorizedOutcome }, 'Order creation rejected: policy not allowed');
      return reply.status(403).send({
        error: {
          code: ErrorCodes.POLICY_VIOLATION,
          message: 'Order creation requires policy decision ALLOW outcome',
          correlationId,
        },
      });
    }

    const proposalParsed = PurchaseProposalSchema.safeParse(rawProposal);
    if (!proposalParsed.success) {
      return reply.status(400).send({
        error: {
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Invalid proposal embedded in order request',
          correlationId,
          details: proposalParsed.error.issues,
        },
      });
    }

    // Independent policy decision verification:
    // Never trust client-supplied authorizedOutcome alone.
    if (policyVerifierOverride) {
      const evaluation = await policyVerifierOverride(proposalParsed.data, correlationId);
      if (evaluation.outcome !== 'ALLOW') {
        reqLogger.warn(
          { outcome: evaluation.outcome },
          'Order creation rejected: independent policy evaluation failed',
        );
        return reply.status(403).send({
          error: {
            code: ErrorCodes.POLICY_VIOLATION,
            message: `Policy evaluation rejected: ${evaluation.reasonMessage ?? evaluation.outcome}`,
            correlationId,
          },
        });
      }
    } else if (config.POLICY_SERVICE_URL && process.env.NODE_ENV !== 'test') {
      try {
        const policyRes = await fetch(`${config.POLICY_SERVICE_URL}/policies/evaluate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-correlation-id': correlationId,
          },
          body: JSON.stringify(proposalParsed.data),
        });
        if (policyRes.ok) {
          const evaluation = (await policyRes.json()) as {
            outcome: string;
            reasonMessage?: string;
          };
          if (evaluation.outcome !== 'ALLOW') {
            reqLogger.warn(
              { outcome: evaluation.outcome },
              'Order creation rejected: downstream policy service evaluated outcome to DENY',
            );
            return reply.status(403).send({
              error: {
                code: ErrorCodes.POLICY_VIOLATION,
                message: `Policy evaluation rejected: ${evaluation.reasonMessage ?? evaluation.outcome}`,
                correlationId,
              },
            });
          }
        }
      } catch (err) {
        reqLogger.warn({ err }, 'Could not contact policy service for independent validation');
      }
    }

    const idempotencyKey =
      (req.headers['x-idempotency-key'] as string) ||
      parseResult.data.idempotencyKey ||
      `order-${proposalParsed.data.id}`;

    try {
      const order = await provider.createOrder(proposalParsed.data, correlationId, {
        idempotencyKey,
        policyDecisionId,
      });
      reqLogger.info(
        {
          orderId: order.id,
          policyDecisionId,
          amountMinor: order.amountMinor,
          provider: provider.providerName,
        },
        'Payment order created successfully',
      );
      return reply.status(201).send(order);
    } catch (err: unknown) {
      if (err instanceof ProposalValidationError) {
        reqLogger.warn({ err: err.message }, 'Invalid proposal for order creation');
        return reply.status(400).send({
          error: {
            code: ErrorCodes.VALIDATION_ERROR,
            message: err.message,
            correlationId,
            details: err.details,
          },
        });
      }

      if (err instanceof IdempotencyConflictError) {
        reqLogger.warn({ err: err.message }, 'Idempotency conflict detected');
        return reply.status(409).send({
          error: {
            code: 'IDEMPOTENCY_CONFLICT',
            message: err.message,
            correlationId,
          },
        });
      }

      const msg = err instanceof Error ? err.message : 'Failed to create payment order';
      reqLogger.error({ err }, 'Failed to create payment order');
      return reply.status(500).send({
        error: {
          code: ErrorCodes.INTERNAL_ERROR,
          message: msg,
          correlationId,
        },
      });
    }
  });

  // Get order
  app.get('/orders/:id', async (req, reply) => {
    const correlationId = req.headers['x-correlation-id'] as string;
    const { id } = req.params as { id: string };

    const order = await provider.getOrder(id, correlationId);
    if (!order) {
      return reply.status(404).send({
        error: {
          code: ErrorCodes.NOT_FOUND,
          message: `Order ${id} not found`,
          correlationId,
        },
      });
    }
    return reply.status(200).send(order);
  });

  // Capture authorized order
  app.post('/orders/:id/capture', async (req, reply) => {
    const correlationId = req.headers['x-correlation-id'] as string;
    const reqLogger = getChildLogger(logger, correlationId);
    const { id } = req.params as { id: string };

    if (!paymentsEnabled) {
      reqLogger.warn('Order capture rejected: PAYMENTS_ENABLED is false');
      return reply.status(403).send({
        error: {
          code: ErrorCodes.PAYMENTS_DISABLED,
          message: 'Payment capture is disabled by configuration',
          correlationId,
        },
      });
    }

    const parseResult = CaptureOrderRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: {
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Missing or invalid policyDecisionId for capture verification',
          correlationId,
          details: parseResult.error.issues,
        },
      });
    }

    const { policyDecisionId } = parseResult.data;
    const captureKey =
      (req.headers['x-idempotency-key'] as string) ||
      parseResult.data.idempotencyKey ||
      `cap-${id}`;

    try {
      const result = await provider.captureOrder(id, policyDecisionId, correlationId, {
        idempotencyKey: captureKey,
      });
      reqLogger.info(
        { captureId: result.captureId, orderId: id, policyDecisionId, status: result.status },
        'Payment order capture completed',
      );
      return reply.status(200).send(result);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Capture failed';
      reqLogger.error({ err }, 'Order capture failed');
      const isPolicyViolation =
        errorMessage.includes('Policy decision') || errorMessage.includes('policy authorization');
      return reply.status(isPolicyViolation ? 403 : 422).send({
        error: {
          code: isPolicyViolation ? ErrorCodes.POLICY_VIOLATION : ErrorCodes.BAD_REQUEST,
          message: errorMessage,
          correlationId,
        },
      });
    }
  });

  // Reconcile order state with authoritative provider state
  app.post('/orders/:id/reconcile', async (req, reply) => {
    const correlationId = req.headers['x-correlation-id'] as string;
    const reqLogger = getChildLogger(logger, correlationId);
    const { id } = req.params as { id: string };

    if (!provider.reconcileOrder) {
      return reply.status(501).send({
        error: {
          code: 'NOT_IMPLEMENTED',
          message: 'Provider does not support reconciliation',
          correlationId,
        },
      });
    }

    try {
      const result = await provider.reconcileOrder(id, correlationId);
      reqLogger.info(
        {
          orderId: id,
          status: result.status,
          currentOrderStatus: result.currentOrderStatus,
          providerStatus: result.providerStatus,
        },
        'Order state reconciliation completed',
      );
      return reply.status(200).send(result);
    } catch (err: unknown) {
      reqLogger.error({ err }, 'Order reconciliation failed');
      return reply.status(500).send({
        error: {
          code: ErrorCodes.INTERNAL_ERROR,
          message: err instanceof Error ? err.message : 'Failed to reconcile payment order',
          correlationId,
        },
      });
    }
  });

  // PayPal Webhook Ingestion endpoint
  app.post('/webhooks/paypal', async (req, reply) => {
    const correlationId = req.headers['x-correlation-id'] as string;
    const reqLogger = getChildLogger(logger, correlationId);

    const headersRecord: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') {
        headersRecord[k.toLowerCase()] = v;
      }
    }

    try {
      const verified = await provider.verifyWebhook(req.body, headersRecord);
      if (!verified) {
        reqLogger.warn('PayPal webhook signature verification failed');
        return reply.status(400).send({ error: 'Invalid webhook signature' });
      }

      reqLogger.info('PayPal webhook event processed successfully');
      return reply.status(200).send({ received: true });
    } catch (err: unknown) {
      reqLogger.error({ err }, 'Error processing PayPal webhook');
      return reply.status(500).send({ error: 'Internal webhook processing error' });
    }
  });

  return app;
}
