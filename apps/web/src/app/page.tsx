'use client';

import React, { useState, useEffect } from 'react';

interface ServiceStatus {
  status: string;
  service: string;
  version: string;
  uptimeSeconds?: number;
  details?: Record<string, unknown>;
}

interface PlatformStatus {
  platform: string;
  version: string;
  providerStatus: {
    activeProvider: string;
    isMock: boolean;
    paypalSandboxConfigured: boolean;
    statusLabel: string;
    paymentsEnabled: boolean;
    warning: string;
  };
}

interface ProposalItem {
  name: string;
  quantity: number;
  unitPriceMinor: number;
  currency: string;
}

interface PurchaseProposal {
  id: string;
  intentId: string;
  agentId: string;
  merchant: {
    id: string;
    name: string;
    category: string;
  };
  items: ProposalItem[];
  totalAmountMinor: number;
  currency: string;
  purpose: string;
  createdAt: string;
}

interface PolicyDecision {
  decisionId: string;
  proposalId: string;
  outcome: 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';
  reasonCode: string;
  reasonMessage: string;
  policyVersion: string;
  decisionTimestamp: string;
}

interface AuditEvent {
  id: string;
  correlationId: string;
  eventType: string;
  actor: string;
  resourceId: string;
  timestamp: string;
  outcome?: string;
  reasonCode?: string;
  metadata: Record<string, unknown>;
}

