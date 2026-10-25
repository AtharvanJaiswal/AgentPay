-- Migration 003: Add Reconciliation Tracking Columns
-- AgentPay Phase 2: Durable Payment Lifecycle, Webhook Integrity & Reconciliation

ALTER TABLE payment_orders
    ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reconciliation_status VARCHAR(32);

CREATE INDEX IF NOT EXISTS idx_payment_orders_reconciliation
    ON payment_orders (reconciliation_status, last_reconciled_at);
