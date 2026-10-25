import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';

/**
 * Deterministically discover the monorepo root directory by traversing upwards
 * from a starting path until marker files ('pnpm-workspace.yaml' or '.git') are found.
 */
export function findRepositoryRoot(startDir?: string): string {
  let currentDir = resolve(startDir ?? dirname(fileURLToPath(import.meta.url)));

  while (true) {
    if (
      existsSync(join(currentDir, 'pnpm-workspace.yaml')) ||
      existsSync(join(currentDir, '.git'))
    ) {
      return currentDir;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  // Fallback to current working directory
  return process.cwd();
}

export interface LoadRootEnvOptions {
  startDir?: string;
  override?: boolean;
}

export interface LoadRootEnvResult {
  loaded: boolean;
  path?: string;
}

/**
 * Loads the monorepo root .env file without overwriting existing environment variables.
 * Preserves process environment variable precedence (override: false by default).
 */
export function loadRootEnv(options?: LoadRootEnvOptions): LoadRootEnvResult {
  const repoRoot = findRepositoryRoot(options?.startDir);
  const rootEnvPath = join(repoRoot, '.env');

  if (existsSync(rootEnvPath)) {
    loadDotenv({ path: rootEnvPath, override: options?.override ?? false });
    return { loaded: true, path: rootEnvPath };
  }

  const cwdEnvPath = join(process.cwd(), '.env');
  if (existsSync(cwdEnvPath)) {
    loadDotenv({ path: cwdEnvPath, override: options?.override ?? false });
    return { loaded: true, path: cwdEnvPath };
  }

  return { loaded: false };
}

// Automatically load repository root .env on module initialization
loadRootEnv();

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
  ALLOW_DEV_IDENTITY: z
    .union([z.boolean(), z.string()])
    .default('false')
    .transform((val) => val === true || val === 'true' || val === '1'),
}).superRefine((data, ctx) => {
  if (data.NODE_ENV === 'production' && data.ALLOW_DEV_IDENTITY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'ALLOW_DEV_IDENTITY is strictly forbidden in production. Production authentication cannot use development identity fallbacks.',
      path: ['ALLOW_DEV_IDENTITY'],
    });
  }
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
    .union([z.boolean(), z.string()])
    .default('false')
    .transform((val) => val === true || val === 'true' || val === '1'),
  POLICY_SERVICE_URL: z.string().url().default('http://policy-service:4002'),
  DATABASE_URL: z.string().default('postgresql://agentpay:agentpay_dev_pw@localhost:5432/agentpay'),
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  PAYPAL_ENVIRONMENT: z.enum(['sandbox', 'live']).default('sandbox'),
  PAYPAL_API_BASE_URL: z.string().url().default('https://api-m.sandbox.paypal.com'),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
}).superRefine((data, ctx) => {
  // Prohibit Live environment in Phase 1B
  if (data.PAYPAL_ENVIRONMENT === 'live') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'PayPal Live environment is forbidden in Phase 1B. Only sandbox is permitted.',
      path: ['PAYPAL_ENVIRONMENT'],
    });
  }

  // Prevent sending Sandbox credentials to Live endpoints or using Live URL
  if (/(^https?:\/\/)?(api-m\.paypal\.com|api\.paypal\.com)/i.test(data.PAYPAL_API_BASE_URL)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'PayPal Live endpoints are forbidden in Phase 1B. Use https://api-m.sandbox.paypal.com.',
      path: ['PAYPAL_API_BASE_URL'],
    });
  }

  if (data.PAYMENT_PROVIDER === 'paypal_sandbox') {
    if (!data.PAYPAL_CLIENT_ID || data.PAYPAL_CLIENT_ID.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'PAYPAL_CLIENT_ID is required when PAYMENT_PROVIDER is paypal_sandbox',
        path: ['PAYPAL_CLIENT_ID'],
      });
    }
    if (!data.PAYPAL_CLIENT_SECRET || data.PAYPAL_CLIENT_SECRET.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'PAYPAL_CLIENT_SECRET is required when PAYMENT_PROVIDER is paypal_sandbox',
        path: ['PAYPAL_CLIENT_SECRET'],
      });
    }
  }
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
    ALLOW_DEV_IDENTITY: env['ALLOW_DEV_IDENTITY'],
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
    NODE_ENV: env['NODE_ENV'] || undefined,
    LOG_LEVEL: env['LOG_LEVEL'] || undefined,
    PORT: env['PAYMENT_SERVICE_PORT'] ?? env['PORT'],
    HOST: env['HOST'] || undefined,
    PAYMENT_PROVIDER: env['PAYMENT_PROVIDER'] || undefined,
    PAYMENTS_ENABLED: env['PAYMENTS_ENABLED'] || undefined,
    POLICY_SERVICE_URL: env['POLICY_SERVICE_URL'] || undefined,
    DATABASE_URL: env['DATABASE_URL'] || undefined,
    PAYPAL_CLIENT_ID: env['PAYPAL_CLIENT_ID'] || undefined,
    PAYPAL_CLIENT_SECRET: env['PAYPAL_CLIENT_SECRET'] || undefined,
    PAYPAL_ENVIRONMENT: env['PAYPAL_ENVIRONMENT'] || undefined,
    PAYPAL_API_BASE_URL: env['PAYPAL_API_BASE_URL'] || undefined,
    PAYPAL_WEBHOOK_ID: env['PAYPAL_WEBHOOK_ID'] || undefined,
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
