import { fileURLToPath } from 'node:url';
import { getPaymentServiceConfig, loadRootEnv, type PaymentServiceConfig } from '@agentpay/config';
import { PayPalOAuthClient, PayPalOAuthError } from '../paypal/oauth-client.js';

export async function runPayPalAuthVerification(
  configOverride?: Partial<PaymentServiceConfig>,
): Promise<{ success: boolean; message: string }> {
  // Ensure repository root .env is deterministically loaded from file URL,
  // without overwriting existing process.env variables (override: false).
  loadRootEnv({ startDir: fileURLToPath(import.meta.url) });

  let config: PaymentServiceConfig;
  try {
    const baseConfig = getPaymentServiceConfig();
    config = configOverride ? { ...baseConfig, ...configOverride } : baseConfig;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log('\n[PayPal Sandbox OAuth Diagnostic]');
    console.log('Status: CONFIGURATION_ERROR');
    console.log(`Details: ${msg}`);
    return { success: false, message: msg };
  }

  const clientId = config.PAYPAL_CLIENT_ID;
  const clientSecret = config.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.log('\n======================================================');
    console.log(' [PayPal Sandbox OAuth Diagnostic]');
    console.log(' Status: SKIPPED (No credentials configured)');
    console.log(' Environment:', config.PAYPAL_ENVIRONMENT);
    console.log(' Note: PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET is missing.');
    console.log(' Set them in your local .env to test live PayPal authentication.');
    console.log('======================================================\n');
    return { success: true, message: 'Skipped: credentials not set' };
  }

  console.log('\n======================================================');
  console.log(' [PayPal Sandbox OAuth Diagnostic]');
  console.log(' Environment:', config.PAYPAL_ENVIRONMENT);
  console.log(' Base URL:', config.PAYPAL_API_BASE_URL);
  console.log(' Contacting PayPal OAuth endpoint...');

  const client = new PayPalOAuthClient({
    clientId,
    clientSecret,
    environment: config.PAYPAL_ENVIRONMENT,
    apiBaseUrl: config.PAYPAL_API_BASE_URL,
    timeoutMs: 10000,
  });

  try {
    const result = await client.verifyCredentials('cli-diagnostic');
    console.log('\n Authentication Result: SUCCESS');
    console.log(` Token Type: ${result.tokenType}`);
    console.log(` Expires In: ${result.expiresInSeconds} seconds`);
    console.log(` Expiry Timestamp (UTC): ${result.expiresAt}`);
    if (result.appId) {
      console.log(` App ID: ${result.appId}`);
    }
    console.log(' (Access token validated and withheld for security)');
    console.log('======================================================\n');
    return { success: true, message: 'Authentication successful' };
  } catch (err: unknown) {
    console.log('\n Authentication Result: FAILED');
    if (err instanceof PayPalOAuthError) {
      console.log(` Code: ${err.code}`);
      console.log(` Status: ${err.statusCode ?? 'N/A'}`);
      console.log(` Message: ${err.message}`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(` Error: ${msg}`);
    }
    console.log(' (Credentials and authorization headers withheld for security)');
    console.log('======================================================\n');
    return { success: false, message: 'Authentication failed' };
  }
}

// Allow direct execution
if (
  process.argv[1]?.endsWith('verify-paypal.ts') ||
  process.argv[1]?.endsWith('verify-paypal.js')
) {
  runPayPalAuthVerification().then((res) => {
    if (!res.success && res.message !== 'Skipped: credentials not set') {
      process.exitCode = 1;
    }
  });
}
