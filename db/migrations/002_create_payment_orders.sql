-- Migration 002: Create Payment Orders and Webhook Events Tables
-- AgentPay Phase 1B: PayPal Sandbox Order Lifecycle

CREATE TABLE IF NOT EXISTS payment_orders (
    id VARCHAR(128) PRIMARY KEY,
    proposal_id UUID NOT NULL,
    policy_decision_id UUID NOT NULL,
    provider VARCHAR(32) NOT NULL,
    status VARCHAR(32) NOT NULL,
    currency VARCHAR(3) NOT NULL,
    amount_minor BIGINT NOT NULL,
    approval_url TEXT,
    capture_id VARCHAR(128),
    captured_at TIMESTAMPTZ,
    idempotency_key VARCHAR(128) UNIQUE,
    request_hash VARCHAR(64),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
);

CREATE INDEX IF NOT EXISTS idx_payment_orders_proposal ON payment_orders (proposal_id);
CREATE INDEX IF NOT EXISTS idx_payment_orders_status ON payment_orders (status);
CREATE INDEX IF NOT EXISTS idx_payment_orders_created_at ON payment_orders (created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_events (
    id VARCHAR(128) PRIMARY KEY,
    event_type VARCHAR(64) NOT NULL,
    resource_id VARCHAR(128) NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_resource_id ON webhook_events (resource_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_event_type ON webhook_events (event_type);
