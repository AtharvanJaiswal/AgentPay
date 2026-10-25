import { z } from 'zod';

/**
 * Currency code: ISO-4217 3-letter uppercase string.
 */
export const CurrencySchema = z
  .string()
  .length(3, 'Currency must be an ISO 4217 3-letter code')
  .regex(/^[A-Z]{3}$/, 'Currency must be 3 uppercase letters');

/**
 * Monetary amount represented in integer minor units (e.g. cents in USD).
 * Strictly forbids floating-point arithmetic.
 */
export const MinorUnitsSchema = z
  .number()
  .int('Amount must be an integer minor unit (e.g., cents)')
  .nonnegative('Amount cannot be negative');

export const PositiveMinorUnitsSchema = z
  .number()
  .int('Amount must be an integer minor unit')
  .positive('Amount must be greater than zero');

/**
 * Standard Health Response schema for all services and the gateway.
 */
export const ApiHealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  service: z.string(),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  timestamp: z.string().datetime(),
  details: z.record(z.unknown()).optional(),
});
export type ApiHealthResponse = z.infer<typeof ApiHealthResponseSchema>;

/**
 * Standard API Error Response structure across all microservices and the gateway.
 */
export const ApiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    correlationId: z.string().optional(),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

/**
 * Reason codes used across AgentPay error handling and policy evaluation.
 */
export const ErrorCodes = {
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  POLICY_VIOLATION: 'POLICY_VIOLATION',
  PAYMENTS_DISABLED: 'PAYMENTS_DISABLED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
  RATE_LIMITED: 'RATE_LIMITED',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
} as const;
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * Safe integer arithmetic helpers for integer minor-unit financial calculations.
 * Strictly prevents numeric precision loss and integer overflow beyond Number.MAX_SAFE_INTEGER.
 */
export function safeIntegerMultiply(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) {
    throw new Error('Operands must be safe integers');
  }
  const result = a * b;
  if (!Number.isSafeInteger(result)) {
    throw new Error(`Integer multiplication overflow: ${a} * ${b} exceeds safe integer bounds`);
  }
  return result;
}

export function safeIntegerAdd(...numbers: number[]): number {
  let sum = 0;
  for (const n of numbers) {
    if (!Number.isSafeInteger(n)) {
      throw new Error(`Operand must be a safe integer: ${n}`);
    }
    sum += n;
    if (!Number.isSafeInteger(sum)) {
      throw new Error('Integer addition overflow: sum exceeds safe integer bounds');
    }
  }
  return sum;
}
