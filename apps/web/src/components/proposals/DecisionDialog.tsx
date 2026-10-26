import React, { useState } from 'react';
import type { StoredPurchaseProposal } from '@agentpay/contracts';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { formatCurrency } from '../../lib/formatting/currency';

export interface DecisionDialogProps {
  isOpen: boolean;
  type: 'approve' | 'reject';
  proposal: StoredPurchaseProposal | null;
  onConfirm: (reasonOrNote?: string) => Promise<void>;
  onClose: () => void;
  submitting: boolean;
}

export const DecisionDialog: React.FC<DecisionDialogProps> = ({
  isOpen,
  type,
  proposal,
  onConfirm,
  onClose,
  submitting,
}) => {
  const [inputVal, setInputVal] = useState('');

  if (!proposal) return null;

  const isApprove = type === 'approve';
  const title = isApprove ? 'Authorize Purchase Proposal' : 'Reject Purchase Proposal';
  const totalFormatted = formatCurrency(proposal.totalAmountMinor, proposal.currency);

  const handleAction = async () => {
    await onConfirm(inputVal.trim() || undefined);
    setInputVal('');
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} testId="decision-dialog-modal">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <div
          style={{
            background: 'rgba(255, 255, 255, 0.03)',
            border: '1px solid var(--card-border)',
            borderRadius: '12px',
            padding: '1rem',
          }}
        >
          <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: '0.25rem' }}>
            Proposal: <strong style={{ color: 'var(--text-muted)' }}>{proposal.id}</strong>
          </div>
          <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-main)' }}>
            {proposal.productName || proposal.productQuery}
          </div>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
            Merchant: <strong>{proposal.merchantName || 'External Catalog'}</strong> | Quantity: <strong>{proposal.quantity}</strong>
          </div>
          <div style={{ marginTop: '0.6rem', display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-dim)' }}>Authoritative Total:</span>
            <span
              data-testid="decision-dialog-total"
              style={{
                fontSize: '1.35rem',
                fontWeight: 800,
                color: isApprove ? 'var(--accent-emerald)' : 'var(--accent-rose)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {totalFormatted}
            </span>
          </div>
        </div>

        {isApprove ? (
          <div>
            <div
              style={{
                background: 'rgba(16, 185, 129, 0.08)',
                border: '1px solid rgba(16, 185, 129, 0.3)',
                borderRadius: '8px',
                padding: '0.75rem 1rem',
                fontSize: '0.825rem',
                color: '#34d399',
                marginBottom: '1rem',
              }}
            >
              <strong>Security Invariant:</strong> Confirming human authorization records your decision in the
              durable database and audit log. It does <em>not</em> execute payment or capture funds.
            </div>

            <label
              htmlFor="approval-note-input"
              style={{
                display: 'block',
                fontSize: '0.85rem',
                fontWeight: 600,
                color: 'var(--text-muted)',
                marginBottom: '0.35rem',
              }}
            >
              Authorization Note (Optional)
            </label>
            <input
              id="approval-note-input"
              data-testid="decision-note-input"
              type="text"
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
              placeholder="e.g. Approved per Q4 infrastructure budget allocation"
              disabled={submitting}
              style={{
                width: '100%',
                padding: '0.75rem 1rem',
                background: 'rgba(255, 255, 255, 0.04)',
                border: '1px solid var(--card-border)',
                borderRadius: '10px',
                color: 'var(--text-main)',
                fontSize: '0.9rem',
                fontFamily: 'inherit',
              }}
            />
          </div>
        ) : (
          <div>
            <label
              htmlFor="rejection-reason-input"
              style={{
                display: 'block',
                fontSize: '0.85rem',
                fontWeight: 600,
                color: 'var(--text-muted)',
                marginBottom: '0.35rem',
              }}
            >
              Rejection Reason (Optional)
            </label>
            <input
              id="rejection-reason-input"
              data-testid="decision-note-input"
              type="text"
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
              placeholder="e.g. Budget exceeded, duplicated purchase, or non-compliant item"
              disabled={submitting}
              style={{
                width: '100%',
                padding: '0.75rem 1rem',
                background: 'rgba(255, 255, 255, 0.04)',
                border: '1px solid var(--card-border)',
                borderRadius: '10px',
                color: 'var(--text-main)',
                fontSize: '0.9rem',
                fontFamily: 'inherit',
              }}
            />
          </div>
        )}

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '0.75rem',
            borderTop: '1px solid var(--card-border)',
            paddingTop: '1rem',
          }}
        >
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            disabled={submitting}
            testId="cancel-decision-dialog-btn"
          >
            Cancel
          </Button>

          <Button
            type="button"
            variant={isApprove ? 'success' : 'danger'}
            loading={submitting}
            onClick={handleAction}
            testId="confirm-decision-btn"
          >
            {isApprove ? 'Confirm Authorization' : 'Confirm Rejection'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
