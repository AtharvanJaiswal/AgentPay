import type { FastifyRequest } from 'fastify';
import type { ApiGatewayConfig } from '@agentpay/config';

export interface Principal {
  readonly id: string;
  readonly authSource: 'development_adapter' | 'test_adapter' | 'verified_session';
}

export interface AuthenticationProvider {
  authenticate(req: FastifyRequest): Promise<Principal | null>;
}

/**
 * Production-safe default provider when no external OAuth/JWT identity provider is configured.
 * Strictly fails closed for all requests in production.
 */
export class ProductionPendingAuthenticationProvider implements AuthenticationProvider {
  async authenticate(_req: FastifyRequest): Promise<Principal | null> {
    // Production authentication is not yet integrated.
    // Fail closed: never trust client-supplied headers or anonymous callers.
    return null;
  }
}

/**
 * Development-only identity provider.
 * Strictly gated by ALLOW_DEV_IDENTITY=true and NODE_ENV !== 'production'.
 */
export class DevelopmentAuthenticationProvider implements AuthenticationProvider {
  constructor(private readonly config: ApiGatewayConfig) {}

  async authenticate(req: FastifyRequest): Promise<Principal | null> {
    // Hard invariant: never permit in production
    if (this.config.NODE_ENV === 'production' || !this.config.ALLOW_DEV_IDENTITY) {
      return null;
    }

    const headerPrincipal = req.headers['x-principal-id'];
    if (typeof headerPrincipal === 'string' && headerPrincipal.trim().length > 0) {
      // Bounded and sanitized development principal ID
      const sanitized = headerPrincipal.trim().slice(0, 128);
      return {
        id: sanitized,
        authSource: 'development_adapter',
      };
    }

    // Default development fallback for local developer iteration
    return {
      id: 'dev-user-principal-01',
      authSource: 'development_adapter',
    };
  }
}

/**
 * Controlled test adapter for deterministic automated testing.
 */
export class TestAuthenticationProvider implements AuthenticationProvider {
  constructor(private readonly defaultPrincipal?: Principal) {}

  async authenticate(req: FastifyRequest): Promise<Principal | null> {
    const headerPrincipal = req.headers['x-principal-id'];
    if (typeof headerPrincipal === 'string' && headerPrincipal.trim().length > 0) {
      return {
        id: headerPrincipal.trim(),
        authSource: 'test_adapter',
      };
    }

    return (
      this.defaultPrincipal ?? {
        id: 'dev-user-principal-01',
        authSource: 'test_adapter',
      }
    );
  }
}
