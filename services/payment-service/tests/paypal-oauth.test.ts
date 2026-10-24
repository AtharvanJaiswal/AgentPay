import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PayPalOAuthClient, PayPalOAuthError } from '../src/paypal/oauth-client.js';
import { PayPalPaymentProvider } from '../src/paypal/provider.js';
import { buildApp } from '../src/app.js';
import { runPayPalAuthVerification } from '../src/cli/verify-paypal.js';
import { PaymentServiceConfigSchema } from '@agentpay/config';

describe('PayPal Sandbox OAuth Client & Provider', () => {
  const dummyClientId = 'MOCK_TEST_CLIENT_ID_12345';
  const dummyClientSecret = 'MOCK_TEST_CLIENT_SECRET_67890';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('Configuration Schema Validation', () => {
    it('accepts mock provider without PayPal credentials', () => {
      const parsed = PaymentServiceConfigSchema.safeParse({
        PAYMENT_PROVIDER: 'mock',
      });
      expect(parsed.success).toBe(true);
    });

    it('rejects paypal_sandbox provider if PAYPAL_CLIENT_ID is missing', () => {
      const parsed = PaymentServiceConfigSchema.safeParse({
        PAYMENT_PROVIDER: 'paypal_sandbox',
        PAYPAL_CLIENT_SECRET: dummyClientSecret,
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        const issues = parsed.error.issues;
        expect(issues.some((i) => i.path.includes('PAYPAL_CLIENT_ID'))).toBe(true);
      }
    });

    it('rejects paypal_sandbox provider if PAYPAL_CLIENT_SECRET is missing', () => {
      const parsed = PaymentServiceConfigSchema.safeParse({
        PAYMENT_PROVIDER: 'paypal_sandbox',
        PAYPAL_CLIENT_ID: dummyClientId,
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        const issues = parsed.error.issues;
        expect(issues.some((i) => i.path.includes('PAYPAL_CLIENT_SECRET'))).toBe(true);
      }
    });

    it('accepts paypal_sandbox provider when both credentials are provided', () => {
      const parsed = PaymentServiceConfigSchema.safeParse({
        PAYMENT_PROVIDER: 'paypal_sandbox',
        PAYPAL_CLIENT_ID: dummyClientId,
        PAYPAL_CLIENT_SECRET: dummyClientSecret,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.PAYPAL_ENVIRONMENT).toBe('sandbox');
        expect(parsed.data.PAYPAL_API_BASE_URL).toBe('https://api-m.sandbox.paypal.com');
      }
    });
  });

  describe('PayPalOAuthClient Unit Tests', () => {
    it('successfully authenticates, formats Basic auth header, and returns safe diagnostics', async () => {
      const mockTokenResponse = {
        scope: 'https://uri.paypal.com/services/invoicing',
        access_token: 'A21AAI_MOCK_TEST_ACCESS_TOKEN_XYZ',
        token_type: 'Bearer',
        app_id: 'APP-80W284485P519543T',
        expires_in: 32400,
        nonce: '2026-10-24T09:00:00Z',
      };

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockTokenResponse,
      });
      vi.stubGlobal('fetch', fetchMock);

      const client = new PayPalOAuthClient({
        clientId: dummyClientId,
        clientSecret: dummyClientSecret,
        environment: 'sandbox',
      });

      const verification = await client.verifyCredentials('corr-test-01');

      // Verify request arguments
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api-m.sandbox.paypal.com/v1/oauth2/token');
      expect(requestInit.method).toBe('POST');
      expect(requestInit.body).toBe('grant_type=client_credentials');

      // Verify Basic Auth header
      const headers = requestInit.headers as Record<string, string>;
      const expectedBasic = Buffer.from(`${dummyClientId}:${dummyClientSecret}`).toString('base64');
      expect(headers['Authorization']).toBe(`Basic ${expectedBasic}`);
      expect(headers['PayPal-Request-Id']).toBe('corr-test-01');

      // Verify returned diagnostic payload (CRITICAL: never returns raw access token)
      expect(verification.authenticated).toBe(true);
      expect(verification.tokenType).toBe('Bearer');
      expect(verification.expiresInSeconds).toBeGreaterThanOrEqual(32390);
      expect(verification.expiresInSeconds).toBeLessThanOrEqual(32400);
      expect(verification.environment).toBe('sandbox');
      expect(verification.appId).toBe('APP-80W284485P519543T');
      expect((verification as unknown as Record<string, unknown>)['access_token']).toBeUndefined();
    });

    it('reuses cached token on subsequent calls and avoids redundant network requests', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'MOCK_TOKEN_1',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const client = new PayPalOAuthClient({
        clientId: dummyClientId,
        clientSecret: dummyClientSecret,
      });

      await client.verifyCredentials();
      await client.verifyCredentials();
      await client.getAccessToken();

      // Only 1 network request should be made due to caching
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // After clearing cache, next call should hit network
      client.clearCache();
      await client.verifyCredentials();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('handles 401 Unauthorized cleanly and throws typed INVALID_CREDENTIALS error without logging secrets', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({
          error: 'invalid_client',
          error_description: 'Client Authentication failed',
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const client = new PayPalOAuthClient({
        clientId: dummyClientId,
        clientSecret: dummyClientSecret,
      });

      await expect(client.verifyCredentials()).rejects.toThrow(PayPalOAuthError);
      try {
        await client.verifyCredentials();
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(PayPalOAuthError);
        const oauthErr = err as PayPalOAuthError;
        expect(oauthErr.code).toBe('INVALID_CREDENTIALS');
        expect(oauthErr.statusCode).toBe(401);
        // Ensure secret and Authorization header are not printed in message
        expect(oauthErr.message).not.toContain(dummyClientSecret);
        expect(oauthErr.message).not.toContain('Basic ');
      }
    });

    it('handles 500 server errors gracefully and throws SERVER_ERROR', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({
          name: 'SERVICE_UNAVAILABLE',
          message: 'Internal PayPal service error',
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const client = new PayPalOAuthClient({
        clientId: dummyClientId,
        clientSecret: dummyClientSecret,
      });

      await expect(client.verifyCredentials()).rejects.toThrow(PayPalOAuthError);
      try {
        await client.verifyCredentials();
      } catch (err: unknown) {
        const oauthErr = err as PayPalOAuthError;
        expect(oauthErr.code).toBe('SERVER_ERROR');
        expect(oauthErr.statusCode).toBe(503);
      }
    });

    it('handles malformed non-JSON responses and throws MALFORMED_RESPONSE', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
      });
      vi.stubGlobal('fetch', fetchMock);

      const client = new PayPalOAuthClient({
        clientId: dummyClientId,
        clientSecret: dummyClientSecret,
      });

      await expect(client.verifyCredentials()).rejects.toThrow(PayPalOAuthError);
      try {
        await client.verifyCredentials();
      } catch (err: unknown) {
        const oauthErr = err as PayPalOAuthError;
        expect(oauthErr.code).toBe('MALFORMED_RESPONSE');
      }
    });

    it('handles response missing required access_token field and throws MALFORMED_RESPONSE', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          some_other_field: 'hello',
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const client = new PayPalOAuthClient({
        clientId: dummyClientId,
        clientSecret: dummyClientSecret,
      });

      await expect(client.verifyCredentials()).rejects.toThrow(PayPalOAuthError);
      try {
        await client.verifyCredentials();
      } catch (err: unknown) {
        const oauthErr = err as PayPalOAuthError;
        expect(oauthErr.code).toBe('MALFORMED_RESPONSE');
      }
    });

    it('handles request timeout and throws TIMEOUT error', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';

      const fetchMock = vi.fn().mockRejectedValue(abortError);
      vi.stubGlobal('fetch', fetchMock);

      const client = new PayPalOAuthClient({
        clientId: dummyClientId,
        clientSecret: dummyClientSecret,
        timeoutMs: 100,
      });

      await expect(client.verifyCredentials()).rejects.toThrow(PayPalOAuthError);
      try {
        await client.verifyCredentials();
      } catch (err: unknown) {
        const oauthErr = err as PayPalOAuthError;
        expect(oauthErr.code).toBe('TIMEOUT');
      }
    });
  });

  describe('PayPalPaymentProvider', () => {
    it('exposes correct provider metadata and delegates authentication', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'PROVIDER_TOKEN',
          token_type: 'Bearer',
          expires_in: 7200,
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const provider = new PayPalPaymentProvider({
        clientId: dummyClientId,
        clientSecret: dummyClientSecret,
      });

      expect(provider.providerName).toBe('PayPal Sandbox');
      expect(provider.isMock).toBe(false);

      const auth = await provider.verifyAuthentication();
      expect(auth.authenticated).toBe(true);
      expect(auth.expiresInSeconds).toBe(7200);
    });
  });

  describe('Fastify /paypal/verify-auth Route', () => {
    it('returns configured=false when credentials are not configured', async () => {
      const app = buildApp(undefined, {
        PAYPAL_CLIENT_ID: undefined,
        PAYPAL_CLIENT_SECRET: undefined,
      });
      const res = await app.inject({
        method: 'GET',
        url: '/paypal/verify-auth',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.authenticated).toBe(false);
      expect(body.configured).toBe(false);
      expect(body.message).toContain('not configured');
    });

    it('returns authenticated=true when credentials are valid in mocked environment', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'LIVE_MOCK_TOKEN',
          token_type: 'Bearer',
          expires_in: 32400,
          app_id: 'TEST_APP_ID',
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const provider = new PayPalPaymentProvider({
        clientId: dummyClientId,
        clientSecret: dummyClientSecret,
      });
      const app = buildApp(provider, {
        PAYPAL_CLIENT_ID: dummyClientId,
        PAYPAL_CLIENT_SECRET: dummyClientSecret,
        PAYPAL_ENVIRONMENT: 'sandbox',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/paypal/verify-auth',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.authenticated).toBe(true);
      expect(body.configured).toBe(true);
      expect(body.environment).toBe('sandbox');
      expect(body.tokenType).toBe('Bearer');
      expect(body.expiresInSeconds).toBeGreaterThanOrEqual(32390);
      expect(body.expiresInSeconds).toBeLessThanOrEqual(32400);
      expect(body.appId).toBe('TEST_APP_ID');
      // Ensure access token is withheld
      expect(body.access_token).toBeUndefined();
    });
  });

  describe('CLI Diagnostic runPayPalAuthVerification', () => {
    it('returns skipped result when credentials are not configured', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await runPayPalAuthVerification({
        PAYPAL_CLIENT_ID: undefined,
        PAYPAL_CLIENT_SECRET: undefined,
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('Skipped: credentials not set');

      const logged = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logged).toContain('Status: SKIPPED (No credentials configured)');
      consoleSpy.mockRestore();
    });

    it('returns success result when mocked credentials succeed, without leaking tokens', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'MOCK_SECRET_ACCESS_TOKEN_DO_NOT_PRINT',
          token_type: 'Bearer',
          expires_in: 32400,
          app_id: 'TEST_CLI_APP_ID',
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await runPayPalAuthVerification({
        PAYPAL_CLIENT_ID: dummyClientId,
        PAYPAL_CLIENT_SECRET: dummyClientSecret,
        PAYPAL_ENVIRONMENT: 'sandbox',
      });

      expect(result.success).toBe(true);
      expect(result.message).toBe('Authentication successful');

      const logged = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logged).toContain('Authentication Result: SUCCESS');
      expect(logged).toContain('App ID: TEST_CLI_APP_ID');
      expect(logged).not.toContain('MOCK_SECRET_ACCESS_TOKEN_DO_NOT_PRINT');
      expect(logged).not.toContain(dummyClientSecret);
      consoleSpy.mockRestore();
    });

    it('returns failure result on HTTP 401 without leaking credentials', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({
          error: 'invalid_client',
          error_description: 'Client Authentication failed',
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await runPayPalAuthVerification({
        PAYPAL_CLIENT_ID: dummyClientId,
        PAYPAL_CLIENT_SECRET: dummyClientSecret,
        PAYPAL_ENVIRONMENT: 'sandbox',
      });

      expect(result.success).toBe(false);
      expect(result.message).toBe('Authentication failed');

      const logged = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logged).toContain('Authentication Result: FAILED');
      expect(logged).not.toContain(dummyClientSecret);
      consoleSpy.mockRestore();
    });
  });
});
