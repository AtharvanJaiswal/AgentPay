import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { getPaymentServiceConfig, loadRootEnv, type PaymentServiceConfig } from '@agentpay/config';
import { PayPalOAuthClient, PayPalOAuthError } from '../paypal/oauth-client.js';

export async function configurePayPalMcp(
  configOverride?: Partial<PaymentServiceConfig>,
): Promise<{ success: boolean; message: string }> {
  loadRootEnv({ startDir: fileURLToPath(import.meta.url) });

  let config: PaymentServiceConfig;
  try {
    const baseConfig = getPaymentServiceConfig();
    config = configOverride ? { ...baseConfig, ...configOverride } : baseConfig;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log('\n[PayPal MCP Configuration]');
    console.log('Status: CONFIGURATION_ERROR');
    console.log(`Details: ${msg}`);
    return { success: false, message: msg };
  }

  const clientId = config.PAYPAL_CLIENT_ID;
  const clientSecret = config.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.log('\n[PayPal MCP Configuration]');
    console.log('Status: FAILED (No credentials configured in environment)');
    return { success: false, message: 'Missing credentials' };
  }

  const oauthClient = new PayPalOAuthClient({
    clientId,
    clientSecret,
    environment: config.PAYPAL_ENVIRONMENT,
    apiBaseUrl: config.PAYPAL_API_BASE_URL,
    timeoutMs: 10000,
  });

  try {
    // 1. Verify credentials and get safe diagnostic metadata
    const verifyResult = await oauthClient.verifyCredentials('mcp-setup-verify');

    // 2. Obtain fresh access token in memory (never printed or logged)
    const token = await oauthClient.getAccessToken('mcp-setup-token');

    // 3. Resolve MCP configuration file path
    const mcpConfigPath = path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');

    if (!fs.existsSync(mcpConfigPath)) {
      throw new Error(`MCP configuration file not found at ${mcpConfigPath}`);
    }

    const rawConfig = fs.readFileSync(mcpConfigPath, 'utf8');
    const mcpConfig = JSON.parse(rawConfig || '{}');

    if (!mcpConfig.mcpServers || typeof mcpConfig.mcpServers !== 'object') {
      mcpConfig.mcpServers = {};
    }

    // 4. Update the PayPal MCP server entry with the temporary access token
    mcpConfig.mcpServers.paypal = {
      command: 'npx',
      args: ['-y', '@paypal/mcp', '--tools=all'],
      env: {
        PAYPAL_ACCESS_TOKEN: token,
        PAYPAL_ENVIRONMENT: 'SANDBOX',
      },
    };

    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), 'utf8');

    console.log('\n======================================================');
    console.log(' [PayPal MCP Server Configuration]');
    console.log(' Status: READY');
    console.log(` Environment:         ${config.PAYPAL_ENVIRONMENT.toUpperCase()}`);
    console.log(` Target Config:       ${mcpConfigPath}`);
    console.log(` Token Type:          ${verifyResult.tokenType}`);
    console.log(` Expires In (sec):    ${verifyResult.expiresInSeconds}`);
    console.log(` Expiry Timestamp:    ${verifyResult.expiresAt}`);
    if (verifyResult.appId) {
      console.log(` App ID:              ${verifyResult.appId}`);
    }
    console.log(' Security Guarantee:  Token safely injected into MCP config without display.');
    console.log(' Orders Policy:       0 orders created, 0 orders captured.');
    console.log('======================================================\n');

    return { success: true, message: 'PayPal MCP server configured successfully' };
  } catch (err: unknown) {
    console.log('\n[PayPal MCP Configuration Failed]');
    if (err instanceof PayPalOAuthError) {
      console.log(`Code: ${err.code}`);
      console.log(`Message: ${err.message}`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`Error: ${msg}`);
    }
    return { success: false, message: 'Failed to configure PayPal MCP server' };
  }
}

// Allow direct CLI execution
if (
  process.argv[1]?.endsWith('configure-paypal-mcp.ts') ||
  process.argv[1]?.endsWith('configure-paypal-mcp.js')
) {
  configurePayPalMcp().then((res) => {
    if (!res.success) {
      process.exitCode = 1;
    }
  });
}
