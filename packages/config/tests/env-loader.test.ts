import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { findRepositoryRoot, loadRootEnv, getPaymentServiceConfig } from '../src/index.js';

describe('Repository Root Discovery & Environment Loader', () => {
  const currentFileDir = dirname(fileURLToPath(import.meta.url));

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('finds the monorepo root directory containing pnpm-workspace.yaml', () => {
    const root = findRepositoryRoot(currentFileDir);
    expect(existsSync(join(root, 'pnpm-workspace.yaml'))).toBe(true);
    expect(existsSync(join(root, 'package.json'))).toBe(true);
  });

  it('finds the root from deeply nested mock paths', () => {
    const deeplyNestedPath = join(currentFileDir, 'a', 'b', 'c', 'd');
    const root = findRepositoryRoot(deeplyNestedPath);
    expect(existsSync(join(root, 'pnpm-workspace.yaml'))).toBe(true);
  });

  it('preserves existing process.env variables (override=false precedence)', () => {
    const testVarKey = 'AGENTPAY_TEST_PRECEDENCE_VAR';
    process.env[testVarKey] = 'EXPLICIT_PROCESS_VAL';

    try {
      loadRootEnv({ startDir: currentFileDir, override: false });
      expect(process.env[testVarKey]).toBe('EXPLICIT_PROCESS_VAL');
    } finally {
      delete process.env[testVarKey];
    }
  });

  it('normalizes empty strings in environment to undefined and applies defaults', () => {
    const config = getPaymentServiceConfig({
      NODE_ENV: 'test',
      PAYMENT_PROVIDER: 'mock',
      PAYPAL_CLIENT_ID: '',
      PAYPAL_CLIENT_SECRET: '',
      PAYPAL_ENVIRONMENT: '',
      PAYPAL_API_BASE_URL: '',
    });

    expect(config.PAYPAL_ENVIRONMENT).toBe('sandbox');
    expect(config.PAYPAL_API_BASE_URL).toBe('https://api-m.sandbox.paypal.com');
    expect(config.PAYPAL_CLIENT_ID).toBeUndefined();
    expect(config.PAYPAL_CLIENT_SECRET).toBeUndefined();
  });
});
