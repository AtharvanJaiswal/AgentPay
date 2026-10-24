import { pino, type Logger as PinoLogger } from 'pino';

export interface LoggerOptions {
  serviceName: string;
  level?: string;
  correlationId?: string;
}

const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'authorization',
  'cookie',
  'password',
  'client_secret',
  'clientSecret',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'api_key',
  'creditCard',
  'cardNumber',
];

export function createLogger(options: LoggerOptions): PinoLogger {
  const level = options.level ?? process.env['LOG_LEVEL'] ?? 'info';

  const baseLogger = pino({
    level,
    formatters: {
      level: (label: string) => ({ level: label }),
    },
    redact: {
      paths: REDACTED_PATHS,
      censor: '[REDACTED]',
    },
    base: {
      service: options.serviceName,
      env: process.env['NODE_ENV'] ?? 'development',
      ...(options.correlationId ? { correlationId: options.correlationId } : {}),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });

  return baseLogger;
}

export type Logger = PinoLogger;

export function getChildLogger(
  logger: Logger,
  correlationId: string,
  additionalContext?: Record<string, unknown>,
): Logger {
  return logger.child({
    correlationId,
    ...additionalContext,
  });
}
