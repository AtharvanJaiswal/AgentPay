import Fastify from 'fastify';
import cors from '@fastify/cors';
import { v4 as uuidv4 } from 'uuid';
import {
  CreateProposalInputSchema,
  StoredPurchaseProposalSchema,
  ProposalIdempotencyConflictError,
  InvalidProposalStateTransitionError,
  ForbiddenProposalAccessError,
  ErrorCodes,
  type ApiHealthResponse,
  type PurchaseIntentParser,
  type ProposalRepository,
  type ProposalLifecycleStatus,
} from '@agentpay/contracts';
import { createLogger, getChildLogger } from '@agentpay/logger';
import { FixtureAIProvider } from './provider.js';
import { DeterministicPurchaseIntentParser } from './parser.js';
import { InMemoryProposalRepository } from './repository.js';

export function buildApp(
  provider = new FixtureAIProvider(),
  parser: PurchaseIntentParser = new DeterministicPurchaseIntentParser(),
  repository: ProposalRepository = new InMemoryProposalRepository(),
) {
  const startTime = Date.now();
  const logger = createLogger({ serviceName: 'agent-service' });

  const app = Fastify({
    logger: false, // We use custom structured logging with correlation IDs
    requestTimeout: 10000,
  });

  app.register(cors, { origin: true });

  // Hook to ensure correlation ID
  app.addHook('onRequest', async (req, reply) => {
    const correlationId = (req.headers['x-correlation-id'] as string) || uuidv4();
    req.headers['x-correlation-id'] = correlationId;
    reply.header('x-correlation-id', correlationId);
  });

  // Health check endpoint
  app.get('/health', async (_req, reply) => {
    const health: ApiHealthResponse = {
      status: 'ok',
      service: 'agent-service',
      version: '0.1.0',
      uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
      details: {
        provider: provider.providerName,
      },
    };
    return reply.status(200).send(health);
  });

  // Generate proposal from parsed purchase intent
  app.post('/proposals/parse', async (req, reply) => {
    const correlationId = req.headers['x-correlation-id'] as string;
    const reqLogger = getChildLogger(logger, correlationId);

    const parseResult = CreateProposalInputSchema.safeParse(req.body);
    if (!parseResult.success) {
      reqLogger.warn({ issues: parseResult.error.issues }, 'Invalid proposal input received');
      return reply.status(400).send({
        error: {
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Invalid proposal input payload',
          correlationId,
          details: parseResult.error.issues,
        },
      });
    }

    const { rawIntent, agentId } = parseResult.data;
    reqLogger.info({ rawIntent, agentId }, 'Generating purchase proposal from intent');

    try {
      const proposal = await provider.generateProposal(rawIntent, agentId, correlationId);
      reqLogger.info(
        { proposalId: proposal.id, totalAmountMinor: proposal.totalAmountMinor },
        'Proposal successfully generated',
      );
      return reply.status(201).send(proposal);
    } catch (err) {
      reqLogger.error({ err }, 'Failed to generate proposal');
      return reply.status(500).send({
        error: {
          code: ErrorCodes.INTERNAL_ERROR,
          message: 'Internal error generating proposal',
          correlationId,
        },
      });
    }
  });

  // Parse raw natural-language text into structured PurchaseIntent
  app.post('/intents/parse', async (req, reply) => {
    const correlationId = req.headers['x-correlation-id'] as string;
    const reqLogger = getChildLogger(logger, correlationId);

    const body = req.body as {
      rawIntent?: string;
      requestId?: string;
      idempotencyKey?: string;
      principalId?: string;
      locale?: string;
    };

    if (!body || typeof body.rawIntent !== 'string') {
      reqLogger.warn('Invalid /intents/parse payload: missing rawIntent');
      return reply.status(400).send({
        error: {
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Missing or invalid rawIntent string in request body',
          correlationId,
        },
      });
    }

    try {
      const parseResult = await parser.parse(body.rawIntent, {
        requestId: body.requestId,
        idempotencyKey: body.idempotencyKey,
        principalId: body.principalId,
        locale: body.locale,
      });

      reqLogger.info({ status: parseResult.status }, 'Purchase intent parsed');

      if (parseResult.status === 'PARSED') {
        return reply.status(200).send(parseResult);
      } else if (parseResult.status === 'NEEDS_CLARIFICATION') {
        return reply.status(200).send(parseResult);
      } else if (parseResult.status === 'UNSUPPORTED_INTENT') {
        return reply.status(200).send(parseResult);
      } else {
        return reply.status(400).send({
          error: {
            code: ErrorCodes.VALIDATION_ERROR,
            message: parseResult.reason,
            correlationId,
            details: parseResult.validationErrors,
          },
          result: parseResult,
        });
      }
    } catch (err) {
      reqLogger.error({ err }, 'Unexpected parser failure');
      return reply.status(500).send({
        error: {
          code: ErrorCodes.INTERNAL_ERROR,
          message: 'Internal error during intent parsing',
          correlationId,
        },
      });
    }
  });

  // Create and persist durable purchase proposal
  app.post('/proposals', async (req, reply) => {
    const correlationId = req.headers['x-correlation-id'] as string;
    const reqLogger = getChildLogger(logger, correlationId);

    const parseResult = StoredPurchaseProposalSchema.safeParse(req.body);
    if (!parseResult.success) {
      reqLogger.warn({ issues: parseResult.error.issues }, 'Invalid purchase proposal payload');
      return reply.status(400).send({
        error: {
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Invalid purchase proposal payload',
          correlationId,
          details: parseResult.error.issues,
        },
      });
    }

    try {
      const stored = await repository.createProposal(parseResult.data);
      reqLogger.info(
        { proposalId: stored.id, status: stored.status, idempotencyKey: stored.idempotencyKey },
        'Purchase proposal persisted successfully',
      );
      return reply.status(201).send(stored);
    } catch (err: unknown) {
      if (err instanceof ProposalIdempotencyConflictError) {
        reqLogger.warn({ err }, 'Proposal idempotency conflict detected');
        return reply.status(409).send({
          error: {
            code: err.code,
            message: err.message,
            correlationId,
          },
        });
      }
      reqLogger.error({ err }, 'Failed to persist purchase proposal');
      return reply.status(500).send({
        error: {
          code: ErrorCodes.INTERNAL_ERROR,
          message: 'Failed to persist purchase proposal',
          correlationId,
        },
      });
    }
  });

  // Retrieve durable proposal by ID
  app.get('/proposals/:id', async (req, reply) => {
    const correlationId = req.headers['x-correlation-id'] as string;
    const { id } = req.params as { id: string };

    const proposal = await repository.getProposalById(id);
    if (!proposal) {
      return reply.status(404).send({
        error: {
          code: ErrorCodes.NOT_FOUND,
          message: `Purchase proposal ${id} not found`,
          correlationId,
        },
      });
    }

    return reply.status(200).send(proposal);
  });

  // Update proposal status
  app.patch('/proposals/:id/status', async (req, reply) => {
    const correlationId = req.headers['x-correlation-id'] as string;
    const reqLogger = getChildLogger(logger, correlationId);
    const { id } = req.params as { id: string };

    const body = req.body as {
      status: ProposalLifecycleStatus;
      policyDecisionId?: string;
      policyOutcome?: 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';
      policyReasonCode?: string;
      metadata?: Record<string, unknown>;
    };

    if (!body || !body.status) {
      return reply.status(400).send({
        error: {
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Missing required status field',
          correlationId,
        },
      });
    }

    try {
      const updated = await repository.updateProposalStatus(id, body.status, {
        expectedPrincipalId: (req.headers['x-principal-id'] as string) || undefined,
        policyDecisionId: body.policyDecisionId,
        policyOutcome: body.policyOutcome,
        policyReasonCode: body.policyReasonCode,
        metadata: body.metadata,
      });

      reqLogger.info({ proposalId: id, newStatus: updated.status }, 'Proposal status updated');
      return reply.status(200).send(updated);
    } catch (err: unknown) {
      if (err instanceof InvalidProposalStateTransitionError) {
        reqLogger.warn({ err }, 'Invalid proposal state transition rejected');
        return reply.status(400).send({
          error: {
            code: err.code,
            message: err.message,
            correlationId,
          },
        });
      }
      if (err instanceof ForbiddenProposalAccessError) {
        reqLogger.warn({ err }, 'Unauthorized proposal status update rejected');
        return reply.status(403).send({
          error: {
            code: err.code,
            message: err.message,
            correlationId,
          },
        });
      }
      reqLogger.error({ err }, 'Failed to update proposal status');
      return reply.status(500).send({
        error: {
          code: ErrorCodes.INTERNAL_ERROR,
          message: err instanceof Error ? err.message : 'Failed to update proposal status',
          correlationId,
        },
      });
    }
  });

  return app;
}
