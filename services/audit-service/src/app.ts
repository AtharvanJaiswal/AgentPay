import Fastify from 'fastify';
import cors from '@fastify/cors';
import { v4 as uuidv4 } from 'uuid';
import {
  CreateAuditEventInputSchema,
  ErrorCodes,
  type ApiHealthResponse,
  type AuditRepository,
} from '@agentpay/contracts';
import { createLogger, getChildLogger } from '@agentpay/logger';
import { InMemoryAuditRepository, PostgresAuditRepository } from './repository.js';
import { getAuditServiceConfig } from '@agentpay/config';

export function buildApp(repository?: AuditRepository) {
  const config = getAuditServiceConfig();
  const repo =
    repository ??
    (config.NODE_ENV === 'test'
      ? new InMemoryAuditRepository()
      : new PostgresAuditRepository(config.DATABASE_URL));

  const startTime = Date.now();
  const logger = createLogger({ serviceName: 'audit-service', level: config.LOG_LEVEL });

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
    let dbStatus = 'in-memory';
    if (repo instanceof PostgresAuditRepository) {
      const isConnected = await repo.checkHealth();
      dbStatus = isConnected ? 'connected' : 'disconnected';
    }

    const health: ApiHealthResponse = {
      status: dbStatus === 'disconnected' ? 'degraded' : 'ok',
      service: 'audit-service',
      version: '0.1.0',
      uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
      details: {
        storageType: repo instanceof PostgresAuditRepository ? 'postgresql' : 'in-memory',
        databaseStatus: dbStatus,
        tamperEvidenceNote:
          'Audit trail is indexed and relational. Cryptographic notarization is scheduled for a future milestone.',
      },
    };
    return reply.status(200).send(health);
  });

  app.post('/events', async (req, reply) => {
    const correlationId = req.headers['x-correlation-id'] as string;
    const reqLogger = getChildLogger(logger, correlationId);

    const parseResult = CreateAuditEventInputSchema.safeParse(req.body);
    if (!parseResult.success) {
      reqLogger.warn({ issues: parseResult.error.issues }, 'Invalid audit event payload');
      return reply.status(400).send({
        error: {
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Invalid audit event payload',
          correlationId,
          details: parseResult.error.issues,
        },
      });
    }

    try {
      const created = await repo.recordEvent(parseResult.data);
      reqLogger.info(
        { eventId: created.id, eventType: created.eventType, actor: created.actor },
        'Audit event recorded successfully',
      );
      return reply.status(201).send(created);
    } catch (err) {
      reqLogger.error({ err }, 'Failed to record audit event');
      return reply.status(500).send({
        error: {
          code: ErrorCodes.INTERNAL_ERROR,
          message: 'Failed to record audit event',
          correlationId,
        },
      });
    }
  });

  app.get('/events', async (req, reply) => {
    const query = req.query as { limit?: string; correlationId?: string };
    const limit = query.limit ? parseInt(query.limit, 10) : 50;

    try {
      const events = await repo.listEvents(limit, query.correlationId);
      return reply.status(200).send(events);
    } catch {
      return reply.status(500).send({
        error: {
          code: ErrorCodes.INTERNAL_ERROR,
          message: 'Failed to retrieve audit events',
        },
      });
    }
  });

  return app;
}