export default function HomePage() {
  const [platformStatus, setPlatformStatus] = useState<PlatformStatus | null>(null);
  const [healthStatus, setHealthStatus] = useState<ServiceStatus | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  // Proposal Simulator State
  const [intentInput, setIntentInput] = useState('Provision micro cloud node for CI');
  const [submitting, setSubmitting] = useState(false);
  const [activeProposal, setActiveProposal] = useState<PurchaseProposal | null>(null);
  const [activeDecision, setActiveDecision] = useState<PolicyDecision | null>(null);
  const [paymentResult, setPaymentResult] = useState<string | null>(null);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);

  const fetchStatus = async () => {
    try {
      setLoading(true);
      setApiError(null);

      // Status check
      const statusRes = await fetch('/api/status');
      if (!statusRes.ok) throw new Error(`Gateway returned status ${statusRes.status}`);
      const statusData = await statusRes.json();
      setPlatformStatus(statusData);

      // Health check
      const healthRes = await fetch('/api/health');
      if (!healthRes.ok) throw new Error(`Health check returned status ${healthRes.status}`);
      const healthData = await healthRes.json();
      setHealthStatus(healthData);

      // Audit trail
      const auditRes = await fetch('/api/audit-events?limit=10');
      if (auditRes.ok) {
        const events = await auditRes.json();
        setAuditEvents(events);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'API Gateway currently unreachable';
      setApiError(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  const handleSimulateIntent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!intentInput.trim()) return;

    try {
      setSubmitting(true);
      setActiveProposal(null);
      setActiveDecision(null);
      setPaymentResult(null);

      // 1. Propose
      const propRes = await fetch('/api/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawIntent: intentInput, agentId: 'autonomous-agent-ui-01' }),
      });

      if (!propRes.ok) {
        const errJson = await propRes.json();
        throw new Error(errJson.error?.message ?? 'Failed to parse proposal');
      }

      const proposal: PurchaseProposal = await propRes.json();
      setActiveProposal(proposal);

      // 2. Evaluate Policy
      const evalRes = await fetch('/api/evaluations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(proposal),
      });

      if (!evalRes.ok) {
        const errJson = await evalRes.json();
        throw new Error(errJson.error?.message ?? 'Policy evaluation failed');
      }

      const decision: PolicyDecision = await evalRes.json();
      setActiveDecision(decision);

      // 3. Attempt Payment Order
      const payRes = await fetch('/api/payments/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposal, policyDecisionId: decision.decisionId }),
      });

      if (!payRes.ok) {
        const payErr = await payRes.json();
        setPaymentResult(
          `Payment Execution Blocked: ${payErr.error?.code ?? 'ERROR'} — ${payErr.error?.message}`,
        );
      } else {
        const orderData = await payRes.json();
        setPaymentResult(
          `Mock Order Created: ${orderData.id} (Status: ${orderData.status}) — MOCK/DEVELOPMENT Provider`,
        );
      }

      // Refresh Audit Trail
      const auditRes = await fetch('/api/audit-events?limit=10');
      if (auditRes.ok) {
        const events = await auditRes.json();
        setAuditEvents(events);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Simulator error';
      setPaymentResult(`Simulation Error: ${message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="container">
      {/* Header */}
      <header className="header">
        <div className="brand-wrapper" data-testid="agentpay-branding">
          <div className="brand-icon">AP</div>
          <div>
            <h1 className="brand-title">AgentPay</h1>
            <p className="brand-tagline">
              AI proposes. Policy enforces. PayPal executes. The audit trail proves what happened.
            </p>
          </div>
        </div>

        <div>
          <span className="badge badge-warning" data-testid="provider-status-badge">
            {platformStatus?.providerStatus?.activeProvider ?? 'MOCK/DEVELOPMENT'}
          </span>
        </div>
      </header>

      {/* Controlled Error Alert if API Gateway is unavailable */}
      {apiError && (
        <div className="error-alert" data-testid="api-error-alert" role="alert">
          <strong>API Gateway Connectivity Notice:</strong> {apiError}. Demonstrating controlled
          error state.
        </div>
      )}

      {/* Explicit Sandbox Warning Banner */}
      <div className="warning-banner" data-testid="sandbox-warning-banner">
        <div className="warning-icon">⚠️</div>
        <div className="warning-text">
          <h4>Provider Status: Sandbox not configured</h4>
          <p>
            AgentPay is running in engineering foundation mode. The payment service operates behind
            a <strong>MOCK/DEVELOPMENT</strong> provider and real payment capture is disabled by
            default. PayPal Sandbox OAuth credentials and live execution will be verified in a
            subsequent milestone.
          </p>
        </div>
      </div>

      {/* Microservices Status Grid */}
      <div className="services-grid">
        <div className="glass-panel service-card" data-testid="api-health-status">
          <div className="service-header">
            <span className="service-name">API Gateway</span>
            <span
              className={`badge ${healthStatus?.status === 'ok' ? 'badge-success' : 'badge-warning'}`}
            >
              {healthStatus?.status ?? 'Connecting'}
            </span>
          </div>
          <span className="service-port">PORT 4000</span>
          <p className="service-desc">
            Single entry point, request rate limiting, correlation ID propagation & schema
            validation.
          </p>
        </div>

        <div className="glass-panel service-card">
          <div className="service-header">
            <span className="service-name">Agent Service</span>
            <span className="badge badge-info">Deterministic</span>
          </div>
          <span className="service-port">PORT 4001</span>
          <p className="service-desc">
            AIProvider abstraction with deterministic development fixtures. Authoritative catalog
            pricing.
          </p>
        </div>

        <div className="glass-panel service-card">
          <div className="service-header">
            <span className="service-name">Policy Service</span>
            <span className="badge badge-success">Enforcing</span>
          </div>
          <span className="service-port">PORT 4002</span>
          <p className="service-desc">
            Deterministic security boundary: spending ceilings, category restrictions, explicit
            approval rules.
          </p>
        </div>

        <div className="glass-panel service-card">
          <div className="service-header">
            <span className="service-name">Payment Service</span>
            <span className="badge badge-warning">Mock Only</span>
          </div>
          <span className="service-port">PORT 4003</span>
          <p className="service-desc">
            PaymentProvider abstraction with Mock adapter. Real captures disabled until PayPal
            verification.
          </p>
        </div>

        <div className="glass-panel service-card">
          <div className="service-header">
            <span className="service-name">Audit Service</span>
            <span className="badge badge-success">Relational</span>
          </div>
          <span className="service-port">PORT 4004</span>
          <p className="service-desc">
            PostgreSQL persistence with strict credential redaction and correlation ID traceability.
          </p>
        </div>
      </div>

      {/* Simulator Section */}
      <div className="simulator-layout">
        {/* Purchase Proposal Simulator Form */}
        <div className="glass-panel">
          <h2 className="section-title">Purchase Intent & Policy Simulator</h2>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1.25rem' }}>
            Simulate how autonomous agent intents are translated into verified proposals, evaluated
            against deterministic security policies, and logged to the audit repository.
          </p>

          <form onSubmit={handleSimulateIntent} data-testid="proposal-form">
            <div className="form-group">
              <label htmlFor="intentInput" className="form-label">
                Agent Intent String
              </label>
              <input
                id="intentInput"
                type="text"
                className="form-input"
                data-testid="proposal-input"
                value={intentInput}
                onChange={(e) => setIntentInput(e.target.value)}
                placeholder="e.g. Provision micro cloud node for CI"
                disabled={submitting}
              />
              <span
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--text-dim)',
                  marginTop: '0.25rem',
                  display: 'block',
                }}
              >
                Try: <em>micro cloud</em> ($15 ALLOW), <em>database cluster</em> ($800
                REQUIRE_APPROVAL), or <em>crypto tokens</em> (DENY).
              </span>
            </div>

            <button
              type="submit"
              className="button-primary"
              data-testid="proposal-submit"
              disabled={submitting || !intentInput.trim()}
            >
              {submitting ? 'Evaluating...' : 'Run Autonomous Evaluation'}
            </button>
          </form>

          {/* Proposal & Decision Inspection */}
          {activeProposal && (
            <div style={{ marginTop: '1.5rem' }}>
              <h3 style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: '0.5rem' }}>
                Generated Purchase Proposal
              </h3>
              <pre className="code-block">
                {JSON.stringify(
                  {
                    proposalId: activeProposal.id,
                    merchant: activeProposal.merchant.name,
                    category: activeProposal.merchant.category,
                    amount: `$${activeProposal.totalAmountMinor / 100}`,
                    currency: activeProposal.currency,
                    items: activeProposal.items,
                  },
                  null,
                  2,
                )}
              </pre>
            </div>
          )}

          {activeDecision && (
            <div style={{ marginTop: '1.25rem' }} data-testid="policy-decision-card">
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  marginBottom: '0.5rem',
                }}
              >
                <h3 style={{ fontSize: '0.95rem', fontWeight: 700 }}>Policy Decision:</h3>
                <span
                  className={`badge ${
                    activeDecision.outcome === 'ALLOW'
                      ? 'badge-success'
                      : activeDecision.outcome === 'DENY'
                        ? 'badge-danger'
                        : 'badge-warning'
                  }`}
                >
                  {activeDecision.outcome}
                </span>
              </div>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                <strong>Reason:</strong> {activeDecision.reasonMessage} ({activeDecision.reasonCode}
                )
              </p>
            </div>
          )}

          {paymentResult && (
            <div
              style={{
                marginTop: '1.25rem',
                padding: '0.75rem 1rem',
                borderRadius: '8px',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid var(--card-border)',
                fontSize: '0.825rem',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {paymentResult}
            </div>
          )}
        </div>

        {/* Live Audit Trail Viewer */}
        <div className="glass-panel">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '1rem',
            }}
          >
            <h2 className="section-title" style={{ margin: 0 }}>
              Live Audit Trail
            </h2>
            <button
              onClick={fetchStatus}
              style={{
                background: 'transparent',
                border: '1px solid var(--card-border)',
                color: 'var(--text-muted)',
                padding: '0.25rem 0.5rem',
                borderRadius: '6px',
                fontSize: '0.75rem',
                cursor: 'pointer',
              }}
            >
              Refresh
            </button>
          </div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
            Structured events persisted with correlation IDs. Secrets and sensitive authentication
            headers are strictly sanitized before storage.
          </p>

          <div className="audit-list" data-testid="audit-trail-list">
            {auditEvents.length === 0 ? (
              <p
                style={{
                  fontSize: '0.8rem',
                  color: 'var(--text-dim)',
                  textAlign: 'center',
                  padding: '2rem 0',
                }}
              >
                {loading ? 'Loading audit trail...' : 'No audit events recorded yet.'}
              </p>
            ) : (
              auditEvents.map((event) => (
                <div key={event.id} className="audit-item">
                  <div className="audit-meta">
                    <span className="audit-type">{event.eventType}</span>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      Actor: {event.actor} {event.reasonCode ? `• ${event.reasonCode}` : ''}
                    </span>
                    <span className="audit-time">
                      {new Date(event.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  {event.outcome && (
                    <span
                      className={`badge ${
                        event.outcome === 'ALLOW' ||
                        event.outcome === 'CREATED' ||
                        event.outcome === 'SUCCESS'
                          ? 'badge-success'
                          : event.outcome === 'DENY' || event.outcome === 'BLOCKED'
                            ? 'badge-danger'
                            : 'badge-warning'
                      }`}
                    >
                      {event.outcome}
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
