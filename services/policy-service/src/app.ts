import Fastify from 'fastify';
import cors from '@fastify/cors';
import { v4 as uuidv4 } from 'uuid';
import { PurchaseProposalSchema, ErrorCodes, type ApiHealthResponse } from '@agentpay/contracts';
import { createLogger, getChildLogger } from '@agentpay/logger';
import { DeterministicPolicyEvaluator } from './evaluator.js';
import { getPolicyServiceConfig } from '@agentpay/config';

export function buildApp(evaluator?: DeterministicPolicyEvaluator) {
  const config = getPolicyServiceConfig();
  const policyEvaluator = evaluator ?? new DeterministicPolicyEvaluator(config);
  const startTime = Date.now();
  const logger = createLogger({ serviceName: 'policy-service', level: config.LOG_LEVEL });

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
      service: 'policy-service',
      version: '0.1.0',
      uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
      details: {
        maxLimitMinor: config.MAX_TRANSACTION_LIMIT_MINOR,
        approvalThresholdMinor: config.APPROVAL_THRESHOLD_MINOR,
        allowedCurrency: config.DEFAULT_ALLOWED_CURRENCY,
      },
    };
    return reply.status(200).send(health);
  });

  app.post('/policies/evaluate', async (req, reply) => {
    const correlationId = req.headers['x-correlation-id'] as string;
    const reqLogger = getChildLogger(logger, correlationId);

    const parseResult = PurchaseProposalSchema.safeParse(req.body);
    if (!parseResult.success) {
      reqLogger.warn({ issues: parseResult.error.issues }, 'Invalid purchase proposal provided');
      return reply.status(400).send({
        error: {
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Invalid purchase proposal payload',
          correlationId,
          details: parseResult.error.issues,
        },
      });
    }

    const proposal = parseResult.data;
    reqLogger.info(
      {
        proposalId: proposal.id,
        amountMinor: proposal.totalAmountMinor,
        merchant: proposal.merchant.name,
      },
      'Evaluating proposal policies',
    );

    try {
      const decision = await policyEvaluator.evaluate(proposal, correlationId);
      reqLogger.info(
        {
          decisionId: decision.decisionId,
          outcome: decision.outcome,
          reasonCode: decision.reasonCode,
        },
        'Policy evaluation completed',
      );
      return reply.status(200).send(decision);
    } catch (err) {
      reqLogger.error({ err }, 'Policy evaluation failed with unhandled error');
      return reply.status(500).send({
        error: {
          code: ErrorCodes.INTERNAL_ERROR,
          message: 'Failed to evaluate policy',
          correlationId,
        },
      });
    }
  });

  return app;
}
