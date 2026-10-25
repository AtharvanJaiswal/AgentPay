import { z } from 'zod';
import { CurrencySchema, PositiveMinorUnitsSchema } from './common.js';
import type { PurchaseProposal } from './proposal.js';
import { PolicyOutcomeSchema } from './policy.js';

export const PaymentOrderStatusSchema = z.enum([
  'CREATED',
  'SAVED',
  'APPROVED',
  'VOIDED',
  'COMPLETED',
  'FAILED',
  'UNKNOWN',
  'PAYER_ACTION_REQUIRED',
]);
export type PaymentOrderStatus = z.infer<typeof PaymentOrderStatusSchema>;

export const PaymentProviderTypeSchema = z.enum(['mock', 'paypal_sandbox']);
export type PaymentProviderType = z.infer<typeof PaymentProviderTypeSchema>;

export const PaymentOrderSchema = z.object({
  id: z.string(),
  proposalId: z.string().uuid(),
  provider: PaymentProviderTypeSchema,
  status: PaymentOrderStatusSchema,
  amountMinor: PositiveMinorUnitsSchema,
  currency: CurrencySchema,
  isMock: z.boolean(),
  approvalUrl: z.string().url().optional(),
  createdAt: z.string().datetime(),
  environmentNote: z.string(),
  idempotencyKey: z.string().optional(),
  lastReconciledAt: z.string().datetime().optional(),
  reconciliationStatus: z.string().optional(),
});
export type PaymentOrder = z.infer<typeof PaymentOrderSchema>;

export const ReconciliationStatusSchema = z.enum([
  'UNCHANGED',
  'UPDATED',
  'DUPLICATE',
  'CONFLICT',
  'NOT_FOUND',
  'RETRYABLE_ERROR',
  'REQUIRES_REVIEW',
]);
export type ReconciliationStatus = z.infer<typeof ReconciliationStatusSchema>;

export const ReconciliationResultSchema = z.object({
  orderId: z.string(),
  status: ReconciliationStatusSchema,
  previousOrderStatus: PaymentOrderStatusSchema.optional(),
  currentOrderStatus: PaymentOrderStatusSchema.optional(),
  providerStatus: z.string().optional(),
  details: z.string().optional(),
  timestamp: z.string().datetime(),
});
export type ReconciliationResult = z.infer<typeof ReconciliationResultSchema>;

export const PaymentCaptureStatusSchema = z.enum([
  'COMPLETED',
  'DECLINED',
  'FAILED',
  'UNKNOWN',
  'PENDING',
]);
export type PaymentCaptureStatus = z.infer<typeof PaymentCaptureStatusSchema>;

export const PaymentCaptureResultSchema = z.object({
  captureId: z.string(),
  orderId: z.string(),
  status: PaymentCaptureStatusSchema,
  capturedAmountMinor: PositiveMinorUnitsSchema,
  currency: CurrencySchema,
  isMock: z.boolean(),
  timestamp: z.string().datetime(),
  environmentNote: z.string(),
});
export type PaymentCaptureResult = z.infer<typeof PaymentCaptureResultSchema>;

export const CreateOrderRequestSchema = z.object({
  proposal: z.unknown(), // validated via PurchaseProposalSchema
  policyDecisionId: z.string().uuid(),
  authorizedOutcome: PolicyOutcomeSchema,
  idempotencyKey: z.string().optional(),
});
export type CreateOrderRequest = z.infer<typeof CreateOrderRequestSchema>;

export const CaptureOrderRequestSchema = z.object({
  policyDecisionId: z.string().uuid(),
  idempotencyKey: z.string().optional(),
});
export type CaptureOrderRequest = z.infer<typeof CaptureOrderRequestSchema>;

export interface CreateOrderOptions {
  idempotencyKey?: string;
  policyDecisionId?: string;
}

export interface CaptureOrderOptions {
  idempotencyKey?: string;
}

export interface PaymentProvider {
  readonly providerName: string;
  readonly isMock: boolean;

  createOrder(
    proposal: PurchaseProposal,
    correlationId: string,
    options?: CreateOrderOptions,
  ): Promise<PaymentOrder>;
  getOrder(orderId: string, correlationId: string): Promise<PaymentOrder | null>;
  captureOrder(
    orderId: string,
    policyDecisionId: string,
    correlationId: string,
    options?: CaptureOrderOptions,
  ): Promise<PaymentCaptureResult>;
  verifyWebhook(payload: unknown, headers: Record<string, string>): Promise<boolean>;
  reconcileOrder?(orderId: string, correlationId: string): Promise<ReconciliationResult>;
}
