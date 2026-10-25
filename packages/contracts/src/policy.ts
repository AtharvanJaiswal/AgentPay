import { z } from 'zod';
import type { PurchaseProposal } from './proposal.js';

export const PolicyOutcomeSchema = z.enum(['ALLOW', 'DENY', 'REQUIRE_APPROVAL']);
export type PolicyOutcome = z.infer<typeof PolicyOutcomeSchema>;

export const PolicyReasonCodes = {
  ALLOW_WITHIN_LIMITS: 'ALLOW_WITHIN_LIMITS',
  DENY_EXCEEDS_HARD_LIMIT: 'DENY_EXCEEDS_HARD_LIMIT',
  DENY_EXCEEDS_USER_BUDGET: 'DENY_EXCEEDS_USER_BUDGET',
  DENY_UNSUPPORTED_CURRENCY: 'DENY_UNSUPPORTED_CURRENCY',
  DENY_RESTRICTED_CATEGORY: 'DENY_RESTRICTED_CATEGORY',
  DENY_AMOUNT_MISMATCH: 'DENY_AMOUNT_MISMATCH',
  REQUIRE_APPROVAL_HIGH_VALUE: 'REQUIRE_APPROVAL_HIGH_VALUE',
  REQUIRE_APPROVAL_RESTRICTED_MERCHANT: 'REQUIRE_APPROVAL_RESTRICTED_MERCHANT',
} as const;
export type PolicyReasonCode = (typeof PolicyReasonCodes)[keyof typeof PolicyReasonCodes];

export const RuleEvaluationResultSchema = z.object({
  ruleId: z.string(),
  ruleName: z.string(),
  passed: z.boolean(),
  outcomeIfTriggered: PolicyOutcomeSchema.optional(),
  details: z.string().optional(),
});
export type RuleEvaluationResult = z.infer<typeof RuleEvaluationResultSchema>;

export const PolicyDecisionSchema = z.object({
  decisionId: z.string().uuid(),
  proposalId: z.string().uuid(),
  outcome: PolicyOutcomeSchema,
  reasonCode: z.string(),
  reasonMessage: z.string(),
  policyVersion: z.string(),
  decisionTimestamp: z.string().datetime(),
  rulesEvaluated: z.array(RuleEvaluationResultSchema),
});
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export interface PolicyEvaluator {
  evaluate(proposal: PurchaseProposal, correlationId: string): Promise<PolicyDecision>;
}
