import Fastify from 'fastify';
import cors from '@fastify/cors';
import { v4 as uuidv4 } from 'uuid';
import { CreateProposalInputSchema, ErrorCodes, type ApiHealthResponse } from '@agentpay/contracts';
import { createLogger, getChildLogger } from '@agentpay/logger';
import { FixtureAIProvider } from './provider.js';

export function buildApp(provider = new FixtureAIProvider()) {
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

  return app;
}
