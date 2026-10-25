import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getPaymentServiceConfig, loadRootEnv } from '@agentpay/config';
import { PayPalOAuthClient } from './oauth-client.js';

export async function startPayPalMcpWrapper(): Promise<void> {
  // Deterministically load root .env
  loadRootEnv({ startDir: fileURLToPath(import.meta.url) });

  const config = getPaymentServiceConfig();
  const clientId = config.PAYPAL_CLIENT_ID;
  const clientSecret = config.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error(
      '[PayPal MCP Wrapper] Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET in environment.',
    );
    process.exit(1);
  }

  const oauthClient = new PayPalOAuthClient({
    clientId,
    clientSecret,
    environment: config.PAYPAL_ENVIRONMENT,
    apiBaseUrl: config.PAYPAL_API_BASE_URL,
    timeoutMs: 15000,
  });

  let accessToken: string;
  try {
    accessToken = await oauthClient.getAccessToken('mcp-wrapper-init');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[PayPal MCP Wrapper] Failed to acquire OAuth token: ${message}`);
    process.exit(1);
  }

  const userArgs = process.argv.slice(2);
  const args = userArgs.length > 0 ? userArgs : ['--tools=all'];

  // On Windows, spawning .cmd requires shell: true in Node 22+ / 24+
  const child = spawn('npx', ['-y', '@paypal/mcp', ...args], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      PAYPAL_ACCESS_TOKEN: accessToken,
      PAYPAL_ENVIRONMENT: 'SANDBOX',
    },
  });

  child.on('error', (err) => {
    console.error(`[PayPal MCP Wrapper] Failed to start @paypal/mcp: ${err.message}`);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });
}

if (process.argv[1]?.endsWith('mcp-wrapper.ts') || process.argv[1]?.endsWith('mcp-wrapper.js')) {
  startPayPalMcpWrapper();
}
