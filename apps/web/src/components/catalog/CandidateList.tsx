import React, { useState } from 'react';
import type { ProductCandidate, ProductSearchResultStatus } from '@agentpay/contracts';
import { CandidateCard } from './CandidateCard';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { formatCurrency, calculateLineTotalMinor } from '../../lib/formatting/currency';

export interface CandidateListProps {
  candidates: ProductCandidate[];
  status?: ProductSearchResultStatus;
  query: string;
  onCreateProposal: (candidate: ProductCandidate, quantity: number) => Promise<void>;
  submitting: boolean;
}

export const CandidateList: React.FC<CandidateListProps> = ({
  candidates,
  status,
  query,
  onCreateProposal,
  submitting,
}) => {
  const [selectedCandidate, setSelectedCandidate] = useState<ProductCandidate | null>(null);
  const [quantity, setQuantity] = useState<number>(1);

  if (candidates.length === 0) {
    return (
      <div data-testid="empty-candidates-notice" style={{ textAlign: 'center', padding: '2rem 1rem' }}>
        <p style={{ color: 'var(--text-muted)' }}>
          No matching products found for &ldquo;{query}&rdquo;. Try refining your search query.
        </p>
      </div>
    );
  }

  const isSelectionRequired = status === 'SELECTION_REQUIRED' || candidates.length > 1;

  const calculatedTotalMinor = selectedCandidate
    ? calculateLineTotalMinor(selectedCandidate.unitPriceMinor, quantity)
    : 0;

  return (
    <div data-testid="candidate-list" style={{ marginTop: '1.5rem' }}>
      {isSelectionRequired && (
        <Alert
          type="warning"
          title="Explicit Selection Required"
          testId="candidate-selection-prompt"
        >
          Found {candidates.length} candidate options matching &ldquo;{query}&rdquo;. AgentPay requires an
          explicit human choice before creating a durable purchase proposal. Auto-selection is disabled.
        </Alert>
      )}

      <div
        data-testid="candidates-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: '1.25rem',
          margin: '1.25rem 0',
        }}
      >
        {candidates.map((candidate) => (
          <CandidateCard
            key={candidate.dedupeKey || candidate.providerProductId}
            candidate={candidate}
            isSelected={selectedCandidate?.providerProductId === candidate.providerProductId}
            onSelect={(c) => setSelectedCandidate(c)}
            disabled={submitting}
          />
        ))}
      </div>

      {/* Explicit Confirmation Action Bar */}
      {!selectedCandidate ? (
        <div
          data-testid="proposal-action-panel"
          style={{
            marginTop: '1.5rem',
            padding: '1.25rem',
            borderRadius: '12px',
            background: 'rgba(255, 255, 255, 0.02)',
            border: '1px dashed var(--card-border)',
            textAlign: 'center',
            color: 'var(--text-muted)',
            fontSize: '0.875rem',
          }}
        >
          Select a candidate above to review details and generate an authorization proposal.
        </div>
      ) : (
        <div
          data-testid="proposal-action-panel"
          className="glass-panel"
          style={{
            marginTop: '1.5rem',
            border: '2px solid var(--accent-blue)',
            borderRadius: '16px',
            padding: '1.25rem 1.5rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '1.25rem',
            background: 'linear-gradient(90deg, rgba(0, 112, 243, 0.12), rgba(15, 22, 35, 0.9))',
          }}
        >
          <div style={{ flex: '1 1 300px' }}>
            <span
              style={{
                fontSize: '0.75rem',
                textTransform: 'uppercase',
                fontWeight: 700,
                color: 'var(--accent-cyan)',
                letterSpacing: '0.04em',
              }}
            >
              Selected Choice for Authorization Proposal
            </span>
            <div style={{ fontWeight: 700, fontSize: '1.05rem', color: 'var(--text-main)', marginTop: '0.2rem' }}>
              {selectedCandidate.title}
            </div>
            <div style={{ fontSize: '0.825rem', color: 'var(--text-muted)' }}>
              Merchant: <strong>{selectedCandidate.merchantName}</strong> | Unit:{' '}
              {formatCurrency(selectedCandidate.unitPriceMinor, selectedCandidate.currency)}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', flexWrap: 'wrap' }}>
            <div>
              <label
                htmlFor="candidate-quantity-input"
                style={{
                  display: 'block',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  color: 'var(--text-dim)',
                  marginBottom: '0.2rem',
                }}
              >
                Quantity
              </label>
              <input
                id="candidate-quantity-input"
                data-testid="candidate-quantity-input"
                type="number"
                min="1"
                max="100"
                value={quantity}
                disabled={submitting}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  setQuantity(Number.isInteger(val) && val > 0 ? Math.min(val, 100) : 1);
                }}
                style={{
                  width: '70px',
                  padding: '0.4rem 0.6rem',
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid var(--card-border)',
                  borderRadius: '8px',
                  color: 'var(--text-main)',
                  fontWeight: 700,
                  textAlign: 'center',
                }}
              />
            </div>

            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>Estimated Total</div>
              <div
                data-testid="selected-candidate-total"
                style={{
                  fontSize: '1.35rem',
                  fontWeight: 800,
                  color: 'var(--accent-cyan)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {formatCurrency(calculatedTotalMinor, selectedCandidate.currency)}
              </div>
            </div>

            <Button
              type="button"
              variant="primary"
              loading={submitting}
              onClick={() => onCreateProposal(selectedCandidate, quantity)}
              testId="create-proposal-btn"
              style={{ padding: '0.75rem 1.5rem', minHeight: '46px' }}
            >
              Create Proposal & Review Policy
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
