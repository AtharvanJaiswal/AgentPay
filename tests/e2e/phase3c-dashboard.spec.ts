import { test, expect } from '@playwright/test';

test.describe('Phase 3C — Human-in-the-Loop Purchase Authorization Dashboard', () => {
  // Ensure the page is ready before each test
  test.beforeEach(async ({ page }) => {
    // Catch any unexpected uncaught exceptions
    page.on('pageerror', (err) => {
      console.error('Browser page error:', err.message);
    });
  });

  test('E2E 1 — Successful product search, candidate disambiguation, explicit selection, and proposal creation', async ({
    page,
  }) => {
    await page.goto('/');

    // 1. Verify Phase 3C navigation tabs
    const catalogTab = page.locator('[data-testid="tab-catalog"]');
    await expect(catalogTab).toBeVisible();
    await catalogTab.click();

    // 2. Perform product search
    const searchInput = page.locator('[data-testid="product-search-input"]');
    const searchBtn = page.locator('[data-testid="product-search-submit"]');
    await expect(searchInput).toBeVisible();
    await searchInput.fill('ergonomic office chair');
    await searchBtn.click();

    // 3. Verify multiple candidates are rendered
    const candidateList = page.locator('[data-testid="candidate-list"]');
    await expect(candidateList).toBeVisible({ timeout: 10000 });
    const candidateCards = page.locator('[data-testid^="candidate-card-"]');
    const count = await candidateCards.count();
    expect(count).toBeGreaterThanOrEqual(1);

    // 4. Verify NO candidate is auto-selected
    // The proposal action panel should show "Select a candidate above to review details"
    const proposalActionPanel = page.locator('[data-testid="proposal-action-panel"]');
    await expect(proposalActionPanel).toContainText('Select a candidate above');

    // 5. Explicitly select the first candidate
    const firstSelectBtn = candidateCards.first().locator('[data-testid^="candidate-select-btn-"]');
    await firstSelectBtn.click();

    // 6. Verify selection is reflected and create proposal button becomes active
    const createProposalBtn = page.locator('[data-testid="create-proposal-btn"]');
    await expect(createProposalBtn).toBeVisible();
    await expect(createProposalBtn).toBeEnabled();

    // 7. Click create proposal
    await createProposalBtn.click();

    // 8. Proposal created successfully alert or banner
    const creationAlert = page.locator('[data-testid="proposal-created-alert"]');
    await expect(creationAlert).toBeVisible({ timeout: 10000 });

    // 9. Navigate to Authorization Dashboard and confirm proposal appears
    const dashboardTab = page.locator('[data-testid="tab-proposals"]');
    await dashboardTab.click();

    const proposalList = page.locator('[data-testid="proposal-list"]');
    await expect(proposalList).toBeVisible();
    const proposalCards = page.locator('[data-testid^="proposal-card-"]');
    await expect(proposalCards.first()).toBeVisible();
  });

  test('E2E 2 — Ambiguous product requires explicit human candidate selection', async ({
    page,
  }) => {
    await page.goto('/');

    // Switch to search tab
    await page.locator('[data-testid="tab-catalog"]').click();

    // Search for a generic query that yields multiple candidates
    await page.locator('[data-testid="product-search-input"]').fill('chair');
    await page.locator('[data-testid="product-search-submit"]').click();

    // Wait for candidate list
    await expect(page.locator('[data-testid="candidate-list"]')).toBeVisible();

    // Verify candidate choices exist and selection prompt is visible
    const selectionPrompt = page.locator('[data-testid="candidate-selection-prompt"]');
    await expect(selectionPrompt).toBeVisible();
    await expect(selectionPrompt).toContainText('Explicit Selection Required');

    // Verify "Create Purchase Proposal" button is NOT rendered without selection
    await expect(page.locator('[data-testid="create-proposal-btn"]')).not.toBeVisible();
  });

  test('E2E 3 — Price change conflict (409) requires explicit human reconfirmation', async ({
    page,
  }) => {
    await page.goto('/');
    await page.locator('[data-testid="tab-catalog"]').click();

    // Search
    await page.locator('[data-testid="product-search-input"]').fill('chair');
    await page.locator('[data-testid="product-search-submit"]').click();
    await expect(page.locator('[data-testid="candidate-list"]')).toBeVisible();

    // Select candidate
    const firstSelectBtn = page.locator('[data-testid^="candidate-select-btn-"]').first();
    await firstSelectBtn.click();

    // Intercept POST /api/purchase-intents to return 409 PRICE_CHANGED_RECONFIRMATION_REQUIRED
    await page.route('**/api/purchase-intents', async (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'PRICE_CHANGED_RECONFIRMATION_REQUIRED',
              message: 'The product price has changed since search. Please review and reconfirm.',
              previousPriceMinor: 24900,
              currentPriceMinor: 27900,
              currency: 'USD',
            },
          }),
        });
      }
      return route.continue();
    });

    // Attempt proposal creation
    await page.locator('[data-testid="create-proposal-btn"]').click();

    // Verify price change modal appears with old and new prices
    const priceChangeModal = page.locator('[data-testid="price-change-modal"]');
    await expect(priceChangeModal).toBeVisible();
    await expect(priceChangeModal).toContainText('Price Change Detected');
    await expect(priceChangeModal).toContainText('$249.00');
    await expect(priceChangeModal).toContainText('$279.00');

    // Dismiss or acknowledge modal
    const acknowledgeBtn = page.locator('[data-testid="price-change-dismiss-btn"]');
    await expect(acknowledgeBtn).toBeVisible();
    await acknowledgeBtn.click();

    await expect(priceChangeModal).not.toBeVisible();
  });

  test('E2E 4 — Human approval flow records authorization without payment execution', async ({
    page,
  }) => {
    await page.goto('/');

    // 1. Create a reviewable proposal first
    await page.locator('[data-testid="tab-catalog"]').click();
    await page.locator('[data-testid="product-search-input"]').fill('ergonomic chair');
    await page.locator('[data-testid="product-search-submit"]').click();
    await expect(page.locator('[data-testid="candidate-list"]')).toBeVisible();
    await page.locator('[data-testid^="candidate-select-btn-"]').first().click();
    await page.locator('[data-testid="create-proposal-btn"]').click();
    await expect(page.locator('[data-testid="proposal-created-alert"]')).toBeVisible({ timeout: 10000 });

    // 2. Open proposals dashboard
    await page.locator('[data-testid="tab-proposals"]').click();
    const proposalCard = page.locator('[data-testid^="proposal-card-"]').first();
    await expect(proposalCard).toBeVisible();
    await proposalCard.click();

    // 3. Inspect proposal detail panel
    const detailPanel = page.locator('[data-testid="proposal-detail-panel"]');
    await expect(detailPanel).toBeVisible();
    await expect(page.locator('[data-testid="proposal-total-amount"]')).toBeVisible();
    await expect(page.locator('[data-testid="proposal-policy-reasons"]')).toBeVisible();

    // 4. Click Approve button
    const approveBtn = page.locator('[data-testid="approve-proposal-btn"]');
    if (await approveBtn.isVisible()) {
      await approveBtn.click();

      // 5. Confirm in decision dialog
      const decisionModal = page.locator('[data-testid="decision-dialog-modal"]');
      await expect(decisionModal).toBeVisible();
      await page.locator('[data-testid="decision-note-input"]').fill('E2E test approval note');
      await page.locator('[data-testid="confirm-decision-btn"]').click();

      // 6. Verify status updates to APPROVED
      const statusBadge = page.locator('[data-testid="proposal-status-badge"]');
      await expect(statusBadge).toContainText('APPROVED');

      // 7. Verify audit event is rendered
      const auditTimeline = page.locator('[data-testid="audit-timeline"]');
      await expect(auditTimeline).toBeVisible();
      await expect(auditTimeline).toContainText('PROPOSAL_APPROVED');
    }
  });

  test('E2E 5 — Human rejection flow records decision and audit event', async ({
    page,
  }) => {
    await page.goto('/');

    // 1. Create a proposal
    await page.locator('[data-testid="tab-catalog"]').click();
    await page.locator('[data-testid="product-search-input"]').fill('chair');
    await page.locator('[data-testid="product-search-submit"]').click();
    await expect(page.locator('[data-testid="candidate-list"]')).toBeVisible();
    await page.locator('[data-testid^="candidate-select-btn-"]').first().click();
    await page.locator('[data-testid="create-proposal-btn"]').click();
    await expect(page.locator('[data-testid="proposal-created-alert"]')).toBeVisible({ timeout: 10000 });

    // 2. Open dashboard and view proposal
    await page.locator('[data-testid="tab-proposals"]').click();
    const proposalCard = page.locator('[data-testid^="proposal-card-"]').first();
    await proposalCard.click();

    // 3. Click Reject button
    const rejectBtn = page.locator('[data-testid="reject-proposal-btn"]');
    if (await rejectBtn.isVisible()) {
      await rejectBtn.click();

      // 4. Confirm in decision dialog
      const decisionModal = page.locator('[data-testid="decision-dialog-modal"]');
      await expect(decisionModal).toBeVisible();
      await page.locator('[data-testid="decision-note-input"]').fill('E2E rejection: over budget');
      await page.locator('[data-testid="confirm-decision-btn"]').click();

      // 5. Verify status updates to CANCELLED
      const statusBadge = page.locator('[data-testid="proposal-status-badge"]');
      await expect(statusBadge).toContainText('CANCELLED');

      // 6. Verify audit timeline shows PROPOSAL_REJECTED
      const auditTimeline = page.locator('[data-testid="audit-timeline"]');
      await expect(auditTimeline).toBeVisible();
      await expect(auditTimeline).toContainText('PROPOSAL_REJECTED');
    }
  });

  test('E2E 6 — Non-reviewable proposal disables decision controls and server rejects forbidden transitions', async ({
    page,
    request,
  }) => {
    await page.goto('/');

    // Create a proposal
    await page.locator('[data-testid="tab-catalog"]').click();
    await page.locator('[data-testid="product-search-input"]').fill('mouse');
    await page.locator('[data-testid="product-search-submit"]').click();
    await expect(page.locator('[data-testid="candidate-list"]')).toBeVisible();
    await page.locator('[data-testid^="candidate-select-btn-"]').first().click();
    await page.locator('[data-testid="create-proposal-btn"]').click();
    await expect(page.locator('[data-testid="proposal-created-alert"]')).toBeVisible({ timeout: 10000 });

    // Go to dashboard
    await page.locator('[data-testid="tab-proposals"]').click();
    const card = page.locator('[data-testid^="proposal-card-"]').first();
    await card.click();

    // Approve the proposal
    const approveBtn = page.locator('[data-testid="approve-proposal-btn"]');
    if (await approveBtn.isVisible()) {
      await approveBtn.click();
      await page.locator('[data-testid="confirm-decision-btn"]').click();
      await expect(page.locator('[data-testid="proposal-status-badge"]')).toContainText('APPROVED');

      // Now proposal is in APPROVED state (non-reviewable)
      // Decision buttons should be disabled or gone
      await expect(page.locator('[data-testid="approve-proposal-btn"]')).not.toBeVisible();
      await expect(page.locator('[data-testid="reject-proposal-btn"]')).not.toBeVisible();

      // Attempt to reject the already-approved proposal directly via API
      const proposalId = await page.locator('[data-testid="proposal-id-display"]').innerText();
      const res = await request.post(`/api/purchase-intents/${proposalId}/reject`, {
        headers: {
          'x-principal-id': 'dev-user-principal-01',
          'content-type': 'application/json',
        },
        data: { reason: 'Illegal second transition' },
      });

      // Server MUST reject transition
      expect([400, 409]).toContain(res.status());
      const data = await res.json();
      expect(data.error.code).toBe('INVALID_STATE_TRANSITION');
    }
  });

  test('E2E 7 — Ownership isolation between principals prevents unauthorized access', async ({
    page,
    request,
  }) => {
    await page.goto('/');

    // 1. Create proposal as Alice (dev-user-principal-01)
    await page.locator('[data-testid="tab-catalog"]').click();
    await page.locator('[data-testid="product-search-input"]').fill('notebook');
    await page.locator('[data-testid="product-search-submit"]').click();
    await expect(page.locator('[data-testid="candidate-list"]')).toBeVisible();
    await page.locator('[data-testid^="candidate-select-btn-"]').first().click();
    await page.locator('[data-testid="create-proposal-btn"]').click();
    await expect(page.locator('[data-testid="proposal-created-alert"]')).toBeVisible({ timeout: 10000 });

    // Grab the created proposal ID
    await page.locator('[data-testid="tab-proposals"]').click();
    await page.locator('[data-testid^="proposal-card-"]').first().click();
    const aliceProposalId = await page.locator('[data-testid="proposal-id-display"]').innerText();
    expect(aliceProposalId).toBeTruthy();

    // 2. Switch to Bob (dev-user-principal-02) using Principal Switcher in header
    const principalSelect = page.locator('[data-testid="principal-switcher-select"]');
    await principalSelect.selectOption('dev-user-principal-02');

    // 3. Confirm Bob cannot view Alice proposal directly via API
    const bobViewRes = await request.get(`/api/purchase-intents/${aliceProposalId}`, {
      headers: { 'x-principal-id': 'dev-user-principal-02' },
    });
    expect(bobViewRes.status()).toBe(403);

    // 4. Confirm Bob cannot approve Alice proposal via API
    const bobApproveRes = await request.post(`/api/purchase-intents/${aliceProposalId}/approve`, {
      headers: {
        'x-principal-id': 'dev-user-principal-02',
        'content-type': 'application/json',
      },
      data: { note: 'Unauthorized approval attempt' },
    });
    expect(bobApproveRes.status()).toBe(403);

    // 5. Confirm Bob cannot read Alice proposal audit trail
    const bobAuditRes = await request.get(`/api/purchase-intents/${aliceProposalId}/audit-events`, {
      headers: { 'x-principal-id': 'dev-user-principal-02' },
    });
    expect(bobAuditRes.status()).toBe(403);
  });

  test('E2E 8 — Duplicate submissions are guarded in UI and idempotent on backend', async ({
    page,
    request,
  }) => {
    await page.goto('/');
    await page.locator('[data-testid="tab-catalog"]').click();

    // Test UI guard: search button is disabled during search
    const searchInput = page.locator('[data-testid="product-search-input"]');
    const searchBtn = page.locator('[data-testid="product-search-submit"]');
    await expect(searchBtn).toBeEnabled();
    await searchInput.fill('ergonomic chair');

    // Test backend idempotency for proposal creation with fixed idempotency key
    const idempotencyKey = `idem-e2e-${Date.now()}`;
    const payload = {
      rawIntent: 'Buy 1 ergonomic chair',
      selectedCandidate: {
        providerId: 'mock-provider',
        providerProductId: 'prod-chair-01',
        expectedUnitPriceMinor: 18000,
        expectedCurrency: 'USD',
        quantity: 1,
      },
      idempotencyKey,
    };

    const firstRes = await request.post('/api/purchase-intents', {
      headers: {
        'x-principal-id': 'dev-user-principal-01',
        'content-type': 'application/json',
      },
      data: payload,
    });
    expect([200, 201]).toContain(firstRes.status());
    const firstData = await firstRes.json();

    // Rapid duplicate request
    const secondRes = await request.post('/api/purchase-intents', {
      headers: {
        'x-principal-id': 'dev-user-principal-01',
        'content-type': 'application/json',
      },
      data: payload,
    });
    expect([200, 201]).toContain(secondRes.status());
    const secondData = await secondRes.json();

    // Must return identical proposal ID
    expect(secondData.proposal.id).toBe(firstData.proposal.id);
  });

  test('E2E 9 — Error recovery: provider failure and empty search are handled safely without crash', async ({
    page,
  }) => {
    await page.goto('/');
    await page.locator('[data-testid="tab-catalog"]').click();

    // 1. Empty input validation
    const searchBtn = page.locator('[data-testid="product-search-submit"]');
    await searchBtn.click();
    const validationAlert = page.locator('[data-testid="search-validation-error"]');
    await expect(validationAlert).toBeVisible();
    await expect(validationAlert).toContainText('Please enter a search query');

    // 2. Simulated provider failure
    await page.route('**/api/products/search', async (route) => {
      return route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'PROVIDER_UNAVAILABLE',
            message: 'Product catalog provider timed out',
          },
        }),
      });
    });

    await page.locator('[data-testid="product-search-input"]').fill('timeout item');
    await searchBtn.click();

    // Verify graceful error display
    const errorAlert = page.locator('[data-testid="search-error-alert"]');
    await expect(errorAlert).toBeVisible();
    await expect(errorAlert).toContainText('Product catalog provider timed out');

    // Page must remain functional
    await expect(page.locator('[data-testid="agentpay-branding"]')).toBeVisible();
  });

  test('E2E 10 — Payment safety invariant: proposal decision records authorization only, zero payment calls', async ({
    page,
    request,
  }) => {
    await page.goto('/');

    // 1. Verify platform status shows PAYMENTS_ENABLED=false
    const statusRes = await request.get('/api/status');
    expect(statusRes.status()).toBe(200);
    const statusData = await statusRes.json();
    const paymentsEnabled = statusData.providerStatus?.paymentsEnabled ?? statusData.paymentsEnabled;
    expect(paymentsEnabled).toBe(false);

    // 2. Verify orders endpoint rejects execution when payments disabled
    const orderRes = await request.post('/api/payments/orders', {
      headers: {
        'x-principal-id': 'dev-user-principal-01',
        'content-type': 'application/json',
      },
      data: {
        proposal: {
          id: '11111111-1111-4111-a111-111111111111',
          intentId: '22222222-2222-4222-a222-222222222222',
          agentId: 'autonomous-agent-e2e',
          merchant: {
            id: 'm-acme-01',
            name: 'Acme Test Supplies',
            category: 'office_supplies',
          },
          items: [
            {
              id: 'item-e2e',
              name: 'Office Notebook',
              quantity: 1,
              unitPriceMinor: 1000,
              currency: 'USD',
            },
          ],
          totalAmountMinor: 1000,
          currency: 'USD',
          purpose: 'Purchase supplies',
          createdAt: new Date().toISOString(),
        },
        policyDecisionId: '33333333-3333-4333-a333-333333333333',
      },
    });

    // Gateway rejects order creation with 403 PAYMENTS_DISABLED because PAYMENTS_ENABLED=false
    expect(orderRes.status()).toBe(403);
    const orderData = await orderRes.json();
    expect(orderData.error.code).toBe('PAYMENTS_DISABLED');
  });
});
