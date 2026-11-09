#!/usr/bin/env bash
set -e

echo "[render-build] Enabling corepack and pnpm..."
corepack enable
corepack prepare pnpm@9.15.4 --activate

echo "[render-build] Installing dependencies..."
pnpm install --frozen-lockfile

echo "[render-build] Building all workspace packages and applications..."
pnpm build

echo "[render-build] Build complete!"
