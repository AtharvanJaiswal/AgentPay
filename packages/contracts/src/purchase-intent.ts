import { z } from 'zod';
import { CurrencySchema, PositiveMinorUnitsSchema } from './common.js';

/**
 * Currency metadata defining ISO code, minor unit decimals, and display name.
 * Strictly avoids universal 100x assumptions (e.g., JPY has 0 decimals).
 */
export interface CurrencyMetadata {
  code: string;
  decimals: number;
  name: string;
}

export const SUPPORTED_CURRENCIES: Record<string, CurrencyMetadata> = {
  USD: { code: 'USD', decimals: 2, name: 'United States Dollar' },
  EUR: { code: 'EUR', decimals: 2, name: 'Euro' },
  GBP: { code: 'GBP', decimals: 2, name: 'British Pound' },
  INR: { code: 'INR', decimals: 2, name: 'Indian Rupee' },
  JPY: { code: 'JPY', decimals: 0, name: 'Japanese Yen' },
  CAD: { code: 'CAD', decimals: 2, name: 'Canadian Dollar' },
  AUD: { code: 'AUD', decimals: 2, name: 'Australian Dollar' },
  BHD: { code: 'BHD', decimals: 3, name: 'Bahraini Dinar' },
  KWD: { code: 'KWD', decimals: 3, name: 'Kuwaiti Dinar' },
};

export function isSupportedCurrency(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(SUPPORTED_CURRENCIES, code.toUpperCase());
}

export function getCurrencyDecimals(code: string): number {
  const meta = SUPPORTED_CURRENCIES[code.toUpperCase()];
  if (!meta) {
    throw new Error(`Unsupported currency code: ${code}`);
  }
  return meta.decimals;
}

/**
 * Converts decimal amount to integer minor units safely based on currency metadata.
 * Rejects ambiguous or excessive fractional precision.
 */
export function convertDecimalToMinorUnits(decimalAmount: number, currency: string): number {
  if (typeof decimalAmount !== 'number' || isNaN(decimalAmount) || !isFinite(decimalAmount)) {
    throw new Error('Invalid decimal amount');
  }
  if (decimalAmount < 0) {
    throw new Error('Amount cannot be negative');
  }

  const decimals = getCurrencyDecimals(currency);
  const factor = Math.pow(10, decimals);
  const roundedMinor = Math.round(decimalAmount * factor);

  if (!Number.isSafeInteger(roundedMinor)) {
    throw new Error('Amount exceeds maximum safe integer representation');
  }

  // Precision check: verify that round-trip matches input within decimal places
  const check = roundedMinor / factor;
  if (Math.abs(check - decimalAmount) > 1e-9) {
    throw new Error(
      `Amount has excessive precision for currency ${currency} (maximum ${decimals} decimals allowed)`,
    );
  }

  return roundedMinor;
}

/**
 * Positive safe integer minor units schema.
 */
export const SafeMinorUnitsSchema = PositiveMinorUnitsSchema.refine(
  (val) => Number.isSafeInteger(val),
  { message: 'Amount must be a safe integer' },
);

/**
 * Monetary constraints schema for purchase intent.
 * Note: A user budget constraint is NOT permission to spend; it is an upper bound constraint.
 */
export const PurchaseIntentConstraintsSchema = z
  .object({
    maxUnitPriceMinor: SafeMinorUnitsSchema.optional(),
    maxTotalMinor: SafeMinorUnitsSchema.optional(),
    currency: CurrencySchema.refine((c) => isSupportedCurrency(c), {
      message: 'Currency is not in the supported currencies list',
    }).optional(),
  })
  .strict();
export type PurchaseIntentConstraints = z.infer<typeof PurchaseIntentConstraintsSchema>;

/**
 * Intent details schema: action, query, quantity, preferences, and constraints.
 */
export const IntentDetailsSchema = z
  .object({
    action: z.literal('purchase'),
    productQuery: z
      .string()
      .trim()
      .min(1, 'Product query cannot be empty')
      .max(500, 'Product query cannot exceed 500 characters'),
    merchantPreference: z
      .string()
      .trim()
      .min(1, 'Merchant preference cannot be empty')
      .max(200, 'Merchant preference cannot exceed 200 characters')
      .optional(),
    quantity: z
      .number()
      .int('Quantity must be an integer')
      .positive('Quantity must be positive')
      .max(1000, 'Quantity cannot exceed 1000 items')
      .refine((val) => Number.isSafeInteger(val), { message: 'Quantity must be a safe integer' }),
    constraints: PurchaseIntentConstraintsSchema.optional(),
  })
  .strict();
