import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// Load .env if present in current working directory
loadDotenv();

const BaseConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export const ApiGatewayConfigSchema = BaseConfigSchema.extend({
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default('0.0.0.0'),
  AGENT_SERVICE_URL: z.string().url().default('http://agent-service:4001'),
  POLICY_SERVICE_URL: z.string().url().default('http://policy-service:4002'),
  PAYMENT_SERVICE_URL: z.string().url().default('http://payment-service:4003'),
  AUDIT_SERVICE_URL: z.string().url().default('http://audit-service:4004'),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  RATE_LIMIT_MAX: z.coerce.number().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  REQUEST_TIMEOUT_MS: z.coerce.number().default(10000),
});
export type ApiGatewayConfig = z.infer<typeof ApiGatewayConfigSchema>;

export const AgentServiceConfigSchema = BaseConfigSchema.extend({
  PORT: z.coerce.number().default(4001),
  HOST: z.string().default('0.0.0.0'),
});
export type AgentServiceConfig = z.infer<typeof AgentServiceConfigSchema>;

export const PolicyServiceConfigSchema = BaseConfigSchema.extend({
  PORT: z.coerce.number().default(4002),
  HOST: z.string().default('0.0.0.0'),
  // Rules thresholds in minor units (cents)
  MAX_TRANSACTION_LIMIT_MINOR: z.coerce.number().default(200000), // $2000 hard limit
  APPROVAL_THRESHOLD_MINOR: z.coerce.number().default(50000), // $500 approval threshold
  DEFAULT_ALLOWED_CURRENCY: z.string().default('USD'),
  RESTRICTED_CATEGORIES: z
    .string()
    .default('gambling,cryptocurrency,weapons,adult_entertainment')
    .transform((val) => val.split(',').map((s) => s.trim().toLowerCase())),
});
export type PolicyServiceConfig = z.infer<typeof PolicyServiceConfigSchema>;

export const PaymentServiceConfigSchema = BaseConfigSchema.extend({
  PORT: z.coerce.number().default(4003),
  HOST: z.string().default('0.0.0.0'),
  PAYMENT_PROVIDER: z.enum(['mock', 'paypal_sandbox']).default('mock'),
  PAYMENTS_ENABLED: z
    .string()
    .default('false')
    .transform((val) => val === 'true' || val === '1'),
  POLICY_SERVICE_URL: z.string().url().default('http://policy-service:4002'),
});
export type PaymentServiceConfig = z.infer<typeof PaymentServiceConfigSchema>;

export const AuditServiceConfigSchema = BaseConfigSchema.extend({
  PORT: z.coerce.number().default(4004),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().default('postgresql://agentpay:agentpay_dev_pw@localhost:5432/agentpay'),
});
export type AuditServiceConfig = z.infer<typeof AuditServiceConfigSchema>;

export function getApiGatewayConfig(env: NodeJS.ProcessEnv = process.env): ApiGatewayConfig {
  return ApiGatewayConfigSchema.parse({
    NODE_ENV: env['NODE_ENV'],
    LOG_LEVEL: env['LOG_LEVEL'],
    PORT: env['API_GATEWAY_PORT'] ?? env['PORT'],
    HOST: env['HOST'],
    AGENT_SERVICE_URL: env['AGENT_SERVICE_URL'],
    POLICY_SERVICE_URL: env['POLICY_SERVICE_URL'],
    PAYMENT_SERVICE_URL: env['PAYMENT_SERVICE_URL'],
    AUDIT_SERVICE_URL: env['AUDIT_SERVICE_URL'],
    APP_BASE_URL: env['APP_BASE_URL'],
    RATE_LIMIT_MAX: env['RATE_LIMIT_MAX'],
    RATE_LIMIT_WINDOW_MS: env['RATE_LIMIT_WINDOW_MS'],
    REQUEST_TIMEOUT_MS: env['REQUEST_TIMEOUT_MS'],
  });
}

export function getAgentServiceConfig(env: NodeJS.ProcessEnv = process.env): AgentServiceConfig {
  return AgentServiceConfigSchema.parse({
    NODE_ENV: env['NODE_ENV'],
    LOG_LEVEL: env['LOG_LEVEL'],
    PORT: env['AGENT_SERVICE_PORT'] ?? env['PORT'],
    HOST: env['HOST'],
  });
}

export function getPolicyServiceConfig(env: NodeJS.ProcessEnv = process.env): PolicyServiceConfig {
  return PolicyServiceConfigSchema.parse({
    NODE_ENV: env['NODE_ENV'],
    LOG_LEVEL: env['LOG_LEVEL'],
    PORT: env['POLICY_SERVICE_PORT'] ?? env['PORT'],
    HOST: env['HOST'],
    MAX_TRANSACTION_LIMIT_MINOR: env['MAX_TRANSACTION_LIMIT_MINOR'],
    APPROVAL_THRESHOLD_MINOR: env['APPROVAL_THRESHOLD_MINOR'],
    DEFAULT_ALLOWED_CURRENCY: env['DEFAULT_ALLOWED_CURRENCY'],
    RESTRICTED_CATEGORIES: env['RESTRICTED_CATEGORIES'],
  });
}

export function getPaymentServiceConfig(
  env: NodeJS.ProcessEnv = process.env,
): PaymentServiceConfig {
  return PaymentServiceConfigSchema.parse({
    NODE_ENV: env['NODE_ENV'],
    LOG_LEVEL: env['LOG_LEVEL'],
    PORT: env['PAYMENT_SERVICE_PORT'] ?? env['PORT'],
    HOST: env['HOST'],
    PAYMENT_PROVIDER: env['PAYMENT_PROVIDER'],
    PAYMENTS_ENABLED: env['PAYMENTS_ENABLED'],
    POLICY_SERVICE_URL: env['POLICY_SERVICE_URL'],
  });
}

export function getAuditServiceConfig(env: NodeJS.ProcessEnv = process.env): AuditServiceConfig {
  return AuditServiceConfigSchema.parse({
    NODE_ENV: env['NODE_ENV'],
    LOG_LEVEL: env['LOG_LEVEL'],
    PORT: env['AUDIT_SERVICE_PORT'] ?? env['PORT'],
    HOST: env['HOST'],
    DATABASE_URL: env['DATABASE_URL'],
  });
}
