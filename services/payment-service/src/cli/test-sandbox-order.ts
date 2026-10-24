import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import { getPaymentServiceConfig, loadRootEnv, type PaymentServiceConfig } from '@agentpay/config';
import type { PurchaseProposal } from '@agentpay/contracts';
import { PayPalPaymentProvider } from '../paypal/provider.js';
import { InMemoryPaymentOrderRepository } from '../repository.js';

export async function runPayPalSandboxOrderTest(
  configOverride?: Partial<PaymentServiceConfig>,
  captureOrderId?: string,
): Promise<{
  success: boolean;
  message: string;
  orderId?: string;
  approvalUrl?: string;
  captureId?: string;
}> {
  loadRootEnv({ startDir: fileURLToPath(import.meta.url) });

  let config: PaymentServiceConfig;
  try {
    const baseConfig = getPaymentServiceConfig();
    config = configOverride ? { ...baseConfig, ...configOverride } : baseConfig;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log('\n[PayPal Sandbox Order Verification]');
    console.log('Status: CONFIGURATION_ERROR');
    console.log(`Details: ${msg}`);
    return { success: false, message: msg };
  }

  const clientId = config.PAYPAL_CLIENT_ID;
  const clientSecret = config.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.log('\n======================================================');
    console.log(' [PayPal Sandbox Order Verification]');
    console.log(' Status: SKIPPED (No credentials configured)');
    console.log(' Environment:', config.PAYPAL_ENVIRONMENT);
    console.log(' Note: PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET is missing.');
    console.log(' Set them in your local .env to test real PayPal Sandbox orders.');
    console.log('======================================================\n');
    return { success: true, message: 'Skipped: credentials not set' };
  }

  console.log('\n======================================================');
  console.log(' [PayPal Sandbox Order Verification]');
  console.log(' Environment:', config.PAYPAL_ENVIRONMENT);
  console.log(' Base URL:', config.PAYPAL_API_BASE_URL);

  const repository = new InMemoryPaymentOrderRepository();
  const provider = new PayPalPaymentProvider({
    clientId,
    clientSecret,
    environment: config.PAYPAL_ENVIRONMENT,
    apiBaseUrl: config.PAYPAL_API_BASE_URL,
    repository,
  });

  const correlationId = `corr_${Date.now()}`;
  const policyDecisionId = uuidv4();

  // If a specific order ID is requested for capture
  if (captureOrderId) {
    console.log(`\n Step: Capturing PayPal Order ID: ${captureOrderId}...`);
    try {
      // 1. Retrieve order from PayPal
      const existing = await provider.getOrder(captureOrderId, correlationId);
      if (!existing) {
        throw new Error(`Order ${captureOrderId} not found in PayPal Sandbox`);
      }

      console.log(`   Current PayPal Status: ${existing.status}`);

      // Seed repository if not present
      await repository.createOrder({
        id: captureOrderId,
        proposalId: existing.proposalId,
        policyDecisionId,
        provider: 'paypal_sandbox',
        status: existing.status,
        currency: existing.currency,
        amountMinor: existing.amountMinor,
        approvalUrl: existing.approvalUrl,
        createdAt: existing.createdAt,
        updatedAt: existing.createdAt,
      });

      // 2. Attempt capture
      const result = await provider.captureOrder(captureOrderId, policyDecisionId, correlationId);
      console.log('\n [PayPal Capture Successful]');
      console.log(`   Capture ID:     ${result.captureId}`);
      console.log(`   Final Status:   ${result.status}`);
      console.log(`   Captured Minor: ${result.capturedAmountMinor}`);
      console.log(`   Currency:       ${result.currency}`);
      console.log(`   Timestamp:      ${result.timestamp}`);
      console.log('======================================================\n');

      return {
        success: true,
        message: 'PayPal Sandbox order captured successfully',
        orderId: captureOrderId,
        captureId: result.captureId,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log('\n [PayPal Capture Attempt Notice]');
      console.log(`   Status: PENDING_APPROVAL / REJECTED`);
      console.log(`   Details: ${msg}`);
      console.log('======================================================\n');
      return { success: false, message: msg, orderId: captureOrderId };
    }
  }

  // Otherwise, create a new order and return approval URL
  console.log(' Step 1: Initializing PayPal Payment Provider...');
  const testProposal: PurchaseProposal = {
    id: uuidv4(),
    intentId: uuidv4(),
    agentId: 'agent_sandbox_verifier',
    merchant: {
      id: 'merchant_sandbox_01',
      name: 'AgentPay Sandbox Merchant',
      category: 'cloud_services',
    },
    items: [
      {
        id: uuidv4(),
        name: 'AgentPay Phase 1B Sandbox Verification Item',
        quantity: 1,
        unitPriceMinor: 100, // $1.00 USD
        currency: 'USD',
      },
    ],
    totalAmountMinor: 100,
    currency: 'USD',
    purpose: 'Phase 1B PayPal Sandbox Order Verification',
    createdAt: new Date().toISOString(),
  };

  const idempotencyKey = `idemp_sandbox_${Date.now()}`;

  console.log(' Step 2: Creating real PayPal Sandbox Order v2...');
  console.log(`   Amount: $1.00 USD (minor units: ${testProposal.totalAmountMinor})`);
  console.log(`   Proposal ID: ${testProposal.id}`);
  console.log(`   Idempotency Key: ${idempotencyKey}`);

  try {
    const order = await provider.createOrder(testProposal, correlationId, {
      policyDecisionId,
      idempotencyKey,
    });

    console.log('\n [PayPal Order Created Successfully]');
    console.log(`   Order ID:       ${order.id}`);
    console.log(`   Status:         ${order.status}`);
    console.log(`   Currency:       ${order.currency}`);
    console.log(`   Amount (cents): ${order.amountMinor}`);
    console.log(`   Approval URL:   ${order.approvalUrl ?? 'None'}`);

    console.log('\n Step 3: Verifying order state retrieval from PayPal API...');
    const retrieved = await provider.getOrder(order.id, correlationId);
    console.log(`   Retrieved State: ${retrieved?.status ?? 'Not found'}`);

    if (order.approvalUrl) {
      console.log('\n======================================================');
      console.log(' BUYER APPROVAL URL:');
      console.log(` ${order.approvalUrl}`);
      console.log('------------------------------------------------------');
      console.log(' Instructions for Sandbox Testing:');
      console.log(' 1. Open the Buyer Approval URL in your browser.');
      console.log(' 2. Log in with your Sandbox Personal Account and click "Complete Purchase".');
      console.log(' 3. Run capture using:');
      console.log(`    pnpm test:paypal-order -- --capture ${order.id}`);
      console.log('======================================================\n');
    }

    return {
      success: true,
      message: 'PayPal Sandbox order created and verified',
      orderId: order.id,
      approvalUrl: order.approvalUrl,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log('\n [PayPal Order Test Failed]');
    console.log(`   Error: ${msg}`);
    console.log('======================================================\n');
    return { success: false, message: msg };
  }
}

// Allow direct execution
if (
  process.argv[1]?.endsWith('test-sandbox-order.ts') ||
  process.argv[1]?.endsWith('test-sandbox-order.js')
) {
  const captureIndex = process.argv.indexOf('--capture');
  const captureId =
    captureIndex !== -1 && process.argv[captureIndex + 1]
      ? process.argv[captureIndex + 1]
      : undefined;

  runPayPalSandboxOrderTest(undefined, captureId).then((res) => {
    if (
      !res.success &&
      res.message !== 'Skipped: credentials not set' &&
      !res.message.includes('requires buyer approval')
    ) {
      process.exitCode = 1;
    }
  });
}
