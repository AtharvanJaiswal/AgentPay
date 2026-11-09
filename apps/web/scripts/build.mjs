import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '..');

// Next.js static prerendering strictly requires NODE_ENV=production during build.
const env = {
  ...process.env,
  NODE_ENV: 'production',
};

const isWin = process.platform === 'win32';
const nextBin = path.join(webRoot, 'node_modules', '.bin', isWin ? 'next.cmd' : 'next');

const child = isWin
  ? spawn('cmd.exe', ['/d', '/s', '/c', `"${nextBin}"`, 'build'], {
      cwd: webRoot,
      env,
      stdio: 'inherit',
      windowsVerbatimArguments: true,
    })
  : spawn(nextBin, ['build'], {
      cwd: webRoot,
      env,
      stdio: 'inherit',
    });

child.on('close', (code) => {
  process.exit(code ?? 0);
});
