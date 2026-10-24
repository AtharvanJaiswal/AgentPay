import { getApiGatewayConfig } from '@agentpay/config';
import { createLogger } from '@agentpay/logger';
import { buildApp } from './app.js';

const config = getApiGatewayConfig();
const logger = createLogger({ serviceName: 'api-gateway', level: config.LOG_LEVEL });
const app = buildApp();

async function start() {
  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    logger.info({ port: config.PORT, host: config.HOST }, 'API Gateway running successfully');
  } catch (err) {
    logger.error({ err }, 'Failed to start API Gateway');
    process.exit(1);
  }
}

const shutdown = async () => {
  logger.info('Shutting down API Gateway gracefully...');
  await app.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
