'use client';

import React, { useState, useEffect, useCallback } from 'react';
import type {
  ProductCandidate,
  ProductSearchResult,
  StoredPurchaseProposal,
  PolicyDecision,
  AuditEvent,
} from '@agentpay/contracts';
import { defaultApiClient, ApiError } from '../lib/api/client';
import { ProductSearchForm } from '../components/catalog/ProductSearchForm';
import { CandidateList } from '../components/catalog/CandidateList';
import { PriceChangeModal, type PriceChangeDetails } from '../components/catalog/PriceChangeModal';
import { ProposalList } from '../components/proposals/ProposalList';
import { ProposalDetail } from '../components/proposals/ProposalDetail';
import { DecisionDialog } from '../components/proposals/DecisionDialog';
import { Alert } from '../components/ui/Alert';

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

export default function HomePage() {
  // Navigation Section State (default simulator for foundation tests, tabs provide clean Phase 3C navigation)
  const [activeTab, setActiveTab] = useState<'catalog' | 'proposals' | 'simulator'>('simulator');

  // Principal Switcher State (Development Identity Simulation)
  const [currentPrincipal, setCurrentPrincipal] = useState<string>('dev-user-principal-01');

  // Platform & Foundation Status
  const [platformStatus, setPlatformStatus] = useState<PlatformStatus | null>(null);
  const [healthStatus, setHealthStatus] = useState<ServiceStatus | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);

  // Phase 3C Catalog Search State
  const [searchResult, setSearchResult] = useState<ProductSearchResult | null>(null);
  const [searchLoading, setSearchLoading] = useState<boolean>(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Phase 3C Price Change Reconfirmation State
  const [priceChangeModalOpen, setPriceChangeModalOpen] = useState<boolean>(false);
  const [pendingSelection, setPendingSelection] = useState<{
    candidate: ProductCandidate;
    quantity: number;
  } | null>(null);
  const [priceChangeDetails, setPriceChangeDetails] = useState<PriceChangeDetails | null>(null);
  const [priceChangeSubmitting, setPriceChangeSubmitting] = useState<boolean>(false);

  // Phase 3C Proposals & Authorization State
  const [proposals, setProposals] = useState<StoredPurchaseProposal[]>([]);
  const [proposalsLoading, setProposalsLoading] = useState<boolean>(false);
  const [selectedProposal, setSelectedProposal] = useState<StoredPurchaseProposal | null>(null);
  const [proposalActionInProgress, setProposalActionInProgress] = useState<boolean>(false);
  const [feedbackMessage, setFeedbackMessage] = useState<{
    type: 'success' | 'warning' | 'error' | 'info';
    message: string;
  } | null>(null);

  // Decision Dialog State
  const [decisionModal, setDecisionModal] = useState<{
    isOpen: boolean;
    type: 'approve' | 'reject';
    proposal: StoredPurchaseProposal | null;
  }>({
    isOpen: false,
    type: 'approve',
    proposal: null,
  });

  // Foundation Simulator State (Preserved for baseline tests & E2E)
  const [intentInput, setIntentInput] = useState('Provision micro cloud node for CI');
  const [submittingSimulator, setSubmittingSimulator] = useState(false);
  const [activeSimulatorProposal, setActiveSimulatorProposal] = useState<StoredPurchaseProposal | null>(null);
  const [activeSimulatorDecision, setActiveSimulatorDecision] = useState<PolicyDecision | null>(null);
  const [activeOrder, setActiveOrder] = useState<{
    id: string;
    status: string;
    currency: string;
    amountMinor: number;
    approvalUrl?: string;
    captureId?: string;
  } | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [captureResult, setCaptureResult] = useState<string | null>(null);
  const [paymentResult, setPaymentResult] = useState<string | null>(null);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);

  // 1. Fetch Global Status and Audit Events
  const fetchStatus = useCallback(async () => {
    try {
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
    }
  }, []);

  // 2. Fetch Proposals for Current Principal
  const fetchProposals = useCallback(async () => {
    try {
      setProposalsLoading(true);
      const list = await defaultApiClient.listProposals();
      setProposals(list);
      // Auto-select latest proposal if none is selected
      if (list.length > 0 && !selectedProposal) {
        setSelectedProposal(list[0]!);
      }
    } catch (err) {
      // Do not pollute global gateway connectivity alert on proposal errors
      console.warn('Proposals fetch notice:', err);
    } finally {
      setProposalsLoading(false);
    }
  }, [selectedProposal]);

  useEffect(() => {
    fetchStatus();
    fetchProposals();
  }, [fetchStatus, fetchProposals]);

  // Handle Principal Switch
  const handlePrincipalChange = (newPrincipal: string) => {
    setCurrentPrincipal(newPrincipal);
    defaultApiClient.setPrincipalId(newPrincipal);
    setSelectedProposal(null);
    setProposals([]);
    fetchProposals();
  };

  // Phase 3C: Product Search
  const handleProductSearch = async (query: string, merchantPreference?: string) => {
    try {
      setSearchLoading(true);
      setSearchError(null);
      setSearchResult(null);

      const result = await defaultApiClient.searchProducts(query, merchantPreference);
      setSearchResult(result);
    } catch (err) {
      if (err instanceof ApiError) {
        setSearchError(err.message);
      } else {
        setSearchError('Product discovery search failed. API Gateway or Catalog Provider unavailable.');
      }
    } finally {
      setSearchLoading(false);
    }
  };

  // Phase 3C: Create Purchase Proposal from Selected Candidate
  const handleCreateProposal = async (
    candidate: ProductCandidate,
    quantity: number,
    reconfirmPriceMinor?: number,
  ) => {
    try {
      setProposalActionInProgress(true);
      setFeedbackMessage(null);

      const response = await defaultApiClient.createPurchaseIntent({
        rawIntent: `Buy ${quantity} of ${candidate.title}`,
        selectedCandidate: {
          providerId: candidate.providerId,
          providerProductId: candidate.providerProductId,
          expectedUnitPriceMinor: reconfirmPriceMinor ?? candidate.unitPriceMinor,
          expectedCurrency: candidate.currency,
          quantity,
        },
      });

      if (response.outcome === 'PROPOSAL_CREATED' || response.outcome === 'POLICY_REVIEW_REQUIRED') {
        setSelectedProposal(response.proposal);
        setFeedbackMessage({
          type: response.outcome === 'PROPOSAL_CREATED' ? 'success' : 'warning',
          message: `${response.message} (Proposal ID: ${response.proposal.id})`,
        });
        await fetchProposals();
        setActiveTab('proposals');
      } else if (response.outcome === 'SELECTION_REQUIRED') {
        setFeedbackMessage({
          type: 'warning',
          message: response.reason,
        });
      }
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.statusCode === 409 || err.code === 'PRICE_CHANGED') {
          // Trigger explicit price change reconfirmation modal
          setPendingSelection({ candidate, quantity });
          setPriceChangeDetails({
            previousPriceMinor: err.previousPriceMinor ?? candidate.unitPriceMinor,
            currentPriceMinor: err.currentPriceMinor,
            currency: err.currency ?? candidate.currency,
            message: err.message,
          });
          setPriceChangeModalOpen(true);
          return;
        }

        if (err.statusCode === 422 || err.code === 'OUT_OF_STOCK') {
          setFeedbackMessage({
            type: 'error',
            message: `Out of Stock: ${err.message}`,
          });
          return;
        }

        setFeedbackMessage({
          type: 'error',
          message: `Proposal Creation Failed (${err.code}): ${err.message}`,
        });
      } else {
        setFeedbackMessage({
          type: 'error',
          message: err instanceof Error ? err.message : 'Unknown proposal creation error',
        });
      }
    } finally {
      setProposalActionInProgress(false);
    }
  };

  // Confirm Price Change Reconfirmation
  const handleConfirmPriceChange = async () => {
    if (!pendingSelection || !priceChangeDetails?.currentPriceMinor) return;

    try {
      setPriceChangeSubmitting(true);
      await handleCreateProposal(
        pendingSelection.candidate,
        pendingSelection.quantity,
        priceChangeDetails.currentPriceMinor,
      );
      setPriceChangeModalOpen(false);
      setPendingSelection(null);
      setPriceChangeDetails(null);
    } finally {
      setPriceChangeSubmitting(false);
    }
  };

  // Phase 3C: Human Authorization & Decision Flow
  const handleConfirmDecision = async (reasonOrNote?: string) => {
    if (!decisionModal.proposal) return;

    try {
      setProposalActionInProgress(true);
      const isApprove = decisionModal.type === 'approve';

      if (isApprove) {
        const res = await defaultApiClient.approveProposal(decisionModal.proposal.id, reasonOrNote);
        setSelectedProposal(res.proposal);
        setFeedbackMessage({
          type: 'success',
          message: `✓ Proposal ${res.proposal.id} successfully authorized! Verifiable audit event logged.`,
        });
      } else {
        const res = await defaultApiClient.rejectProposal(decisionModal.proposal.id, reasonOrNote);
        setSelectedProposal(res.proposal);
        setFeedbackMessage({
          type: 'warning',
          message: `✕ Proposal ${res.proposal.id} rejected. Rejection reason logged to audit repository.`,
        });
      }

      await fetchProposals();
      await fetchStatus();
      setDecisionModal({ isOpen: false, type: 'approve', proposal: null });
    } catch (err) {
      if (err instanceof ApiError) {
        setFeedbackMessage({
          type: 'error',
          message: `Decision rejected by backend (${err.code}): ${err.message}`,
        });
      } else {
        setFeedbackMessage({
          type: 'error',
          message: err instanceof Error ? err.message : 'Decision execution failed',
        });
      }
    } finally {
      setProposalActionInProgress(false);
    }
  };

  // Foundation Simulator Handler (Preserved for baseline backward compatibility)
  const handleSimulateIntent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!intentInput.trim()) return;

    try {
      setSubmittingSimulator(true);
      setActiveSimulatorProposal(null);
      setActiveSimulatorDecision(null);
      setActiveOrder(null);
      setCaptureResult(null);
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

      const proposal = await propRes.json();
      setActiveSimulatorProposal(proposal);

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
      setActiveSimulatorDecision(decision);

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
        setActiveOrder(orderData);
        setPaymentResult(
          `Order Created: ${orderData.id} (Status: ${orderData.status}) — ${orderData.approvalUrl ? 'Buyer Approval Required' : 'Order Ready'}`,
        );
      }

      // Refresh status & audit trail
      await fetchStatus();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Simulator error';
      setPaymentResult(`Simulation Error: ${message}`);
    } finally {
      setSubmittingSimulator(false);
    }
  };

  const handleCaptureOrder = async () => {
    if (!activeOrder || !activeSimulatorDecision) return;
    try {
      setCapturing(true);
      setCaptureResult(null);

      const res = await fetch(`/api/payments/orders/${activeOrder.id}/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policyDecisionId: activeSimulatorDecision.decisionId }),
      });

      const data = await res.json();
      if (!res.ok) {
        setCaptureResult(`Capture Failed: ${data.error?.code ?? 'ERROR'} — ${data.error?.message}`);
      } else {
        setCaptureResult(
          `Capture Succeeded: ID ${data.captureId ?? data.id} (Status: ${data.status})`,
        );
        setActiveOrder((prev) =>
          prev ? { ...prev, status: data.status, captureId: data.captureId } : null,
        );
      }

      await fetchStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Capture error';
      setCaptureResult(`Capture Error: ${msg}`);
    } finally {
      setCapturing(false);
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

        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          {/* Principal Identity Switcher (Dev Mode) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <label
              htmlFor="principal-switcher-select"
              style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase' }}
            >
              Principal:
            </label>
            <select
              id="principal-switcher-select"
              data-testid="principal-switcher-select"
              value={currentPrincipal}
              onChange={(e) => handlePrincipalChange(e.target.value)}
              style={{
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid var(--card-border)',
                borderRadius: '8px',
                color: 'var(--text-main)',
                padding: '0.35rem 0.65rem',
                fontSize: '0.8rem',
                fontFamily: 'var(--font-mono)',
                outline: 'none',
              }}
            >
              <option value="dev-user-principal-01">dev-user-principal-01 (Default)</option>
              <option value="dev-user-principal-02">dev-user-principal-02 (Bob)</option>
              <option value="user-principal-A">user-principal-A (Alice)</option>
              <option value="user-principal-B">user-principal-B (Bob)</option>
            </select>
          </div>

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
        <div className="warning-icon">
          {platformStatus?.providerStatus?.isMock === false ? 'ℹ️' : '⚠️'}
        </div>
        <div className="warning-text">
          <h4>
            Provider Status:{' '}
            {platformStatus?.providerStatus?.statusLabel ??
              'Sandbox not configured (Mock Provider Active)'}{' '}
            [MOCK/DEVELOPMENT]
          </h4>
          <p>
            {platformStatus?.providerStatus?.warning ??
              'AgentPay is running in engineering foundation mode. The payment service operates behind a MOCK/DEVELOPMENT provider and real payment capture is disabled by default. PayPal Sandbox OAuth credentials and live execution will be verified in a subsequent milestone.'}
          </p>
        </div>
      </div>

      {/* Main Feature Tabs */}
      <div
        data-testid="dashboard-tab-bar"
        style={{
          display: 'flex',
          gap: '0.75rem',
          margin: '1.5rem 0 2rem 0',
          borderBottom: '1px solid var(--card-border)',
          paddingBottom: '0.75rem',
          flexWrap: 'wrap',
        }}
      >
        <button
          type="button"
          data-testid="tab-catalog"
          onClick={() => setActiveTab('catalog')}
          style={{
            background: activeTab === 'catalog' ? 'rgba(0, 112, 243, 0.2)' : 'transparent',
            border: activeTab === 'catalog' ? '1px solid var(--accent-blue)' : '1px solid transparent',
            color: activeTab === 'catalog' ? 'var(--accent-cyan)' : 'var(--text-muted)',
            borderRadius: '10px',
            padding: '0.6rem 1.25rem',
            fontSize: '0.9rem',
            fontWeight: 700,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
          }}
        >
          🔍 Product Search &amp; Discovery
        </button>

        <button
          type="button"
          data-testid="tab-proposals"
          onClick={() => {
            setActiveTab('proposals');
            fetchProposals();
          }}
          style={{
            background: activeTab === 'proposals' ? 'rgba(0, 112, 243, 0.2)' : 'transparent',
            border: activeTab === 'proposals' ? '1px solid var(--accent-blue)' : '1px solid transparent',
            color: activeTab === 'proposals' ? 'var(--accent-cyan)' : 'var(--text-muted)',
            borderRadius: '10px',
            padding: '0.6rem 1.25rem',
            fontSize: '0.9rem',
            fontWeight: 700,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
          }}
        >
          📋 Authorization Dashboard ({proposals.length})
        </button>

        <button
          type="button"
          data-testid="tab-simulator"
          onClick={() => setActiveTab('simulator')}
          style={{
            background: activeTab === 'simulator' ? 'rgba(0, 112, 243, 0.2)' : 'transparent',
            border: activeTab === 'simulator' ? '1px solid var(--accent-blue)' : '1px solid transparent',
            color: activeTab === 'simulator' ? 'var(--accent-cyan)' : 'var(--text-muted)',
            borderRadius: '10px',
            padding: '0.6rem 1.25rem',
            fontSize: '0.9rem',
            fontWeight: 700,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
          }}
        >
          ⚡ Foundation Simulator
        </button>
      </div>

      {/* Global Action Feedback Alert */}
      {feedbackMessage && (
        <div data-testid="proposal-created-alert">
          <Alert
            type={feedbackMessage.type}
            title={
              feedbackMessage.type === 'success'
                ? 'Success'
                : feedbackMessage.type === 'error'
                  ? 'Error'
                  : 'Notice'
            }
            testId="feedback-alert"
          >
            {feedbackMessage.message}
          </Alert>
        </div>
      )}

      {/* TAB 1: PRODUCT SEARCH & CANDIDATE DISAMBIGUATION */}
      {activeTab === 'catalog' && (
        <section data-testid="catalog-search-section">
          <div className="glass-panel">
            <h2 className="section-title" style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>
              External Product Discovery &amp; Candidate Disambiguation
            </h2>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1.25rem' }}>
              Search across external catalog providers. If multiple candidate items match your query,
              AgentPay strictly requires explicit human selection before creating a verifiable proposal.
            </p>

            <ProductSearchForm onSearch={handleProductSearch} loading={searchLoading} />

            {searchError && (
              <Alert type="error" title="Search Failure" testId="search-error-alert">
                {searchError}
              </Alert>
            )}

            {searchResult && (
              <CandidateList
                candidates={searchResult.candidates}
                status={searchResult.status}
                query={searchResult.query}
                onCreateProposal={handleCreateProposal}
                submitting={proposalActionInProgress}
              />
            )}
          </div>
        </section>
      )}

      {/* TAB 2: HUMAN-IN-THE-LOOP AUTHORIZATION DASHBOARD */}
      {activeTab === 'proposals' && (
        <section data-testid="proposals-dashboard-section">
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: selectedProposal ? '1fr 1.3fr' : '1fr',
              gap: '1.5rem',
              alignItems: 'start',
            }}
          >
            {/* Proposals List Card */}
            <div className="glass-panel">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '1rem',
                }}
              >
                <h2 className="section-title" style={{ margin: 0, fontSize: '1.15rem' }}>
                  Purchase Proposals for &ldquo;{currentPrincipal}&rdquo;
                </h2>
                <button
                  type="button"
                  onClick={fetchProposals}
                  style={{
                    background: 'transparent',
                    border: '1px solid var(--card-border)',
                    color: 'var(--text-muted)',
                    borderRadius: '6px',
                    padding: '0.25rem 0.6rem',
                    fontSize: '0.75rem',
                    cursor: 'pointer',
                  }}
                >
                  Refresh
                </button>
              </div>

              <ProposalList
                proposals={proposals}
                selectedProposalId={selectedProposal?.id}
                onSelectProposal={(p) => setSelectedProposal(p)}
                loading={proposalsLoading}
              />
            </div>

            {/* Selected Proposal Inspection & Authorization Review */}
            {selectedProposal && (
              <div>
                <ProposalDetail
                  proposal={selectedProposal}
                  onApproveClick={(p) => setDecisionModal({ isOpen: true, type: 'approve', proposal: p })}
                  onRejectClick={(p) => setDecisionModal({ isOpen: true, type: 'reject', proposal: p })}
                  actionInProgress={proposalActionInProgress}
                />
              </div>
            )}
          </div>
        </section>
      )}

      {/* TAB 3: FOUNDATION SIMULATOR (Preserved for baseline automated tests) */}
      <section
        data-testid="foundation-simulator-section"
        style={{ display: activeTab === 'simulator' ? 'block' : 'none' }}
      >
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
              <span
                className={`badge ${platformStatus?.providerStatus?.isMock === false ? 'badge-info' : 'badge-warning'}`}
              >
                {platformStatus?.providerStatus?.isMock === false ? 'PayPal Sandbox' : 'Mock Only'}
              </span>
            </div>
            <span className="service-port">PORT 4003</span>
            <p className="service-desc">
              {platformStatus?.providerStatus?.isMock === false
                ? 'PayPal Orders v2 Sandbox provider active with server-side policy and idempotency controls.'
                : 'PaymentProvider abstraction with Mock adapter. Real captures disabled until PayPal verification.'}
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
                  disabled={submittingSimulator}
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
                disabled={submittingSimulator || !intentInput.trim()}
              >
                {submittingSimulator ? 'Evaluating...' : 'Run Autonomous Evaluation'}
              </button>
            </form>

            {/* Proposal & Decision Inspection */}
            {activeSimulatorProposal && (
              <div style={{ marginTop: '1.5rem' }}>
                <h3 style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: '0.5rem' }}>
                  Generated Purchase Proposal
                </h3>
                <pre className="code-block">
                  {JSON.stringify(activeSimulatorProposal, null, 2)}
                </pre>
              </div>
            )}

            {activeSimulatorDecision && (
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
                      activeSimulatorDecision.outcome === 'ALLOW'
                        ? 'badge-success'
                        : activeSimulatorDecision.outcome === 'DENY'
                          ? 'badge-danger'
                          : 'badge-warning'
                    }`}
                  >
                    {activeSimulatorDecision.outcome}
                  </span>
                </div>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                  <strong>Reason:</strong> {activeSimulatorDecision.reasonMessage} (
                  {activeSimulatorDecision.reasonCode})
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

            {activeOrder && (
              <div
                style={{
                  marginTop: '1.25rem',
                  padding: '1rem',
                  borderRadius: '8px',
                  background: 'rgba(255, 255, 255, 0.04)',
                  border: '1px solid var(--card-border)',
                }}
                data-testid="order-lifecycle-card"
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '0.75rem',
                  }}
                >
                  <h4 style={{ fontSize: '0.9rem', fontWeight: 600, margin: 0 }}>
                    Order Lifecycle Management
                  </h4>
                  <span className="badge badge-warning" data-testid="order-status-badge">
                    {activeOrder.status}
                  </span>
                </div>
                <p
                  style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}
                >
                  Order ID: <code style={{ fontFamily: 'var(--font-mono)' }}>{activeOrder.id}</code>
                </p>

                <div
                  style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}
                >
                  {activeOrder.approvalUrl && (
                    <a
                      href={activeOrder.approvalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="button-secondary"
                      data-testid="paypal-approval-link"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.35rem',
                        padding: '0.5rem 1rem',
                        borderRadius: '6px',
                        textDecoration: 'none',
                        fontSize: '0.825rem',
                        fontWeight: 600,
                      }}
                    >
                      Approve in PayPal Sandbox ↗
                    </a>
                  )}

                  <button
                    type="button"
                    onClick={handleCaptureOrder}
                    disabled={capturing || activeOrder.status === 'COMPLETED'}
                    className="button-primary"
                    data-testid="capture-order-button"
                    style={{
                      padding: '0.5rem 1rem',
                      fontSize: '0.825rem',
                    }}
                  >
                    {capturing
                      ? 'Capturing...'
                      : activeOrder.status === 'COMPLETED'
                        ? 'Already Captured'
                        : 'Capture Approved Order'}
                  </button>
                </div>

                {captureResult && (
                  <div
                    style={{
                      marginTop: '0.75rem',
                      padding: '0.5rem 0.75rem',
                      borderRadius: '6px',
                      fontSize: '0.8rem',
                      fontFamily: 'var(--font-mono)',
                      background: captureResult.startsWith('Capture Succeeded')
                        ? 'rgba(34, 197, 94, 0.1)'
                        : 'rgba(239, 68, 68, 0.1)',
                      border: captureResult.startsWith('Capture Succeeded')
                        ? '1px solid rgba(34, 197, 94, 0.3)'
                        : '1px solid rgba(239, 68, 68, 0.3)',
                      color: captureResult.startsWith('Capture Succeeded') ? '#4ade80' : '#f87171',
                    }}
                    data-testid="capture-result"
                  >
                    {captureResult}
                  </div>
                )}
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
                type="button"
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
            <p
              style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}
            >
              Append-only audit trail persisted to PostgreSQL with correlation IDs and automated
              credential redaction.
            </p>

            <div className="audit-list">
              {auditEvents.length === 0 ? (
                <p style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>
                  No audit events recorded yet.
                </p>
              ) : (
                auditEvents.map((event) => (
                  <div key={event.id} className="audit-item" data-testid="audit-event-item">
                    <div className="audit-item-header">
                      <span className="audit-event-type">{event.eventType}</span>
                      <span className="audit-timestamp">
                        {new Date(event.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="audit-meta">
                      Actor: <strong>{event.actor}</strong> | Correlation:{' '}
                      <span style={{ fontFamily: 'var(--font-mono)' }}>
                        {event.correlationId.slice(0, 8)}...
                      </span>
                    </div>
                    {event.outcome && (
                      <div className="audit-meta" style={{ marginTop: '0.2rem' }}>
                        Outcome: <span className="badge badge-info">{event.outcome}</span>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Explicit Price Change Reconfirmation Modal */}
      <PriceChangeModal
        isOpen={priceChangeModalOpen}
        details={priceChangeDetails}
        onConfirm={handleConfirmPriceChange}
        onCancel={() => {
          setPriceChangeModalOpen(false);
          setPendingSelection(null);
          setPriceChangeDetails(null);
        }}
        submitting={priceChangeSubmitting}
      />

      {/* Decision Confirmation Modal (Approval / Rejection) */}
      <DecisionDialog
        isOpen={decisionModal.isOpen}
        type={decisionModal.type}
        proposal={decisionModal.proposal}
        onConfirm={handleConfirmDecision}
        onClose={() => setDecisionModal({ isOpen: false, type: 'approve', proposal: null })}
        submitting={proposalActionInProgress}
      />
    </div>
  );
}
