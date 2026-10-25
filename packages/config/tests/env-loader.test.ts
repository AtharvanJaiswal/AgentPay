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
    expect(config.APP_BASE_URL).toBe('http://localhost:3000');
    expect(config.PAYMENTS_ENABLED).toBe(false);
  });

  describe('Payment Provider Configuration & Security Invariants', () => {
    it('defaults PAYMENT_PROVIDER to mock and PAYMENTS_ENABLED to false', () => {
      const config = getPaymentServiceConfig({
        NODE_ENV: 'test',
      });
      expect(config.PAYMENT_PROVIDER).toBe('mock');
      expect(config.PAYMENTS_ENABLED).toBe(false);
      expect(config.APP_BASE_URL).toBe('http://localhost:3000');
    });

    it('rejects paypal_sandbox provider when PAYPAL_CLIENT_ID is missing', () => {
      expect(() =>
        getPaymentServiceConfig({
          NODE_ENV: 'test',
          PAYMENT_PROVIDER: 'paypal_sandbox',
          PAYPAL_CLIENT_SECRET: 'mock_secret',
        }),
      ).toThrowError(/PAYPAL_CLIENT_ID is required/);
    });

    it('rejects paypal_sandbox provider when PAYPAL_CLIENT_SECRET is missing', () => {
      expect(() =>
        getPaymentServiceConfig({
          NODE_ENV: 'test',
          PAYMENT_PROVIDER: 'paypal_sandbox',
          PAYPAL_CLIENT_ID: 'mock_id',
        }),
      ).toThrowError(/PAYPAL_CLIENT_SECRET is required/);
    });

    it('strictly forbids live environment and live endpoints in Phase 1B', () => {
      expect(() =>
        getPaymentServiceConfig({
          NODE_ENV: 'test',
          PAYMENT_PROVIDER: 'paypal_sandbox',
          PAYPAL_CLIENT_ID: 'mock_id',
          PAYPAL_CLIENT_SECRET: 'mock_secret',
          PAYPAL_ENVIRONMENT: 'live',
        }),
      ).toThrowError(/PayPal Live environment is forbidden/);

      expect(() =>
        getPaymentServiceConfig({
          NODE_ENV: 'test',
          PAYMENT_PROVIDER: 'paypal_sandbox',
          PAYPAL_CLIENT_ID: 'mock_id',
          PAYPAL_CLIENT_SECRET: 'mock_secret',
          PAYPAL_API_BASE_URL: 'https://api-m.paypal.com',
        }),
      ).toThrowError(/PayPal Live endpoints are forbidden/);
    });

    it('accepts valid paypal_sandbox configuration with safe defaults', () => {
      const config = getPaymentServiceConfig({
        NODE_ENV: 'test',
        PAYMENT_PROVIDER: 'paypal_sandbox',
        PAYPAL_CLIENT_ID: 'mock_client_id_123',
        PAYPAL_CLIENT_SECRET: 'mock_client_secret_456',
        APP_BASE_URL: 'http://localhost:3000',
      });

      expect(config.PAYMENT_PROVIDER).toBe('paypal_sandbox');
      expect(config.PAYPAL_ENVIRONMENT).toBe('sandbox');
      expect(config.PAYPAL_API_BASE_URL).toBe('https://api-m.sandbox.paypal.com');
      expect(config.PAYMENTS_ENABLED).toBe(false);
      expect(config.APP_BASE_URL).toBe('http://localhost:3000');
    });
  });
});
