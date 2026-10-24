import Fastify from 'fastify';
import cors from '@fastify/cors';
import { v4 as uuidv4 } from 'uuid';
import {
  CreateOrderRequestSchema,
  CaptureOrderRequestSchema,
  PurchaseProposalSchema,
  ErrorCodes,
  type ApiHealthResponse,
} from '@agentpay/contracts';
import { createLogger, getChildLogger } from '@agentpay/logger';
import { MockPaymentProvider } from './provider.js';
import { getPaymentServiceConfig } from '@agentpay/config';

export function buildApp(
  provider = new MockPaymentProvider(),
  configOverride?: { paymentsEnabled?: boolean },
) {
  const config = getPaymentServiceConfig();
  const paymentsEnabled = configOverride?.paymentsEnabled ?? config.PAYMENTS_ENABLED;
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
        statusNote: paymentsEnabled
          ? 'Payments enabled in development mock mode'
          : 'Payment operations disabled by default configuration',
      },
    };
    return reply.status(200).send(health);
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

    try {
      const order = await provider.createOrder(proposalParsed.data, correlationId);
      reqLogger.info(
        { orderId: order.id, policyDecisionId, amountMinor: order.amountMinor },
        'Payment order created successfully under MOCK provider',
      );
      return reply.status(201).send(order);
    } catch (err) {
      reqLogger.error({ err }, 'Failed to create payment order');
      return reply.status(500).send({
        error: {
          code: ErrorCodes.INTERNAL_ERROR,
          message: 'Failed to create payment order',
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

    try {
      const result = await provider.captureOrder(id, policyDecisionId, correlationId);
      reqLogger.info(
        { captureId: result.captureId, orderId: id, policyDecisionId },
        'Mock order capture completed',
      );
      return reply.status(200).send(result);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Capture failed';
      reqLogger.error({ err }, 'Order capture failed');
      return reply.status(422).send({
        error: {
          code: ErrorCodes.BAD_REQUEST,
          message: errorMessage,
          correlationId,
        },
      });
    }
  });

  return app;
}
