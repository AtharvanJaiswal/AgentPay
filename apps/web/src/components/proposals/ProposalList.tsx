import React, { useState } from 'react';
import type { StoredPurchaseProposal, ProposalLifecycleStatus } from '@agentpay/contracts';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { formatCurrency } from '../../lib/formatting/currency';

export interface ProposalListProps {
  proposals: StoredPurchaseProposal[];
  selectedProposalId?: string;
  onSelectProposal: (proposal: StoredPurchaseProposal) => void;
  loading?: boolean;
}

const FILTER_STATUSES: { label: string; value?: ProposalLifecycleStatus }[] = [
  { label: 'All Proposals' },
  { label: 'Action Required', value: 'POLICY_REVIEW_REQUIRED' },
  { label: 'Ready for Review', value: 'READY_FOR_REVIEW' },
  { label: 'Approved', value: 'APPROVED' },
  { label: 'Rejected', value: 'CANCELLED' },
  { label: 'Policy Denied', value: 'POLICY_DENIED' },
];

export const ProposalList: React.FC<ProposalListProps> = ({
  proposals,
  selectedProposalId,
  onSelectProposal,
  loading = false,
}) => {
  const [activeFilter, setActiveFilter] = useState<ProposalLifecycleStatus | undefined>(undefined);

  const filteredProposals = activeFilter
    ? proposals.filter((p) => p.status === activeFilter)
    : proposals;

  return (
    <div data-testid="proposal-list">
      {/* Filter Tabs */}
      <div
        data-testid="proposal-status-filter-bar"
        style={{
          display: 'flex',
          gap: '0.5rem',
          flexWrap: 'wrap',
          marginBottom: '1.25rem',
          borderBottom: '1px solid var(--card-border)',
          paddingBottom: '0.75rem',
        }}
      >
        {FILTER_STATUSES.map((filter) => {
          const isActive = activeFilter === filter.value;
          return (
            <button
              key={filter.label}
              data-testid={`filter-btn-${filter.value || 'ALL'}`}
              type="button"
              onClick={() => setActiveFilter(filter.value)}
              style={{
                background: isActive ? 'rgba(0, 112, 243, 0.2)' : 'transparent',
                border: isActive ? '1px solid var(--accent-blue)' : '1px solid transparent',
                borderRadius: '8px',
                padding: '0.4rem 0.85rem',
                color: isActive ? 'var(--accent-cyan)' : 'var(--text-muted)',
                fontSize: '0.8rem',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
            >
              {filter.label}
            </button>
          );
        })}
      </div>

      {loading ? (
        <div data-testid="proposals-loading-state" style={{ color: 'var(--text-muted)', padding: '2rem 1rem', textAlign: 'center' }}>
          Loading purchase authorization proposals...
        </div>
      ) : filteredProposals.length === 0 ? (
        <div data-testid="proposals-empty-state" style={{ color: 'var(--text-dim)', padding: '2rem 1rem', textAlign: 'center' }}>
          No purchase proposals found under this filter.
        </div>
      ) : (
        <div
          data-testid="proposal-items-grid"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
          }}
        >
          {filteredProposals.map((prop) => {
            const isSelected = selectedProposalId === prop.id;
            return (
              <div
                key={prop.id}
                data-testid={`proposal-card-${prop.id}`}
                style={{
                  background: isSelected ? 'rgba(0, 112, 243, 0.12)' : 'var(--card-bg)',
                  border: isSelected ? '1px solid var(--accent-blue)' : '1px solid var(--card-border)',
                  borderRadius: '12px',
                  padding: '1rem 1.25rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: '1rem',
                  transition: 'all 0.2s ease',
                }}
              >
                <div style={{ flex: '1 1 260px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                    <Badge status={prop.status} testId={`proposal-badge-${prop.id}`} />
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
                      {prop.id.slice(0, 8)}...
                    </span>
                  </div>

                  <div style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-main)' }}>
                    {prop.productName || prop.productQuery}
                  </div>

                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    Merchant: {prop.merchantName || 'External Catalog'} | Qty: {prop.quantity}
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', textTransform: 'uppercase' }}>
                      Authoritative Total
                    </div>
                    <div
                      style={{
                        fontWeight: 800,
                        fontSize: '1.15rem',
                        color: 'var(--text-main)',
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      {formatCurrency(prop.totalAmountMinor, prop.currency)}
                    </div>
                  </div>

                  <Button
                    type="button"
                    variant={isSelected ? 'primary' : 'secondary'}
                    onClick={() => onSelectProposal(prop)}
                    testId={`inspect-proposal-btn-${prop.id}`}
                    style={{ fontSize: '0.8rem', padding: '0.5rem 0.9rem' }}
                  >
                    {isSelected ? 'Selected' : 'Review & Decide'}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
