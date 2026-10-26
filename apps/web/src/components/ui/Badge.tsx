import React from 'react';
import type { ProposalLifecycleStatus } from '@agentpay/contracts';

export interface BadgeProps {
  status?: ProposalLifecycleStatus | string;
  variant?: 'success' | 'warning' | 'danger' | 'info' | 'default';
  children?: React.ReactNode;
  testId?: string;
}

export function getStatusVariant(status?: string): 'success' | 'warning' | 'danger' | 'info' | 'default' {
  switch (status) {
    case 'APPROVED':
    case 'EXACT_MATCH':
    case 'IN_STOCK':
    case 'PROVIDER_VERIFIED':
    case 'ALLOW':
      return 'success';
    case 'READY_FOR_REVIEW':
    case 'POLICY_REVIEW_REQUIRED':
    case 'REQUIRE_APPROVAL':
    case 'SELECTION_REQUIRED':
    case 'LIMITED':
      return 'warning';
    case 'POLICY_DENIED':
    case 'CANCELLED':
    case 'EXPIRED':
    case 'OUT_OF_STOCK':
    case 'DENY':
      return 'danger';
    case 'INTENT_RECEIVED':
    case 'CLARIFICATION_REQUIRED':
    case 'REVALIDATED':
      return 'info';
    default:
      return 'default';
  }
}

export function formatStatusLabel(status?: string): string {
  if (!status) return 'Unknown';
  switch (status) {
    case 'READY_FOR_REVIEW':
      return 'Ready for Review';
    case 'POLICY_REVIEW_REQUIRED':
      return 'Policy Review Required';
    case 'POLICY_DENIED':
      return 'Policy Denied';
    case 'SELECTION_REQUIRED':
      return 'Selection Required';
    case 'CLARIFICATION_REQUIRED':
      return 'Clarification Required';
    case 'INTENT_RECEIVED':
      return 'Intent Received';
    case 'IN_STOCK':
      return 'In Stock';
    case 'OUT_OF_STOCK':
      return 'Out of Stock';
    case 'PROVIDER_VERIFIED':
      return 'Provider Verified';
    default:
      return status.replace(/_/g, ' ');
  }
}

export const Badge: React.FC<BadgeProps> = ({ status, variant, children, testId }) => {
  const resolvedVariant = variant ?? getStatusVariant(status);
  const className = `badge badge-${resolvedVariant}`;

  return (
    <span className={className} data-testid={testId}>
      {children ?? formatStatusLabel(status)}
    </span>
  );
};
