'use client';

import React, { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

interface OrderDetails {
  id: string;
  status: string;
  currency: string;
  amountMinor: number;
  provider: string;
  isMock: boolean;
  captureId?: string;
}

function OrderCancelledContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const [loading, setLoading] = useState<boolean>(true);
  const [order, setOrder] = useState<OrderDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sanitizedToken = token && /^[A-Za-z0-9_-]{1,64}$/.test(token) ? token : null;

  const verifyOrderState = async (orderId: string) => {
    try {
      setLoading(true);
      setError(null);

      const res = await fetch(`/api/payments/orders/${encodeURIComponent(orderId)}`, {
        cache: 'no-store',
      });

      if (!res.ok) {
        if (res.status === 404) {
          setError(`Order ${orderId} was not found in the payment service repository.`);
        } else {
          setError(`Backend responded with HTTP ${res.status} while checking order status.`);
        }
        return;
      }

      const data = (await res.json()) as OrderDetails;
      setOrder(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to query payment service';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (sanitizedToken) {
      verifyOrderState(sanitizedToken);
    } else {
      setLoading(false);
    }
  }, [sanitizedToken]);

  return (
    <div className="container" style={{ maxWidth: '800px', paddingTop: '4rem' }}>
      <header className="header" style={{ borderBottom: 'none', paddingBottom: '1rem' }}>
        <div className="brand-wrapper">
          <div className="brand-icon">AP</div>
          <div>
            <h1 className="brand-title" style={{ fontSize: '1.5rem' }}>
              AgentPay Checkout
            </h1>
            <p className="brand-subtitle" style={{ fontSize: '0.85rem' }}>
              Verifiable Payment Authorization & Audit Platform
            </p>
          </div>
        </div>
      </header>

      <div className="glass-panel" data-testid="orders-cancelled-panel">
        <div
          style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.25rem' }}
        >
          <div
            style={{
              width: '12px',
              height: '12px',
              borderRadius: '50%',
              backgroundColor: 'var(--accent-amber)',
              boxShadow: '0 0 12px rgba(245, 166, 35, 0.5)',
            }}
          />
          <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>
            PayPal Checkout Session Cancelled
          </h2>
        </div>

        <div
          data-testid="cancellation-summary-alert"
          style={{
            padding: '1rem',
            borderRadius: '8px',
            backgroundColor: 'rgba(245, 166, 35, 0.1)',
            border: '1px solid var(--accent-amber)',
            color: 'var(--text-main)',
            marginBottom: '1.5rem',
            fontSize: '0.9rem',
            lineHeight: 1.5,
          }}
        >
          {order?.status === 'COMPLETED' ? (
            <span>
              <strong>Note:</strong> Authoritative backend records indicate this order was already
              captured before the browser cancelled. No double charge occurred.
            </span>
          ) : (
            <span>
              <strong>Checkout Cancelled:</strong> The buyer cancelled or abandoned the checkout
              session at PayPal. No funds have been captured, and the payment authorization remains
              unapproved.
            </span>
          )}
        </div>

        {sanitizedToken ? (
          <div style={{ marginBottom: '1.5rem' }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '140px 1fr',
                gap: '0.5rem',
                fontSize: '0.9rem',
              }}
            >
              <span style={{ color: 'var(--text-muted)' }}>PayPal Order ID:</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                {sanitizedToken}
              </span>

              <span style={{ color: 'var(--text-muted)' }}>Backend State:</span>
              <span>
                {loading ? (
                  <span style={{ color: 'var(--accent-cyan)' }}>
                    Checking authoritative state...
                  </span>
                ) : order ? (
                  <span
                    className="badge"
                    data-testid="order-status-badge"
                    style={{
                      backgroundColor:
                        order.status === 'COMPLETED'
                          ? 'rgba(16, 185, 129, 0.2)'
                          : 'rgba(245, 166, 35, 0.2)',
                      color:
                        order.status === 'COMPLETED'
                          ? 'var(--accent-emerald)'
                          : 'var(--accent-amber)',
                      fontWeight: 700,
                    }}
                  >
                    {order.status}
                  </span>
                ) : (
                  <span style={{ color: 'var(--text-muted)' }}>
                    Unverified / Cancelled at Checkout
                  </span>
                )}
              </span>

              {order && (
                <>
                  <span style={{ color: 'var(--text-muted)' }}>Amount:</span>
                  <span>
                    {order.currency} {(order.amountMinor / 100).toFixed(2)}
                  </span>
                </>
              )}
            </div>
          </div>
        ) : (
          <div
            data-testid="no-token-notice"
            style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1.5rem' }}
          >
            No order token was provided in the return query string.
          </div>
        )}

        {error && (
          <div
            data-testid="verification-error-alert"
            style={{
              padding: '0.75rem 1rem',
              borderRadius: '8px',
              backgroundColor: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid var(--card-border)',
              fontSize: '0.85rem',
              color: 'var(--text-dim)',
              marginBottom: '1.5rem',
            }}
          >
            Status lookup detail: {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
          <Link
            href="/"
            className="btn"
            data-testid="return-home-btn"
            style={{
              padding: '0.75rem 1.5rem',
              borderRadius: '8px',
              backgroundColor: 'var(--accent-blue)',
              color: '#fff',
              textDecoration: 'none',
              fontWeight: 600,
              fontSize: '0.9rem',
              display: 'inline-block',
            }}
          >
            ← Return to AgentPay Dashboard
          </Link>

          {sanitizedToken && (
            <button
              type="button"
              onClick={() => verifyOrderState(sanitizedToken)}
              className="btn"
              data-testid="refresh-status-btn"
              style={{
                padding: '0.75rem 1.5rem',
                borderRadius: '8px',
                backgroundColor: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid var(--card-border)',
                color: 'var(--text-main)',
                fontWeight: 600,
                fontSize: '0.9rem',
                cursor: 'pointer',
              }}
            >
              Verify Status
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function OrderCancelledPage() {
  return (
    <Suspense
      fallback={
        <div
          className="container"
          style={{ maxWidth: '800px', paddingTop: '4rem', textAlign: 'center' }}
        >
          <p style={{ color: 'var(--text-muted)' }}>Loading cancellation status...</p>
        </div>
      }
    >
      <OrderCancelledContent />
    </Suspense>
  );
}
