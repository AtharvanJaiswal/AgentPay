import { v4 as uuidv4 } from 'uuid';
import type {
  PurchaseProposal,
  PolicyDecision,
  PaymentOrder,
  AuditEvent,
} from '@agentpay/contracts';

export function createMockProposal(overrides: Partial<PurchaseProposal> = {}): PurchaseProposal {
  return {
    id: uuidv4(),
    intentId: uuidv4(),
    agentId: 'test-agent-01',
    merchant: {
      id: 'merchant-cloud-01',
      name: 'Cloud Computing Services',
      category: 'cloud_hosting',
    },
    items: [
      {
        id: 'item-01',
        name: 'Developer Cloud Node Monthly',
        quantity: 1,
        unitPriceMinor: 2500, // $25.00
        currency: 'USD',
      },
    ],
    totalAmountMinor: 2500,
    currency: 'USD',
    purpose: 'Provisioning continuous integration runner',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function createMockPolicyDecision(overrides: Partial<PolicyDecision> = {}): PolicyDecision {
  return {
    decisionId: uuidv4(),
    proposalId: uuidv4(),
    outcome: 'ALLOW',
    reasonCode: 'ALLOW_WITHIN_LIMITS',
    reasonMessage: 'Proposal satisfies standard spending and merchant security guidelines',
    policyVersion: '1.0.0-dev',
    decisionTimestamp: new Date().toISOString(),
    rulesEvaluated: [
      {
        ruleId: 'RULE_MAX_AMOUNT',
        ruleName: 'Maximum Amount Ceiling',
        passed: true,
      },
      {
        ruleId: 'RULE_MERCHANT_CATEGORY',
        ruleName: 'Merchant Category Restriction',
        passed: true,
      },
      {
        ruleId: 'RULE_CURRENCY_CHECK',
        ruleName: 'Supported Currency Validation',
        passed: true,
      },
    ],
    ...overrides,
  };
}

export function createMockPaymentOrder(overrides: Partial<PaymentOrder> = {}): PaymentOrder {
  return {
    id: `MOCK-ORDER-${uuidv4().substring(0, 8).toUpperCase()}`,
    proposalId: uuidv4(),
    provider: 'mock',
    status: 'CREATED',
    amountMinor: 2500,
    currency: 'USD',
    isMock: true,
    approvalUrl: 'http://localhost:3000/mock-paypal-approval',
    createdAt: new Date().toISOString(),
    environmentNote: 'MOCK/DEVELOPMENT provider only. No real PayPal transaction executed.',
    ...overrides,
  };
}

export function createMockAuditEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: uuidv4(),
    correlationId: uuidv4(),
    eventType: 'PROPOSAL_CREATED',
    actor: 'agent-service',
    resourceId: uuidv4(),
    timestamp: new Date().toISOString(),
    metadata: {
      source: 'test-suite',
    },
    outcome: 'SUCCESS',
    reasonCode: 'PROPOSAL_REGISTERED',
    ...overrides,
  };
}
