import { fileURLToPath } from 'node:url';
import { getPaymentServiceConfig, loadRootEnv, type PaymentServiceConfig } from '@agentpay/config';
import { PayPalOAuthClient } from '../paypal/oauth-client.js';
import { PayPalOrdersClient, PayPalOrderApiError } from '../paypal/orders-client.js';

export async function diagnosePayPalOrder(
  orderId: string,
  configOverride?: Partial<PaymentServiceConfig>,
): Promise<{ success: boolean; data?: unknown; message: string }> {
  loadRootEnv({ startDir: fileURLToPath(import.meta.url) });

  let config: PaymentServiceConfig;
  try {
    const baseConfig = getPaymentServiceConfig();
    config = configOverride ? { ...baseConfig, ...configOverride } : baseConfig;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log('\n[PayPal Order Diagnostics]');
    console.log('Status: CONFIGURATION_ERROR');
    console.log(`Details: ${msg}`);
    return { success: false, message: msg };
  }

  const clientId = config.PAYPAL_CLIENT_ID;
  const clientSecret = config.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.log('\n[PayPal Order Diagnostics]');
    console.log('Status: SKIPPED (No credentials configured)');
    return { success: false, message: 'Missing credentials' };
  }

  const oauthClient = new PayPalOAuthClient({
    clientId,
    clientSecret,
    environment: config.PAYPAL_ENVIRONMENT,
    apiBaseUrl: config.PAYPAL_API_BASE_URL,
    timeoutMs: 10000,
  });

  const ordersClient = new PayPalOrdersClient({
    oauthClient,
    apiBaseUrl: config.PAYPAL_API_BASE_URL,
    timeoutMs: 10000,
  });

  console.log('\n======================================================');
  console.log(' [PayPal Sandbox Order Diagnostics]');
  console.log(` Target Order ID: ${orderId}`);
  console.log(` Environment:     ${config.PAYPAL_ENVIRONMENT}`);
  console.log(` Base URL:        ${config.PAYPAL_API_BASE_URL}`);
  console.log(' Querying PayPal GET /v2/checkout/orders/' + orderId + '...');

  try {
    const order = await ordersClient.getOrder(orderId, 'diag-' + Date.now());

    console.log('\n--- Order Metadata ---');
    console.log(`Order ID: ${order.id}`);
    console.log(`Status:   ${order.status}`);
    console.log(`Intent:   ${order.intent ?? 'N/A'}`);

    const unit = order.purchase_units?.[0];
    if (unit) {
      console.log('\n--- Purchase Unit & Payee Details ---');
      console.log(`Reference ID: ${unit.reference_id ?? 'N/A'}`);
      console.log(`Amount:       ${unit.amount?.currency_code} ${unit.amount?.value}`);
      const payee = (unit as unknown as Record<string, unknown>).payee as
        | { merchant_id?: string; email_address?: string }
        | undefined;
      if (payee) {
        console.log(`Payee Merchant ID:    ${payee.merchant_id ?? 'N/A'}`);
        console.log(`Payee Email:          ${payee.email_address ?? 'N/A'}`);
      } else {
        console.log('Payee: (Not explicitly returned on purchase_unit)');
      }
    }

    console.log('\n--- HATEOAS Links ---');
    if (order.links && order.links.length > 0) {
      for (const link of order.links) {
        console.log(`- rel: [${link.rel}] (${link.method ?? 'GET'}) -> ${link.href}`);
      }
    } else {
      console.log('No links returned.');
    }

    const rawAny = order as unknown as Record<string, unknown>;
    if (rawAny.payment_source) {
      console.log('\n--- Payment Source ---');
      console.log(JSON.stringify(rawAny.payment_source, null, 2));
    }

    console.log('======================================================\n');
    return { success: true, data: order, message: 'Diagnosis complete' };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log('\n[PayPal Order Diagnostics Failed]');
    console.log(`Error: ${msg}`);
    if (err instanceof PayPalOrderApiError) {
      console.log(`HTTP Status: ${err.statusCode}`);
      if (err.details) {
        console.log('PayPal Error Details:', JSON.stringify(err.details, null, 2));
      }
    }
    console.log('======================================================\n');
    return { success: false, message: msg };
  }
}

// Allow CLI execution
if (
  process.argv[1]?.endsWith('diagnose-order.ts') ||
  process.argv[1]?.endsWith('diagnose-order.js')
) {
  const targetId = process.argv[2] || '06F822997H928472C';
  diagnosePayPalOrder(targetId);
}
