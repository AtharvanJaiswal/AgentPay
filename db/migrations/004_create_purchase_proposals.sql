-- Migration 004: Create Purchase Proposals Table with Idempotency Scope
-- AgentPay Phase 3A: Purchase Intent, Policy Evaluation, and Proposal Durability

CREATE TABLE IF NOT EXISTS purchase_proposals (
    id UUID PRIMARY KEY,
    request_id VARCHAR(128) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    idempotency_scope VARCHAR(128) NOT NULL DEFAULT 'default',
    request_hash VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL,
    product_query TEXT NOT NULL,
    product_id VARCHAR(128),
    product_name TEXT,
    merchant_id VARCHAR(128),
    merchant_name VARCHAR(255),
    merchant_category VARCHAR(64),
    quantity INT NOT NULL DEFAULT 1,
    currency VARCHAR(3) NOT NULL,
    unit_price_minor BIGINT,
    subtotal_minor BIGINT,
    tax_minor BIGINT DEFAULT 0,
    shipping_minor BIGINT DEFAULT 0,
    total_amount_minor BIGINT,
    policy_decision_id UUID,
    policy_outcome VARCHAR(32),
    policy_reason_code VARCHAR(128),
    principal_id VARCHAR(128),
    correlation_id VARCHAR(128) NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    CONSTRAINT uq_purchase_proposals_idempotency_scope UNIQUE (idempotency_scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_purchase_proposals_status ON purchase_proposals (status);
CREATE INDEX IF NOT EXISTS idx_purchase_proposals_principal ON purchase_proposals (principal_id);
CREATE INDEX IF NOT EXISTS idx_purchase_proposals_correlation_id ON purchase_proposals (correlation_id);
CREATE INDEX IF NOT EXISTS idx_purchase_proposals_created_at ON purchase_proposals (created_at DESC);
