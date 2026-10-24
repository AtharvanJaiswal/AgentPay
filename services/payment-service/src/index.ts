import { getPaymentServiceConfig } from '@agentpay/config';
import { createLogger } from '@agentpay/logger';
import { buildApp } from './app.js';

const config = getPaymentServiceConfig();
const logger = createLogger({ serviceName: 'payment-service', level: config.LOG_LEVEL });
const app = buildApp();

async function start() {
  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    logger.info(
      {
        port: config.PORT,
        host: config.HOST,
        paymentsEnabled: config.PAYMENTS_ENABLED,
        provider: config.PAYMENT_PROVIDER,
      },
      'Payment Service running successfully',
    );
  } catch (err) {
    logger.error({ err }, 'Failed to start Payment Service');
    process.exit(1);
  }
}

const shutdown = async () => {
  logger.info('Shutting down Payment Service gracefully...');
  await app.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
