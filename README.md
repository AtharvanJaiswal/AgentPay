# AgentPay

> **"AI proposes. Policy enforces. PayPal executes. The audit trail proves what happened."**

AgentPay is a verifiable payment-authorization and audit platform for autonomous AI agents. It establishes an unbypassable policy and audit perimeter between non-deterministic AI agent reasoning and actual financial execution — ensuring that every payment originates from a validated proposal, passes deterministic policy rules, and is immutably recorded before any funds move.

[![CI](https://github.com/AtharvanJaiswal/AgentPay/actions/workflows/ci.yml/badge.svg)](https://github.com/AtharvanJaiswal/AgentPay/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

---

## Table of Contents

- [Problem Statement](#problem-statement)
- [Architecture](#architecture)
- [Technology Stack](#technology-stack)
- [Implementation Status](#implementation-status)
- [Security Model](#security-model)
- [Prerequisites](#prerequisites)
- [Setup and Installation](#setup-and-installation)
- [Environment Variables](#environment-variables)
- [Development and Verification](#development-and-verification)
- [API Reference](#api-reference)
- [Database and Audit Trail](#database-and-audit-trail)
- [CI/CD](#cicd)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)
- [License](#license)

---

## Problem Statement

Autonomous AI agents that can browse the web, write code, and execute tasks are increasingly capable of initiating real financial transactions. Without an independent authorization layer, this creates serious risks:

- **Unconstrained spending**: An agent may generate a proposal for an arbitrary amount with no enforced ceiling.
- **Unauditable execution**: Without an immutable audit trail, there is no trustworthy record of why a payment was made.
- **Race conditions and double-spend**: Retried agent requests without idempotency guarantees can result in duplicate charges.
- **No human checkpoint**: High-value or unusual transactions may proceed without any human review.
- **Authorization bypass**: A compromised or misbehaving agent could submit fabricated approval status to trigger payment capture.

AgentPay addresses each of these through deterministic server-side policy enforcement, integer minor-unit monetary arithmetic, idempotency keys, request-hash binding, and a monotonic audit ledger — none of which can be bypassed by the agent layer.

---

## Architecture

```mermaid
flowchart TD
    subgraph Browser["Client / Browser"]
        Web["Web Application\nNext.js (:3000)"]
    end

    subgraph PublicBoundary["Public API Boundary"]
        GW["API Gateway\nFastify (:4000)\nRate limiting · CORS · Correlation IDs"]
    end

    subgraph InternalMesh["Internal Docker Network (Private — not host-exposed)"]
        Agent["Agent Service\n(:4001)\nProposal generation"]
        Policy["Policy Service\n(:4002)\nDeterministic rules engine"]
        Payment["Payment Service\n(:4003)\nMock · PayPal Sandbox adapter"]
        Audit["Audit Service\n(:4004)\nPostgreSQL audit recorder"]
    end

    subgraph External["External (Sandbox Only)"]
        PayPal["PayPal Sandbox\nOrders v2 API"]
    end

    subgraph Storage["Persistent Storage"]
        Postgres[("PostgreSQL 17\naudit_events\npayment_orders\nwebhook_events")]
    end

    Web -->|"User request"| GW
    GW -->|"1. Generate proposal"| Agent
    GW -->|"2. Evaluate policy (independent)"| Policy
    GW -->|"3. Create / capture order (ALLOW only)"| Payment
    GW -->|"4. Record audit event"| Audit
    Policy -->|"Log decision"| Audit
    Payment -->|"Log order / capture"| Audit
    Payment -->|"PayPal Sandbox API calls"| PayPal
    Audit -->|"Parameterized SQL"| Postgres
    Payment -->|"payment_orders · webhook_events"| Postgres
```

### Service and Package Inventory

| Component                  | Port | Exposed to Host | Description                                                                               |
| -------------------------- | ---- | --------------- | ----------------------------------------------------------------------------------------- |
| `apps/web`                 | 3000 | ✅ Yes          | Next.js 15 web application — status dashboard and policy simulator                        |
| `services/api-gateway`     | 4000 | ✅ Yes          | Fastify public API gateway — rate limiting, CORS, correlation ID propagation              |
| `services/agent-service`   | 4001 | Internal only   | Proposal generation from raw intent input                                                 |
| `services/policy-service`  | 4002 | Internal only   | Deterministic policy rules engine (amount limits, currency whitelist, category blacklist) |
| `services/payment-service` | 4003 | Internal only   | Payment provider abstraction — Mock and PayPal Sandbox adapter                            |
| `services/audit-service`   | 4004 | Internal only   | Immutable audit event recorder backed by PostgreSQL                                       |
| `packages/contracts`       | —    | —               | Shared Zod schemas and TypeScript interfaces across all services                          |
| `packages/config`          | —    | —               | Validated, Zod-parsed environment configuration loaders with `.env` auto-discovery        |
| `packages/logger`          | —    | —               | Pino-based structured JSON logger with credential redaction                               |
| `packages/test-utils`      | —    | —               | Deterministic test factories and proposal fixtures                                        |

---

## Technology Stack

| Category                   | Technology                 | Version            |
| -------------------------- | -------------------------- | ------------------ |
| Language                   | TypeScript                 | 5.7.3              |
| Runtime                    | Node.js                    | 24.x LTS           |
| Package Manager            | pnpm                       | 9.15.4             |
| Web Application            | Next.js                    | 15.x               |
| API Framework              | Fastify                    | 5.2.1              |
| Schema Validation          | Zod                        | 3.24.1             |
| Database                   | PostgreSQL                 | 17-alpine (Docker) |
| Containerisation           | Docker Compose             | v2                 |
| Unit / Integration Tests   | Vitest                     | 2.1.8              |
| E2E Tests                  | Playwright                 | 1.49.1             |
| Linter                     | ESLint + typescript-eslint | 9.18.0 / 8.20.0    |
| Formatter                  | Prettier                   | 3.4.2              |
| CI/CD                      | GitHub Actions             | —                  |
| Payment Provider (Sandbox) | PayPal Orders v2 REST API  | —                  |

---

## Implementation Status

> [!WARNING] > **Default configuration: mock payments, payments disabled.** > `PAYMENT_PROVIDER=mock` and `PAYMENTS_ENABLED=false` are the defaults in `.env.example`, `docker-compose.yml`, and all CI pipelines. No real funds move without explicit developer configuration.

### ✅ Phase 0 — Engineering Foundation (Complete)

- **Monorepo**: pnpm workspaces with `apps/`, `services/`, and `packages/` layout.
- **Shared packages**: `@agentpay/contracts`, `@agentpay/config`, `@agentpay/logger`, `@agentpay/test-utils`.
- **Microservices mesh**: All five backend services wired with health checks, correlation ID propagation, and CORS.
- **PostgreSQL persistence**: `audit_events` and `schema_migrations` tables via `db/migrations/001_create_audit_events.sql`.
- **Mock payment provider**: Safe zero-fund `MockPaymentProvider` implementing `PaymentProvider` interface.
- **Docker Compose**: Full multi-service orchestration with `service_healthy` dependency conditions.
- **CI/CD**: Three-stage GitHub Actions pipeline (code quality → unit/integration tests → Docker build + Playwright E2E).
- **Policy engine**: Deterministic rules — hard ceiling (USD 2,000), high-value human-approval threshold (USD 500), currency whitelist (USD), category blacklist (gambling, cryptocurrency, weapons, adult entertainment).
- **Audit trail**: Sanitised PostgreSQL audit log with `correlation_id`, `event_type`, `actor`, `outcome`, and `metadata`.

### ✅ Phase 1A — PayPal Sandbox OAuth Adapter (Complete)

- Zero-dependency OAuth 2.0 client (`PayPalOAuthClient`) using the `client_credentials` grant.
- Basic Auth credential construction entirely server-side; credentials never logged.
- In-memory token caching with 60-second pre-expiry refresh buffer.
- Strict sandbox enforcement: `PAYPAL_ENVIRONMENT=live` and live API hostnames (`api-m.paypal.com`) are rejected at both the Zod config schema level and the client constructor level.
- `GET /paypal/verify-auth` diagnostic endpoint (reports token metadata only — no credential or token values).
- `pnpm verify:paypal` CLI tool for safe credential verification.

### 🔄 Phase 1B — PayPal Sandbox Order Lifecycle (In Progress)

The following have been implemented and tested:

**Order creation and persistence**

- `PayPalOrdersClient` sends `POST /v2/checkout/orders` with `intent: CAPTURE`, validated amounts, and `payment_source.paypal.experience_context` for return/cancel URLs.
- Amounts and currencies derived exclusively from the server-validated `PurchaseProposal` — the client cannot supply its own monetary values.
- `payment_orders` PostgreSQL table ([`db/migrations/002_create_payment_orders.sql`](db/migrations/002_create_payment_orders.sql)) persists order ID, proposal ID, policy decision ID, status, currency, amount, approval URL, capture ID, idempotency key, and request hash.

**Buyer approval URL**

- Approval URL extracted from PayPal's HATEOAS `links[]` (`rel: "approve"` or `rel: "payer-action"`). Never manually constructed.
- `/orders/success` and `/orders/cancelled` routes registered as PayPal return/cancel endpoints.

**Order retrieval and status polling**

- `GET /orders/:id` queries PayPal's `GET /v2/checkout/orders/:id` and updates local status monotonically.

**Proposal amount and currency consistency validation**

- `validateProposalAmountsAndCurrency()` fires before any OAuth or network call.
- Enforces: positive safe-integer amounts, 3-letter ISO currency code, per-item currency match, and exact equality of `Σ(unitPriceMinor × quantity) === totalAmountMinor`.
- Safe-integer overflow guards on both multiplication and addition.
- Rejects invalid proposals with `HTTP 400 VALIDATION_ERROR`.

**Capture authorization**

- `POST /orders/:id/capture` re-verifies buyer approval status against PayPal's live API before executing capture — local stored status alone is insufficient.
- Policy decision ID from order creation must be supplied and match the stored server-side value.

**Idempotency**

- Orders and captures use stable idempotency keys bound to a SHA-256 request hash (`requestHash`) of the proposal.
- Replayed requests with the same key and identical payload return the cached result.
- Replayed requests with the same key but a different proposal are rejected with `HTTP 409 IDEMPOTENCY_CONFLICT`.

**Webhook verification and deduplication**

- `POST /webhooks/paypal` verifies PayPal transmission signature cryptographically via `POST /v1/notifications/verify-webhook-signature`.
- Transmission IDs are stored in `webhook_events` to prevent duplicate processing.
- Order status transitions are monotonic: a `COMPLETED` order cannot be regressed to `APPROVED` by a late webhook.

**Timeout and unknown-outcome safety**

- Capture requests that time out throw `PayPalCaptureTimeoutError`, which marks the order `UNKNOWN` in the repository rather than assuming success or failure.
- Orders in `UNKNOWN` state require manual or automated reconciliation before releasing budget.

**⚠️ Outstanding issue — Sandbox buyer approval**

- Order creation succeeds (HTTP 201) and PayPal returns an approval URL.
- During buyer approval at the PayPal checkout page, the Sandbox reports: _"This seller doesn't accept payments in your currency."_
- Investigation confirms this is not an application-code defect. The API payload sends `currency_code: "USD"` consistently. The `payee` field is correctly absent (PayPal routes to the OAuth token owner).
- The most likely cause is the Sandbox Business merchant account's **payment receiving preference**, which defaults to blocking currencies not already held. This must be resolved in the [PayPal Developer Dashboard](https://developer.paypal.com/) — see [Troubleshooting](#paypal-sandbox-buyer-approval-currency-error) below.
- **End-to-end Sandbox capture has not been completed and is not claimed.**

---

## Security Model

### Policy enforcement is server-side and unbypassable

The API gateway independently evaluates every proposal against the policy engine before forwarding any request to the payment service. A client submitting `authorizedOutcome: "ALLOW"` cannot skip this check — the gateway discards the client-supplied outcome and re-evaluates from scratch.

### Trusted server-side amounts

Monetary values in the PayPal order payload are derived entirely from the server-validated `PurchaseProposal`. The payment service does not accept client-supplied price fields. Minor-unit (integer cent) arithmetic is used throughout; floating-point is only used when converting to PayPal's decimal string format via `.toFixed(2)` after validation.

### Currency and item-total consistency

`validateProposalAmountsAndCurrency` enforces exact arithmetic equality `Σ(unitPriceMinor × quantity) === totalAmountMinor` and currency consistency across all items before any network request. Overflow is detected on both multiplication and running sum.

### Policy authorization before capture

The capture endpoint requires a `policyDecisionId` that must match the value stored at order-creation time on the server. A fabricated or mismatched decision ID returns `HTTP 403 POLICY_VIOLATION` with zero PayPal API calls made. Additionally, capture independently re-verifies buyer approval status against PayPal's live API — a locally forged `APPROVED` status does not bypass this check.

### Idempotency safeguards

Every order creation and capture includes a stable `PayPal-Request-Id` idempotency key. Request hashes prevent payload substitution attacks on reused keys.

### Webhook verification

PayPal webhooks are verified cryptographically before any state transition. Duplicate transmission IDs are idempotently accepted but not reprocessed.

### Safe timeout handling

Capture timeouts result in `UNKNOWN` status — not a success assumption. Manual or automated reconciliation is required before the budget is released.

### Sandbox-only guard

`PAYPAL_ENVIRONMENT=live` is rejected at the Zod schema level. Live PayPal API hostnames (`api-m.paypal.com`, `api.paypal.com`) are rejected both in the config schema and in the `PayPalOAuthClient` constructor. These guards cannot be bypassed without modifying the source code.

### Credential safety

OAuth credentials (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`) are read from environment variables only. Basic Auth headers, access tokens, and client secrets are never logged, returned in responses, or included in error messages.

---

## Prerequisites

- **Node.js** v24.x LTS
- **pnpm** 9.15.4 — `npm install -g pnpm@9.15.4`
- **Docker Desktop** with Docker Compose v2 (Docker 24+)
- **Git**

---

## Setup and Installation

### 1. Clone the repository

```powershell
git clone https://github.com/AtharvanJaiswal/AgentPay.git
Set-Location AgentPay
```

### 2. Install dependencies

```powershell
pnpm install
```

### 3. Configure environment

```powershell
Copy-Item .env.example .env
```

Edit `.env` for your local setup. The defaults work out of the box for Docker Compose development. **Never commit `.env` to version control.** The `.gitignore` excludes it, and the `.env.example` contains only safe placeholders.

### 4. Validate the Docker Compose configuration

```powershell
docker compose config
```

### 5. Build and start the full stack

```powershell
docker compose up -d --build
```

This starts PostgreSQL (with automatic migration), audit-service, policy-service, agent-service, payment-service, api-gateway, and the web application.

### 6. Verify services are healthy

```powershell
docker compose ps
# All services should show "(healthy)"
```

Open [http://localhost:3000](http://localhost:3000) to view the web dashboard.
Open [http://localhost:4000/api/health](http://localhost:4000/api/health) to see the API gateway health summary.

### 7. Stop services

```powershell
docker compose down
```

> [!CAUTION]
> Do not use `docker compose down -v` during routine development — it destroys the persistent PostgreSQL volume containing your audit history.

---

### Local Development Without Docker

If you prefer to run services individually (PostgreSQL must still be running):

```powershell
# Start PostgreSQL only
docker compose up -d postgres

# Run database migrations
pnpm db:migrate

# Start all services in development mode (tsx watch)
pnpm dev
```

---

## Environment Variables

Copy `.env.example` to `.env`. Values marked `[required for PayPal]` are only needed when using the PayPal Sandbox adapter.

| Variable               | Default                                                         | Description                                                      |
| ---------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------- |
| `NODE_ENV`             | `development`                                                   | Runtime environment                                              |
| `LOG_LEVEL`            | `info`                                                          | `debug`, `info`, `warn`, or `error`                              |
| `WEB_PORT`             | `3000`                                                          | Next.js web application port                                     |
| `API_GATEWAY_PORT`     | `4000`                                                          | API gateway host-exposed port                                    |
| `AGENT_SERVICE_PORT`   | `4001`                                                          | Agent service port (internal)                                    |
| `POLICY_SERVICE_PORT`  | `4002`                                                          | Policy service port (internal)                                   |
| `PAYMENT_SERVICE_PORT` | `4003`                                                          | Payment service port (internal)                                  |
| `AUDIT_SERVICE_PORT`   | `4004`                                                          | Audit service port (internal)                                    |
| `APP_BASE_URL`         | `http://localhost:3000`                                         | PayPal return/cancel URL base                                    |
| `DATABASE_URL`         | `postgresql://agentpay:agentpay_dev_pw@localhost:5432/agentpay` | PostgreSQL connection string                                     |
| `POSTGRES_USER`        | `agentpay`                                                      | PostgreSQL username                                              |
| `POSTGRES_PASSWORD`    | `agentpay_dev_pw`                                               | PostgreSQL password (change for non-local use)                   |
| `POSTGRES_DB`          | `agentpay`                                                      | PostgreSQL database name                                         |
| `PAYMENT_PROVIDER`     | `mock`                                                          | `mock` or `paypal_sandbox` — **mock is the default**             |
| `PAYMENTS_ENABLED`     | `false`                                                         | Master payment kill-switch — **false is the default**            |
| `PAYPAL_CLIENT_ID`     | _(empty)_                                                       | [required for PayPal] Sandbox REST app Client ID                 |
| `PAYPAL_CLIENT_SECRET` | _(empty)_                                                       | [required for PayPal] Sandbox REST app Client Secret             |
| `PAYPAL_ENVIRONMENT`   | `sandbox`                                                       | Only `sandbox` is permitted — `live` is rejected at schema parse |
| `PAYPAL_API_BASE_URL`  | `https://api-m.sandbox.paypal.com`                              | PayPal Sandbox base URL — live endpoints are rejected            |
| `PAYPAL_WEBHOOK_ID`    | _(empty)_                                                       | [optional] PayPal webhook ID for signature verification          |

> [!IMPORTANT] > `PAYMENT_PROVIDER=mock` and `PAYMENTS_ENABLED=false` must remain the defaults. Do not commit real PayPal credentials. Never set `PAYPAL_ENVIRONMENT=live` — this is enforced at the code level and will throw at startup.

---

## Development and Verification

All commands run from the monorepo root.

### Code quality

```powershell
# Check formatting (Prettier)
pnpm format

# Auto-fix formatting
pnpm format:fix

# Run ESLint
pnpm lint

# Auto-fix lint issues
pnpm lint:fix

# TypeScript typecheck across all workspaces
pnpm typecheck
```

### Tests

```powershell
# All Vitest tests (unit + service-level tests)
pnpm test

# Unit tests only (packages and services)
pnpm test:unit

# Integration and migration tests
pnpm test:integration

# Playwright E2E tests (requires Docker stack running)
pnpm test:e2e
```

### Build

```powershell
# Build all workspace packages
pnpm build
```

### Docker

```powershell
# Validate Compose configuration
docker compose config

# Build all Docker images
pnpm docker:build

# Start the full stack
pnpm docker:up

# Stream logs
pnpm docker:logs

# Stop all containers
pnpm docker:down
```

### PayPal Sandbox diagnostics

> [!IMPORTANT] > `pnpm verify:paypal` and `diagnose-order.ts` perform **read-only** operations only — they verify OAuth credentials and retrieve existing order status. They do not create, capture, or cancel payment orders. Do not run `pnpm test:paypal-order` unless you intentionally want to create a new Sandbox order and have explicitly configured `PAYMENT_PROVIDER=paypal_sandbox` and `PAYMENTS_ENABLED=true` in your local `.env`.

```powershell
# Verify PayPal Sandbox OAuth credentials (read-only, never logs credentials or tokens)
pnpm verify:paypal

# Diagnose an existing Sandbox order by ID (read-only GET request — replace ORDER_ID)
pnpm --filter @agentpay/payment-service tsx src/cli/diagnose-order.ts ORDER_ID

# Create a new test Sandbox order — only run intentionally
# Requires PAYMENT_PROVIDER=paypal_sandbox and PAYMENTS_ENABLED=true in .env
pnpm test:paypal-order
```

---

## API Reference

All requests through the API gateway should include `Content-Type: application/json`. Correlation IDs are automatically propagated via `x-correlation-id` headers.

### API Gateway (`http://localhost:4000`)

| Method | Path                               | Description                                             |
| ------ | ---------------------------------- | ------------------------------------------------------- |
| `GET`  | `/api/health`                      | Aggregate health status of all downstream services      |
| `GET`  | `/api/status`                      | Platform status and provider configuration summary      |
| `POST` | `/api/proposals`                   | Generate a `PurchaseProposal` from raw agent intent     |
| `POST` | `/api/evaluations`                 | Evaluate a `PurchaseProposal` against the policy engine |
| `POST` | `/api/payments/orders`             | Create a payment order (requires prior policy ALLOW)    |
| `GET`  | `/api/payments/orders/:id`         | Retrieve payment order status                           |
| `POST` | `/api/payments/orders/:id/capture` | Capture an approved payment order                       |
| `GET`  | `/api/audit-events`                | List recent audit events (`?limit=N&correlationId=...`) |

### Payment Service (internal, `:4003`)

| Method | Path                  | Description                                                      |
| ------ | --------------------- | ---------------------------------------------------------------- |
| `GET`  | `/health`             | Payment service health and provider status                       |
| `GET`  | `/paypal/verify-auth` | PayPal OAuth credential verification (token metadata only)       |
| `POST` | `/orders`             | Create payment order (called by gateway after policy evaluation) |
| `GET`  | `/orders/:id`         | Get order details and current status                             |
| `POST` | `/orders/:id/capture` | Capture authorized order (requires `policyDecisionId`)           |
| `POST` | `/webhooks/paypal`    | PayPal webhook ingestion with signature verification             |

#### Example: Create a payment order (via gateway)

```json
POST /api/payments/orders
Content-Type: application/json

{
  "proposal": {
    "id": "11111111-1111-4111-a111-111111111111",
    "intentId": "22222222-2222-4222-a222-222222222222",
    "agentId": "autonomous-agent-01",
    "merchant": {
      "id": "merchant-cloud-01",
      "name": "Cloud Infrastructure Inc",
      "category": "cloud_services"
    },
    "items": [
      {
        "id": "item-01",
        "name": "4-core Compute Node",
        "quantity": 1,
        "unitPriceMinor": 2500,
        "currency": "USD"
      }
    ],
    "totalAmountMinor": 2500,
    "currency": "USD",
    "purpose": "Automated CI worker node rental",
    "createdAt": "2026-10-24T00:00:00.000Z"
  }
}
```

Note: `totalAmountMinor` uses integer minor units (cents). USD 25.00 = `2500`.

---

## Database and Audit Trail

### Migrations

Migrations run automatically when Docker Compose starts (via PostgreSQL's `docker-entrypoint-initdb.d/`). For local non-Docker development, run `pnpm db:migrate`.

| Migration                       | Tables Created                      |
| ------------------------------- | ----------------------------------- |
| `001_create_audit_events.sql`   | `schema_migrations`, `audit_events` |
| `002_create_payment_orders.sql` | `payment_orders`, `webhook_events`  |

### `audit_events`

Records every significant event in the proposal-to-payment pipeline:

| Column           | Type    | Description                                                                                             |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------- |
| `id`             | UUID    | Primary key                                                                                             |
| `correlation_id` | VARCHAR | Links all events in a single request chain                                                              |
| `event_type`     | VARCHAR | e.g. `PROPOSAL_CREATED`, `POLICY_EVALUATED_ALLOW`, `ORDER_CREATED`, `ORDER_CAPTURED`, `PAYMENT_BLOCKED` |
| `actor`          | VARCHAR | Which service or agent performed the action                                                             |
| `resource_id`    | VARCHAR | Proposal ID, order ID, or decision ID                                                                   |
| `outcome`        | VARCHAR | `CREATED`, `ALLOW`, `DENY`, `BLOCKED`, `COMPLETED`                                                      |
| `reason_code`    | VARCHAR | Policy engine reason code, if applicable                                                                |
| `metadata`       | JSONB   | Sanitised context (amounts, merchant, environment note)                                                 |

### `payment_orders`

Persists the full lifecycle of each payment order:

| Column               | Type       | Description                                                                                |
| -------------------- | ---------- | ------------------------------------------------------------------------------------------ |
| `id`                 | VARCHAR    | PayPal order ID                                                                            |
| `proposal_id`        | UUID       | Associated proposal                                                                        |
| `policy_decision_id` | UUID       | Server-side policy authorization binding                                                   |
| `provider`           | VARCHAR    | `mock` or `paypal_sandbox`                                                                 |
| `status`             | VARCHAR    | `CREATED`, `PAYER_ACTION_REQUIRED`, `APPROVED`, `COMPLETED`, `FAILED`, `VOIDED`, `UNKNOWN` |
| `currency`           | VARCHAR(3) | ISO 4217 currency code                                                                     |
| `amount_minor`       | BIGINT     | Amount in minor units (cents)                                                              |
| `approval_url`       | TEXT       | PayPal buyer approval URL                                                                  |
| `capture_id`         | VARCHAR    | PayPal capture transaction ID                                                              |
| `idempotency_key`    | VARCHAR    | Unique per order/capture operation                                                         |
| `request_hash`       | VARCHAR    | SHA-256 hash of proposal for idempotency binding                                           |

### `webhook_events`

Stores deduplication records for PayPal webhook transmission IDs, preventing duplicate state transitions.

---

## CI/CD

Two GitHub Actions workflows are configured:

### [`ci.yml`](.github/workflows/ci.yml) — Continuous Integration

Triggers on every push and pull request to `main`. Three sequential stages:

1. **Code Quality & Type Check** — `pnpm format`, `pnpm lint`, `pnpm typecheck`
2. **Unit & Integration Tests** — builds shared packages, then runs `pnpm test:unit` and `pnpm test:integration`
3. **Docker Build & Playwright E2E** — validates `docker compose config`, builds all images, starts the full stack, runs Playwright E2E tests, and uploads artifacts on failure

### [`cd.yml`](.github/workflows/cd.yml) — Continuous Deployment

Separate CD pipeline for deployment to target environments.

All CI steps use pinned action SHAs (not floating version tags) to prevent supply-chain attacks.

---

## Troubleshooting

### Docker services not reaching `(healthy)` state

```powershell
# Check which service is unhealthy
docker compose ps

# Stream logs for a specific service
docker compose logs payment-service --tail=50
docker compose logs postgres --tail=30
```

PostgreSQL must reach `(healthy)` before dependent services start. If PostgreSQL never becomes healthy, check that port 5432 is not already in use.

### Port conflicts

Edit `.env` to change the exposed ports:

```env
WEB_PORT=3001
API_GATEWAY_PORT=4010
```

### PayPal OAuth failure (`INVALID_CREDENTIALS`)

1. Verify `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` are populated in your local `.env`.
2. Confirm the credentials are from a **Sandbox** REST API app in the [PayPal Developer Dashboard](https://developer.paypal.com/) — not a Live app.
3. Run `pnpm verify:paypal` to get a sanitised diagnostic (no credentials or tokens are printed).
4. Ensure `PAYPAL_ENVIRONMENT=sandbox` and `PAYPAL_API_BASE_URL=https://api-m.sandbox.paypal.com`.

### PayPal Sandbox buyer approval — currency error

**Observed**: _"This seller doesn't accept payments in your currency."_ at the PayPal checkout page after order creation succeeds.

**Status**: Root cause not yet fully confirmed. The most probable cause is the Sandbox Business merchant account's **payment receiving preference**, which defaults to blocking currencies not already held by the account.

**Confirmed not to be the cause** (from code inspection):

- API payload correctly sets `currency_code: "USD"` in all three currency fields.
- The `payee` field is intentionally absent from `purchase_units` (correct for single-seller integrations).
- API hostname is consistently `https://api-m.sandbox.paypal.com`.
- No Live credentials or endpoints are in use.

**Recommended resolution** (action required in PayPal Developer Dashboard):

1. Log in to [https://www.sandbox.paypal.com](https://www.sandbox.paypal.com) using the **Sandbox Business account** credentials (Developer Dashboard → Sandbox → Accounts → Business account → View/Edit).
2. Navigate to: **Settings (gear icon) → Account Settings → Getting paid and managing my risk → Block Payments → Update**
3. Set _"Allow payments sent to me in a currency I do not hold"_ → **"Yes, accept and convert them to my primary currency."**
4. Alternatively, add USD explicitly under **Manage Currencies**.
5. Retry the buyer approval URL for your order.

**Collecting sanitised diagnostics without disclosing secrets**:

```powershell
# GET only — never creates or captures. Replace ORDER_ID with your actual ID.
pnpm --filter @agentpay/payment-service tsx src/cli/diagnose-order.ts ORDER_ID
```

This prints order status, amount, payee info (if returned), and HATEOAS links. It never prints access tokens, credentials, or authorization headers.

### Order status `UNKNOWN` after capture timeout

A capture timeout marks the order `UNKNOWN`. Do not retry the capture automatically. Verify the capture status manually in the [PayPal Sandbox Dashboard](https://www.sandbox.paypal.com) before taking further action.

### TypeScript errors after pulling changes

```powershell
pnpm build
pnpm typecheck
```

### Playwright E2E failures

```powershell
# Install browser binaries
pnpm exec playwright install --with-deps chromium

# Ensure Docker stack is running and healthy, then run E2E
docker compose up -d
pnpm test:e2e
```

Playwright reports and screenshots are saved to `playwright-report/` on failure.

### Windows line endings (`CRLF` vs `LF`)

If shell scripts or Dockerfiles fail due to line endings:

```powershell
git config core.autocrlf input
```

---

## Roadmap

### ✅ Completed

- **Phase 0**: Microservices mesh, shared packages, Docker Compose, PostgreSQL, CI/CD
- **Phase 1A**: PayPal Sandbox OAuth adapter — credential validation, token caching, sandbox-only enforcement
- **Phase 1B** (partial): PayPal Sandbox order creation, buyer approval URL extraction, capture authorization, idempotency, webhook signature verification, proposal financial integrity validation, timeout/unknown-outcome safety, PostgreSQL persistence

### 🔄 In Progress

- **Phase 1B**: Resolving Sandbox buyer approval currency eligibility issue; full end-to-end capture verification

### 📋 Planned

- **Phase 1C**: Webhook ingestion in production Docker environment, full audit integration for webhook-driven state transitions
- **Phase 2**: Cryptographic tamper-evidence — Merkle hashing and proof chains over the PostgreSQL audit ledger
- **Phase 3**: Human Approval Portal — web UI for reviewing and approving `REQUIRE_APPROVAL` proposals
- **Phase 4**: Multi-agent support — per-agent spending limits, audit isolation, and budget enforcement across agent pools

### Contributing

1. Fork the repository and create a feature branch from `main`.
2. Run `pnpm install` and ensure `pnpm format`, `pnpm lint`, `pnpm typecheck`, and `pnpm test` all pass.
3. Add or update tests for any changed behaviour.
4. Submit a pull request targeting `main`. All CI checks must pass before review.

**Non-negotiable requirements:**

- `PAYMENT_PROVIDER=mock` and `PAYMENTS_ENABLED=false` must remain the defaults.
- No Live PayPal credentials or endpoints may be introduced.
- Credential or token values must never appear in logs, responses, or error messages.
- Payment security controls (policy enforcement, idempotency, capture authorization) must not be weakened.

---

## License

Licensed under the [Apache License, Version 2.0](LICENSE).

```
Copyright 2026 AgentPay contributors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0
```

---

## Architecture Overview

```mermaid
flowchart TD
    subgraph Browser ["Host / Browser Boundary"]
        Web["Web Application\nNext.js (:3000)"]
    end

    subgraph GatewayBoundary ["Public API Boundary"]
        GW["API Gateway\nFastify (:4000)"]
    end

    subgraph InternalMesh ["Internal Docker Network (Private)"]
        Agent["Agent Service\n(:4001)\nFixtureAIProvider"]
        Policy["Policy Service\n(:4002)\nDeterministic Rules"]
        Payment["Payment Service\n(:4003)\nMock Provider"]
        Audit["Audit Service\n(:4004)\nPostgreSQL Recorder"]
    end

    subgraph Storage ["Persistent Storage"]
        Postgres[("PostgreSQL 17\naudit_events")]
    end

    Web -->|User Request & Status| GW
    GW -->|1. Parse Intent| Agent
    GW -->|2. Evaluate Policy| Policy
    GW -->|3. Strict Allow Verification| Payment
    GW -->|4. Record Audit Event| Audit
    Policy -->|Log Decision| Audit
    Payment -->|Log Order / Capture| Audit
    Audit -->|Parameterized SQL| Postgres
```

---

## Engineering Foundation Status & Provider Notice

> [!WARNING] > **DEVELOPMENT / ENGINEERING FOUNDATION PHASE**
>
> 1. **Sandbox Not Configured**: Real PayPal Sandbox OAuth credentials and order lifecycle verification have **not yet been configured** in this foundation phase.
> 2. **Mock Provider Active**: The payment service operates strictly under a `MOCK/DEVELOPMENT` provider that transfers zero funds. Payment execution is disabled by default (`PAYMENTS_ENABLED=false`).
> 3. **Non-Production Notice**: Do not use this configuration in production or with live financial accounts.

---

## Repository Structure

```
AgentPay/
├── apps/
│   └── web/                     # Next.js 15 Web Application (:3000)
├── services/
│   ├── api-gateway/             # Fastify API Gateway (:4000)
│   ├── agent-service/           # Agent Intent & Proposal Service (:4001)
│   ├── policy-service/          # Deterministic Policy Engine (:4002)
│   ├── payment-service/         # Payment Provider Abstraction & Mock (:4003)
│   └── audit-service/           # Sanitized PostgreSQL Audit Service (:4004)
├── packages/
│   ├── contracts/               # Shared Zod schemas and TypeScript interfaces
│   ├── config/                  # Validated environment configuration loaders
│   ├── logger/                  # Pino-based structured JSON logger with redaction
│   └── test-utils/              # Deterministic test factories and fixtures
├── db/
│   ├── migrations/              # Versioned SQL migrations (001_create_audit_events.sql)
│   └── migrate.ts               # Idempotent migration runner
├── tests/
│   ├── integration/             # Migration and cross-service integration tests
│   └── e2e/                     # Playwright end-to-end browser test suite
├── docs/                        # Architecture, threat model, development, testing, CI/CD
├── .github/workflows/           # CI/CD GitHub Actions workflows
├── docker-compose.yml           # Production-ready multi-service Docker Compose configuration
├── .env.example                 # Safe environment configuration template
└── README.md
```

---

## Service Ports & Health Endpoints

| Service             | Port   | Host Exposed                  | Health Endpoint   |
| :------------------ | :----- | :---------------------------- | :---------------- |
| **Web Application** | `3000` | Yes (`http://localhost:3000`) | `GET /`           |
| **API Gateway**     | `4000` | Yes (`http://localhost:4000`) | `GET /api/health` |
| **Agent Service**   | `4001` | Internal Docker Network only  | `GET /health`     |
| **Policy Service**  | `4002` | Internal Docker Network only  | `GET /health`     |
| **Payment Service** | `4003` | Internal Docker Network only  | `GET /health`     |
| **Audit Service**   | `4004` | Internal Docker Network only  | `GET /health`     |
| **PostgreSQL**      | `5432` | Internal Docker Network only  | `pg_isready`      |

---

## Prerequisites

- **Node.js**: `v24.x LTS` (verified with `v24.12.0`)
- **pnpm**: `9.15.4` or later
- **Docker & Docker Compose**: Docker 24+ (Compose v2.20+)

---

## Quickstart (Docker-First)

### 1. Configure Environment

```bash
cp .env.example .env
```

### 2. Validate Compose Configuration

```bash
docker compose config
```

### 3. Build & Launch Containers

```bash
docker compose up -d --build
```

### 4. Check Health & Logs

```bash
docker compose ps
docker compose logs --tail=100
```

### 5. Open Web Dashboard

Navigate to [http://localhost:3000](http://localhost:3000) to view the service status monitor and policy simulator.

### 6. Stop Containers Gracefully

```bash
docker compose down
```

> [!CAUTION]
> Never use `docker compose down -v` as a routine command, because it will destroy the persistent PostgreSQL volume storing your audit history.

---

## Local Development (Without Docker)

1. Start PostgreSQL:
   ```bash
   docker compose up -d postgres
   ```
2. Run database migrations:
   ```bash
   pnpm db:migrate
   ```
3. Run microservices and web application:
   ```bash
   pnpm dev
   ```

---

## Testing & Diagnostic Commands

```bash
# Run all Vitest unit and integration tests (37 tests across contracts, services, integration)
pnpm test

# Run unit tests only
pnpm test:unit

# Run migration and integration tests
pnpm test:integration

# Run Playwright E2E tests (Chromium)
pnpm test:e2e

# Run safe PayPal Sandbox OAuth diagnostic (never logs credentials or tokens)
pnpm verify:paypal

# Run TypeScript type check across all workspaces
pnpm typecheck

# Run ESLint
pnpm lint

# Check formatting
pnpm format
```

---

## Troubleshooting

### Windows Line Endings (`CRLF` vs `LF`)

If shell scripts or Dockerfiles fail on Windows due to line endings, Git can convert line endings automatically. Ensure `.gitattributes` or your editor preserves `LF` for Docker files:

```bash
git config core.autocrlf input
```

### Port Conflicts (3000 or 4000 already in use)

If port 3000 or 4000 is occupied by another process on your machine, edit `.env`:

```env
WEB_PORT=3001
API_GATEWAY_PORT=4010
```

### Docker Volume Reset (Clean Slate)

To perform a complete clean slate rebuild (deleting test database data):

```bash
docker compose down -v
docker compose up -d --build
```

---

## Milestones & Roadmap

- [x] **Phase 0: Engineering Foundation**: Microservices mesh, shared packages, Docker Compose orchestration, PostgreSQL persistence, and CI/CD pipelines.
- [x] **Phase 1A: PayPal Sandbox OAuth Adapter**: Lightweight zero-dependency OAuth client, Basic authentication, safe token caching, credential validation, and diagnostics.
- [ ] **Phase 1B: PayPal Sandbox Order Lifecycle**: End-to-end sandbox order creation, buyer approval URL resolution, payment capture, and idempotency tracking.
- [ ] **Phase 1C: Webhook Signature Verification & Audit**: Real-time webhook ingestion with PayPal transmission ID verification and immutable audit logging.
- [ ] **Phase 2: Cryptographic Tamper-Evidence**: Merkle hashing and cryptographic proof chains over the PostgreSQL audit ledger.
- [ ] **Phase 3: Human Approval Portal**: Web UI workflow allowing administrators to review and approve proposals flagged with `REQUIRE_APPROVAL`.

---

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
