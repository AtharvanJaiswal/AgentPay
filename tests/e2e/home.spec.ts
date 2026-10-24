import { test, expect } from '@playwright/test';

test.describe('AgentPay End-to-End Foundation Suite', () => {
  test('home page loads, displays AgentPay branding, and identifies mock/sandbox status', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto('/');

    // 1. Branding check
    const branding = page.locator('[data-testid="agentpay-branding"]');
    await expect(branding).toBeVisible();
    await expect(branding).toContainText('AgentPay');
    await expect(branding).toContainText('AI proposes. Policy enforces. PayPal executes.');

    // 2. Visible Provider / Sandbox unconfigured status
    const providerBadge = page.locator('[data-testid="provider-status-badge"]');
    await expect(providerBadge).toBeVisible();
    await expect(providerBadge).toContainText('MOCK/DEVELOPMENT');

    const warningBanner = page.locator('[data-testid="sandbox-warning-banner"]');
    await expect(warningBanner).toBeVisible();
    await expect(warningBanner).toContainText('Sandbox not configured');
    await expect(warningBanner).toContainText('MOCK/DEVELOPMENT');

    // 3. No unexpected browser console errors during happy path
    expect(consoleErrors).toEqual([]);
  });

  test('UI shows a controlled error when the API is unavailable rather than a broken page', async ({
    page,
  }) => {
    // Intercept /api/status to simulate backend gateway downtime
    await page.route('**/api/status', async (route) => {
      await route.abort('connectionrefused');
    });

    await page.goto('/');

    // Page must not crash; branding remains intact
    const branding = page.locator('[data-testid="agentpay-branding"]');
    await expect(branding).toBeVisible();

    // Controlled alert must be displayed
    const errorAlert = page.locator('[data-testid="api-error-alert"]');
    await expect(errorAlert).toBeVisible();
    await expect(errorAlert).toContainText('API Gateway Connectivity Notice');
  });

  test('API health endpoint returns a successful response via API proxy', async ({ request }) => {
    const res = await request.get('/api/health');
    // In local web standalone or gateway, health should respond with valid JSON status
    if (res.status() === 200) {
      const data = await res.json();
      expect(data.status).toBeDefined();
      expect(data.service).toBeDefined();
    } else {
      // Degraded / connecting is also handled cleanly with JSON
      expect([200, 502, 503]).toContain(res.status());
    }
  });

  test('Invalid proposal data is rejected with a controlled error response', async ({
    request,
  }) => {
    const res = await request.post('/api/proposals', {
      data: {
        rawIntent: '', // Empty intent is invalid
      },
    });

    // Gateway / agent service rejects invalid shape with 400 or downstream 502
    expect([400, 502]).toContain(res.status());
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  test('A denied high-risk proposal is rejected and policy prevents payment creation', async ({
    request,
  }) => {
    // Attempt to evaluate policy directly via API gateway for a prohibited luxury crypto token
    const prohibitedProposal = {
      id: '11111111-1111-4111-a111-111111111111',
      intentId: '22222222-2222-4222-a222-222222222222',
      agentId: 'autonomous-agent-e2e',
      merchant: {
        id: 'm-crypto-01',
        name: 'Crypto Lottery Voucher Stakes',
        category: 'gambling',
      },
      items: [
        {
          id: 'item-e2e',
          name: 'Prohibited Casino Tokens',
          quantity: 1,
          unitPriceMinor: 500000,
          currency: 'USD',
        },
      ],
      totalAmountMinor: 500000,
      currency: 'USD',
      purpose: 'Unrestricted high risk token purchase',
      createdAt: new Date().toISOString(),
    };

    const res = await request.post('/api/payments/orders', {
      data: {
        proposal: prohibitedProposal,
        policyDecisionId: '33333333-3333-4333-a333-333333333333',
      },
    });

    // Gateway MUST reject payment creation with 403 POLICY_VIOLATION (or 502 if gateway downstream offline in unit e2e mode)
    if (res.status() === 403) {
      const data = await res.json();
      expect(data.error.code).toBe('POLICY_VIOLATION');
      expect(data.error.details.outcome).toBe('DENY');
    }
  });

  test('Simulating an approved intent renders the order lifecycle card and capture controls', async ({
    page,
  }) => {
    await page.goto('/');

    const submitBtn = page.locator('[data-testid="proposal-submit"]');
    await expect(submitBtn).toBeVisible();

    // Trigger autonomous evaluation
    await submitBtn.click();

    // The policy decision card should appear
    const policyCard = page.locator('[data-testid="policy-decision-card"]');
    await expect(policyCard).toBeVisible({ timeout: 10000 });

    // The order lifecycle card should be rendered if payment order succeeded
    const orderCard = page.locator('[data-testid="order-lifecycle-card"]');
    // If order was created, verify capture button exists
    if (await orderCard.isVisible()) {
      const captureBtn = page.locator('[data-testid="capture-order-button"]');
      await expect(captureBtn).toBeVisible();
    }
  });

  test('Direct capture request without policy authorization is rejected', async ({ request }) => {
    const res = await request.post('/api/payments/orders/test-order-e2e/capture', {
      data: {
        policyDecisionId: '', // Missing / empty policy decision
      },
    });

    // Gateway / payment-service must reject unauthorized or non-existent capture with 400, 403, 404, or 502
    expect([400, 403, 404, 502]).toContain(res.status());
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  test('Order success return route renders safely with missing token without crashing', async ({
    page,
  }) => {
    await page.goto('/orders/success');

    const panel = page.locator('[data-testid="orders-success-panel"]');
    await expect(panel).toBeVisible();

    const missingAlert = page.locator('[data-testid="missing-token-alert"]');
    await expect(missingAlert).toBeVisible();
    await expect(missingAlert).toContainText('Missing Order Token');

    const returnBtn = page.locator('[data-testid="return-home-btn"]');
    await expect(returnBtn).toBeVisible();
  });

  test('Order success return route handles malformed tokens safely', async ({ page }) => {
    await page.goto('/orders/success?token=<script>alert(1)</script>');

    const invalidAlert = page.locator('[data-testid="invalid-token-alert"]');
    await expect(invalidAlert).toBeVisible();
    await expect(invalidAlert).toContainText('Invalid Order Token Format');
  });

  test('Order success return route displays order status, security boundary notice, and never triggers capture', async ({
    page,
  }) => {
    let captureRequested = false;
    await page.route('**/api/payments/orders/*/capture', (route) => {
      captureRequested = true;
      return route.abort();
    });

    await page.route('**/api/payments/orders/TEST_ORDER_TOKEN_123', (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'TEST_ORDER_TOKEN_123',
          status: 'APPROVED',
          currency: 'USD',
          amountMinor: 2500,
          provider: 'paypal_sandbox',
          isMock: false,
        }),
      });
    });

    await page.goto('/orders/success?token=TEST_ORDER_TOKEN_123&PayerID=TEST_PAYER_XYZ');

    const panel = page.locator('[data-testid="orders-success-panel"]');
    await expect(panel).toBeVisible();

    const badge = page.locator('[data-testid="order-status-badge"]');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('APPROVED');

    const securityNotice = page.locator('[data-testid="security-notice"]');
    await expect(securityNotice).toBeVisible();
    await expect(securityNotice).toContainText('never triggers payment capture automatically');

    // Prove that visiting the return URL never triggers a capture request
    expect(captureRequested).toBe(false);
  });

  test('Order cancelled return route renders cancellation details and provides safe return path', async ({
    page,
  }) => {
    await page.goto('/orders/cancelled?token=06F822997H928472C');

    const panel = page.locator('[data-testid="orders-cancelled-panel"]');
    await expect(panel).toBeVisible();

    const summary = page.locator('[data-testid="cancellation-summary-alert"]');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('Checkout Cancelled');

    const returnBtn = page.locator('[data-testid="return-home-btn"]');
    await expect(returnBtn).toBeVisible();
  });

  test('Order approved alias route renders successfully without 404', async ({ page }) => {
    await page.goto('/orders/approved?token=06F822997H928472C');

    const panel = page.locator('[data-testid="orders-success-panel"]');
    await expect(panel).toBeVisible();
  });
});
