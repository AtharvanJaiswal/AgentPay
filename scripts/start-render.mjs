import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const isWin = process.platform === 'win32';
const nodeBin = process.execPath;
const nextBin = path.join(root, 'apps', 'web', 'node_modules', '.bin', isWin ? 'next.cmd' : 'next');
const tsxBin = path.join(root, 'node_modules', '.bin', isWin ? 'tsx.cmd' : 'tsx');

// Render assigns an external port via PORT (usually 10000 or 3000)
const PUBLIC_PORT = process.env.PORT || '3000';
const HOST = '0.0.0.0';

// Fixed internal ports for microservices mesh (internal loopback 127.0.0.1)
const INTERNAL_GATEWAY_PORT = '4000';
const INTERNAL_AGENT_PORT = '4001';
const INTERNAL_POLICY_PORT = '4002';
const INTERNAL_PAYMENT_PORT = '4003';
const INTERNAL_AUDIT_PORT = '4004';

const colors = {
  'audit-service': '\x1b[35m',   // magenta
  'policy-service': '\x1b[34m',  // blue
  'payment-service': '\x1b[32m', // green
  'agent-service': '\x1b[33m',   // yellow
  'api-gateway': '\x1b[36m',     // cyan
  'web': '\x1b[31m',             // red
  reset: '\x1b[0m',
};

function log(name, message) {
  const color = colors[name] || '';
  const lines = message.toString().trim().split('\n');
  for (const line of lines) {
    if (line) {
      console.log(`${color}[${name}]${colors.reset} ${line}`);
    }
  }
}

// 1. Run database migrations if DATABASE_URL is configured
async function runMigrationsIfAvailable() {
  if (!process.env.DATABASE_URL) {
    console.log('[start-render] No DATABASE_URL configured. Audit & payment services will use fallback persistence.');
    return;
  }

  console.log('[start-render] DATABASE_URL detected. Running database migrations...');
  return new Promise((resolve) => {
    const mig = spawn(tsxBin, ['db/migrate.ts'], {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
      shell: isWin && tsxBin.endsWith('.cmd'),
    });

    mig.on('close', (code) => {
      if (code === 0) {
        console.log('[start-render] Migrations applied successfully.');
      } else {
        console.warn(`[start-render] Migrations exited with code ${code}. Continuing startup...`);
      }
      resolve();
    });

    mig.on('error', (err) => {
      console.warn(`[start-render] Could not run migrations: ${err.message}. Continuing startup...`);
      resolve();
    });
  });
}

// 2. Start all services
async function main() {
  await runMigrationsIfAvailable();

  console.log(`\n======================================================`);
  console.log(` Starting AgentPay unified stack for Render...`);
  console.log(` Public Web Dashboard: port ${PUBLIC_PORT}`);
  console.log(` Internal API Gateway: port ${INTERNAL_GATEWAY_PORT}`);
  console.log(` Internal Services: ports 4001-4004`);
  console.log(`======================================================\n`);

  const services = [
    {
      name: 'audit-service',
      cmd: nodeBin,
      args: ['dist/index.js'],
      cwd: path.join(root, 'services', 'audit-service'),
      env: {
        ...process.env,
        PORT: INTERNAL_AUDIT_PORT,
        HOST: '0.0.0.0',
      },
    },
    {
      name: 'policy-service',
      cmd: nodeBin,
      args: ['dist/index.js'],
      cwd: path.join(root, 'services', 'policy-service'),
      env: {
        ...process.env,
        PORT: INTERNAL_POLICY_PORT,
        HOST: '0.0.0.0',
      },
    },
    {
      name: 'payment-service',
      cmd: nodeBin,
      args: ['dist/index.js'],
      cwd: path.join(root, 'services', 'payment-service'),
      env: {
        ...process.env,
        PORT: INTERNAL_PAYMENT_PORT,
        HOST: '0.0.0.0',
        POLICY_SERVICE_URL: `http://127.0.0.1:${INTERNAL_POLICY_PORT}`,
      },
    },
    {
      name: 'agent-service',
      cmd: nodeBin,
      args: ['dist/index.js'],
      cwd: path.join(root, 'services', 'agent-service'),
      env: {
        ...process.env,
        PORT: INTERNAL_AGENT_PORT,
        HOST: '0.0.0.0',
      },
    },
    {
      name: 'api-gateway',
      cmd: nodeBin,
      args: ['dist/index.js'],
      cwd: path.join(root, 'services', 'api-gateway'),
      env: {
        ...process.env,
        PORT: INTERNAL_GATEWAY_PORT,
        HOST: '0.0.0.0',
        AGENT_SERVICE_URL: `http://127.0.0.1:${INTERNAL_AGENT_PORT}`,
        POLICY_SERVICE_URL: `http://127.0.0.1:${INTERNAL_POLICY_PORT}`,
        PAYMENT_SERVICE_URL: `http://127.0.0.1:${INTERNAL_PAYMENT_PORT}`,
        AUDIT_SERVICE_URL: `http://127.0.0.1:${INTERNAL_AUDIT_PORT}`,
        APP_BASE_URL: process.env.APP_BASE_URL || `http://localhost:${PUBLIC_PORT}`,
      },
    },
    {
      name: 'web',
      cmd: nextBin,
      args: ['start', '-p', String(PUBLIC_PORT), '-H', HOST],
      cwd: path.join(root, 'apps', 'web'),
      env: {
        ...process.env,
        PORT: String(PUBLIC_PORT),
        HOSTNAME: HOST,
        API_GATEWAY_URL: `http://127.0.0.1:${INTERNAL_GATEWAY_PORT}`,
      },
    },
  ];

  const children = [];

  for (const svc of services) {
    const child = spawn(svc.cmd, svc.args, {
      cwd: svc.cwd,
      env: svc.env,
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: isWin && svc.cmd.endsWith('.cmd'),
    });

    child.stdout.on('data', (d) => log(svc.name, d));
    child.stderr.on('data', (d) => log(svc.name, d));

    child.on('close', (code) => {
      log(svc.name, `Process exited with code ${code}`);
    });

    children.push(child);
  }

  function shutdown() {
    console.log('\n[start-render] Shutting down all services gracefully...');
    for (const child of children) {
      if (isWin) {
        spawn('taskkill', ['/pid', String(child.pid), '/f', '/t']);
      } else {
        child.kill('SIGTERM');
      }
    }
  }

  process.on('SIGINT', () => {
    shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    shutdown();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[start-render] Fatal error:', err);
  process.exit(1);
});
