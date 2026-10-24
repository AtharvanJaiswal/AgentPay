# Local Development Guide

## Prerequisites

- **Node.js**: `v24.x LTS`
- **Package Manager**: `pnpm` (version `9.15.4` or later)
- **Container Engine**: Docker Desktop or Docker Engine (`>= 24.x`) with Docker Compose (`>= v2.20`)
- **Git**

## Setup Instructions

### 1. Clone & Configure Environment

```bash
# Clone the repository
git clone https://github.com/AtharvanJaiswal/AgentPay.git
cd AgentPay

# Copy example environment configuration
cp .env.example .env
```

### 2. Install Dependencies

Install all monorepo dependencies using a frozen lockfile:

```bash
pnpm install --frozen-lockfile
```

### 3. Build Shared Packages

Shared packages (`@agentpay/contracts`, `@agentpay/config`, `@agentpay/logger`, `@agentpay/test-utils`) must be built prior to running individual services in standalone TypeScript mode:

```bash
pnpm build
```

## Running the Application

### Option A: Docker-First (Recommended)

Start the entire microservices mesh, frontend, and PostgreSQL in isolated containers:

```bash
# Build all images
docker compose build

# Start services in the background
docker compose up -d

# Verify container health
docker compose ps

# Follow logs
docker compose logs --tail=100 -f

# Gracefully stop containers (preserves database volume)
docker compose down
```

> [!CAUTION] > **Never run `docker compose down -v`** in routine development, as it will wipe the local PostgreSQL volume and all recorded audit history.

### Option B: Local Node.js Development

If you prefer to run services natively during active code changes:

1. Start only PostgreSQL via Docker:
   ```bash
   docker compose up -d postgres
   ```
2. Apply database migrations:
   ```bash
   pnpm db:migrate
   ```
3. Start the API Gateway:
   ```bash
   pnpm --filter @agentpay/api-gateway dev
   ```
4. Start the Web App:
   ```bash
   pnpm --filter @agentpay/web dev
   ```

## Database Management & Migrations

Migrations are stored in `db/migrations/` and tracked idempotently in the `schema_migrations` table.

```bash
# Run migrations safely
pnpm db:migrate
```

To reset the development database safely without losing custom configuration:

```bash
docker compose exec postgres psql -U agentpay -d agentpay -c "TRUNCATE audit_events;"
```

---

## PayPal Sandbox OAuth Configuration (Phase 1A)

The payment microservice includes a lightweight, secure OAuth client for the official PayPal Sandbox (`https://api-m.sandbox.paypal.com/v1/oauth2/token`). By default, `PAYMENT_PROVIDER=mock` and `PAYMENTS_ENABLED=false`, keeping the platform completely decoupled from third-party networks during routine development.

### 1. Obtaining Sandbox Credentials

1. Log into the [PayPal Developer Portal](https://developer.paypal.com/dashboard/).
2. Navigate to **Apps & Credentials** and select the **Sandbox** tab.
3. Select or create a REST API App.
4. Copy the **Client ID** and **Secret**.

### 2. Secure Configuration

Add your sandbox credentials strictly to your local, uncommitted `.env` file (copied from `.env.example`):

```env
# PayPal Sandbox Credentials (SERVER-SIDE ONLY - NEVER COMMIT TO GIT)
PAYPAL_CLIENT_ID=your_sandbox_client_id_here
PAYPAL_CLIENT_SECRET=your_sandbox_client_secret_here
PAYPAL_ENVIRONMENT=sandbox
PAYPAL_API_BASE_URL=https://api-m.sandbox.paypal.com
```

> [!CAUTION]
>
> - Never commit `.env` or paste real credentials into GitHub issues, PRs, or chat logs.
> - Credentials and OAuth access tokens are never logged or stored in audit payloads.
> - Basic Authentication headers and access tokens are strictly withheld from client-facing endpoints.

### 3. Safe Diagnostic Verification

AgentPay provides an explicit diagnostic command to test Sandbox authentication without triggering payment side effects or exposing secrets:

```bash
# Run safe PayPal OAuth diagnostic
pnpm verify:paypal
```

When valid credentials are present, the CLI verifies the OAuth handshake and reports:

- Authentication status (`SUCCESS` / `FAILED`)
- Environment (`sandbox`)
- Token expiry time in seconds
- Associated App ID (if returned by PayPal)
- **Never prints the raw access token, client secret, or Basic Authorization header.**

If credentials are absent, the command safely reports:
`Status: SKIPPED (No credentials configured)` and exits with code 0 without failing CI.

### 4. PayPal Orders v2 Sandbox Order Lifecycle (Phase 1B)

To test the real PayPal Sandbox order lifecycle (create order, inspect approval URL, and retrieve order state):

```bash
# Test PayPal Orders v2 Sandbox flow
pnpm test:paypal-order
```

This diagnostic script:

1. Contacts PayPal Sandbox `POST /v2/checkout/orders` using server-authoritative amounts ($1.00 USD).
2. Extracts and displays the PayPal buyer approval link (`rel: "payer-action"` / `rel: "approve"`).
3. Validates order state via `GET /v2/checkout/orders/{id}` (`PAYER_ACTION_REQUIRED`).
4. Logs the created order ID and instructions for manual Sandbox buyer approval and capture.

### 5. Running Unit and Integration Tests

Unit tests simulate the full PayPal OAuth and Orders v2 lifecycle using mocked HTTP responses and require no live network or credentials:

```bash
# Run payment-service tests
pnpm --filter @agentpay/payment-service test
```
