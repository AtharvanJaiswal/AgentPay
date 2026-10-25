import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Database Migrations Verification', () => {
  const migrationsDir = path.resolve(__dirname, '../../db/migrations');

  it('migrations directory contains ordered sql files', () => {
    expect(fs.existsSync(migrationsDir)).toBe(true);
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]).toBe('001_create_audit_events.sql');
  });

  it('001_create_audit_events.sql defines schema_migrations, audit_events table and required indexes', () => {
    const sql = fs.readFileSync(path.join(migrationsDir, '001_create_audit_events.sql'), 'utf-8');

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS schema_migrations');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS audit_events');
    expect(sql).toContain('id UUID PRIMARY KEY');
    expect(sql).toContain('correlation_id VARCHAR(128) NOT NULL');
    expect(sql).toContain('event_type VARCHAR(64) NOT NULL');
    expect(sql).toContain('idx_audit_events_correlation_id');
    expect(sql).toContain('idx_audit_events_timestamp');
    expect(sql).toContain('TIMESTAMPTZ');
  });

  it('002_create_payment_orders.sql defines payment_orders and webhook_events tables and indexes', () => {
    const sql = fs.readFileSync(path.join(migrationsDir, '002_create_payment_orders.sql'), 'utf-8');

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS payment_orders');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS webhook_events');
    expect(sql).toContain('id VARCHAR(128) PRIMARY KEY');
    expect(sql).toContain('proposal_id UUID NOT NULL');
    expect(sql).toContain('policy_decision_id UUID NOT NULL');
    expect(sql).toContain('idempotency_key VARCHAR(128) UNIQUE');
    expect(sql).toContain('idx_payment_orders_proposal');
    expect(sql).toContain('idx_payment_orders_status');
    expect(sql).toContain('idx_webhook_events_resource_id');
  });

  it('003_add_reconciliation_columns.sql defines last_reconciled_at and reconciliation_status columns', () => {
    const sql = fs.readFileSync(
      path.join(migrationsDir, '003_add_reconciliation_columns.sql'),
      'utf-8',
    );

    expect(sql).toContain('ALTER TABLE payment_orders');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS reconciliation_status VARCHAR(32)');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_payment_orders_reconciliation');
  });

  it('004_create_purchase_proposals.sql defines purchase_proposals table with idempotency scope constraint and indexes', () => {
    const sql = fs.readFileSync(
      path.join(migrationsDir, '004_create_purchase_proposals.sql'),
      'utf-8',
    );

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS purchase_proposals');
    expect(sql).toContain('id UUID PRIMARY KEY');
    expect(sql).toContain('request_id VARCHAR(128) NOT NULL');
    expect(sql).toContain('idempotency_key VARCHAR(128) NOT NULL');
    expect(sql).toContain('idempotency_scope VARCHAR(128) NOT NULL');
    expect(sql).toContain('request_hash VARCHAR(64) NOT NULL');
    expect(sql).toContain('status VARCHAR(32) NOT NULL');
    expect(sql).toContain('product_query TEXT NOT NULL');
    expect(sql).toContain('quantity INT NOT NULL');
    expect(sql).toContain('currency VARCHAR(3) NOT NULL');
    expect(sql).toContain('total_amount_minor BIGINT');
    expect(sql).toContain(
      'CONSTRAINT uq_purchase_proposals_idempotency_scope UNIQUE (idempotency_scope, idempotency_key)',
    );
    expect(sql).toContain('idx_purchase_proposals_status');
    expect(sql).toContain('idx_purchase_proposals_principal');
    expect(sql).toContain('idx_purchase_proposals_correlation_id');
  });
});
