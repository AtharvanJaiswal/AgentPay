import React from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { formatCurrency } from '../../lib/formatting/currency';

export interface PriceChangeDetails {
  previousPriceMinor?: number;
  currentPriceMinor?: number;
  currency?: string;
  message?: string;
}

export interface PriceChangeModalProps {
  isOpen: boolean;
  details: PriceChangeDetails | null;
  onConfirm: () => void;
  onCancel: () => void;
  submitting?: boolean;
}

export const PriceChangeModal: React.FC<PriceChangeModalProps> = ({
  isOpen,
  details,
  onConfirm,
  onCancel,
  submitting = false,
}) => {
  if (!details) return null;

  const currency = details.currency || 'USD';
  const oldPriceFormatted = formatCurrency(details.previousPriceMinor, currency);
  const newPriceFormatted = formatCurrency(details.currentPriceMinor, currency);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title="Price Change Detected — Reconfirmation Required"
      testId="price-change-modal"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: 1.5 }}>
          During authoritative server-side candidate revalidation, the catalog provider reported that
          the item price has changed. AgentPay invariants prohibit silent price updates. You must explicitly
          review and reconfirm the new price.
        </p>

        <div
          data-testid="price-change-diff"
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '1rem',
            background: 'rgba(255, 255, 255, 0.03)',
            border: '1px solid var(--card-border)',
            borderRadius: '12px',
            padding: '1.25rem',
            textAlign: 'center',
          }}
        >
          <div>
            <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: '0.35rem' }}>
              Previous Quoted Price
            </div>
            <div
              data-testid="previous-price-display"
              style={{
                fontSize: '1.25rem',
                fontWeight: 700,
                color: 'var(--text-muted)',
                textDecoration: 'line-through',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {oldPriceFormatted}
            </div>
          </div>

          <div>
            <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', color: 'var(--accent-amber)', marginBottom: '0.35rem' }}>
              Current Revalidated Price
            </div>
            <div
              data-testid="current-price-display"
              style={{
                fontSize: '1.35rem',
                fontWeight: 800,
                color: '#fbbf24',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {newPriceFormatted}
            </div>
          </div>
        </div>

        {details.message && (
          <div style={{ fontSize: '0.825rem', color: 'var(--text-dim)', fontStyle: 'italic' }}>
            Provider notice: &ldquo;{details.message}&rdquo;
          </div>
        )}

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '0.75rem',
            borderTop: '1px solid var(--card-border)',
            paddingTop: '1rem',
            marginTop: '0.5rem',
          }}
        >
          <Button
            type="button"
            variant="secondary"
            onClick={onCancel}
            disabled={submitting}
            testId="price-change-dismiss-btn"
          >
            Cancel Selection
          </Button>

          <Button
            type="button"
            variant="primary"
            loading={submitting}
            onClick={onConfirm}
            testId="confirm-price-change-btn"
          >
            Accept New Price &amp; Continue
          </Button>
        </div>
      </div>
    </Modal>
  );
};