export type IntentDetails = z.infer<typeof IntentDetailsSchema>;

/**
 * Context schema capturing caller source, locale, and principal.
 */
export const PurchaseIntentContextSchema = z
  .object({
    source: z.literal('user'),
    locale: z
      .string()
      .trim()
      .min(2, 'Locale must be at least 2 characters')
      .max(35, 'Locale cannot exceed 35 characters')
      .optional(),
    principalId: z
      .string()
      .trim()
      .min(1, 'Principal ID cannot be empty')
      .max(128, 'Principal ID cannot exceed 128 characters')
      .optional(),
  })
  .strict();
export type PurchaseIntentContext = z.infer<typeof PurchaseIntentContextSchema>;

/**
 * Canonical PurchaseIntent Schema: versioned, strictly typed, runtime validated.
 */
export const PurchaseIntentSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: z
      .string()
      .trim()
      .min(1, 'requestId cannot be empty')
      .max(128, 'requestId cannot exceed 128 characters'),
    idempotencyKey: z
      .string()
      .trim()
      .min(1, 'idempotencyKey cannot be empty')
      .max(128, 'idempotencyKey cannot exceed 128 characters'),
    intent: IntentDetailsSchema,
    context: PurchaseIntentContextSchema,
  })
  .strict();
export type PurchaseIntent = z.infer<typeof PurchaseIntentSchema>;

/**
 * Discriminated union of parse results from the PurchaseIntentParser.
 */
export const PurchaseIntentParseResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('PARSED'),
    intent: PurchaseIntentSchema,
    confidence: z.number().min(0).max(1).optional(),
    rawInput: z.string(),
  }),
  z.object({
    status: z.literal('NEEDS_CLARIFICATION'),
    reason: z.string().min(1),
    question: z.string().min(1),
    rawInput: z.string(),
  }),
  z.object({
    status: z.literal('UNSUPPORTED_INTENT'),
    reason: z.string().min(1),
    rawInput: z.string(),
  }),
  z.object({
    status: z.literal('INVALID_INPUT'),
    reason: z.string().min(1),
    validationErrors: z.array(z.any()).optional(),
    rawInput: z.string(),
  }),
]);
export type PurchaseIntentParseResult = z.infer<typeof PurchaseIntentParseResultSchema>;

/**
 * Typed PurchaseIntentParser contract.
 */
export interface PurchaseIntentParser {
  parse(
    input: string,
    options?: {
      requestId?: string;
      idempotencyKey?: string;
      principalId?: string;
      locale?: string;
    },
  ): Promise<PurchaseIntentParseResult>;
}

/**
 * Public Gateway Request Schema for POST /api/purchase-intents
 */
export const CreatePurchaseIntentInputSchema = z
  .object({
    rawIntent: z
      .string()
      .trim()
      .min(1, 'rawIntent cannot be empty')
      .max(1000, 'rawIntent cannot exceed 1000 characters'),
    requestId: z
      .string()
      .trim()
      .min(1, 'requestId cannot be empty')
      .max(128, 'requestId cannot exceed 128 characters')
      .optional(),
    idempotencyKey: z
      .string()
      .trim()
      .min(1, 'idempotencyKey cannot be empty')
      .max(128, 'idempotencyKey cannot exceed 128 characters')
      .optional(),
    locale: z
      .string()
      .trim()
      .min(2, 'locale must be at least 2 characters')
      .max(35, 'locale cannot exceed 35 characters')
      .optional(),
    selectedCandidate: z
      .object({
        providerProductId: z.string().min(1).max(128),
        providerId: z.string().min(1).max(64).default('mock-provider'),
        expectedUnitPriceMinor: z.number().int().nonnegative().optional(),
        expectedCurrency: z.string().length(3).optional(),
      })
      .optional(),
  })
  .strict();
export type CreatePurchaseIntentInput = z.infer<typeof CreatePurchaseIntentInputSchema>;
