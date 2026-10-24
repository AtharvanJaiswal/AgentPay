import { z } from 'zod';
import { CurrencySchema, PositiveMinorUnitsSchema } from './common.js';
import type { PurchaseProposal } from './proposal.js';

export const PaymentOrderStatusSchema = z.enum([
  'CREATED',
  'SAVED',
  'APPROVED',
  'VOIDED',
  'COMPLETED',
  'FAILED',
]);
export type PaymentOrderStatus = z.infer<typeof PaymentOrderStatusSchema>;

export const PaymentOrderSchema = z.object({
  id: z.string(),
  proposalId: z.string().uuid(),
  provider: z.literal('mock'),
  status: PaymentOrderStatusSchema,
  amountMinor: PositiveMinorUnitsSchema,
  currency: CurrencySchema,
  isMock: z.literal(true),
  approvalUrl: z.string().url().optional(),
  createdAt: z.string().datetime(),
  environmentNote: z.string(),
});
export type PaymentOrder = z.infer<typeof PaymentOrderSchema>;

export const PaymentCaptureResultSchema = z.object({
  captureId: z.string(),
  orderId: z.string(),
  status: z.enum(['COMPLETED', 'DECLINED', 'FAILED']),
  capturedAmountMinor: PositiveMinorUnitsSchema,
  currency: CurrencySchema,
  isMock: z.literal(true),
  timestamp: z.string().datetime(),
  environmentNote: z.string(),
});
export type PaymentCaptureResult = z.infer<typeof PaymentCaptureResultSchema>;

import { PolicyOutcomeSchema } from './policy.js';

export const CreateOrderRequestSchema = z.object({
  proposal: z.unknown(), // validated via PurchaseProposalSchema
  policyDecisionId: z.string().uuid(),
  authorizedOutcome: PolicyOutcomeSchema,
});
export type CreateOrderRequest = z.infer<typeof CreateOrderRequestSchema>;

export const CaptureOrderRequestSchema = z.object({
  policyDecisionId: z.string().uuid(),
});
export type CaptureOrderRequest = z.infer<typeof CaptureOrderRequestSchema>;

export interface PaymentProvider {
  readonly providerName: string;
  readonly isMock: boolean;

  createOrder(proposal: PurchaseProposal, correlationId: string): Promise<PaymentOrder>;
  getOrder(orderId: string, correlationId: string): Promise<PaymentOrder | null>;
  captureOrder(
    orderId: string,
    policyDecisionId: string,
    correlationId: string,
  ): Promise<PaymentCaptureResult>;
  verifyWebhook(payload: unknown, headers: Record<string, string>): Promise<boolean>;
}
