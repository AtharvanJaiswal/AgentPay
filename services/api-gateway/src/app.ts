import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { v4 as uuidv4 } from 'uuid';
import {
  CreateProposalInputSchema,
  PurchaseProposalSchema,
  ErrorCodes,
  type ApiHealthResponse,
} from '@agentpay/contracts';
import { createLogger, getChildLogger } from '@agentpay/logger';
import { getApiGatewayConfig } from '@agentpay/config';
import { ServiceClient } from './client.js';

export function buildApp(clientOverride?: ServiceClient) {
  const config = getApiGatewayConfig();
  const client = clientOverride ?? new ServiceClient(config);
  const startTime = Date.now();
  const logger = createLogger({ serviceName: 'api-gateway', level: config.LOG_LEVEL });

  const app = Fastify({
    logger: false,
    bodyLimit: 262144, // 256 KB limit
    requestTimeout: config.REQUEST_TIMEOUT_MS,
  });

  // Explicit CORS configuration
  app.register(cors, {
    origin: [config.APP_BASE_URL, 'http://localhost:3000', 'http://127.0.0.1:3000'],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-correlation-id'],
    credentials: true,
  });

  // Basic rate limiting at public boundary
  app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    errorResponseBuilder: (_req, context) => ({
      error: {
        code: ErrorCodes.RATE_LIMITED,
        message: `Too many requests, please retry after ${context.after}`,
      },
    }),
  });

  // Correlation ID propagation hook
  app.addHook('onRequest', async (req, reply) => {
    const correlationId = (req.headers['x-correlation-id'] as string) || uuidv4();
    req.headers['x-correlation-id'] = correlationId;
    reply.header('x-correlation-id', correlationId);
  });

  // Standard Health Check
  app.get('/api/health', async (_req, reply) => {
    const [agentHealth, policyHealth, paymentHealth, auditHealth] = await Promise.all([
      client.checkServiceHealth(config.AGENT_SERVICE_URL),
      client.checkServiceHealth(config.POLICY_SERVICE_URL),
      client.checkServiceHealth(config.PAYMENT_SERVICE_URL),
      client.checkServiceHealth(config.AUDIT_SERVICE_URL),
    ]);

    const downstream = {
      agentService: agentHealth?.status ?? 'down',
      policyService: policyHealth?.status ?? 'down',
      paymentService: paymentHealth?.status ?? 'down',
      auditService: auditHealth?.status ?? 'down',
    };

    const isAllOk = Object.values(downstream).every((status) => status === 'ok');

    const health: ApiHealthResponse = {
      status: isAllOk ? 'ok' : 'degraded',
      service: 'api-gateway',
      version: '0.1.0',
      uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
      details: {
        downstream,
      },
    };

    return reply.status(200).send(health);
  });

  // Platform Status Endpoint for Web UI
  app.get('/api/status', async (_req, reply) => {
    const paymentHealth = await client.checkServiceHealth(config.PAYMENT_SERVICE_URL);
    const paymentDetails = paymentHealth?.details as
      | {
          provider?: string;
          isMock?: boolean;
          paymentsEnabled?: boolean;
          oauthConfigured?: boolean;
        }
      | undefined;

    const isSandboxActive = Boolean(
      paymentDetails && !paymentDetails.isMock && paymentDetails.provider === 'PayPal Sandbox',
    );
    const activeProvider = paymentDetails?.provider ?? 'MOCK/DEVELOPMENT';
    const isMock = paymentDetails?.isMock ?? true;
    const paymentsEnabled = paymentDetails?.paymentsEnabled ?? false;
    const paypalConfigured = Boolean(paymentDetails?.oauthConfigured || isSandboxActive);

    const statusLabel = isSandboxActive
      ? paymentsEnabled
        ? 'PayPal Sandbox Active (Payments Enabled)'
        : 'PayPal Sandbox Active (Capture Disabled)'
      : 'Sandbox not configured (Mock Provider Active)';

    const warning = isSandboxActive
      ? paymentsEnabled
        ? 'PayPal Sandbox Orders v2 is active with live capture enabled for test orders.'
        : 'PayPal Sandbox Orders v2 is active. Real payment capture is disabled by default configuration.'
      : 'Real payment capture is disabled. PayPal Sandbox credentials and OAuth verification will be configured in a subsequent phase.';

    return reply.status(200).send({
      platform: 'AgentPay',
      version: '0.1.0-foundation',
      timestamp: new Date().toISOString(),
      providerStatus: {
        activeProvider,
        isMock,
        paypalSandboxConfigured: paypalConfigured,
        statusLabel,
        paymentsEnabled,
        warning,
      },
      security: {
        policyEngineActive: true,
        enforceStrictAllow: true,
        auditTrailEnabled: true,
      },
    });
  });

  // Create Proposal via Agent Service
  app.post('/api/proposals', async (req, reply) => {
    const correlationId = req.headers['x-correlation-id'] as string;
    const reqLogger = getChildLogger(logger, correlationId);

    const parseResult = CreateProposalInputSchema.safeParse(req.body);
    if (!parseResult.success) {
      reqLogger.warn({ issues: parseResult.error.issues }, 'Invalid proposal input received');
      return reply.status(400).send({
        error: {
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Invalid proposal input',
          correlationId,
          details: parseResult.error.issues,
        },
      });
    }

    try {
      const { rawIntent, agentId } = parseResult.data;
      const proposal = await client.createProposal(rawIntent, agentId, correlationId);

      // Audit event
      await client.recordAuditEvent(
        {
          correlationId,
          eventType: 'PROPOSAL_CREATED',
          actor: agentId,
          resourceId: proposal.id,
          outcome: 'CREATED',
          metadata: {
            merchantName: proposal.merchant.name,
            totalAmountMinor: proposal.totalAmountMinor,
            currency: proposal.currency,
          },
        },
        correlationId,
      );

      return reply.status(201).send(proposal);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error creating proposal';
      reqLogger.error({ err }, 'Proposal generation failed');
      return reply.status(502).send({
        error: {
          code: ErrorCodes.SERVICE_UNAVAILABLE,
          message,
          correlationId,
        },
      });
    }
  });

  // Evaluate Policy via Policy Service
  app.post('/api/evaluations', async (req, reply) => {
    const correlationId = req.headers['x-correlation-id'] as string;
    const reqLogger = getChildLogger(logger, correlationId);

    const parseResult = PurchaseProposalSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: {
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Invalid purchase proposal for policy evaluation',
          correlationId,
          details: parseResult.error.issues,
        },
      });
    }

    const proposal = parseResult.data;

    try {
      const decision = await client.evaluatePolicy(proposal, correlationId);

      // Audit policy outcome
      const auditEventType =
        decision.outcome === 'ALLOW'
          ? 'POLICY_EVALUATED_ALLOW'
          : decision.outcome === 'DENY'
            ? 'POLICY_EVALUATED_DENY'
            : 'POLICY_EVALUATED_APPROVAL_REQUIRED';

      await client.recordAuditEvent(
        {
          correlationId,
          eventType: auditEventType,
          actor: 'policy-service',
          resourceId: decision.decisionId,
          outcome: decision.outcome,
          reasonCode: decision.reasonCode,
          metadata: {
            proposalId: proposal.id,
            reasonMessage: decision.reasonMessage,
            totalAmountMinor: proposal.totalAmountMinor,
          },
        },
        correlationId,
      );

      return reply.status(200).send(decision);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Policy evaluation failed';
      reqLogger.error({ err }, 'Policy evaluation downstream failed');
      return reply.status(502).send({
        error: {
          code: ErrorCodes.SERVICE_UNAVAILABLE,
          message,
          correlationId,
        },
      });
    }
  });

  // Create Payment Order (Strict Policy Enforcement - Never bypasses Policy Service)
  app.post('/api/payments/orders', async (req, reply) => {
    const correlationId = req.headers['x-correlation-id'] as string;
    const reqLogger = getChildLogger(logger, correlationId);

    const body = req.body as { proposal?: unknown; policyDecisionId?: string };
    const proposalParse = PurchaseProposalSchema.safeParse(body?.proposal);
    if (!proposalParse.success) {
      return reply.status(400).send({
        error: {
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Invalid proposal in payment order request',
          correlationId,
          details: proposalParse.error.issues,
        },
      });
    }

    const proposal = proposalParse.data;

    // Independent verification: Evaluate policy deterministically
    const decision = await client.evaluatePolicy(proposal, correlationId);

    if (decision.outcome !== 'ALLOW') {
      reqLogger.warn(
        { outcome: decision.outcome, reasonCode: decision.reasonCode, proposalId: proposal.id },
        'Payment creation blocked by policy engine: zero payment provider calls made',
      );

      // Audit payment blocked
      await client.recordAuditEvent(
        {
          correlationId,
          eventType: 'PAYMENT_BLOCKED',
          actor: 'api-gateway',
          resourceId: proposal.id,
          outcome: 'BLOCKED',
          reasonCode: decision.reasonCode,
          metadata: {
            reasonMessage: decision.reasonMessage,
            attemptedAmountMinor: proposal.totalAmountMinor,
          },
        },
        correlationId,
      );

      return reply.status(403).send({
        error: {
          code: ErrorCodes.POLICY_VIOLATION,
          message: `Payment creation rejected: Policy outcome is ${decision.outcome} (${decision.reasonMessage})`,
          correlationId,
          details: decision,
        },
      });
    }

    try {
      const order = await client.createPaymentOrder(
        proposal,
        decision.decisionId,
        'ALLOW',
        correlationId,
      );

      // Audit order creation
      await client.recordAuditEvent(
        {
          correlationId,
          eventType: 'ORDER_CREATED',
          actor: 'payment-service',
          resourceId: order.id,
          outcome: 'CREATED',
          metadata: {
            proposalId: proposal.id,
            amountMinor: order.amountMinor,
            isMock: order.isMock,
          },
        },
        correlationId,
      );

      return reply.status(201).send(order);
    } catch (err: unknown) {
      const errorObj = err as { code?: string; statusCode?: number; message?: string };
      return reply.status(errorObj.statusCode ?? 500).send({
        error: {
          code: errorObj.code ?? ErrorCodes.INTERNAL_ERROR,
          message: errorObj.message ?? 'Payment service failed to create order',
          correlationId,
        },
      });
    }
  });

  // Get Payment Order
  app.get('/api/payments/orders/:id', async (req, reply) => {
    const correlationId = req.headers['x-correlation-id'] as string;
    const { id } = req.params as { id: string };

    const order = await client.getPaymentOrder(id, correlationId);
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

  // Capture Payment Order
  app.post('/api/payments/orders/:id/capture', async (req, reply) => {
    const correlationId = req.headers['x-correlation-id'] as string;
    const reqLogger = getChildLogger(logger, correlationId);
    const { id } = req.params as { id: string };
    const body = req.body as { policyDecisionId?: string; idempotencyKey?: string };

    if (!body?.policyDecisionId) {
      return reply.status(400).send({
        error: {
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'policyDecisionId is required to capture payment order',
          correlationId,
        },
      });
    }

    const idempotencyKey =
      (req.headers['x-idempotency-key'] as string) || body.idempotencyKey || `cap-${id}`;

    try {
      const result = await client.capturePaymentOrder(
        id,
        body.policyDecisionId,
        correlationId,
        idempotencyKey,
      );

      // Audit order capture
      await client.recordAuditEvent(
        {
          correlationId,
          eventType: result.status === 'COMPLETED' ? 'ORDER_CAPTURED' : 'SYSTEM_SECURITY_ALERT',
          actor: 'payment-service',
          resourceId: result.captureId,
          outcome: result.status,
          metadata: {
            orderId: id,
            capturedAmountMinor: result.capturedAmountMinor,
            currency: result.currency,
            status: result.status,
            environmentNote: result.environmentNote,
          },
        },
        correlationId,
      );

      return reply.status(200).send(result);
    } catch (err: unknown) {
      const errorObj = err as { code?: string; statusCode?: number; message?: string };
      reqLogger.error({ err }, 'Order capture failed');
      return reply.status(errorObj.statusCode ?? 422).send({
        error: {
          code: errorObj.code ?? ErrorCodes.BAD_REQUEST,
          message: errorObj.message ?? 'Failed to capture payment order',
          correlationId,
        },
      });
    }
  });

  // Reconcile Payment Order State
  app.post('/api/payments/orders/:id/reconcile', async (req, reply) => {
    const correlationId = req.headers['x-correlation-id'] as string;
    const reqLogger = getChildLogger(logger, correlationId);
    const { id } = req.params as { id: string };

    try {
      const result = await client.reconcilePaymentOrder(id, correlationId);
      reqLogger.info(
        {
          orderId: id,
          status: result.status,
          currentOrderStatus: result.currentOrderStatus,
        },
        'Payment order reconciliation completed via gateway',
      );
      return reply.status(200).send(result);
    } catch (err: unknown) {
      const errorObj = err as { code?: string; statusCode?: number; message?: string };
      reqLogger.error({ err }, 'Order reconciliation failed');
      return reply.status(errorObj.statusCode ?? 500).send({
        error: {
          code: errorObj.code ?? ErrorCodes.INTERNAL_ERROR,
          message: errorObj.message ?? 'Failed to reconcile payment order',
          correlationId,
        },
      });
    }
  });

  // List Recent Audit Events
  app.get('/api/audit-events', async (req, reply) => {
    const query = req.query as { limit?: string; correlationId?: string };
    const limit = query.limit ? parseInt(query.limit, 10) : 50;

    const events = await client.listAuditEvents(limit, query.correlationId);
    return reply.status(200).send(events);
  });

  return app;
}
