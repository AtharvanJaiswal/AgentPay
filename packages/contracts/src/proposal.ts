import crypto from 'node:crypto';
import { z } from 'zod';
import { CurrencySchema, MinorUnitsSchema, PositiveMinorUnitsSchema } from './common.js';

export const ProposalItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPriceMinor: MinorUnitsSchema,
  currency: CurrencySchema,
});
export type ProposalItem = z.infer<typeof ProposalItemSchema>;

export const MerchantSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: z.string().min(1),
});
export type Merchant = z.infer<typeof MerchantSchema>;

export const PurchaseProposalSchema = z.object({
  id: z.string().uuid(),
  intentId: z.string().uuid(),
  agentId: z.string().min(1),
  merchant: MerchantSchema,
  items: z.array(ProposalItemSchema).min(1, 'Proposal must contain at least one item'),
  totalAmountMinor: PositiveMinorUnitsSchema,
  currency: CurrencySchema,
  purpose: z.string().min(1),
  userBudgetMinor: z.number().int().positive().optional(),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string().datetime(),
});
export type PurchaseProposal = z.infer<typeof PurchaseProposalSchema>;

export const CreateProposalInputSchema = z.object({
  rawIntent: z.string().min(1, 'Raw intent text cannot be empty'),
  agentId: z.string().default('agent-assistant-01'),
});
export type CreateProposalInput = z.infer<typeof CreateProposalInputSchema>;

export const ProposalLifecycleStatusSchema = z.enum([
  'INTENT_RECEIVED',
  'CLARIFICATION_REQUIRED',
  'SELECTION_REQUIRED',
  'POLICY_DENIED',
  'POLICY_REVIEW_REQUIRED',
  'READY_FOR_REVIEW',
  'APPROVED',
  'EXPIRED',
  'CANCELLED',
]);
export type ProposalLifecycleStatus = z.infer<typeof ProposalLifecycleStatusSchema>;

export const StoredPurchaseProposalSchema = z.object({
  id: z.string().uuid(),
  requestId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  idempotencyScope: z.string().min(1).default('default'),
  requestHash: z.string().min(1),
  status: ProposalLifecycleStatusSchema,
  productQuery: z.string().min(1),
  productId: z.string().optional(),
  productName: z.string().optional(),
  merchantId: z.string().optional(),
  merchantName: z.string().optional(),
  merchantCategory: z.string().optional(),
  quantity: z.number().int().positive().default(1),
  currency: CurrencySchema,
  unitPriceMinor: MinorUnitsSchema.optional(),
  subtotalMinor: MinorUnitsSchema.optional(),
  taxMinor: MinorUnitsSchema.optional(),
  shippingMinor: MinorUnitsSchema.optional(),
  totalAmountMinor: MinorUnitsSchema.optional(),
  policyDecisionId: z.string().uuid().optional(),
  policyOutcome: z.enum(['ALLOW', 'DENY', 'REQUIRE_APPROVAL']).optional(),
  policyReasonCode: z.string().optional(),
  principalId: z.string().optional(),
  correlationId: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type StoredPurchaseProposal = z.infer<typeof StoredPurchaseProposalSchema>;

export class ProposalIdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = 'ProposalIdempotencyConflictError';
  }
}

export class InvalidProposalStateTransitionError extends Error {
  public readonly code = 'INVALID_STATE_TRANSITION';
  public readonly statusCode = 400;

  constructor(from: ProposalLifecycleStatus, to: ProposalLifecycleStatus, message?: string) {
    super(
      message ||
        `Invalid proposal state transition from '${from}' to '${to}'. This transition is prohibited by lifecycle rules.`,
    );
    this.name = 'InvalidProposalStateTransitionError';
  }
}

export class ForbiddenProposalAccessError extends Error {
  public readonly code = 'FORBIDDEN';
  public readonly statusCode = 403;

  constructor(message = 'Access to purchase proposal denied for principal') {
    super(message);
    this.name = 'ForbiddenProposalAccessError';
  }
}

export const VALID_PROPOSAL_STATUS_TRANSITIONS: Record<
  ProposalLifecycleStatus,
  readonly ProposalLifecycleStatus[]
> = {
  INTENT_RECEIVED: [
    'CLARIFICATION_REQUIRED',
    'SELECTION_REQUIRED',
    'POLICY_DENIED',
    'POLICY_REVIEW_REQUIRED',
    'READY_FOR_REVIEW',
    'CANCELLED',
  ],
  CLARIFICATION_REQUIRED: ['INTENT_RECEIVED', 'CANCELLED'],
  SELECTION_REQUIRED: ['INTENT_RECEIVED', 'CANCELLED'],
  POLICY_DENIED: ['CANCELLED'], // Terminal state - cannot be approved or marked ready
  POLICY_REVIEW_REQUIRED: ['APPROVED', 'CANCELLED', 'POLICY_DENIED'], // Explicit human authorization
  READY_FOR_REVIEW: ['APPROVED', 'CANCELLED', 'EXPIRED'],
  APPROVED: ['CANCELLED', 'EXPIRED'], // Approved cannot be reverted to draft/review
  EXPIRED: [], // Terminal
  CANCELLED: [], // Terminal
};

export function isValidProposalStatusTransition(
  from: ProposalLifecycleStatus,
  to: ProposalLifecycleStatus,
): boolean {
  if (from === to) return true; // Idempotent same-status
  const allowed = VALID_PROPOSAL_STATUS_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

export function computeIntentFingerprint(intent: {
  action: string;
  productQuery: string;
  quantity: number;
  merchantPreference?: string;
  selectedProductId?: string;
  constraints?: {
    maxUnitPriceMinor?: number;
    maxTotalMinor?: number;
    currency?: string;
  };
}): string {
  // Stable canonical serialization excluding volatile fields (timestamps, correlation IDs)
  const canonical = JSON.stringify({
    action: intent.action,
    productQuery: intent.productQuery.trim().toLowerCase(),
    quantity: intent.quantity,
    merchantPreference: intent.merchantPreference?.trim().toLowerCase() ?? '',
    selectedProductId: intent.selectedProductId?.trim().toLowerCase() ?? '',
    constraints: {
      maxUnitPriceMinor: intent.constraints?.maxUnitPriceMinor ?? null,
      maxTotalMinor: intent.constraints?.maxTotalMinor ?? null,
      currency: intent.constraints?.currency?.toUpperCase() ?? '',
    },
  });
  // Use crypto for SHA-256 fingerprinting
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export interface ProposalRepository {
  createProposal(proposal: StoredPurchaseProposal): Promise<StoredPurchaseProposal>;
  getProposalById(id: string): Promise<StoredPurchaseProposal | null>;
  getProposalByIdempotencyKey(scope: string, key: string): Promise<StoredPurchaseProposal | null>;
  updateProposalStatus(
    id: string,
    status: ProposalLifecycleStatus,
    updates?: {
      expectedPrincipalId?: string;
      policyDecisionId?: string;
      policyOutcome?: 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';
      policyReasonCode?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<StoredPurchaseProposal>;
}
