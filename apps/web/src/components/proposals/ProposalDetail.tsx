import React, { useState } from 'react';
import type { StoredPurchaseProposal } from '@agentpay/contracts';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { ProposalAuditTimeline } from './ProposalAuditTimeline';
import { formatCurrency } from '../../lib/formatting/currency';

export interface ProposalDetailProps {
  proposal: StoredPurchaseProposal;
  onApproveClick: (proposal: StoredPurchaseProposal) => void;
  onRejectClick: (proposal: StoredPurchaseProposal) => void;
  actionInProgress?: boolean;
}

export const ProposalDetail: React.FC<ProposalDetailProps> = ({
  proposal,
  onApproveClick,
  onRejectClick,
  actionInProgress = false,
}) => {
  const [showAudit, setShowAudit] = useState(true);

  const isReviewable =
    proposal.status === 'READY_FOR_REVIEW' || proposal.status === 'POLICY_REVIEW_REQUIRED';

  const totalFormatted = formatCurrency(proposal.totalAmountMinor, proposal.currency);
  const unitPriceFormatted = formatCurrency(proposal.unitPriceMinor, proposal.currency);

  const policyReasonMessage =
    (proposal.metadata?.['policyReasonMessage'] as string) ||
    (proposal.policyReasonCode ? `Policy code: ${proposal.policyReasonCode}` : 'Standard validation');

  return (
    <div
      data-testid="proposal-detail-panel"
      className="glass-panel"
      style={{
        borderRadius: '16px',
        padding: '1.75rem',
        border: '1px solid var(--card-border-hover)',
        marginTop: '1.5rem',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          borderBottom: '1px solid var(--card-border)',
          paddingBottom: '1.25rem',
          marginBottom: '1.25rem',
          flexWrap: 'wrap',
          gap: '0.75rem',
        }}
      >
        <div>
          <div
            style={{
              fontSize: '0.75rem',
              color: 'var(--text-dim)',
              fontFamily: 'var(--font-mono)',
              marginBottom: '0.25rem',
            }}
          >
            PROPOSAL ID: <span data-testid="proposal-id-display">{proposal.id}</span>
          </div>
          <h2
            data-testid="proposal-title-display"
            style={{
              fontSize: '1.35rem',
              fontWeight: 800,
              color: 'var(--text-main)',
              letterSpacing: '-0.02em',
            }}
          >
            {proposal.productName || proposal.productQuery}
          </h2>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
            Merchant: <strong>{proposal.merchantName || 'External Catalog'}</strong>{' '}
            {proposal.merchantCategory && <span>({proposal.merchantCategory})</span>}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Badge status={proposal.status} testId="proposal-status-badge" />
        </div>
      </div>

      {/* Grid: Financials & Policy Breakdown */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: '1.25rem',
          marginBottom: '1.5rem',
        }}
      >
        {/* Financial Breakdown */}
        <div
          style={{
            background: 'rgba(255, 255, 255, 0.02)',
            border: '1px solid var(--card-border)',
            borderRadius: '12px',
            padding: '1.25rem',
          }}
        >
          <div
            style={{
              fontSize: '0.75rem',
              textTransform: 'uppercase',
              fontWeight: 700,
              color: 'var(--text-dim)',
              letterSpacing: '0.04em',
              marginBottom: '0.75rem',
            }}
          >
            Authoritative Financial Specification
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: '0.875rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-muted)' }}>Unit Price:</span>
              <span style={{ fontWeight: 600 }}>{unitPriceFormatted}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-muted)' }}>Quantity:</span>
              <span style={{ fontWeight: 600 }}>{proposal.quantity}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-muted)' }}>Currency:</span>
              <span style={{ fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{proposal.currency}</span>
            </div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                borderTop: '1px solid var(--card-border)',
                paddingTop: '0.6rem',
                marginTop: '0.25rem',
              }}
            >
              <span style={{ fontWeight: 700, color: 'var(--text-main)' }}>Total Minor Units:</span>
              <span
                data-testid="proposal-total-amount"
                style={{
                  fontWeight: 800,
                  fontSize: '1.25rem',
                  color: 'var(--accent-cyan)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {totalFormatted}
              </span>
            </div>
          </div>
        </div>

        {/* Authoritative Policy Review */}
        <div
          data-testid="policy-review-panel"
          style={{
            background: 'rgba(255, 255, 255, 0.02)',
            border: '1px solid var(--card-border)',
            borderRadius: '12px',
            padding: '1.25rem',
          }}
        >
          <div
            style={{
              fontSize: '0.75rem',
              textTransform: 'uppercase',
              fontWeight: 700,
              color: 'var(--text-dim)',
              letterSpacing: '0.04em',
              marginBottom: '0.75rem',
            }}
          >
            Authoritative Policy Evaluation
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: '0.875rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: 'var(--text-muted)' }}>Policy Outcome:</span>
              <Badge status={proposal.policyOutcome || proposal.status} testId="policy-outcome-badge" />
            </div>

            {proposal.policyReasonCode && (
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-muted)' }}>Reason Code:</span>
                <code
                  data-testid="policy-reason-code"
                  style={{ color: 'var(--accent-amber)', fontSize: '0.8rem' }}
                >
                  {proposal.policyReasonCode}
                </code>
              </div>
            )}

            <div
              data-testid="proposal-policy-reasons"
              style={{
                background: 'rgba(0, 0, 0, 0.25)',
                border: '1px solid var(--card-border)',
                borderRadius: '8px',
                padding: '0.65rem 0.85rem',
                fontSize: '0.8rem',
                color: 'var(--text-main)',
                lineHeight: 1.4,
                marginTop: '0.25rem',
              }}
            >
              {policyReasonMessage}
            </div>
          </div>
        </div>
      </div>

      {/* Decision Status & Authorization Actions */}
      <div
        style={{
          borderTop: '1px solid var(--card-border)',
          paddingTop: '1.25rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        <div>
          {proposal.status === 'APPROVED' && (
            <div data-testid="approved-notice" style={{ color: 'var(--accent-emerald)', fontSize: '0.875rem', fontWeight: 600 }}>
              ✓ Proposal authorized by human reviewer ({proposal.metadata?.['approvedByPrincipal'] as string || 'Principal'}). Ready for downstream execution in a future phase.
            </div>
          )}
          {proposal.status === 'CANCELLED' && (
            <div data-testid="rejected-notice" style={{ color: 'var(--accent-rose)', fontSize: '0.875rem', fontWeight: 600 }}>
              ✕ Proposal rejected by human reviewer. Reason: {proposal.metadata?.['rejectionReason'] as string || 'Declined'}.
            </div>
          )}
          {proposal.status === 'POLICY_DENIED' && (
            <div data-testid="denied-notice" style={{ color: 'var(--accent-rose)', fontSize: '0.875rem', fontWeight: 600 }}>
              ✕ Proposal was denied automatically by the policy engine. Authorization is blocked.
            </div>
          )}
          {isReviewable && (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              Requires explicit authorization decision. Payment execution is strictly disabled.
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Button
            type="button"
            variant="outline"
            onClick={() => setShowAudit(!showAudit)}
            testId="toggle-audit-btn"
            style={{ fontSize: '0.8rem', padding: '0.5rem 0.9rem' }}
          >
            {showAudit ? 'Hide Audit History' : 'View Audit History'}
          </Button>

          {isReviewable ? (
            <>
              <Button
                type="button"
                variant="danger"
                disabled={actionInProgress}
                onClick={() => onRejectClick(proposal)}
                testId="reject-proposal-btn"
                style={{ padding: '0.65rem 1.25rem' }}
              >
                Reject Proposal
              </Button>

              <Button
                type="button"
                variant="success"
                disabled={actionInProgress}
                onClick={() => onApproveClick(proposal)}
                testId="approve-proposal-btn"
                style={{ padding: '0.65rem 1.5rem' }}
              >
                Authorize Proposal ✓
              </Button>
            </>
          ) : (
            <span
              data-testid="decision-controls-disabled"
              style={{ fontSize: '0.8rem', color: 'var(--text-dim)', fontStyle: 'italic' }}
            >
              Decision finalized (Non-reviewable transition)
            </span>
          )}
        </div>
      </div>

      {/* Audit History Timeline */}
      {showAudit && (
        <div style={{ marginTop: '1.5rem', borderTop: '1px solid var(--card-border)', paddingTop: '1.25rem' }}>
          <h4 style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: '0.75rem', color: 'var(--text-main)' }}>
            Verifiable Server Audit Log
          </h4>
          <ProposalAuditTimeline
            key={`${proposal.id}-${proposal.status}-${proposal.updatedAt}`}
            proposalId={proposal.id}
          />
        </div>
      )}
    </div>
  );
};
