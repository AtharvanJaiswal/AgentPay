import React from 'react';
import type { ProductCandidate } from '@agentpay/contracts';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { formatCurrency } from '../../lib/formatting/currency';

export interface CandidateCardProps {
  candidate: ProductCandidate;
  isSelected: boolean;
  onSelect: (candidate: ProductCandidate) => void;
  disabled?: boolean;
}

export const CandidateCard: React.FC<CandidateCardProps> = ({
  candidate,
  isSelected,
  onSelect,
  disabled = false,
}) => {
  const isOutOfStock = candidate.availability === 'OUT_OF_STOCK';

  return (
    <div
      data-testid={`candidate-card-${candidate.providerProductId}`}
      style={{
        background: isSelected
          ? 'linear-gradient(180deg, rgba(0, 112, 243, 0.15) 0%, rgba(15, 22, 35, 0.8) 100%)'
          : 'var(--card-bg)',
        border: isSelected
          ? '2px solid var(--accent-cyan)'
          : '1px solid var(--card-border)',
        borderRadius: '14px',
        padding: '1.25rem',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        gap: '1rem',
        transition: 'all 0.2s ease',
        boxShadow: isSelected ? '0 0 20px rgba(0, 229, 255, 0.2)' : 'none',
      }}
    >
      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: '0.5rem',
            marginBottom: '0.5rem',
          }}
        >
          <span
            style={{
              fontSize: '0.75rem',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: 'var(--accent-cyan)',
            }}
          >
            {candidate.merchantName}
          </span>
          <div style={{ display: 'flex', gap: '0.35rem' }}>
            <Badge status={candidate.availability} testId="candidate-availability-badge" />
          </div>
        </div>

        <h3
          style={{
            fontSize: '1.05rem',
            fontWeight: 700,
            color: 'var(--text-main)',
            lineHeight: 1.4,
            marginBottom: '0.5rem',
          }}
          title={candidate.title}
        >
          {candidate.title}
        </h3>

        {candidate.description && (
          <p
            style={{
              fontSize: '0.8rem',
              color: 'var(--text-muted)',
              lineHeight: 1.4,
              marginBottom: '0.75rem',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {candidate.description}
          </p>
        )}
      </div>

      <div
        style={{
          borderTop: '1px solid var(--card-border)',
          paddingTop: '0.85rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '0.5rem',
        }}
      >
        <div>
          <div
            style={{
              fontSize: '0.7rem',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              color: 'var(--text-dim)',
            }}
          >
            Authoritative Unit Price
          </div>
          <div
            data-testid="candidate-price"
            style={{
              fontSize: '1.25rem',
              fontWeight: 800,
              color: 'var(--text-main)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {formatCurrency(candidate.unitPriceMinor, candidate.currency)}
          </div>
        </div>

        <Button
          type="button"
          variant={isSelected ? 'success' : 'secondary'}
          disabled={disabled || isOutOfStock}
          onClick={() => onSelect(candidate)}
          testId={`candidate-select-btn-${candidate.providerProductId}`}
          style={{ padding: '0.5rem 1rem', fontSize: '0.8rem' }}
        >
          {isSelected ? 'Selected ✓' : isOutOfStock ? 'Out of Stock' : 'Select Product'}
        </Button>
      </div>
    </div>
  );
};
