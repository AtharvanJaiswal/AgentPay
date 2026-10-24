# AgentPay Testing Guide

AgentPay uses a multi-tiered testing strategy comprising unit tests, integration tests, contract verification, and Playwright end-to-end browser tests.

## Test Commands

| Target                | Command                 | Description                                                              |
| :-------------------- | :---------------------- | :----------------------------------------------------------------------- |
| **All Tests**         | `pnpm test`             | Runs all Vitest suites across packages, services, and integration tests. |
| **Unit Tests**        | `pnpm test:unit`        | Tests business logic in packages and individual services.                |
| **Integration Tests** | `pnpm test:integration` | Verifies database migration scripts and cross-service behavior.          |
| **E2E Browser Tests** | `pnpm test:e2e`         | Runs Playwright tests against Chromium.                                  |
| **Typecheck**         | `pnpm typecheck`        | Strict TypeScript compiler validation across all workspaces.             |
| **Linting**           | `pnpm lint`             | ESLint verification.                                                     |
| **Formatting**        | `pnpm format`           | Prettier code style validation.                                          |

## Playwright End-to-End Tests

Playwright validates the end-to-end user experience and critical security boundaries in a real browser:

1. **Branding & Layout**: Confirms the AgentPay branding, tagline, and interactive components render correctly.
2. **Provider Transparency**: Verifies that the UI explicitly identifies the provider as `MOCK/DEVELOPMENT` and states `Sandbox not configured`.
3. **Controlled Error Recovery**: Validates that when the API Gateway is unavailable or fails, a controlled error banner appears rather than a broken page.
4. **Policy Enforcement Verification**: Guarantees that high-risk or prohibited proposals result in rejection and trigger zero payment orders.
5. **Console Integrity**: Confirms no unexpected console errors or unhandled exceptions occur during standard operation.

### Running Playwright Locally

To install browser binaries:

```bash
pnpm exec playwright install --with-deps chromium
```

To run tests with UI debugger:

```bash
pnpm exec playwright test --ui
```
