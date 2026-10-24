export type PayPalEnvironment = 'sandbox' | 'live';

export interface PayPalOAuthClientOptions {
  clientId: string;
  clientSecret: string;
  environment?: PayPalEnvironment;
  apiBaseUrl?: string;
  timeoutMs?: number;
}

export interface PayPalOAuthVerificationResult {
  authenticated: true;
  tokenType: string;
  expiresInSeconds: number;
  expiresAt: string;
  environment: PayPalEnvironment;
  appId?: string;
}

export interface PayPalTokenResponse {
  scope?: string;
  access_token: string;
  token_type: string;
  app_id?: string;
  expires_in: number;
  nonce?: string;
}

export type PayPalOAuthErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'SERVER_ERROR'
  | 'MALFORMED_RESPONSE'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'UNKNOWN_ERROR';

export class PayPalOAuthError extends Error {
  readonly code: PayPalOAuthErrorCode;
  readonly statusCode?: number;
  readonly correlationId?: string;

  constructor(
    code: PayPalOAuthErrorCode,
    message: string,
    options?: { statusCode?: number; correlationId?: string; cause?: unknown },
  ) {
    // Ensure credentials or sensitive headers are never in the error message
    super(`[PayPal OAuth] ${code}: ${message}`);
    this.name = 'PayPalOAuthError';
    this.code = code;
    this.statusCode = options?.statusCode;
    this.correlationId = options?.correlationId;
    if (options?.cause) {
      this.cause = options.cause;
    }
  }
}

export class PayPalOAuthClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly environment: PayPalEnvironment;
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;

  // In-memory cache for token to avoid redundant token generation
  private cachedToken: {
    accessToken: string;
    tokenType: string;
    expiresAtMs: number;
    appId?: string;
  } | null = null;

  constructor(options: PayPalOAuthClientOptions) {
    if (!options.clientId || options.clientId.trim().length === 0) {
      throw new PayPalOAuthError('INVALID_CREDENTIALS', 'PayPal Client ID cannot be empty');
    }
    if (!options.clientSecret || options.clientSecret.trim().length === 0) {
      throw new PayPalOAuthError('INVALID_CREDENTIALS', 'PayPal Client Secret cannot be empty');
    }

    if (options.environment === 'live') {
      throw new PayPalOAuthError(
        'INVALID_CREDENTIALS',
        'PayPal Live operations are strictly forbidden in Phase 1B. Only sandbox is permitted.',
      );
    }

    const resolvedBaseUrl = (options.apiBaseUrl ?? 'https://api-m.sandbox.paypal.com').replace(
      /\/$/,
      '',
    );
    if (/(^https?:\/\/)?(api-m\.paypal\.com|api\.paypal\.com)/i.test(resolvedBaseUrl)) {
      throw new PayPalOAuthError(
        'INVALID_CREDENTIALS',
        'PayPal Live endpoints are strictly forbidden in Phase 1B.',
      );
    }

    this.clientId = options.clientId.trim();
    this.clientSecret = options.clientSecret.trim();
    this.environment = 'sandbox';
    this.apiBaseUrl = resolvedBaseUrl;
    this.timeoutMs = options.timeoutMs ?? 10000;
  }

  /**
   * Safe diagnostic authentication method.
   * Reports only whether authentication succeeded and token expiry, NEVER returning or logging the token.
   */
  async verifyCredentials(correlationId?: string): Promise<PayPalOAuthVerificationResult> {
    const tokenData = await this.fetchToken(correlationId);
    const expiresInSeconds = Math.max(0, Math.round((tokenData.expiresAtMs - Date.now()) / 1000));

    return {
      authenticated: true,
      tokenType: tokenData.tokenType,
      expiresInSeconds,
      expiresAt: new Date(tokenData.expiresAtMs).toISOString(),
      environment: this.environment,
      ...(tokenData.appId ? { appId: tokenData.appId } : {}),
    };
  }

  /**
   * Internal retrieval of access token with safe caching.
   * Token is intended strictly for internal Authorization header construction in subsequent phases.
   */
  async getAccessToken(correlationId?: string): Promise<string> {
    const tokenData = await this.fetchToken(correlationId);
    return tokenData.accessToken;
  }

  /**
   * Clear cached token (useful for tests or token refresh scenarios).
   */
  clearCache(): void {
    this.cachedToken = null;
  }

  private async fetchToken(correlationId?: string): Promise<{
    accessToken: string;
    tokenType: string;
    expiresAtMs: number;
    appId?: string;
  }> {
    // If cached token exists and has > 60 seconds of validity remaining, reuse it
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAtMs > now + 60000) {
      return this.cachedToken;
    }

    const endpoint = `${this.apiBaseUrl}/v1/oauth2/token`;
    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'Accept-Language': 'en_US',
          ...(correlationId ? { 'PayPal-Request-Id': correlationId } : {}),
        },
        body: 'grant_type=client_credentials',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.status === 401) {
        throw new PayPalOAuthError(
          'INVALID_CREDENTIALS',
          'PayPal returned 401 Unauthorized. Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.',
          { statusCode: 401, correlationId },
        );
      }

      if (response.status >= 500) {
        throw new PayPalOAuthError(
          'SERVER_ERROR',
          `PayPal OAuth server returned HTTP ${response.status}.`,
          { statusCode: response.status, correlationId },
        );
      }

      if (!response.ok) {
        throw new PayPalOAuthError(
          'SERVER_ERROR',
          `PayPal OAuth endpoint returned HTTP ${response.status}.`,
          { statusCode: response.status, correlationId },
        );
      }

      let data: PayPalTokenResponse;
      try {
        data = (await response.json()) as PayPalTokenResponse;
      } catch (err) {
        throw new PayPalOAuthError(
          'MALFORMED_RESPONSE',
          'PayPal OAuth response could not be parsed as JSON.',
          { statusCode: response.status, correlationId, cause: err },
        );
      }

      if (!data || typeof data.access_token !== 'string' || typeof data.expires_in !== 'number') {
        throw new PayPalOAuthError(
          'MALFORMED_RESPONSE',
          'PayPal OAuth response did not contain required access_token or expires_in fields.',
          { statusCode: response.status, correlationId },
        );
      }

      const expiresAtMs = now + data.expires_in * 1000;
      this.cachedToken = {
        accessToken: data.access_token,
        tokenType: data.token_type || 'Bearer',
        expiresAtMs,
        appId: data.app_id,
      };

      return this.cachedToken;
    } catch (err) {
      clearTimeout(timeoutId);

      if (err instanceof PayPalOAuthError) {
        throw err;
      }

      if (err instanceof Error && err.name === 'AbortError') {
        throw new PayPalOAuthError(
          'TIMEOUT',
          `PayPal OAuth request timed out after ${this.timeoutMs}ms.`,
          { correlationId, cause: err },
        );
      }

      const errorMessage = err instanceof Error ? err.message : 'Unknown network failure';
      throw new PayPalOAuthError(
        'NETWORK_ERROR',
        `Network communication failure with PayPal: ${errorMessage}`,
        { correlationId, cause: err },
      );
    }
  }
}
