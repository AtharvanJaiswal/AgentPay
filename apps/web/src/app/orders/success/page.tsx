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
  approvalUrl?: string;
  captureId?: string;
}

function OrderSuccessContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const payerId = searchParams.get('PayerID');

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
          setError(`Backend responded with HTTP ${res.status} while verifying order status.`);
        }
        return;
      }

      const data = (await res.json()) as OrderDetails;
      setOrder(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to connect to payment service';
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

  const formatAmount = (amountMinor: number, currency: string) => {
    const value = (amountMinor / 100).toFixed(2);
    return `${currency} ${value}`;
  };

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

      <div className="glass-panel" data-testid="orders-success-panel">
        <div
          style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.25rem' }}
        >
          <div
            style={{
              width: '12px',
              height: '12px',
              borderRadius: '50%',
              backgroundColor:
                order?.status === 'COMPLETED' ? 'var(--accent-emerald)' : 'var(--accent-cyan)',
              boxShadow: '0 0 12px rgba(0, 229, 255, 0.5)',
            }}
          />
          <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>PayPal Checkout Return</h2>
        </div>

        {!token ? (
          <div
            data-testid="missing-token-alert"
            style={{
              padding: '1rem',
              borderRadius: '8px',
              backgroundColor: 'rgba(244, 63, 94, 0.1)',
              border: '1px solid var(--accent-rose)',
              color: 'var(--text-main)',
              marginBottom: '1.5rem',
            }}
          >
            <strong>Missing Order Token:</strong> No PayPal order token was provided in the URL
            query string.
          </div>
        ) : !sanitizedToken ? (
          <div
            data-testid="invalid-token-alert"
            style={{
              padding: '1rem',
              borderRadius: '8px',
              backgroundColor: 'rgba(244, 63, 94, 0.1)',
              border: '1px solid var(--accent-rose)',
              color: 'var(--text-main)',
              marginBottom: '1.5rem',
            }}
          >
            <strong>Invalid Order Token Format:</strong> The provided token contains invalid
            characters.
          </div>
        ) : null}

        {sanitizedToken && (
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

              {payerId && (
                <>
                  <span style={{ color: 'var(--text-muted)' }}>Payer ID:</span>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{payerId}</span>
                </>
              )}

              <span style={{ color: 'var(--text-muted)' }}>Authoritative State:</span>
              <span>
                {loading ? (
                  <span style={{ color: 'var(--accent-cyan)' }}>Querying payment service...</span>
                ) : order ? (
                  <span
                    className="badge"
                    data-testid="order-status-badge"
                    style={{
                      backgroundColor:
                        order.status === 'COMPLETED'
                          ? 'rgba(16, 185, 129, 0.2)'
                          : order.status === 'APPROVED'
                            ? 'rgba(0, 229, 255, 0.2)'
                            : 'rgba(245, 166, 35, 0.2)',
                      color:
                        order.status === 'COMPLETED'
                          ? 'var(--accent-emerald)'
                          : order.status === 'APPROVED'
                            ? 'var(--accent-cyan)'
                            : 'var(--accent-amber)',
                      fontWeight: 700,
                    }}
                  >
                    {order.status}
                  </span>
                ) : (
                  <span style={{ color: 'var(--accent-rose)' }}>Unverified</span>
                )}
              </span>

              {order && (
                <>
                  <span style={{ color: 'var(--text-muted)' }}>Order Amount:</span>
                  <span>{formatAmount(order.amountMinor, order.currency)}</span>

                  <span style={{ color: 'var(--text-muted)' }}>Provider:</span>
                  <span style={{ textTransform: 'uppercase' }}>{order.provider}</span>

                  {order.captureId && (
                    <>
                      <span style={{ color: 'var(--text-muted)' }}>Capture ID:</span>
                      <span
                        style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-emerald)' }}
                      >
                        {order.captureId}
                      </span>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* Security & Verification Disclaimer */}
        <div
          data-testid="security-notice"
          style={{
            padding: '1rem',
            borderRadius: '8px',
            backgroundColor: 'rgba(0, 112, 243, 0.08)',
            border: '1px solid rgba(0, 112, 243, 0.25)',
            fontSize: '0.85rem',
            lineHeight: 1.5,
            color: 'var(--text-muted)',
            marginBottom: '1.5rem',
          }}
        >
          <strong style={{ color: 'var(--accent-cyan)' }}>Security Boundary Notice:</strong>{' '}
          Returning to this page confirms that the PayPal session has returned to AgentPay.
          Crucially, visiting this URL <em>never triggers payment capture automatically</em>. Final
          capture execution requires server-side policy verification and explicit authorization by
          the payment service.
        </div>

        {error && (
          <div
            data-testid="verification-error-alert"
            style={{
              padding: '1rem',
              borderRadius: '8px',
              backgroundColor: 'rgba(244, 63, 94, 0.1)',
              border: '1px solid var(--accent-rose)',
              fontSize: '0.85rem',
              color: 'var(--text-main)',
              marginBottom: '1.5rem',
            }}
          >
            <strong>Verification Note:</strong> {error}
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
              Check Authoritative State
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function OrderSuccessPage() {
  return (
    <Suspense
      fallback={
        <div
          className="container"
          style={{ maxWidth: '800px', paddingTop: '4rem', textAlign: 'center' }}
        >
          <p style={{ color: 'var(--text-muted)' }}>Loading order verification...</p>
        </div>
      }
    >
      <OrderSuccessContent />
    </Suspense>
  );
}
