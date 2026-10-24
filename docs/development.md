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
