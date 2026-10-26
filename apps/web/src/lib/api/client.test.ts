import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiClient, ApiError } from './client';

describe('ApiClient & ApiError', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('correctly constructs ApiError with status, code, and details', () => {
    const error = new ApiError({
      message: 'Product not found',
      statusCode: 404,
      code: 'NOT_FOUND',
      details: { productId: 'item-1' },
    });
    expect(error.name).toBe('ApiError');
    expect(error.message).toBe('Product not found');
    expect(error.statusCode).toBe(404);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.details).toEqual({ productId: 'item-1' });
    expect(error.isPriceChangeConflict()).toBe(false);
  });

  it('identifies price change conflicts correctly in ApiError', () => {
    const conflictError = new ApiError({
      message: 'Candidate price changed',
      statusCode: 409,
      code: 'PRICE_CHANGED_RECONFIRMATION_REQUIRED',
      previousPriceMinor: 1000,
      currentPriceMinor: 1200,
    });
    expect(conflictError.isPriceChangeConflict()).toBe(true);
  });

  it('sets custom principal header when configured', async () => {
    const client = new ApiClient({
      activePrincipalId: 'principal-test-dev',
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ status: 'healthy', paymentsEnabled: false }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await client.getPlatformStatus();
    expect(result.status).toBe('healthy');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const callArgs = mockFetch.mock.calls[0];
    const headers = callArgs[1].headers as Headers;
    expect(headers.get('x-principal-id')).toBe('principal-test-dev');
  });

  it('normalizes HTTP error responses into ApiError instances', async () => {
    const client = new ApiClient();

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        error: {
          code: 'PRICE_CHANGED_RECONFIRMATION_REQUIRED',
          message: 'Price has changed',
          details: { previousPriceMinor: 100, currentPriceMinor: 150 },
        },
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(client.searchProducts('phone')).rejects.toThrow(ApiError);
  });
});
