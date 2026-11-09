import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const colors = {
  'audit-service': '\x1b[35m',   // magenta
  'policy-service': '\x1b[34m',  // blue
  'payment-service': '\x1b[32m', // green
  'agent-service': '\x1b[33m',   // yellow
  'api-gateway': '\x1b[36m',     // cyan
  'web': '\x1b[31m',             // red
  reset: '\x1b[0m',
};

const isWin = process.platform === 'win32';
const nodeBin = process.execPath;
const nextBin = path.join(root, 'apps', 'web', 'node_modules', '.bin', isWin ? 'next.cmd' : 'next');

const services = [
  {
    name: 'audit-service',
    cmd: nodeBin,
    args: ['dist/index.js'],
    cwd: path.join(root, 'services', 'audit-service'),
  },
  {
    name: 'policy-service',
    cmd: nodeBin,
    args: ['dist/index.js'],
    cwd: path.join(root, 'services', 'policy-service'),
  },
  {
    name: 'payment-service',
    cmd: nodeBin,
    args: ['dist/index.js'],
    cwd: path.join(root, 'services', 'payment-service'),
  },
  {
    name: 'agent-service',
    cmd: nodeBin,
    args: ['dist/index.js'],
    cwd: path.join(root, 'services', 'agent-service'),
  },
  {
    name: 'api-gateway',
    cmd: nodeBin,
    args: ['dist/index.js'],
    cwd: path.join(root, 'services', 'api-gateway'),
  },
  {
    name: 'web',
    cmd: nextBin,
    args: ['start', '-p', '3000'],
    cwd: path.join(root, 'apps', 'web'),
  },
];

const children = [];

function log(name, message) {
  const color = colors[name] || '';
  const lines = message.toString().trim().split('\n');
  for (const line of lines) {
    if (line) {
      console.log(`${color}[${name}]${colors.reset} ${line}`);
    }
  }
}

console.log('Starting AgentPay platform (all services + web dashboard)...\n');

for (const svc of services) {
  const child = spawn(svc.cmd, svc.args, {
    cwd: svc.cwd,
    env: process.env,
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
  console.log('\nShutting down all services...');
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
