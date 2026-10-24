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
});
