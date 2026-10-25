import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { v4 as uuidv4 } from 'uuid';
import {
  CreateProposalInputSchema,
  CreatePurchaseIntentInputSchema,
  PurchaseProposalSchema,
  resolveCatalogItem,
  computeIntentFingerprint,
  safeIntegerMultiply,
  safeIntegerAdd,
  ErrorCodes,
  type ApiHealthResponse,
  type StoredPurchaseProposal,
  type PurchaseProposal,
  type PurchaseIntentParseResult,
  type PolicyDecision,
} from '@agentpay/contracts';
import { createLogger, getChildLogger } from '@agentpay/logger';
import { getApiGatewayConfig, type ApiGatewayConfig } from '@agentpay/config';
import { ServiceClient } from './client.js';
import {
  type AuthenticationProvider,
  DevelopmentAuthenticationProvider,
  ProductionPendingAuthenticationProvider,
  TestAuthenticationProvider,
} from './auth.js';

export function buildApp(
  clientOverride?: ServiceClient,
  configOverride?: ApiGatewayConfig,
  authProviderOverride?: AuthenticationProvider,
) {
  const config = configOverride ?? getApiGatewayConfig();
  const client = clientOverride ?? new ServiceClient(config);
  const authProvider =
    authProviderOverride ??
    (config.NODE_ENV === 'test'
      ? new TestAuthenticationProvider()
      : config.ALLOW_DEV_IDENTITY && config.NODE_ENV !== 'production'
        ? new DevelopmentAuthenticationProvider(config)
        : new ProductionPendingAuthenticationProvider());
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

  // Orchestrated Purchase Intent Workflow:
  // User request -> Gateway validation -> Agent intent parsing -> (Clarification / Unsupported)
  // -> Authoritative Catalog Resolution -> Policy Service Evaluation -> (Deny / Review)
  // -> Durable Proposal Creation with PostgreSQL Idempotency Scope -> Audit Trail
  app.post('/api/purchase-intents', async (req, reply) => {
    const correlationId = req.headers['x-correlation-id'] as string;
    const reqLogger = getChildLogger(logger, correlationId);

    // 1. Gateway Input Validation
    const parseResult = CreatePurchaseIntentInputSchema.safeParse(req.body);
    if (!parseResult.success) {
      reqLogger.warn(
        { issues: parseResult.error.issues },
        'Invalid purchase intent input received',
      );
      return reply.status(400).send({
        error: {
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Invalid purchase intent input payload',
          correlationId,
          details: parseResult.error.issues,
        },
      });
    }

    const { rawIntent } = parseResult.data;
    // 2. Caller Authentication & Scope
    const principal = await authProvider.authenticate(req);
    if (!principal) {
      reqLogger.warn('Unauthenticated request to /api/purchase-intents rejected');
      return reply.status(401).send({
        error: {
          code: ErrorCodes.UNAUTHORIZED,
          message:
            'Authentication required. Valid authenticated credentials must be provided to create purchase proposals.',
          correlationId,
        },
      });
    }

    const principalId = principal.id;
    const requestId = parseResult.data.requestId || uuidv4();
    const idempotencyKey =
      parseResult.data.idempotencyKey ||
      (req.headers['idempotency-key'] as string) ||
      `intent-${uuidv4()}`;
    const idempotencyScope = `principal:${principalId}`;

    reqLogger.info(
      {
        principalId,
        authSource: principal.authSource,
        requestId,
        idempotencyKey,
        idempotencyScope,
      },
      'Processing purchase intent workflow',
    );

    // Audit initial intent receipt
    await client.recordAuditEvent(
      {
        correlationId,
        eventType: 'INTENT_RECEIVED',
        actor: principalId,
        resourceId: requestId,
        outcome: 'RECEIVED',
        metadata: { rawIntent: rawIntent.slice(0, 200), idempotencyKey, idempotencyScope },
      },
      correlationId,
    );

    // 3. Agent Intent Parsing & Ambiguity Detection
    let parsedResult: PurchaseIntentParseResult;
    try {
      parsedResult = await client.parseIntent(rawIntent, correlationId, {
        requestId,
        idempotencyKey,
        principalId,
        locale: parseResult.data.locale,
      });
    } catch (err: unknown) {
      reqLogger.error({ err }, 'Agent intent parsing failed');
      return reply.status(502).send({
        error: {
          code: ErrorCodes.SERVICE_UNAVAILABLE,
          message: 'Agent service intent parsing unavailable',
          correlationId,
        },
      });
    }

    if (parsedResult.status === 'UNSUPPORTED_INTENT') {
      await client.recordAuditEvent(
        {
          correlationId,
          eventType: 'INTENT_UNSUPPORTED',
          actor: principalId,
          resourceId: requestId,
          outcome: 'UNSUPPORTED',
          metadata: { reason: parsedResult.reason },
        },
        correlationId,
      );
      return reply.status(200).send({
        outcome: 'UNSUPPORTED_INTENT',
        reason: parsedResult.reason,
        correlationId,
      });
    }

    if (parsedResult.status === 'NEEDS_CLARIFICATION') {
      await client.recordAuditEvent(
        {
          correlationId,
          eventType: 'INTENT_CLARIFICATION_REQUIRED',
          actor: principalId,
          resourceId: requestId,
          outcome: 'CLARIFICATION_REQUIRED',
          metadata: { reason: parsedResult.reason, question: parsedResult.question },
        },
        correlationId,
      );
      return reply.status(200).send({
        outcome: 'CLARIFICATION_REQUIRED',
        reason: parsedResult.reason,
        question: parsedResult.question,
        rawInput: parsedResult.rawInput,
        correlationId,
      });
    }

    if (parsedResult.status === 'INVALID_INPUT') {
      return reply.status(400).send({
        error: {
          code: ErrorCodes.VALIDATION_ERROR,
          message: parsedResult.reason,
          correlationId,
          details: parsedResult.validationErrors,
        },
      });
    }

    const intent = parsedResult.intent;

    // 4. Authoritative Product Catalog Resolution
    const catalogItem = resolveCatalogItem(
      intent.intent.productQuery,
      intent.intent.merchantPreference,
    );

    if (!catalogItem) {
      await client.recordAuditEvent(
        {
          correlationId,
          eventType: 'INTENT_SELECTION_REQUIRED',
          actor: principalId,
          resourceId: requestId,
          outcome: 'SELECTION_REQUIRED',
          metadata: { query: intent.intent.productQuery },
        },
        correlationId,
      );
      return reply.status(200).send({
        outcome: 'SELECTION_REQUIRED',
        reason: `Product "${intent.intent.productQuery}" could not be resolved from authoritative catalog. Specific product selection is required.`,
        query: intent.intent.productQuery,
        correlationId,
      });
    }

    // 5. Monetary Calculation with Checked Safe Integer Minor Units
    const quantity = intent.intent.quantity;
    const unitPriceMinor = catalogItem.unitPriceMinor;
    const taxMinor = 0;
    const shippingMinor = 0;
    let subtotalMinor: number;
    let totalAmountMinor: number;
    try {
      subtotalMinor = safeIntegerMultiply(unitPriceMinor, quantity);
      totalAmountMinor = safeIntegerAdd(subtotalMinor, taxMinor, shippingMinor);
    } catch (err: unknown) {
      reqLogger.error({ err }, 'Integer minor unit calculation overflow');
      return reply.status(400).send({
        error: {
          code: ErrorCodes.VALIDATION_ERROR,
          message: err instanceof Error ? err.message : 'Monetary arithmetic error',
          correlationId,
        },
      });
    }
    const currency = catalogItem.currency;

    // Fingerprint canonical intent for database-backed idempotency
    const requestHash = computeIntentFingerprint({
      action: intent.intent.action,
      productQuery: intent.intent.productQuery,
      quantity,
      merchantPreference: intent.intent.merchantPreference,
      constraints: intent.intent.constraints,
    });

    const proposalId = uuidv4();

    // Build PurchaseProposal structure for authoritative Policy Service evaluation
    const proposalForPolicy: PurchaseProposal = {
      id: proposalId,
      intentId: intent.requestId,
      agentId: 'agent-assistant-01',
      merchant: {
        id: catalogItem.merchantId,
        name: catalogItem.merchantName,
        category: catalogItem.category,
      },
      items: [
        {
          id: catalogItem.id,
          name: catalogItem.name,
          quantity,
          unitPriceMinor,
          currency,
        },
      ],
      totalAmountMinor,
      currency,
      purpose: `Purchase intent: ${intent.intent.productQuery}`,
      userBudgetMinor: intent.intent.constraints?.maxTotalMinor,
      metadata: {
        principalId,
        idempotencyKey,
      },
      createdAt: new Date().toISOString(),
    };

    // 6. Server-Side Policy Evaluation (Policy Service is authoritative; never bypassed)
    let decision: PolicyDecision;
    try {
      decision = await client.evaluatePolicy(proposalForPolicy, correlationId);
    } catch (err: unknown) {
      reqLogger.error({ err }, 'Policy evaluation downstream failed');
      return reply.status(502).send({
        error: {
          code: ErrorCodes.SERVICE_UNAVAILABLE,
          message: 'Policy evaluation service unavailable',
          correlationId,
        },
      });
    }

    // 7. Branch on Policy Decision
    if (decision.outcome === 'DENY') {
      await client.recordAuditEvent(
        {
          correlationId,
          eventType: 'PROPOSAL_POLICY_DENIED',
          actor: 'policy-service',
          resourceId: decision.decisionId,
          outcome: 'DENY',
          reasonCode: decision.reasonCode,
          metadata: {
            proposalId,
            reasonMessage: decision.reasonMessage,
            totalAmountMinor,
            merchantCategory: catalogItem.category,
          },
        },
        correlationId,
      );

      return reply.status(403).send({
        outcome: 'POLICY_DENIED',
        policyDecision: decision,
        message: `Purchase intent denied by policy: ${decision.reasonMessage}`,
        correlationId,
      });
    }

    const proposalStatus =
      decision.outcome === 'ALLOW' ? 'READY_FOR_REVIEW' : 'POLICY_REVIEW_REQUIRED';

    const storedProposalInput: StoredPurchaseProposal = {
      id: proposalId,
      requestId,
      idempotencyKey,
      idempotencyScope,
      requestHash,
      status: proposalStatus,
      productQuery: intent.intent.productQuery,
      productId: catalogItem.id,
      productName: catalogItem.name,
      merchantId: catalogItem.merchantId,
      merchantName: catalogItem.merchantName,
      merchantCategory: catalogItem.category,
      quantity,
      currency,
      unitPriceMinor,
      subtotalMinor,
      taxMinor,
      shippingMinor,
      totalAmountMinor,
      policyDecisionId: decision.decisionId,
      policyOutcome: decision.outcome,
      policyReasonCode: decision.reasonCode,
      principalId,
      correlationId,
      metadata: {
        rawIntent,
        policyReasonMessage: decision.reasonMessage,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // 8. Durable Proposal Creation (Database-Enforced Idempotency)
    let storedProposal: StoredPurchaseProposal;
    try {
      storedProposal = await client.persistProposal(storedProposalInput, correlationId);
    } catch (err: unknown) {
      const errorObj = err as { code?: string; statusCode?: number; message?: string };
      if (errorObj.statusCode === 409 || errorObj.code === 'IDEMPOTENCY_CONFLICT') {
        reqLogger.warn('Idempotency conflict during proposal persistence');
        return reply.status(409).send({
          error: {
            code: 'IDEMPOTENCY_CONFLICT',
            message:
              errorObj.message ||
              'Idempotency key was already used with a different intent payload',
            correlationId,
          },
        });
      }
      reqLogger.error({ err }, 'Failed to persist durable proposal');
      return reply.status(502).send({
        error: {
          code: ErrorCodes.SERVICE_UNAVAILABLE,
          message: 'Failed to persist purchase proposal',
          correlationId,
        },
      });
    }

    // 9. Audit Event Recording
    const auditEventType =
      decision.outcome === 'ALLOW' ? 'PROPOSAL_READY_FOR_REVIEW' : 'PROPOSAL_REVIEW_REQUIRED';

    await client.recordAuditEvent(
      {
        correlationId,
        eventType: auditEventType,
        actor: 'api-gateway',
        resourceId: storedProposal.id,
        outcome: storedProposal.status,
        reasonCode: decision.reasonCode,
        metadata: {
          totalAmountMinor,
          currency,
          merchantName: catalogItem.merchantName,
          policyDecisionId: decision.decisionId,
        },
      },
      correlationId,
    );

    const outcome = decision.outcome === 'ALLOW' ? 'PROPOSAL_CREATED' : 'POLICY_REVIEW_REQUIRED';
    const httpStatus = decision.outcome === 'ALLOW' ? 201 : 200;

    return reply.status(httpStatus).send({
      outcome,
      proposal: storedProposal,
      policyDecision: decision,
      message:
        decision.outcome === 'ALLOW'
          ? 'Purchase proposal created and ready for user review'
          : `Purchase proposal created but requires explicit human authorization (${decision.reasonMessage})`,
      correlationId,
    });
  });

  // Get Proposal by ID (with principal authorization check)
  app.get('/api/purchase-intents/:id', async (req, reply) => {
    const correlationId = req.headers['x-correlation-id'] as string;
    const { id } = req.params as { id: string };

    const principal = await authProvider.authenticate(req);
    if (!principal) {
      return reply.status(401).send({
        error: {
          code: ErrorCodes.UNAUTHORIZED,
          message:
            'Authentication required. Valid authenticated credentials must be provided to access purchase proposals.',
          correlationId,
        },
      });
    }

    const principalId = principal.id;

    const proposal = await client.getProposal(id, correlationId);
    if (!proposal) {
      return reply.status(404).send({
        error: {
          code: ErrorCodes.NOT_FOUND,
          message: `Purchase proposal ${id} not found`,
          correlationId,
        },
      });
    }

    // Verify principal ownership if principal is defined on proposal
    if (proposal.principalId && proposal.principalId !== principalId) {
      return reply.status(403).send({
        error: {
          code: ErrorCodes.FORBIDDEN,
          message: 'Access to purchase proposal denied for principal',
          correlationId,
        },
      });
    }

    return reply.status(200).send(proposal);
  });

  // Create Proposal via Agent Service (Legacy / direct agent endpoint)
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
