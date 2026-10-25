import { v4 as uuidv4 } from 'uuid';
import type {
  PolicyDecision,
  PolicyEvaluator,
  PurchaseProposal,
  RuleEvaluationResult,
} from '@agentpay/contracts';
import { PolicyReasonCodes } from '@agentpay/contracts';
import type { PolicyServiceConfig } from '@agentpay/config';

export class DeterministicPolicyEvaluator implements PolicyEvaluator {
  private readonly config: PolicyServiceConfig;
  private readonly policyVersion = '1.0.0-foundation';

  constructor(config: PolicyServiceConfig) {
    this.config = config;
  }

  async evaluate(proposal: PurchaseProposal, _correlationId: string): Promise<PolicyDecision> {
    const rulesEvaluated: RuleEvaluationResult[] = [];

    // Rule 1: Currency Check
    const isCurrencyAllowed = proposal.currency === this.config.DEFAULT_ALLOWED_CURRENCY;
    rulesEvaluated.push({
      ruleId: 'RULE_CURRENCY_CHECK',
      ruleName: 'Supported Currency Validation',
      passed: isCurrencyAllowed,
      details: isCurrencyAllowed
        ? `Currency ${proposal.currency} is supported`
        : `Currency ${proposal.currency} is not supported. Only ${this.config.DEFAULT_ALLOWED_CURRENCY} is currently accepted.`,
    });

    if (!isCurrencyAllowed) {
      return {
        decisionId: uuidv4(),
        proposalId: proposal.id,
        outcome: 'DENY',
        reasonCode: PolicyReasonCodes.DENY_UNSUPPORTED_CURRENCY,
        reasonMessage: `Currency ${proposal.currency} is rejected by security policy`,
        policyVersion: this.policyVersion,
        decisionTimestamp: new Date().toISOString(),
        rulesEvaluated,
      };
    }

    // Rule 2: Item Amount Consistency Verification (Integer Arithmetic)
    const computedTotal = proposal.items.reduce(
      (sum, item) => sum + item.quantity * item.unitPriceMinor,
      0,
    );
    const amountsMatch = computedTotal === proposal.totalAmountMinor;
    rulesEvaluated.push({
      ruleId: 'RULE_AMOUNT_CONSISTENCY',
      ruleName: 'Itemized Minor Unit Arithmetic Verification',
      passed: amountsMatch,
      details: amountsMatch
        ? 'Total amount perfectly matches sum of line items'
        : `Reported total (${proposal.totalAmountMinor}) does not match line items sum (${computedTotal})`,
    });

    if (!amountsMatch) {
      return {
        decisionId: uuidv4(),
        proposalId: proposal.id,
        outcome: 'DENY',
        reasonCode: PolicyReasonCodes.DENY_AMOUNT_MISMATCH,
        reasonMessage:
          'Arithmetic integrity check failed: line item totals do not match proposal total',
        policyVersion: this.policyVersion,
        decisionTimestamp: new Date().toISOString(),
        rulesEvaluated,
      };
    }

    // Rule 3: Merchant Category Blacklist
    const merchantCategory = proposal.merchant.category.toLowerCase().trim();
    const isRestrictedCategory = this.config.RESTRICTED_CATEGORIES.includes(merchantCategory);
    rulesEvaluated.push({
      ruleId: 'RULE_MERCHANT_CATEGORY',
      ruleName: 'Restricted Merchant Category Policy',
      passed: !isRestrictedCategory,
      details: isRestrictedCategory
        ? `Category "${merchantCategory}" is in restricted categories list: ${this.config.RESTRICTED_CATEGORIES.join(', ')}`
        : `Category "${merchantCategory}" is permitted`,
    });

    if (isRestrictedCategory) {
      return {
        decisionId: uuidv4(),
        proposalId: proposal.id,
        outcome: 'DENY',
        reasonCode: PolicyReasonCodes.DENY_RESTRICTED_CATEGORY,
        reasonMessage: `Merchant category "${proposal.merchant.category}" is prohibited by risk policy`,
        policyVersion: this.policyVersion,
        decisionTimestamp: new Date().toISOString(),
        rulesEvaluated,
      };
    }

    // Rule 4: Hard Ceiling Limit Check
    const exceedsHardLimit = proposal.totalAmountMinor > this.config.MAX_TRANSACTION_LIMIT_MINOR;
    rulesEvaluated.push({
      ruleId: 'RULE_HARD_LIMIT',
      ruleName: 'Maximum Autonomous Transaction Limit',
      passed: !exceedsHardLimit,
      details: exceedsHardLimit
        ? `Total ${proposal.totalAmountMinor} exceeds hard ceiling of ${this.config.MAX_TRANSACTION_LIMIT_MINOR} minor units ($${this.config.MAX_TRANSACTION_LIMIT_MINOR / 100})`
        : `Total is within maximum ceiling of $${this.config.MAX_TRANSACTION_LIMIT_MINOR / 100}`,
    });

    if (exceedsHardLimit) {
      return {
        decisionId: uuidv4(),
        proposalId: proposal.id,
        outcome: 'DENY',
        reasonCode: PolicyReasonCodes.DENY_EXCEEDS_HARD_LIMIT,
        reasonMessage: `Transaction amount exceeds platform hard ceiling of $${this.config.MAX_TRANSACTION_LIMIT_MINOR / 100}`,
        policyVersion: this.policyVersion,
        decisionTimestamp: new Date().toISOString(),
        rulesEvaluated,
      };
    }

    // Rule 4b: User-Configured Budget Constraint Check
    if (proposal.userBudgetMinor !== undefined) {
      const exceedsUserBudget = proposal.totalAmountMinor > proposal.userBudgetMinor;
      rulesEvaluated.push({
        ruleId: 'RULE_USER_BUDGET_LIMIT',
        ruleName: 'User Maximum Budget Constraint',
        passed: !exceedsUserBudget,
        details: exceedsUserBudget
          ? `Total (${proposal.totalAmountMinor}) exceeds user-specified budget constraint (${proposal.userBudgetMinor})`
          : `Total (${proposal.totalAmountMinor}) is within user-specified budget constraint (${proposal.userBudgetMinor})`,
      });

      if (exceedsUserBudget) {
        return {
          decisionId: uuidv4(),
          proposalId: proposal.id,
          outcome: 'DENY',
          reasonCode: PolicyReasonCodes.DENY_EXCEEDS_USER_BUDGET,
          reasonMessage: `Transaction amount exceeds explicit user budget constraint of ${proposal.userBudgetMinor} minor units`,
          policyVersion: this.policyVersion,
          decisionTimestamp: new Date().toISOString(),
          rulesEvaluated,
        };
      }
    }

    // Rule 5: Explicit Approval Requirement for High-Value Purchases
    const requiresExplicitApproval =
      proposal.totalAmountMinor > this.config.APPROVAL_THRESHOLD_MINOR;
    rulesEvaluated.push({
      ruleId: 'RULE_APPROVAL_THRESHOLD',
      ruleName: 'High-Value Explicit Human Approval Threshold',
      passed: !requiresExplicitApproval,
      details: requiresExplicitApproval
        ? `Amount $${proposal.totalAmountMinor / 100} exceeds automated spending threshold of $${this.config.APPROVAL_THRESHOLD_MINOR / 100} and requires explicit authorization.`
        : `Amount $${proposal.totalAmountMinor / 100} is within automated autonomous spending threshold.`,
    });

    if (requiresExplicitApproval) {
      return {
        decisionId: uuidv4(),
        proposalId: proposal.id,
        outcome: 'REQUIRE_APPROVAL',
        reasonCode: PolicyReasonCodes.REQUIRE_APPROVAL_HIGH_VALUE,
        reasonMessage: `Transaction value requires explicit human approval prior to payment creation ($${proposal.totalAmountMinor / 100} > $${this.config.APPROVAL_THRESHOLD_MINOR / 100})`,
        policyVersion: this.policyVersion,
        decisionTimestamp: new Date().toISOString(),
        rulesEvaluated,
      };
    }

    // Default Allow
    return {
      decisionId: uuidv4(),
      proposalId: proposal.id,
      outcome: 'ALLOW',
      reasonCode: PolicyReasonCodes.ALLOW_WITHIN_LIMITS,
      reasonMessage: 'Proposal satisfies all automated spending and risk policies',
      policyVersion: this.policyVersion,
      decisionTimestamp: new Date().toISOString(),
      rulesEvaluated,
    };
  }
}
