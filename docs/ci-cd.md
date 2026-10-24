# Continuous Integration & Delivery (CI/CD)

## CI Pipeline Overview (`.github/workflows/ci.yml`)

The CI pipeline runs on all pull requests and pushes to `main`. It enforces strict quality gates:

```mermaid
flowchart LR
    A[Code Quality\n(ESLint, Prettier, TypeScript)] --> B[Unit & Integration Tests\n(Vitest, Migrations)]
    B --> C[Docker & E2E\n(Docker Build, Compose Up, Playwright)]
```

### CI Security Standards

- **Least Privilege Permissions**: `permissions: contents: read` is set globally.
- **Pinned Actions**: Third-party actions are pinned to immutable commit SHAs.
- **Frozen Lockfile**: Dependencies are installed strictly via `pnpm install --frozen-lockfile`.
- **E2E Artifact Preservation**: Playwright failure traces, videos, and screenshots are uploaded as GitHub Actions artifacts upon failure.

## CD Pipeline Overview (`.github/workflows/cd.yml`)

The CD workflow defines a safe, gated release pipeline:

- **Branch Protection**: Restricted exclusively to pushes to `main` or version tags (`v*.*.*`), plus manual `workflow_dispatch`.
- **Gating Mechanism**: The deployment halts if production container registry credentials (`CONTAINER_REGISTRY_URL`) are absent.
- **No Simulated Deployments**: The pipeline explicitly halts rather than reporting a false success when production targets are unconfigured.
